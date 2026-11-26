import { randomUUID } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AccountRiskStatus, Prisma } from '@prisma/client';
import { config } from '../config';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { decryptAccountSecret } from './account-secrets';

const sixHours = 6 * 3_600_000;
const oneDay = 24 * 3_600_000;
const autoManagedKinds = new Set([
  'cookie_expired',
  'auth_expired',
  'auth_expiring',
  'rate_limited',
  'health_check_failed',
]);

export type RecordRiskInput = {
  workspaceId: string;
  accountId: string;
  level: Exclude<AccountRiskStatus, 'normal'>;
  kind: string;
  message: string;
  actorId?: string | null;
  forceNotify?: boolean;
};

function hasXhsSessionKeys(cookieHeader: string) {
  const keys = new Set(
    cookieHeader
      .split(';')
      .map((part) => part.trim().split('=')[0]?.trim())
      .filter(Boolean),
  );
  return ['web_session', 'a1', 'customer-sso-sid', 'galaxy_creator_session_id'].some((k) => keys.has(k));
}

@Injectable()
export class AccountRiskService {
  private readonly logger = new Logger(AccountRiskService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async recordRisk(input: RecordRiskInput) {
    const now = new Date();
    const { account, event, shouldNotify } = await this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "ChannelAccount"
        WHERE id = ${input.accountId} AND "workspaceId" = ${input.workspaceId} FOR UPDATE
      `;
      if (!locked) throw new NotFoundException('账号不存在');
      const existing = await tx.channelAccount.findUniqueOrThrow({
        where: { id: input.accountId },
        include: { group: { select: { name: true } } },
      });

      const recentSame = !input.forceNotify ? await tx.accountRiskEvent.findFirst({
        where: {
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          kind: input.kind,
          resolvedAt: null,
          createdAt: { gte: new Date(now.getTime() - sixHours) },
        },
        select: { id: true },
      }) : null;

      await tx.channelAccount.update({
        where: { id: input.accountId },
        data: {
          riskStatus: input.level,
          riskReason: input.message.slice(0, 300),
          riskDetectedAt: now,
        },
      });

      const created = await tx.accountRiskEvent.create({
        data: {
          id: randomUUID(),
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          level: input.level,
          kind: input.kind,
          message: input.message.slice(0, 300),
          feishuStatus: 'skipped',
          feishuError: recentSame ? '6 小时内同类风险已告警，本次跳过重复发送' : null,
          actorId: input.actorId ?? null,
        },
      });
      return { account: existing, event: created, shouldNotify: !recentSame };
    });

    if (!shouldNotify) return event;

    const delivered = await this.notifications.sendAccountRiskAlert(input.workspaceId, {
      level: input.level,
      accountName: account.alias ? `${account.alias}（${account.displayName}）` : account.displayName,
      platform: account.platform,
      groupName: account.group?.name,
      operator: account.operator,
      message: input.message,
    });

    return this.prisma.accountRiskEvent.update({
      where: { id: event.id },
      data: {
        feishuStatus: delivered.status,
        feishuError: delivered.error ?? null,
      },
    });
  }

  async resolveRisk(workspaceId: string, accountId: string, actorId: string | null, note = '人工确认风险已解除', notify = false) {
    const now = new Date();
    const { account, event } = await this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "ChannelAccount"
        WHERE id = ${accountId} AND "workspaceId" = ${workspaceId} FOR UPDATE
      `;
      if (!locked) throw new NotFoundException('账号不存在');
      const existing = await tx.channelAccount.findUniqueOrThrow({
        where: { id: accountId },
        include: { group: { select: { name: true } } },
      });

      await tx.channelAccount.update({
        where: { id: accountId },
        data: { riskStatus: 'normal', riskReason: null, riskDetectedAt: null },
      });
      await tx.accountRiskEvent.updateMany({
        where: { workspaceId, accountId, resolvedAt: null },
        data: { resolvedAt: now, resolvedById: actorId },
      });
      const created = await tx.accountRiskEvent.create({
        data: {
          id: randomUUID(),
          workspaceId,
          accountId,
          level: 'normal',
          kind: 'resolved',
          message: note.slice(0, 300),
          feishuStatus: 'skipped',
          actorId,
          resolvedAt: now,
          resolvedById: actorId,
        },
      });
      return { account: existing, event: created };
    });

