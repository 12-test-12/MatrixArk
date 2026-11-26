import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

test('CI 根据改动路径选择检查，并保留手动选择', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'matrixark-ci-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = resolve('infra/ci/select-targets.mjs');
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'CI fixture');
  git('config', 'user.email', 'ci@example.test');
  git('commit', '--quiet', '--allow-empty', '-m', 'baseline');
  const base = git('rev-parse', 'HEAD');
  function select(file, event = 'push', manual = {}) {
    if (file) {
      mkdirSync(dirname(join(directory, file)), { recursive: true });
      writeFileSync(join(directory, file), 'fixture');
      git('add', '--', file);
      git('commit', '--quiet', '-m', file);
    }
    return Object.fromEntries(execFileSync(process.execPath, [script], {
      cwd: directory,
      env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: '',
        CHANGED_BASE: file ? `${git('rev-parse', 'HEAD')}~1` : base, CHANGED_HEAD: git('rev-parse', 'HEAD'),
        RUN_DATABASE: 'false', RUN_API: 'false', PACKAGE_DOCKER: 'false', ...manual },
      encoding: 'utf8',
    }).trim().split('\n').map(line => line.trim().split('=')));
  }
  for (const directory of ['tasks', 'content', 'accounts', 'auth', 'workspaces', 'notifications', 'common', 'worker']) {
    assert.deepEqual(select(`apps/api/src/${directory}/fixture.ts`), {
      database: 'true', api: 'true', package_image: 'false',
    });
  }
  assert.deepEqual(select('docs/plan.md'), { database: 'false', api: 'false', package_image: 'false' });
  assert.deepEqual(select('apps/web/app/page.tsx'), { database: 'false', api: 'true', package_image: 'false' });
  assert.deepEqual(select(null, 'workflow_dispatch', { RUN_DATABASE: 'true', PACKAGE_DOCKER: 'true' }), {
    database: 'true', api: 'false', package_image: 'true',
  });
});
