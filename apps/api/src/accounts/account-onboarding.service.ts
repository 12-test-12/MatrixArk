import { createHash, randomUUID } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import {
  cleanTags,
  encryptAccountSecret,
  maskLoginIdentifier,
  normalizeEgressIp,
  parseCookieHeader,
  validatePlatformCookie,
} from './account-secrets';
import { MatrixGroupsService } from './matrix-groups.service';
import { bilibiliManualUidPrefix, bilibiliWebUidPrefix, parseProfileInput } from './publish-account';

const qrGenerateResponseSchema = z.object({
  code: z.literal(0),
  data: z.object({
    url: z.string().url(),
    qrcode_key: z.string().min(1).max(256),
  }),
});

const qrPollResponseSchema = z.object({
  code: z.literal(0),
  data: z.object({
    url: z.string().optional(),
    code: z.number().int(),
    message: z.string().optional(),
  }),
});

const biliNavResponseSchema = z.object({
  code: z.number().int(),
  data: z.object({
    isLogin: z.boolean().optional(),
    mid: z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d{0,19}$/)]).optional(),
    uname: z.string().optional(),
  }).optional(),
});

export const passwordAccountSchema = z.object({
  platform: z.enum(['xiaohongshu', 'bilibili']),
  displayName: z.string().trim().min(1, '请填写账号显示名称').max(60),
  loginIdentifier: z.string().trim().min(1, '请填写登录账号（手机号 / 邮箱 / 用户名）').max(120),
  password: z.string().min(1, '请填写登录密码').max(256),
  profile: z.string().trim().max(1000).optional(),
  profileUrl: z.string().trim().max(1000).nullable().optional(),
  operator: z.string().trim().max(40).optional(),
  groupId: z.string().min(1).nullable().optional(),
  alias: z.string().trim().max(60).optional(),
  tags: z.array(z.string().trim().min(1).max(24)).max(12).optional(),
  egressIp: z.string().trim().max(64).nullable().optional(),
  profileLabel: z.string().trim().max(64).nullable().optional(),
}).strict();

export const cookieImportSchema = z.object({
  platform: z.enum(['xiaohongshu', 'bilibili']),
  cookie: z.string().trim().min(1, '请粘贴 Cookie 内容').max(32_768),
  accountId: z.string().min(1).optional(),
  displayName: z.string().trim().max(60).optional(),
  profileUrl: z.string().trim().max(1000).nullable().optional(),
  operator: z.string().trim().max(40).optional(),
  groupId: z.string().min(1).nullable().optional(),
  alias: z.string().trim().max(60).optional(),
  tags: z.array(z.string().trim().min(1).max(24)).max(12).optional(),
  cookieExpiresAt: z.string().datetime({ offset: true }).transform((v) => new Date(v)).nullable().optional(),
  egressIp: z.string().trim().max(64).nullable().optional(),
  profileLabel: z.string().trim().max(64).nullable().optional(),
}).strict();

export const readSessionSchema = z.object({
  readAccountId: z.string().min(1).nullable().optional(),
  readCookie: z.string().trim().max(32_768).nullable().optional(),
  readCookieLabel: z.string().trim().max(60).nullable().optional(),
}).strict();

type BiliQrTicket = {
  id: string;
  qrcodeKey: string;
  verificationUrl: string;
  expiresAt: number;
  nextPollAt: number;
  busy: boolean;
  status: 'pending' | 'scanned' | 'expired' | 'connected';
  groupId: string | null;
  accountId?: string;
};

