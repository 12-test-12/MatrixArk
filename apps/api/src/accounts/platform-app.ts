import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import type { Platform, Prisma } from '@prisma/client';
import { localKey } from '../common/local-key';
import { config } from '../config';

export const platformKeyId = 'platform-local-v1';

export function encryptPlatformSecret(binding: string[], value: string) {
  const key = localKey(config.storage.localDir, '.platform-key', true);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(binding)));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [nonce, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.');
}

export function decryptPlatformSecret(binding: string[], ciphertext: string) {
  const [nonce, tag, data, extra] = ciphertext.split('.');
  if (!nonce || !tag || !data || extra !== undefined) throw new Error('平台凭据格式无效');
  const iv = Buffer.from(nonce, 'base64url');
  const authTag = Buffer.from(tag, 'base64url');
  if (iv.length !== 12 || authTag.length !== 16) throw new Error('平台凭据格式无效');
  const key = localKey(config.storage.localDir, '.platform-key');
  const cipher = createDecipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(binding)));
  cipher.setAuthTag(authTag);
  return Buffer.concat([cipher.update(Buffer.from(data, 'base64url')), cipher.final()]).toString('utf8');
}

export function workspacePlatformApp(db: Prisma.TransactionClient, workspaceId: string, platform: Platform) {
  return db.platformAppSetting.findUnique({
    where: { workspaceId_platform: { workspaceId, platform } },
    select: { appId: true, secretCiphertext: true },
  });
}

export async function readPlatformApp(db: Prisma.TransactionClient, workspaceId: string, platform: Platform) {
  const setting = await workspacePlatformApp(db, workspaceId, platform);
  if (!setting) return undefined;
  try {
    return { appId: setting.appId,
      appSecret: decryptPlatformSecret(['app', workspaceId, platform, setting.appId], setting.secretCiphertext),
      revision: setting.secretCiphertext };
  } catch {
    throw new ServiceUnavailableException('平台凭据暂时无法读取，请联系管理员检查服务端存储或重新保存应用凭据。');
  }
}
