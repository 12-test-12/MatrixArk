import { createHash, randomBytes } from 'node:crypto';
import { ConflictException, Controller, Get, Header, Injectable, Query, Redirect } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators';
import type { SessionUser } from '../auth/session.service';
import { can } from '../common/permissions';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { bindBilibiliAccount } from './bilibili-account';
import { readPlatformApp } from './platform-app';

const callbackPath = '/api/channels/bilibili/oauth/callback';
const statePattern = /^[\w-]{43}$/;
const oauthToken = z.object({
  code: z.literal(0),
  data: z.object({ access_token: z.string().regex(/^[!-~]{1,4096}$/), expires_in: z.number().int().positive() }),
});
const hashState = (state: string) => createHash('sha256').update(state).digest('hex');

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

  async start(workspaceId: string, userId: string, origin?: string) {
    const callback = callbackUrl(origin);
    const app = await readPlatformApp(this.prisma, workspaceId, 'bilibili');
    const appId = app?.appId ?? (config.bilibili.enabled ? config.bilibili.clientId : undefined);
    if (!appId) throw new ConflictException('请先在发布账号页保存 B 站开放平台应用凭据。');
    const now = new Date();
    const binding = { workspaceId, userId, platform: 'bilibili' as const, accountId: null };
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
    status: 'expired' | 'denied' | 'failed' | 'connected'; workspaceId?: string;
  }> {
    const invalid = { status: 'expired' } as const;
    if (config.sandboxChannel || typeof state !== 'string' || !statePattern.test(state)) return invalid;
    const now = new Date();
    const where = { userId, stateHash: hashState(state), platform: 'bilibili' as const,
      accountId: null, consumedAt: null, expiresAt: { gt: now }, workspace: { trialOwnerId: null } };
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
      await bindBilibiliAccount(this.prisma, workspaceId, userId, {
        accessToken: grant.data.data.access_token, expiresAt: new Date(grant.data.data.expires_in * 1000),
      }, app);
      return { status: 'connected', workspaceId };
    } catch {
      return { status: 'failed', workspaceId };
    }
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
