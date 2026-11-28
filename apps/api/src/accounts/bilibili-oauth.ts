import { createHash, randomBytes } from 'node:crypto';
import { ConflictException, Controller, Get, Header, Injectable, NotFoundException, Query, Redirect } from '@nestjs/common';
import { BilibiliAdapter } from '@matrixark/adapters';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators';
import type { SessionUser } from '../auth/session.service';
import { can } from '../common/permissions';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { bindBilibiliAccount } from './bilibili-account';
import { decryptPlatformSecret, encryptPlatformSecret, readPlatformApp } from './platform-app';

const callbackPath = '/api/channels/bilibili/oauth/callback';
const statePattern = /^[\w-]{43}$/;
const oauthToken = z.object({
  code: z.literal(0),
  data: z.object({ access_token: z.string().regex(/^[!-~]{1,4096}$/), expires_in: z.number().int().positive() }),
});
const hashState = (state: string) => createHash('sha256').update(state).digest('hex');
const pendingGrant = z.object({ accessToken: z.string().regex(/^[!-~]{1,4096}$/), expiresAt: z.string().datetime(),
  openid: z.string().min(1).max(256), name: z.string().min(1), scopes: z.array(z.string()),
  appId: z.string(), appRevision: z.string(), managed: z.boolean() });
const revision = (app: { revision: string } | undefined, secret: string) => app?.revision ?? hashState(secret);

export const configuredBilibiliOAuthOrigin = config.publicBaseUrl && URL.canParse(config.publicBaseUrl)
  ? new URL(config.publicBaseUrl).origin : null;

function callbackUrl(origin?: string) {
  const base = configuredBilibiliOAuthOrigin ?? origin ?? config.apiOrigin;
  const url = URL.canParse(base) ? new URL(base) : null;
  const loopback = url && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!url || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || (!configuredBilibiliOAuthOrigin && !loopback) || (origin && origin !== url.origin)) {
    throw new ConflictException('请使用发布账号页显示的回调地址所在的域名打开 MatrixArk，再发起 B 站授权。');
  }
  return new URL(callbackPath, url.origin).href;
}

@Injectable()
export class BilibiliOAuthService {
  constructor(private readonly prisma: PrismaService) {}

  async start(workspaceId: string, userId: string, origin?: string, accountId?: string) {
    const callback = callbackUrl(origin);
    const app = await readPlatformApp(this.prisma, workspaceId, 'bilibili');
    const appId = app?.appId ?? (config.bilibili.enabled ? config.bilibili.clientId : undefined);
    if (!appId) throw new ConflictException('请先在发布账号页保存 B 站开放平台应用凭据。');
    if (accountId && !await this.prisma.channelAccount.findFirst({
      where: { id: accountId, workspaceId, platform: 'bilibili', archivedAt: null, channelKind: { not: 'sandbox' } }, select: { id: true },
    })) throw new NotFoundException('账号不存在或不可授权');
    const now = new Date();
    const binding = { workspaceId, userId, platform: 'bilibili' as const, accountId: accountId ?? null };
    const state = randomBytes(32).toString('base64url');
    await this.prisma.$transaction([
      this.prisma.oAuthState.deleteMany({ where: { ...binding, expiresAt: { lte: now } } }),
      this.prisma.oAuthState.create({ data: { ...binding, appId, stateHash: hashState(state),
        expiresAt: new Date(now.getTime() + 10 * 60_000) }, select: { id: true } }),
    ]);
    const authorization = new URL('https://account.bilibili.com/pc/account-pc/auth/oauth');
    authorization.search = new URLSearchParams({ client_id: appId, gourl: callback, state }).toString();
    return { authorizationUrl: authorization.href };
  }

