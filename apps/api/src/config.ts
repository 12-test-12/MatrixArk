import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../../..');
const rootEnv = join(repoRoot, '.env');

if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

function sandboxEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? 'false';
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error('SANDBOX_CHANNEL 必须为 true 或 false');
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const storageDir = process.env.STORAGE_LOCAL_DIR ?? './storage';
const storageDriver = process.env.STORAGE_DRIVER ?? 'local';
const sandboxChannel = sandboxEnabled(process.env.SANDBOX_CHANNEL);
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? '';
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) throw new Error('请在 .env 或进程环境中设置 DATABASE_URL');
const database = URL.canParse(databaseUrl) ? new URL(databaseUrl) : undefined;
if (!database || !['postgresql:', 'postgres:'].includes(database.protocol) || !database.hostname || database.pathname.length < 2) {
  throw new Error('DATABASE_URL 必须是包含主机和库名的 PostgreSQL 连接地址');
}
if (storageDriver !== 'local') throw new Error('STORAGE_DRIVER 当前只支持 local');
if (process.env.NODE_ENV === 'production') {
  if (sandboxChannel) throw new Error('生产环境要求 SANDBOX_CHANNEL=false');
  if (!publicBaseUrl.startsWith('https://')) throw new Error('生产环境的 PUBLIC_BASE_URL 必须使用 HTTPS');
}

export const config = {
  databaseUrl,
  host: process.env.API_HOST ?? '127.0.0.1',
  port: int(process.env.API_PORT, 4000),
  apiOrigin: process.env.API_ORIGIN ?? 'http://localhost:3000',
  sessionTtlDays: int(process.env.SESSION_TTL_DAYS, 30),
  xiaohongshu: {
    appId: process.env.XIAOHONGSHU_APP_ID?.trim(),
    appSecret: process.env.XIAOHONGSHU_APP_SECRET?.trim(),
  },
  storage: {
    localDir: isAbsolute(storageDir) ? storageDir : join(repoRoot, storageDir),
  },
  publicBaseUrl,
} as const;
