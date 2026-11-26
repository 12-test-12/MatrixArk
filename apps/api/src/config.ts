import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../../..');
const rootEnv = join(repoRoot, '.env');

if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

function boolean(value: string | undefined, name: string): boolean {
  const normalized = value?.trim().toLowerCase() ?? 'false';
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} 必须为 true 或 false`);
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const storageDir = process.env.STORAGE_LOCAL_DIR ?? './storage';
const storageDriver = process.env.STORAGE_DRIVER ?? 'local';
const sandboxChannel = boolean(process.env.SANDBOX_CHANNEL, 'SANDBOX_CHANNEL');
const apiHost = process.env.API_HOST ?? '127.0.0.1';
const bilibili = {
  enabled: boolean(process.env.BILIBILI_OFFICIAL_ENABLED, 'BILIBILI_OFFICIAL_ENABLED'),
  clientId: process.env.BILIBILI_CLIENT_ID?.trim(),
  clientSecret: process.env.BILIBILI_CLIENT_SECRET?.trim(),
  credentialsKey: process.env.BILIBILI_CREDENTIALS_KEY?.trim(),
};
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? '';
const databaseUrl = process.env.DATABASE_URL?.trim();
const notificationKey = process.env.NOTIFICATION_CREDENTIALS_KEY?.trim();

if (!databaseUrl) throw new Error('请在 .env 或进程环境中设置 DATABASE_URL');
const database = URL.canParse(databaseUrl) ? new URL(databaseUrl) : undefined;
if (!database || !['postgresql:', 'postgres:'].includes(database.protocol) || !database.hostname || database.pathname.length < 2) {
  throw new Error('DATABASE_URL 必须是包含主机和库名的 PostgreSQL 连接地址');
}
if (storageDriver !== 'local') throw new Error('STORAGE_DRIVER 当前只支持 local');
if (notificationKey && !/^[\da-f]{64}$/i.test(notificationKey)) {
  throw new Error('NOTIFICATION_CREDENTIALS_KEY 必须为 64 位十六进制字符');
}
if (bilibili.enabled && (sandboxChannel || !bilibili.clientId || !bilibili.clientSecret
  || !bilibili.credentialsKey || !/^[\da-f]{64}$/i.test(bilibili.credentialsKey))) {
  throw new Error('启用 B 站官方投稿须关闭沙箱，并配置 BILIBILI_CLIENT_ID、BILIBILI_CLIENT_SECRET 和 64 位十六进制 BILIBILI_CREDENTIALS_KEY');
}
if (process.env.NODE_ENV === 'production') {
  if (sandboxChannel) throw new Error('生产环境要求 SANDBOX_CHANNEL=false');
  if (!publicBaseUrl.startsWith('https://')) throw new Error('生产环境的 PUBLIC_BASE_URL 必须使用 HTTPS');
}

export const config = {
  databaseUrl,
  host: apiHost,
  trialAvailable: process.env.NODE_ENV !== 'production' && ['127.0.0.1', 'localhost', '::1'].includes(apiHost),
  port: int(process.env.API_PORT, 4000),
  apiOrigin: process.env.API_ORIGIN ?? 'http://localhost:3000',
  sessionTtlDays: int(process.env.SESSION_TTL_DAYS, 30),
  sandboxChannel,
  bilibili,
  notificationKey,
  xiaohongshu: {
    appId: process.env.XIAOHONGSHU_APP_ID?.trim(),
    appSecret: process.env.XIAOHONGSHU_APP_SECRET?.trim(),
  },
  storage: {
    localDir: isAbsolute(storageDir) ? storageDir : join(repoRoot, storageDir),
  },
  publicBaseUrl,
} as const;
