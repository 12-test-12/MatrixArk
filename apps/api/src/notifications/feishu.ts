import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config';

const keyId = 'notification-v1';
const localKeyId = 'notification-local-v1';
export const feishuWebhook = /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[\w-]{1,200}$/u;

type SecretField = 'webhook' | 'signSecret';

function localKey(create = false): Buffer {
  const directory = config.storage.localDir;
  const path = join(directory, '.notification-key');
  if (create) {
    try {
      return localKey();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, `.notification-key-${randomBytes(12).toString('hex')}`);
    writeFileSync(temporary, randomBytes(32), { mode: 0o600, flag: 'wx' });
    try {
      // Publish the complete key atomically so the API and Worker never use different keys.
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      unlinkSync(temporary);
    }
  }
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error('飞书凭据密钥文件无效');
  return key;
}

export function encryptFeishu(workspaceId: string, field: SecretField, value: string) {
  const key = config.notificationKey ? Buffer.from(config.notificationKey, 'hex') : localKey(true);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify([workspaceId, field])));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { keyId: config.notificationKey ? keyId : localKeyId,
    ciphertext: [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.') };
}

export function decryptFeishu(workspaceId: string, field: SecretField, ciphertext: string, storedKeyId: string | null) {
  const key = storedKeyId === localKeyId ? localKey()
    : storedKeyId === keyId && config.notificationKey ? Buffer.from(config.notificationKey, 'hex') : null;
  if (!key) throw new Error('无法读取飞书凭据');
  const [nonce, tag, data, extra] = ciphertext.split('.');
  if (!nonce || !tag || !data || extra !== undefined) throw new Error('飞书凭据格式无效');
  const iv = Buffer.from(nonce, 'base64url');
  const authTag = Buffer.from(tag, 'base64url');
  if (iv.length !== 12 || authTag.length !== 16) throw new Error('飞书凭据格式无效');
  const cipher = createDecipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify([workspaceId, field])));
  cipher.setAuthTag(authTag);
  return Buffer.concat([cipher.update(Buffer.from(data, 'base64url')), cipher.final()]).toString('utf8');
}

export type DeliveryResult = { status: 'sent' } | { status: 'failed' | 'retry' | 'skipped'; reason: string };

export async function sendFeishu(webhook: string, secret: string | undefined, text: string): Promise<DeliveryResult> {
  if (!feishuWebhook.test(webhook)) return { status: 'failed', reason: '飞书机器人地址无效' };
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signed = secret ? { timestamp, sign: createHmac('sha256', `${timestamp}\n${secret}`).digest('base64') } : {};
  try {
    const response = await fetch(webhook, {
      method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
      body: JSON.stringify({ ...signed, msg_type: 'text', content: { text } }), signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 429) return { status: 'retry', reason: '飞书机器人限流' };
    if (response.status >= 500) return { status: 'failed', reason: '飞书投递结果未知' };
    if (!response.ok) return { status: 'failed', reason: `飞书拒绝投递（HTTP ${response.status}）` };
    const payload = await response.json() as { code?: unknown; StatusCode?: unknown } | null;
    const code = payload?.code ?? payload?.StatusCode;
    if (code === 0) return { status: 'sent' };
    if (code === 11232) return { status: 'retry', reason: '飞书机器人限流' };
    if (typeof code === 'number' && Number.isInteger(code)) {
      return { status: 'failed', reason: `飞书拒绝投递（${code}）` };
    }
  } catch {
    // A timeout or invalid response leaves open the possibility Feishu already accepted the message.
  }
  return { status: 'failed', reason: '飞书投递结果未知' };
}