  async finish(userId: string, state: unknown, code: unknown): Promise<{
    status: 'expired' | 'denied' | 'failed' | 'pending'; workspaceId?: string;
  }> {
    const invalid = { status: 'expired' } as const;
    if (config.sandboxChannel || typeof state !== 'string' || !statePattern.test(state)) return invalid;
    const now = new Date();
    const where = { userId, stateHash: hashState(state), platform: 'bilibili' as const,
      consumedAt: null, expiresAt: { gt: now }, workspace: { trialOwnerId: null } };
    const request = await this.prisma.oAuthState.findFirst({ where, select: { id: true, appId: true, workspaceId: true } });
    if (!request?.appId) return invalid;
    const { workspaceId } = request;
    const membership = await this.prisma.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId } } });
    if (!membership || !can(membership.role, 'account:manage')) return invalid;
    const { count } = await this.prisma.oAuthState.updateMany({ where: { ...where, id: request.id }, data: { consumedAt: now } });
    if (!count) return invalid;
    if (typeof code !== 'string' || !/^[!-~]{1,2048}$/.test(code)) return { status: 'denied', workspaceId };

    try {
      const app = await readPlatformApp(this.prisma, workspaceId, 'bilibili');
      const clientId = app?.appId ?? (config.bilibili.enabled ? config.bilibili.clientId : undefined);
      const clientSecret = app?.appSecret ?? config.bilibili.clientSecret;
      if (clientId !== request.appId || !clientSecret) return { status: 'failed', workspaceId };
      const response = await fetch('https://api.bilibili.com/x/account-oauth2/v1/token', {
        method: 'POST',
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code }),
        signal: AbortSignal.timeout(12_000),
        redirect: 'error',
      });
      if (!response.ok) return { status: 'failed', workspaceId };
      const grant = oauthToken.safeParse(await response.json());
      if (!grant.success) return { status: 'failed', workspaceId };
      const identity = await new BilibiliAdapter({ clientId, clientSecret }).authorizedAccount(grant.data.data.access_token);
      const payload: z.infer<typeof pendingGrant> = {
        accessToken: grant.data.data.access_token,
        expiresAt: new Date(Date.now() + grant.data.data.expires_in * 1000).toISOString(),
        ...identity, appId: clientId, appRevision: revision(app, clientSecret), managed: Boolean(app),
      };
      const { count: saved } = await this.prisma.oAuthState.updateMany({
        where: { id: request.id, userId, workspaceId, expiresAt: { gt: new Date() } },
        data: { pendingGrantCiphertext: encryptPlatformSecret(['bilibili-pending', workspaceId, userId, request.id], JSON.stringify(payload)) },
      });
      return { status: saved ? 'pending' : 'expired', workspaceId };
    } catch {
      return { status: 'failed', workspaceId };
    }
  }

  private decode(workspaceId: string, userId: string, record: { id: string; pendingGrantCiphertext: string | null }) {
    try {
      return pendingGrant.parse(JSON.parse(decryptPlatformSecret(
        ['bilibili-pending', workspaceId, userId, record.id], record.pendingGrantCiphertext!,
      )));
    } catch { throw new ConflictException('待确认授权无法读取，请取消后重新授权'); }
  }

  async pending(workspaceId: string, userId: string) {
    const now = new Date();
    await this.prisma.oAuthState.updateMany({
      where: { workspaceId, userId, platform: 'bilibili', expiresAt: { lte: now }, pendingGrantCiphertext: { not: null } },
      data: { pendingGrantCiphertext: null },
    });
    const records = await this.prisma.oAuthState.findMany({
      where: { workspaceId, userId, platform: 'bilibili', pendingGrantCiphertext: { not: null }, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' }, take: 20,
    });
    const items = await Promise.all(records.map(async (record) => {
      let grant: z.infer<typeof pendingGrant>;
      try {
        grant = this.decode(workspaceId, userId, record);
      } catch {
        // 单条授权损坏时只清理它，不能让整个待确认列表不可用。
        await this.prisma.oAuthState.updateMany({ where: { id: record.id, workspaceId, userId,
          pendingGrantCiphertext: record.pendingGrantCiphertext }, data: { pendingGrantCiphertext: null } });
        return null;
      }
      if (new Date(grant.expiresAt) <= now) {
        await this.prisma.oAuthState.updateMany({ where: { id: record.id, workspaceId, userId,
          pendingGrantCiphertext: record.pendingGrantCiphertext }, data: { pendingGrantCiphertext: null } });
        return null;
      }
      const existing = await this.prisma.channelAccount.findFirst({
        where: { workspaceId, platform: 'bilibili', externalId: grant.openid }, select: { id: true, archivedAt: true },
      });
      // 仅同一 openid 的原档案可直接续期；UID、昵称和用户选择不构成映射证据。
      return { id: record.id, accountId: record.accountId, openid: grant.openid, name: grant.name, scopes: grant.scopes,
        expiresAt: grant.expiresAt, confirmBefore: record.expiresAt, existingAccountId: existing?.id ?? null,
        requiresSeparate: Boolean(record.accountId && existing?.id !== record.accountId), archived: Boolean(existing?.archivedAt) };
    }));
    return items.filter((item) => item !== null);
  }

  async confirm(workspaceId: string, userId: string, id: string, saveSeparately: boolean) {
    if (config.sandboxChannel) throw new ConflictException('沙箱模式不能保存真实授权');
    const record = await this.prisma.oAuthState.findFirst({
      where: { id, workspaceId, userId, platform: 'bilibili', pendingGrantCiphertext: { not: null },
        consumedAt: { not: null }, expiresAt: { gt: new Date() }, workspace: { trialOwnerId: null } },
    });
    if (!record?.pendingGrantCiphertext) throw new ConflictException('待确认授权已过期、取消或已保存');
    const grant = this.decode(workspaceId, userId, record);
    const app = await readPlatformApp(this.prisma, workspaceId, 'bilibili');
    const appId = app?.appId ?? (config.bilibili.enabled ? config.bilibili.clientId : undefined);
    const secret = app?.appSecret ?? config.bilibili.clientSecret;
    if (!secret || appId !== grant.appId || Boolean(app) !== grant.managed || revision(app, secret) !== grant.appRevision) {
      throw new ConflictException('应用配置已变化，请取消后重新授权');
    }
    const accountId = await bindBilibiliAccount(this.prisma, workspaceId, userId,
      { accessToken: grant.accessToken, expiresAt: new Date(grant.expiresAt) }, app,
      { accountId: saveSeparately ? undefined : record.accountId ?? undefined, expectedOpenid: grant.openid,
        pending: { id: record.id, ciphertext: record.pendingGrantCiphertext } });
    return { id: accountId };
  }

  async discard(workspaceId: string, userId: string, id: string) {
    const { count } = await this.prisma.oAuthState.updateMany({
      where: { id, workspaceId, userId, platform: 'bilibili', pendingGrantCiphertext: { not: null } },
      data: { pendingGrantCiphertext: null },
    });
    if (!count) throw new NotFoundException('待确认授权不存在');
    return { ok: true };
  }

  async disable(workspaceId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ChannelAccount" WHERE id = ${id} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
      const account = await tx.channelAccount.findFirst({ where: { id, workspaceId, platform: 'bilibili', channelKind: 'official', archivedAt: null } });
      if (!account) throw new NotFoundException('官方账号不存在');
      if (await tx.publishTask.findFirst({ where: { accountId: id, status: 'dispatching' }, select: { id: true } })) {
        throw new ConflictException('账号正在投稿，请等待本次提交结束再停用授权');
      }
      await tx.channelAccount.update({ where: { id }, data: { credentials: Prisma.DbNull,
        credentialsCiphertext: null, credentialsKeyId: null, credentialsUpdatedAt: new Date(), authStatus: 'revoked',
        authScope: [], authExpiresAt: null } });
      return { ok: true };
    });
  }
}

@Controller('channels/bilibili/oauth')
export class BilibiliOAuthController {
  constructor(private readonly oauth: BilibiliOAuthService) {}

  @Get('callback')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Redirect('/', 303)
  async callback(@CurrentUser() user: SessionUser, @Query('state') state: unknown, @Query('code') code: unknown) {
    const { status, workspaceId } = await this.oauth.finish(user.id, state, code);
    const query = new URLSearchParams({ bilibiliAuthorization: status });
    if (workspaceId) query.set('workspace', workspaceId);
    return { url: '/?' + query.toString() };
  }
}