function extractCookiesFromResponse(response: Response, callbackUrl?: string) {
  const entries: Record<string, string> = {};
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [];
  for (const raw of setCookies) {
    const first = raw.split(';')[0]?.trim();
    if (!first) continue;
    const eq = first.indexOf('=');
    if (eq > 0) entries[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  if (callbackUrl && URL.canParse(callbackUrl)) {
    const parsed = new URL(callbackUrl);
    for (const key of ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']) {
      const val = parsed.searchParams.get(key);
      if (val && !entries[key]) entries[key] = val;
    }
  }
  return Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('; ');
}

@Injectable()
export class AccountOnboardingService {
  // Pending Bilibili web QR logins in-memory (short-lived 180s tickets).
  private readonly pendingBiliQr = new Map<string, BiliQrTicket>();
  private readonly startingBiliQr = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly groups: MatrixGroupsService,
  ) {}

  private async verifyBilibiliCookie(cookieHeader: string) {
    let response: Response;
    try {
      response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        headers: {
          cookie: cookieHeader,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          referer: 'https://www.bilibili.com/',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new BadGatewayException('暂时无法连接 B 站核验接口，请检查网络后重试');
    }
    if (!response.ok) throw new BadGatewayException(`B 站核验接口返回 HTTP ${response.status}`);
    const parsed = biliNavResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success || parsed.data.code === -101 || !parsed.data.data?.isLogin || !parsed.data.data.mid) {
      throw new BadRequestException('B 站 Cookie 无效或尚未登录，请重新扫码或确认已复制最新的 SESSDATA');
    }
    return {
      mid: String(parsed.data.data.mid),
      uname: parsed.data.data.uname?.trim() || `B站用户 ${parsed.data.data.mid}`,
    };
  }

  private async uniqueDisplayName(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    platform: 'bilibili' | 'xiaohongshu',
    preferred: string,
  ) {
    // 数据库的「工作室 + 平台 + 显示名」唯一索引包含已归档账号，这里也必须一起避开，
    // 否则同名账号重新接入时会撞唯一键，接口直接 500。
    const existing = await tx.channelAccount.findMany({
      where: { workspaceId, platform },
      select: { displayName: true },
    });
    const used = new Set(existing.map(({ displayName }) => displayName));
    const base = Array.from(preferred.trim() || '新账号').slice(0, 50).join('');
    let candidate = base;
    for (let suffix = 2; used.has(candidate); suffix++) {
      candidate = `${base} (${suffix})`;
    }
    return candidate;
  }

  async startBilibiliWebQr(workspaceId: string, userId: string, groupId?: string | null) {
    const key = JSON.stringify([workspaceId, userId]);
    if (this.startingBiliQr.has(key) || this.pendingBiliQr.get(key)?.busy) {
      throw new ConflictException('正在生成二维码，请稍后重试');
    }
    this.startingBiliQr.add(key);
    try {
      const validGroupId = await this.groups.assertWorkspaceGroup(this.prisma, workspaceId, groupId);
      let response: Response;
      try {
        response = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
          headers: {
            accept: 'application/json',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new BadGatewayException('暂时无法连接 B 站扫码登录服务，请稍后重试');
      }
      if (!response.ok) throw new BadGatewayException(`B 站二维码服务返回 HTTP ${response.status}`);
      const payload = qrGenerateResponseSchema.safeParse(await response.json().catch(() => null));
      if (!payload.success) throw new BadGatewayException('B 站二维码返回格式异常，请稍后重试');

      const now = Date.now();
      const ticket: BiliQrTicket = {
        id: randomUUID(),
        qrcodeKey: payload.data.data.qrcode_key,
        verificationUrl: payload.data.data.url,
        expiresAt: now + 180_000,
        nextPollAt: now + 1500,
        busy: false,
        status: 'pending',
        groupId: validGroupId,
      };
      this.pendingBiliQr.set(key, ticket);
      setTimeout(() => {
        if (this.pendingBiliQr.get(key) === ticket) this.pendingBiliQr.delete(key);
      }, 180_000).unref();
      return { id: ticket.id, verificationUrl: ticket.verificationUrl, expiresAt: ticket.expiresAt };
    } finally {
      this.startingBiliQr.delete(key);
    }
  }

  async pollBilibiliWebQr(workspaceId: string, userId: string, id: string) {
    const key = JSON.stringify([workspaceId, userId]);
    const ticket = this.pendingBiliQr.get(key);
    if (!ticket || ticket.id !== id) throw new NotFoundException('扫码请求不存在或已失效，请重新获取二维码');
    if (ticket.expiresAt <= Date.now()) {
      this.pendingBiliQr.delete(key);
      return { status: 'expired' as const };
    }
    if (ticket.status === 'connected' || ticket.status === 'expired' || ticket.busy || ticket.nextPollAt > Date.now()) {
      return { status: ticket.status, ...(ticket.accountId ? { accountId: ticket.accountId } : {}) };
    }
    ticket.busy = true;
    ticket.nextPollAt = Date.now() + 1500;
    try {
      const url = new URL('https://passport.bilibili.com/x/passport-login/web/qrcode/poll');
      url.searchParams.set('qrcode_key', ticket.qrcodeKey);
      let response: Response;
      try {
        response = await fetch(url, {
          headers: {
            accept: 'application/json',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new BadGatewayException('暂时无法连接 B 站扫码状态接口，请稍后重试');
      }
      if (!response.ok) throw new BadGatewayException(`B 站扫码状态接口返回 HTTP ${response.status}`);
      const payload = qrPollResponseSchema.safeParse(await response.json().catch(() => null));
      if (!payload.success) throw new BadGatewayException('B 站扫码状态返回格式异常');

      const code = payload.data.data.code;
      if (code === 86101) {
        ticket.status = 'pending';
        return { status: 'pending' as const };
      }
      if (code === 86090) {
        ticket.status = 'scanned';
        return { status: 'scanned' as const };
      }
      if (code === 86038) {
        ticket.status = 'expired';
        return { status: 'expired' as const };
      }
      if (code !== 0) {
        throw new BadGatewayException(payload.data.data.message || `B 站扫码未成功（${code}）`);
      }

      const cookieHeader = extractCookiesFromResponse(response, payload.data.data.url);
      if (!cookieHeader || !cookieHeader.includes('SESSDATA=')) {
        throw new BadGatewayException('B 站未返回完整登录 Cookie，请重新扫码');
      }
      const { mid, uname } = await this.verifyBilibiliCookie(cookieHeader);
      const accountId = await this.saveBilibiliWebAccount(workspaceId, userId, {
        mid,
        uname,
        cookieHeader,
        accessMethod: 'qr_login',
        groupId: ticket.groupId,
      });
      ticket.status = 'connected';
      ticket.accountId = accountId;
      return { status: 'connected' as const, accountId };
    } finally {
      ticket.busy = false;
      ticket.nextPollAt = Date.now() + 1500;
    }
  }

  private async saveBilibiliWebAccount(
    workspaceId: string,
    userId: string,
    params: {
      mid: string;
      uname: string;
      cookieHeader: string;
      accessMethod: 'qr_login' | 'cookie';
      accountId?: string;
      displayName?: string;
      operator?: string;
      groupId?: string | null;
      alias?: string;
      tags?: string[];
      cookieExpiresAt?: Date | null;
      egressIp?: string | null;
      profileLabel?: string | null;
    },
  ) {
    const webId = bilibiliWebUidPrefix + params.mid;
    const manualId = bilibiliManualUidPrefix + params.mid;
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
      const validGroupId = params.groupId !== undefined
        ? await this.groups.assertWorkspaceGroup(tx, workspaceId, params.groupId)
        : undefined;
      const existing = params.accountId
        ? await tx.channelAccount.findFirst({ where: { id: params.accountId, workspaceId, platform: 'bilibili' } })
        : await tx.channelAccount.findFirst({
            where: { workspaceId, platform: 'bilibili', externalId: { in: [webId, manualId] } },
          });
      if (existing?.archivedAt) {
        throw new ConflictException('该 B 站账号已归档，请先在归档列表中恢复后再更新登录态');
      }
      if (existing && existing.channelKind === 'official') {
        throw new ConflictException('该 B 站账号已绑定开放平台官方通道');
      }

      const id = existing?.id ?? randomUUID();
      const { ciphertext, keyId } = encryptAccountSecret('cookie', workspaceId, id, params.cookieHeader);
      const resolvedName = existing
        ? existing.displayName
        : await this.uniqueDisplayName(tx, workspaceId, 'bilibili', params.displayName?.trim() || params.uname);

      const commonData = {
        externalId: webId,
        channelKind: 'manual' as const,
        accessMethod: params.accessMethod,
        authStatus: 'active' as const,
        authCheckedAt: now,
        authAuthorizedBy: userId,
        cookieCiphertext: ciphertext,
        cookieKeyId: keyId,
        cookieUpdatedAt: now,
        ...(params.cookieExpiresAt !== undefined && { cookieExpiresAt: params.cookieExpiresAt }),
        ...(params.egressIp !== undefined && { egressIp: params.egressIp }),
        ...(params.profileLabel !== undefined && { profileLabel: params.profileLabel }),
        riskStatus: 'normal' as const,
        riskReason: null,
        riskDetectedAt: null,
        ...(validGroupId !== undefined && { groupId: validGroupId }),
        ...(params.operator !== undefined && { operator: params.operator.trim() || null }),
        ...(params.alias !== undefined && { alias: params.alias.trim() || null }),
        ...(params.tags !== undefined && { tags: cleanTags(params.tags) }),
      };

      if (existing) {
        await tx.channelAccount.update({ where: { id }, data: commonData });
        await tx.accountRiskEvent.updateMany({
          where: { workspaceId, accountId: id, resolvedAt: null },
          data: { resolvedAt: now, resolvedById: userId },
        });
      } else {
        await tx.channelAccount.create({
          data: {
            id,
            workspaceId,
            platform: 'bilibili',
            displayName: resolvedName,
            ...commonData,
          },
        });
      }
      return id;
    });
  }

  async addPasswordAccount(workspaceId: string, userId: string, input: z.infer<typeof passwordAccountSchema>) {
    const parsedProfile = parseProfileInput(input.platform, input.profileUrl ?? input.profile);
    const uid = input.platform === 'bilibili' ? parsedProfile.uid : null;
    const now = new Date();
    const masked = maskLoginIdentifier(input.loginIdentifier);
    const egressIp = input.egressIp !== undefined ? normalizeEgressIp(input.egressIp) : undefined;
    const profileLabel = input.profileLabel !== undefined ? (input.profileLabel?.trim() || null) : undefined;
    const id = randomUUID();
    const { ciphertext, keyId } = encryptAccountSecret(
      'password',
      workspaceId,
      id,
      JSON.stringify({ loginIdentifier: input.loginIdentifier, password: input.password }),
    );

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
        const groupId = await this.groups.assertWorkspaceGroup(tx, workspaceId, input.groupId);
        if (uid) {
          const dupUid = await tx.channelAccount.findFirst({
            where: {
              workspaceId,
              platform: 'bilibili',
              externalId: { in: [bilibiliManualUidPrefix + uid, bilibiliWebUidPrefix + uid] },
            },
            select: { archivedAt: true },
          });
          if (dupUid) {
            throw new ConflictException(dupUid.archivedAt ? '这个 B 站 UID 已归档，请在归档列表恢复' : '这个 B 站 UID 已经添加');
          }
        }
        const created = await tx.channelAccount.create({
          data: {
            id,
            workspaceId,
            platform: input.platform,
            channelKind: 'manual',
            accessMethod: 'password',
            displayName: input.displayName,
            externalId: uid ? bilibiliWebUidPrefix + uid : `pwd-${id}`,
            operator: input.operator?.trim() || null,
            groupId,
            alias: input.alias?.trim() || null,
            tags: cleanTags(input.tags),
            ...(egressIp !== undefined && { egressIp }),
            ...(profileLabel !== undefined && { profileLabel }),
            ...(parsedProfile.profileUrl !== undefined && { profileUrl: parsedProfile.profileUrl }),
            loginIdentifier: masked,
            passwordCiphertext: ciphertext,
            passwordKeyId: keyId,
            authStatus: 'active',
            authCheckedAt: now,
            authAuthorizedBy: userId,
          },
          select: { id: true, displayName: true, platform: true },
        });
        return created;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('该平台下已有同名在用账号，请更换账号显示名称');
      }
      throw error;
    }
  }

  async importCookieAccount(workspaceId: string, userId: string, input: z.infer<typeof cookieImportSchema>) {
    const { entries, header, expiresAt } = parseCookieHeader(input.cookie);
    validatePlatformCookie(input.platform, entries);
    const cookieExpiresAt = input.cookieExpiresAt !== undefined ? input.cookieExpiresAt : expiresAt;
    const egressIp = input.egressIp !== undefined ? normalizeEgressIp(input.egressIp) : undefined;
    const profileLabel = input.profileLabel !== undefined ? (input.profileLabel?.trim() || null) : undefined;

    if (input.platform === 'bilibili') {
      const { mid, uname } = await this.verifyBilibiliCookie(header);
      const id = await this.saveBilibiliWebAccount(workspaceId, userId, {
        mid,
        uname,
        cookieHeader: header,
        accessMethod: 'cookie',
        accountId: input.accountId,
        displayName: input.displayName,
        operator: input.operator,
        groupId: input.groupId,
        alias: input.alias,
        tags: input.tags,
        cookieExpiresAt,
        egressIp,
        profileLabel,
      });
      return { id, platform: 'bilibili' as const };
    }

    const explicitProfileUrl = parseProfileInput('xiaohongshu', input.profileUrl).profileUrl;
    const creatorUserId = entries['x-user-id-creator.xiaohongshu.com']?.trim();
    const detectedProfileUrl = explicitProfileUrl === undefined && creatorUserId && /^[0-9a-f]{24}$/i.test(creatorUserId)
      ? `https://www.xiaohongshu.com/user/profile/${creatorUserId}`
      : undefined;

    const identitySeed = entries['x-user-id-creator.xiaohongshu.com']
      || entries['customer-sso-sid']
      || entries.a1
      || entries.web_session
      || header;
    const identityHash = createHash('sha256').update(identitySeed).digest('hex').slice(0, 24);
    const externalId = `xhs-cookie:${identityHash}`;
    const now = new Date();

    const accountId = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
      const validGroupId = input.groupId !== undefined
        ? await this.groups.assertWorkspaceGroup(tx, workspaceId, input.groupId)
        : undefined;
      const existing = input.accountId
        ? await tx.channelAccount.findFirst({ where: { id: input.accountId, workspaceId, platform: 'xiaohongshu' } })
        : await tx.channelAccount.findFirst({ where: { workspaceId, platform: 'xiaohongshu', externalId } });

      if (existing?.archivedAt) {
        throw new ConflictException('该小红书账号已归档，请在归档列表恢复后再更新 Cookie');
      }
      if (!existing && !input.displayName?.trim()) {
        throw new BadRequestException('首次导入小红书 Cookie 请填写账号显示名称');
      }

      const id = existing?.id ?? randomUUID();
      const { ciphertext, keyId } = encryptAccountSecret('cookie', workspaceId, id, header);
      const nextProfileUrl = explicitProfileUrl !== undefined
        ? explicitProfileUrl
        : !existing?.profileUrl
          ? detectedProfileUrl
          : undefined;
      const commonData = {
        channelKind: 'manual' as const,
        accessMethod: 'cookie' as const,
        authStatus: 'active' as const,
        authCheckedAt: now,
        authAuthorizedBy: userId,
        cookieCiphertext: ciphertext,
        cookieKeyId: keyId,
        cookieUpdatedAt: now,
        ...(cookieExpiresAt !== undefined && { cookieExpiresAt }),
        ...(egressIp !== undefined && { egressIp }),
        ...(profileLabel !== undefined && { profileLabel }),
        ...(nextProfileUrl !== undefined && { profileUrl: nextProfileUrl }),
        riskStatus: 'normal' as const,
        riskReason: null,
        riskDetectedAt: null,
        ...(validGroupId !== undefined && { groupId: validGroupId }),
        ...(input.operator !== undefined && { operator: input.operator.trim() || null }),
        ...(input.alias !== undefined && { alias: input.alias.trim() || null }),
        ...(input.tags !== undefined && { tags: cleanTags(input.tags) }),
      };

      if (existing) {
        await tx.channelAccount.update({ where: { id }, data: commonData });
        await tx.accountRiskEvent.updateMany({
          where: { workspaceId, accountId: id, resolvedAt: null },
          data: { resolvedAt: now, resolvedById: userId },
        });
      } else {
        const displayName = await this.uniqueDisplayName(tx, workspaceId, 'xiaohongshu', input.displayName!.trim());
        await tx.channelAccount.create({
          data: {
            id,
            workspaceId,
            platform: 'xiaohongshu',
            displayName,
            externalId,
            ...commonData,
          },
        });
      }
      return id;
    });
    return { id: accountId, platform: 'xiaohongshu' as const };
  }

  async configureReadSession(workspaceId: string, accountId: string, input: z.infer<typeof readSessionSchema>) {
    const now = new Date();
    const parsedCookie = input.readCookie ? parseCookieHeader(input.readCookie) : null;
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
      const account = await tx.channelAccount.findFirst({ where: { id: accountId, workspaceId } });
      if (!account || account.archivedAt) throw new NotFoundException('账号不存在或已归档');

      let nextReadAccountId = account.readAccountId;
      if (input.readAccountId !== undefined) {
        if (input.readAccountId === null) {
          nextReadAccountId = null;
        } else {
          if (input.readAccountId === accountId) {
            throw new BadRequestException('读取小号不能绑定账号本身，请选择同平台其他辅助采集号或直接配置独立读取 Cookie');
          }
          const readAcc = await tx.channelAccount.findFirst({
            where: { id: input.readAccountId, workspaceId, archivedAt: null },
            select: { id: true, platform: true },
          });
          if (!readAcc) throw new NotFoundException('指定的采集小号不存在或已归档');
          if (readAcc.platform !== account.platform) {
            throw new BadRequestException('读写分离账号必须属于同一平台');
          }
          nextReadAccountId = readAcc.id;
        }
      }

      let readCookieUpdate: Record<string, unknown> = {};
      if (input.readCookie === null) {
        readCookieUpdate = {
          readCookieCiphertext: null,
          readCookieKeyId: null,
          readCookieLabel: null,
          readCookieUpdatedAt: null,
        };
      } else if (parsedCookie) {
        validatePlatformCookie(account.platform, parsedCookie.entries);
        const { ciphertext, keyId } = encryptAccountSecret('read-cookie', workspaceId, accountId, parsedCookie.header);
        readCookieUpdate = {
          readCookieCiphertext: ciphertext,
          readCookieKeyId: keyId,
          readCookieLabel: input.readCookieLabel?.trim() || '独立只读会话',
          readCookieUpdatedAt: now,
        };
      } else if (input.readCookieLabel !== undefined) {
        readCookieUpdate = { readCookieLabel: input.readCookieLabel?.trim() || null };
      }

      return tx.channelAccount.update({
        where: { id: accountId },
        data: {
          ...(input.readAccountId !== undefined && { readAccountId: nextReadAccountId }),
          ...readCookieUpdate,
        },
        select: {
          id: true,
          readAccountId: true,
          readAccount: { select: { id: true, displayName: true, alias: true } },
          readCookieLabel: true,
          readCookieUpdatedAt: true,
        },
      });
    });
  }
}
