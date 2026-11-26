import { randomUUID } from 'node:crypto';
import { BadGatewayException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { readPlatformApp, workspacePlatformApp } from './platform-app';

const origin = 'https://openaccount.xiaohongshu.com';
const envelope = z.object({ code: z.number().int(), success: z.boolean(), data: z.unknown() });
const device = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri_complete: z.string().url().refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return url.origin === origin && url.pathname === '/device' && !url.username && !url.password
      && !url.searchParams.has('device_code');
  }),
  expires_in: z.number().int().positive().max(600),
  interval: z.number().int().positive().max(600),
});
const token = z.object({
  access_token: z.string().min(1),
  open_id: z.string().min(1).max(256),
  scope: z.array(z.string()).refine((scopes) => scopes.includes('basic_info')),
});
const profile = z.object({ open_id: z.string().min(1).max(256), nickname: z.string().trim().min(1).max(200) });

function verifiedData<T>(result: z.infer<typeof envelope>, schema: z.ZodType<T>) {
  const value = schema.safeParse(result.data);
  if (result.code !== 0 || !result.success || !value.success) {
    throw new BadGatewayException('小红书未返回有效的授权信息，请重新发起授权。');
  }
  return value.data;
}

async function request(endpoint: string, body: object, accessToken?: string) {
  try {
    const response = await fetch(origin + '/api/sns/v1/oauth2/' + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(accessToken && { authorization: `Bearer ${accessToken}` }) },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    const result = envelope.parse(await response.json());
    if (!response.ok && result.code === 0) throw new Error();
    return result;
  } catch {
    throw new BadGatewayException('暂时无法连接小红书授权服务，请稍后重试。');
  }
}

type Authorization = {
  appId: string;
  id: string; code: string; verificationUrl: string; userCode: string; expiresAt: number; interval: number;
  nextPollAt: number; busy: boolean; status: 'pending' | 'scanned' | 'expired' | 'denied' | 'connected';
  grant?: z.infer<typeof token>;
};

@Injectable()
export class XiaohongshuIdentityService {
  // shortcut: pending device codes live in one API process; a restart requires a new scan.
  private readonly pending = new Map<string, Authorization>();
  private readonly starting = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  async start(workspaceId: string, userId: string) {
    const key = JSON.stringify([workspaceId, userId]);
    if (this.starting.has(key) || this.pending.get(key)?.busy) throw new ConflictException('正在处理授权，请稍后重试。');
    this.starting.add(key);
    try {
      const { appId, appSecret } = await readPlatformApp(this.prisma, workspaceId, 'xiaohongshu') ?? config.xiaohongshu;
      if (!appId || !appSecret) throw new ConflictException('请先在发布账号页保存小红书开放平台应用 ID 和密钥。');
      const app = { app_id: appId, app_secret: appSecret };
      const response = await request('device/code', {
        ...app, scopes: ['basic_info'], scene: 'web', client_name: 'MatrixArk',
      });
      if (response.code === 37007) throw new ConflictException('小红书开放平台应用尚未开通 Web 扫码授权。');
      const result = verifiedData(response, device);
      const now = Date.now();
      const entry: Authorization = {
        appId,
        id: randomUUID(),
        code: result.device_code,
        verificationUrl: result.verification_uri_complete,
        userCode: result.user_code,
        expiresAt: now + result.expires_in * 1000,
        interval: result.interval * 1000,
        nextPollAt: now + result.interval * 1000,
        busy: false,
        status: 'pending',
      };
      this.pending.set(key, entry);
      setTimeout(() => {
        if (this.pending.get(key) === entry) this.pending.delete(key);
      }, result.expires_in * 1000).unref();
      return { id: entry.id, verificationUrl: entry.verificationUrl, userCode: entry.userCode, expiresAt: entry.expiresAt };
    } finally {
      this.starting.delete(key);
    }
  }