    if (!notify) return event;

    const delivered = await this.notifications.sendAccountRiskAlert(workspaceId, {
      level: 'normal',
      accountName: account.alias ? `${account.alias}（${account.displayName}）` : account.displayName,
      platform: account.platform,
      groupName: account.group?.name,
      operator: account.operator,
      message: note,
    });
    return this.prisma.accountRiskEvent.update({
      where: { id: event.id },
      data: { feishuStatus: delivered.status, feishuError: delivered.error ?? null },
    });
  }

  async listEvents(workspaceId: string, accountId?: string) {
    return this.prisma.accountRiskEvent.findMany({
      where: { workspaceId, ...(accountId ? { accountId } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
      include: {
        account: { select: { id: true, displayName: true, alias: true, platform: true } },
        actor: { select: { id: true, name: true } },
        resolvedBy: { select: { id: true, name: true } },
      },
    });
  }

  async checkAccountHealth(workspaceId: string, accountId: string, actorId?: string | null, forceNotify = false) {
    const account = await this.prisma.channelAccount.findFirst({
      where: { id: accountId, workspaceId, archivedAt: null },
    });
    if (!account) throw new NotFoundException('账号不存在或已归档');

    const now = new Date();

    if (account.rateLimitedUntil && account.rateLimitedUntil > now) {
      const event = await this.recordRisk({
        workspaceId,
        accountId,
        level: 'risk',
        kind: 'rate_limited',
        message: `平台接口触发限流冷却，预计恢复时间 ${account.rateLimitedUntil.toLocaleString('zh-CN')}`,
        actorId,
        forceNotify,
      });
      return { status: 'risk' as const, reason: event.message, feishuStatus: event.feishuStatus };
    }

    if (account.channelKind === 'official' && account.authExpiresAt) {
      if (account.authExpiresAt <= now) {
        await this.prisma.channelAccount.update({
          where: { id: accountId },
          data: { authStatus: 'expired' },
        });
        const event = await this.recordRisk({
          workspaceId,
          accountId,
          level: 'risk',
          kind: 'auth_expired',
          message: 'B 站开放平台授权已过期，自动投稿和成效同步已暂停，请重新授权连接。',
          actorId,
          forceNotify,
        });
        return { status: 'risk' as const, reason: event.message, feishuStatus: event.feishuStatus };
      }
      if (account.authExpiresAt.getTime() - now.getTime() <= oneDay) {
        const event = await this.recordRisk({
          workspaceId,
          accountId,
          level: 'warning',
          kind: 'auth_expiring',
          message: `B 站开放平台授权将于 24 小时内到期（${account.authExpiresAt.toLocaleString('zh-CN')}），请提前重新授权。`,
          actorId,
          forceNotify,
        });
        return { status: 'warning' as const, reason: event.message, feishuStatus: event.feishuStatus };
      }
      // 授权仍在有效期内：记录本次体检时间，否则巡检队列会一直卡在这批账号上。
      await this.prisma.channelAccount.update({ where: { id: accountId }, data: { authCheckedAt: now } });
    }

    if (account.cookieCiphertext) {
      const cookie = decryptAccountSecret('cookie', workspaceId, accountId, account.cookieCiphertext, account.cookieKeyId);
      if (!cookie) {
        const event = await this.recordRisk({
          workspaceId,
          accountId,
          level: 'risk',
          kind: 'cookie_expired',
          message: '保存的 Cookie 凭据无法解密，请重新扫码或重新导入 Cookie。',
          actorId,
          forceNotify,
        });
        return { status: 'risk' as const, reason: event.message, feishuStatus: event.feishuStatus };
      }

      if (account.platform === 'bilibili') {
        const check = await this.probeBilibiliCookie(cookie);
        if (check.state === 'invalid') {
          await this.prisma.channelAccount.update({ where: { id: accountId }, data: { authStatus: 'expired' } });
          const event = await this.recordRisk({
            workspaceId,
            accountId,
            level: 'risk',
            kind: 'cookie_expired',
            message: check.reason,
            actorId,
            forceNotify,
          });
          return { status: 'risk' as const, reason: event.message, feishuStatus: event.feishuStatus };
        }
        if (check.state === 'error') {
          const event = await this.recordRisk({
            workspaceId,
            accountId,
            level: 'warning',
            kind: 'health_check_failed',
            message: check.reason,
            actorId,
            forceNotify,
          });
          return { status: 'warning' as const, reason: event.message, feishuStatus: event.feishuStatus };
        }
        await this.prisma.channelAccount.update({
          where: { id: accountId },
          data: { authStatus: 'active', authCheckedAt: now },
        });
      } else if (account.platform === 'xiaohongshu') {
        if (!hasXhsSessionKeys(cookie)) {
          const event = await this.recordRisk({
            workspaceId,
            accountId,
            level: 'risk',
            kind: 'cookie_expired',
            message: '小红书 Cookie 缺少核心会话字段，请重新导入有效 Cookie。',
            actorId,
            forceNotify,
          });
          return { status: 'risk' as const, reason: event.message, feishuStatus: event.feishuStatus };
        }
        // 小红书没有可调用的登录态接口，只能确认会话字段齐全；同样推进体检时间，保证巡检轮得到其他账号。
        await this.prisma.channelAccount.update({ where: { id: accountId }, data: { authCheckedAt: now } });
      }
    }

    if (account.riskStatus !== 'normal') {
      const latestOpen = await this.prisma.accountRiskEvent.findFirst({
        where: { workspaceId, accountId, resolvedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { kind: true },
      });
      if (!latestOpen || autoManagedKinds.has(latestOpen.kind)) {
        await this.resolveRisk(workspaceId, accountId, actorId ?? null, '账号体检通过，风险已自动解除');
        return { status: 'normal' as const, reason: '账号状态正常', feishuStatus: 'skipped' as const };
      }
      return { status: account.riskStatus, reason: account.riskReason ?? '存在人工标记的风险', feishuStatus: 'skipped' as const };
    }

    return { status: 'normal' as const, reason: '账号状态正常', feishuStatus: 'skipped' as const };
  }

  private async probeBilibiliCookie(cookie: string): Promise<
    { state: 'ok'; mid: string; uname: string } | { state: 'invalid'; reason: string } | { state: 'error'; reason: string }
  > {
    try {
      const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        headers: {
          cookie,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          referer: 'https://www.bilibili.com/',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return { state: 'error', reason: `B 站体检接口返回 HTTP ${response.status}` };
      const payload = (await response.json()) as {
        code?: number;
        data?: { isLogin?: boolean; mid?: number | string; uname?: string };
      };
      if (payload.code === -101 || !payload.data?.isLogin || !payload.data.mid) {
        return { state: 'invalid', reason: 'B 站 Cookie 登录态已失效或退出登录，请重新扫码或更新 Cookie。' };
      }
      return { state: 'ok', mid: String(payload.data.mid), uname: String(payload.data.uname ?? '').trim() };
    } catch {
      return { state: 'error', reason: '连接 B 站账号体检接口超时或网络异常，请稍后重试。' };
    }
  }

  async scanDueAccountHealth() {
    if (config.sandboxChannel) return;
    const now = new Date();
    const where: Prisma.ChannelAccountWhereInput = {
      archivedAt: null,
      workspace: { trialOwnerId: null },
      OR: [
        { cookieCiphertext: { not: null } },
        { channelKind: 'official' },
        { rateLimitedUntil: { not: null } },
      ],
    };
    const candidates = await this.prisma.channelAccount.findMany({
      where,
      orderBy: [{ authCheckedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      select: { id: true, workspaceId: true, authCheckedAt: true, riskStatus: true },
      take: 15,
    });
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60_000);
    for (const candidate of candidates) {
      if (candidate.authCheckedAt && candidate.authCheckedAt > tenMinutesAgo && candidate.riskStatus === 'normal') {
        continue;
      }
      try {
        await this.checkAccountHealth(candidate.workspaceId, candidate.id, null, false);
      } catch (error) {
        this.logger.warn(`账号健康体检未完成 · ${candidate.id}: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    }
  }
}
