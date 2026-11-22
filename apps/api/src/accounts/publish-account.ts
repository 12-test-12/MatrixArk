import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ChannelAccount, Prisma } from '@prisma/client';
import { config } from '../config';
import { decryptPlatformSecret, encryptPlatformSecret, platformKeyId, readPlatformApp } from './platform-app';

type AccountIdentity = Pick<ChannelAccount, 'workspaceId' | 'id' | 'externalId'>;
const biliKeyId = 'bilibili-v1';

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

export function publishChannel(account: ChannelAccount, now: Date) {
  if (!account.externalId || !account.authCheckedAt || account.archivedAt
    || (account.rateLimitedUntil && account.rateLimitedUntil > now)) return undefined;
  if (account.channelKind === 'manual') {
    return ['active', 'pending'].includes(account.authStatus) ? 'manual' : undefined;
  }
  if (account.platform !== 'bilibili' || account.authStatus !== 'active') return undefined;
  if (account.channelKind === 'sandbox') return config.sandboxChannel ? 'sandbox' : undefined;
  const enabled = account.credentialsKeyId === platformKeyId ? !config.sandboxChannel
    : config.bilibili.enabled && account.credentialsKeyId === biliKeyId;
  if (enabled && account.authExpiresAt && account.authExpiresAt > now
    && account.authScope.includes('ATC_BASE') && account.authScope.includes('ATC_DATA')
    && account.credentialsCiphertext) return 'official';
  return undefined;
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
