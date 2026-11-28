import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  askConfirm, pendingConfirms, removeConfirm, resolveConfirm, subscribeConfirms,
} from './confirm-queue.ts';

const options = { title: '归档原稿？', description: '归档后不再参与派发。' };

test('确认队列按先来先服务逐个结算', async () => {
  const before = pendingConfirms().length;
  const first = askConfirm(options);
  const second = askConfirm(options);
  const [head, next] = pendingConfirms().slice(before);
  assert.ok(head && next);
  assert.notEqual(head.id, next.id);
  assert.equal(pendingConfirms().indexOf(head), before);

  resolveConfirm(head.id, true);
  assert.equal(await first, true);
  assert.equal(pendingConfirms().includes(head), true, '等待退场动画期间仍保留在队列里');

  removeConfirm(head.id);
  assert.equal(pendingConfirms().includes(head), false);
  assert.equal(pendingConfirms().indexOf(next), before);

  resolveConfirm(next.id, false);
  assert.equal(await second, false);
  removeConfirm(next.id);
});

test('已结算的确认重复回执不会改变结果', async () => {
  const before = pendingConfirms().length;
  const pending = askConfirm(options);
  const item = pendingConfirms()[before]!;

  resolveConfirm(item.id, true);
  resolveConfirm(item.id, false);
  removeConfirm(item.id);
  resolveConfirm(item.id, false);

  assert.equal(await pending, true);
  assert.equal(pendingConfirms().length, before);
});

test('迟到的关闭事件不会结算或移除下一个弹窗', async () => {
  const before = pendingConfirms().length;
  const first = askConfirm(options);
  const second = askConfirm(options);
  const [head, next] = pendingConfirms().slice(before);
  assert.ok(head && next);

  resolveConfirm(head.id, true);
  removeConfirm(head.id);

  // 旧弹窗的 close 事件在新弹窗挂载之后才到，必须被完全忽略。
  resolveConfirm(head.id, false);
  removeConfirm(head.id);

  assert.equal(pendingConfirms().indexOf(next), before);
  assert.equal(await first, true);
  const state = await Promise.race([
    second.then(() => 'settled'),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 20)),
  ]);
  assert.equal(state, 'pending');
  assert.equal(pendingConfirms().includes(next), true);

  resolveConfirm(next.id, true);
  removeConfirm(next.id);
  assert.equal(await second, true);
});

test('订阅者会收到当前队列与每次变更', async () => {
  const seen: number[][] = [];
  const before = pendingConfirms().length;
  const unsubscribe = subscribeConfirms((queue) => seen.push(queue.map((item) => item.id)));

  const pending = askConfirm(options);
  const item = pendingConfirms()[before]!;
  assert.equal(seen.at(-1)?.includes(item.id), true);

  resolveConfirm(item.id, true);
  removeConfirm(item.id);
  assert.equal(seen.at(-1)?.includes(item.id), false);
  assert.equal(await pending, true);

  unsubscribe();
});
