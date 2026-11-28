import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = join(here, '..');

if (process.argv[2] === 'migrate' && !process.env.DATABASE_URL) {
  console.error('缺少 DATABASE_URL：请在进程环境中提供，或复制 .env.example 为 .env 后使用 pnpm db:migrate');
  process.exit(1);
}

const args = [...process.argv.slice(2), '--schema', 'prisma/schema.prisma'];
const prismaPackage = createRequire(import.meta.url).resolve('prisma/package.json');
const prisma = join(dirname(prismaPackage), 'build/index.js');
const result = spawnSync(process.execPath, [prisma, ...args], {
  stdio: 'inherit',
  cwd: apiDir,
  env: process.env,
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