  async poll(workspaceId: string, userId: string, id: string) {
    const key = JSON.stringify([workspaceId, userId]);
    const entry = this.pending.get(key);
    if (!entry || entry.id !== id) throw new NotFoundException('授权请求不存在，请重新发起授权。');
    if (entry.expiresAt <= Date.now()) {
      this.pending.delete(key);
      return { status: 'expired' as const };
    }
    if (entry.status === 'connected' || entry.status === 'expired' || entry.status === 'denied' || entry.busy || entry.nextPollAt > Date.now()) {
      return { status: entry.status };
    }
    entry.busy = true;
    entry.nextPollAt = Date.now() + entry.interval;
    try {
      if (!entry.grant) {
        const { appId, appSecret } = await readPlatformApp(this.prisma, workspaceId, 'xiaohongshu') ?? config.xiaohongshu;
        if (appId !== entry.appId || !appSecret) {
          entry.status = 'expired';
          entry.code = '';
          return { status: entry.status };
        }
        const result = await request('device/token', { app_id: appId, app_secret: appSecret, device_code: entry.code });
        if (result.code === 37002 || result.code === 37009) {
          entry.status = result.code === 37009 ? 'scanned' : 'pending';
          return { status: entry.status };
        }
        if (result.code === 37003) {
          entry.interval += 5_000;
          return { status: entry.status };
        }
        if ([37000, 37001, 37004, 37005, 37006, 31002].includes(result.code)) {
          entry.status = result.code === 31002 ? 'denied' : 'expired';
          entry.code = '';
          return { status: entry.status };
        }
        entry.grant = verifiedData(result, token);
      }
      const identity = verifiedData(await request('batch_get_min_user_info', {}, entry.grant.access_token), profile);
      if (identity.open_id !== entry.grant.open_id) {
        this.pending.delete(key);
        throw new BadGatewayException('小红书返回的账号身份不一致，请重新授权。');
      }
      const saved = await this.saveIdentity(workspaceId, userId, entry.appId, identity);
      entry.grant = undefined;
      entry.code = '';
      entry.status = saved ? 'connected' : 'expired';
      return { status: entry.status };
    } finally {
      entry.busy = false;
      entry.nextPollAt = Date.now() + entry.interval;
    }
  }

  private async saveIdentity(workspaceId: string, userId: string, appId: string, identity: z.infer<typeof profile>) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
      const current = await workspacePlatformApp(tx, workspaceId, 'xiaohongshu');
      if ((current?.appId ?? config.xiaohongshu.appId) !== appId) return false;
      const scope = { workspaceId, platform: 'xiaohongshu' as const, archivedAt: null };
      const existing = await tx.channelAccount.findFirst({ where: { ...scope, externalId: identity.open_id } });
      const verified = { authCheckedAt: new Date(), authAuthorizedBy: userId, authScope: ['basic_info'], accessMethod: 'qr_login' as const };
      if (existing) {
        const identityOnly = existing.channelKind === 'official' && existing.authStatus === 'pending'
          && existing.authScope.length === 1 && existing.authScope[0] === 'basic_info'
          && !existing.credentials && !existing.credentialsCiphertext;
        await tx.channelAccount.update({ where: { id: existing.id }, data: {
          ...verified, ...(identityOnly && { channelKind: 'manual', authStatus: 'active' }),
        } });
        return true;
      }
      const names = new Set((await tx.channelAccount.findMany({ where: scope, select: { displayName: true } }))
        .map(({ displayName }) => displayName));
      const nickname = Array.from(identity.nickname).slice(0, 50).join('');
      let displayName = nickname;
      for (let suffix = 2; names.has(displayName); suffix++) displayName = `${nickname} (${suffix})`;
      await tx.channelAccount.create({
        data: { ...scope, ...verified, channelKind: 'manual', authStatus: 'active', displayName, externalId: identity.open_id },
      });
      return true;
    });
  }
}
