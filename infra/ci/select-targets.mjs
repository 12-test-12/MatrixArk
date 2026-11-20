import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const { GITHUB_EVENT_NAME, GITHUB_OUTPUT, CHANGED_BASE, CHANGED_HEAD } = process.env;
const manual = GITHUB_EVENT_NAME === 'workflow_dispatch';

function changedFiles() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).split('\0').filter(Boolean);
  if (!CHANGED_BASE || /^0+$/.test(CHANGED_BASE)) {
    return git('ls-tree', '-r', '--name-only', '-z', CHANGED_HEAD);
  }
  const comparison = GITHUB_EVENT_NAME === 'pull_request' ? '...' : '..';
  return git('diff', '--name-only', '-z', '--no-renames', `${CHANGED_BASE}${comparison}${CHANGED_HEAD}`, '--');
}

let database = process.env.RUN_DATABASE === 'true';
let api = process.env.RUN_API === 'true';
if (!manual) {
  try {
    const files = changedFiles().filter((path) => !path.endsWith('.md'));
    const common = files.some((path) => [
      'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/api/package.json',
      '.github/workflows/matrixark.yml', 'infra/ci/select-targets.mjs',
    ].includes(path));
    database = common || files.some((path) =>
      path.startsWith('apps/api/prisma/') || path.startsWith('apps/api/scripts/') || path === 'infra/ci/check-database.sh',
    );
    api = common || files.some((path) =>
      path.startsWith('apps/api/src/') || path.startsWith('packages/') || [
        'apps/api/scripts/prisma.mjs', 'apps/api/prisma/schema.prisma', 'apps/api/tsconfig.json',
        'apps/api/tsconfig.build.json', 'apps/api/nest-cli.json', 'tsconfig.base.json', '.env.example',
      ].includes(path),
    );
  } catch {
    console.warn('无法比较当前提交，执行 API 和数据库检查。');
    database = api = true;
  }
}

const packageImage = manual && process.env.PACKAGE_DOCKER === 'true';
const result = `database=${database}\napi=${api}\npackage_image=${packageImage}\n`;
if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, result);
process.stdout.write(result);
