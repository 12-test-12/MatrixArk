import { resolveAccountCapabilities } from './account-capabilities';
import { biliKeyId, bilibiliManualProfile } from './platforms/bilibili-account-policy';
export { bilibiliManualUidPrefix, bilibiliWebUidPrefix, extractBilibiliUid, isUnverifiedBilibiliAccount, bilibiliManualProfile } from './platforms/bilibili-account-policy';

import { BadRequestException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ChannelAccount, Platform, Prisma } from '@prisma/client';
import { config } from '../config';
import { decryptPlatformSecret, encryptPlatformSecret, platformKeyId, readPlatformApp } from './platform-app';

const xhsHexIdPattern = /^[0-9a-f]{24}$/i;
const xhsProfilePathPattern = /^\/user\/profile\/([a-zA-Z0-9_-]{8,64})\/?$/;

/** Validate optional Bilibili UID/space URL or Xiaohongshu profile URL/ID consistently across onboarding and editing. */
export function parseProfileInput(platform: Platform, raw?: string | null): {
  uid: string | null;
  profileUrl: string | null | undefined;
} {
  if (raw === undefined) return { uid: null, profileUrl: undefined };
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) return { uid: null, profileUrl: null };
  if (platform === 'bilibili') {
    const uid = /^[1-9][0-9]{0,19}$/.test(trimmed)
      ? trimmed
      : /^https:\/\/space\.bilibili\.com\/([1-9][0-9]{0,19})\/?(?:[?#]\S*)?$/i.exec(trimmed)?.[1];
    if (!uid) {
      throw new BadRequestException('B 站主页或 UID 格式不正确，请填写数字 UID 或 space.bilibili.com 链接');
    }
    return { uid, profileUrl: `https://space.bilibili.com/${uid}` };
  }
  if (xhsHexIdPattern.test(trimmed)) {
    return { uid: null, profileUrl: `https://www.xiaohongshu.com/user/profile/${trimmed}` };
  }
  if (URL.canParse(trimmed)) {
    const url = new URL(trimmed);
    const match = xhsProfilePathPattern.exec(url.pathname);
    if (url.origin === 'https://www.xiaohongshu.com' && !url.username && !url.password && match) {
      return { uid: null, profileUrl: `${url.origin}/user/profile/${match[1]}${url.search}` };
    }
  }
  throw new BadRequestException('小红书主页链接格式不正确，请填写 https://www.xiaohongshu.com/user/profile/... 链接或 24 位用户 ID');
}

export function resolveAccountProfileUrl(
  account: Pick<ChannelAccount, 'platform' | 'channelKind' | 'externalId' | 'profileUrl'>,
) {
  return account.profileUrl ?? bilibiliManualProfile(account);
}

type AccountIdentity = Pick<ChannelAccount, 'workspaceId' | 'id' | 'externalId'>;

function binding(account: AccountIdentity) {
  return Buffer.from(JSON.stringify([account.workspaceId, account.id, account.externalId]));
}

export function encryptBilibiliCredentials(account: AccountIdentity, accessToken: string, managed = false) {
  if (managed) {
    return {
      credentialsCiphertext: encryptPlatformSecret(['bilibili-account', account.workspaceId, account.id, account.externalId!], accessToken),
      credentialsKeyId: platformKeyId,
    };
  }
  const key = config.bilibili.credentialsKey;
  if (!key || !/^[\da-f]{64}$/i.test(key) || !/^[!-~]{1,4096}$/.test(accessToken)) {
    throw new Error('B 站令牌或加密密钥格式无效');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  cipher.setAAD(binding(account));
  const data = Buffer.concat([cipher.update(JSON.stringify({ access_token: accessToken }), 'utf8'), cipher.final()]);
  return {
    credentialsCiphertext: [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.'),
    credentialsKeyId: biliKeyId,
  };
}

export function bilibiliCredentials(account: ChannelAccount) {
  const key = config.bilibili.credentialsKey;
  const ciphertext = account.credentialsCiphertext;
  if (!ciphertext) return undefined;
  try {
    if (account.credentialsKeyId === platformKeyId && account.externalId) {
      const access_token = decryptPlatformSecret(['bilibili-account', account.workspaceId, account.id, account.externalId], ciphertext);
      return /^[!-~]{1,4096}$/.test(access_token) ? { access_token } : undefined;
    }
    if (!key || account.credentialsKeyId !== biliKeyId) return undefined;
    const [nonce, tag, data, extra] = ciphertext.split('.');
    if (!nonce || !tag || !data || extra !== undefined) return undefined;
    const iv = Buffer.from(nonce, 'base64url');
    const authTag = Buffer.from(tag, 'base64url');
    if (iv.length !== 12 || authTag.length !== 16) return undefined;
    const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
    cipher.setAAD(binding(account));
    cipher.setAuthTag(authTag);
    const { access_token } = JSON.parse(Buffer.concat([cipher.update(Buffer.from(data, 'base64url')), cipher.final()]).toString('utf8'));
    return typeof access_token === 'string' && /^[!-~]{1,4096}$/.test(access_token) ? { access_token } : undefined;
  } catch {
    return undefined;
  }
}

export async function bilibiliAppOptions(db: Prisma.TransactionClient, account: ChannelAccount) {
  if (account.credentialsKeyId !== platformKeyId) return config.bilibili;
  const app = await readPlatformApp(db, account.workspaceId, 'bilibili');
  return app ? { clientId: app.appId, clientSecret: app.appSecret } : undefined;
}

export function publishChannel(account: ChannelAccount, now: Date, trial = false) {
  return resolveAccountCapabilities(account, now, trial).channel;
}
