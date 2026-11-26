import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

process.env.DATABASE_URL ??= 'postgresql://fixture@127.0.0.1/matrixark_worker_test';
process.env.SANDBOX_CHANNEL ??= 'false';

const { runBounded } = await import('../dist/worker/concurrency.js');
const { WorkerModule } = await import('../dist/worker/worker.module.js');

test('runBounded 严格限制最大并发数并保持结果顺序', async () => {
  let active = 0;
  let maxActive = 0;
  const results = await runBounded([10, 20, 30, 40, 50], 2, async (item, index) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await delay(15);
    active--;
    return `${index}:${item}`;
  });
  assert.equal(maxActive, 2);
  assert.deepEqual(results, ['0:10', '1:20', '2:30', '3:40', '4:50']);
  assert.deepEqual(await runBounded([], 4, async () => 1), []);
});

test('WorkerModule 模块图中不包含任何 HTTP Controller', () => {
  const visited = new Set();
  const controllers = [];
  function walk(mod) {
    if (!mod || typeof mod !== 'function' || visited.has(mod)) return;
    visited.add(mod);
    const modControllers = Reflect.getMetadata('controllers', mod) ?? [];
    for (const ctrl of modControllers) controllers.push(ctrl.name);
    const imports = Reflect.getMetadata('imports', mod) ?? [];
    for (const imp of imports) walk(imp?.module ?? imp);
  }
  walk(WorkerModule);
  assert.deepEqual(controllers, []);
  assert.ok(visited.size >= 6);
});
