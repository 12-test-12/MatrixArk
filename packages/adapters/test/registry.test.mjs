import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, BilibiliAdapter, ChannelNotConfiguredError, createDefaultAdapterRegistry, resolveAdapter } from '../dist/index.js';

test('默认注册覆盖人工、沙箱和 B 站官方通道，保持试用沙箱行为', async () => {
  const registry = createDefaultAdapterRegistry();
  for (const platform of ['bilibili', 'xiaohongshu']) {
    assert.equal(registry.resolve(platform, 'manual').kind, 'manual');
    assert.equal(registry.resolve(platform, 'sandbox').kind, 'sandbox');
    assert.equal(resolveAdapter(platform, 'manual', { forceSandbox: true }).kind, 'manual');
  }
  assert.ok(registry.resolve('bilibili', 'official') instanceof BilibiliAdapter);
  assert.equal(registry.resolve('xiaohongshu', 'official', { forceSandbox: true }).kind, 'sandbox');
  assert.throws(() => registry.resolve('xiaohongshu', 'official'), ChannelNotConfiguredError);
  const receipt = await registry.resolve('bilibili', 'sandbox', { trial: true }).publish({
    variant: {}, account: {}, slot: { idempotencyKey: 'any-key' },
  });
  assert.equal(receipt.status, 'submitted');
});

test('新通道可通过工厂注册，重复注册失败时保留原注册内容', () => {
  const registry = new AdapterRegistry();
  let received;
  const adapter = { kind: 'manual', platforms: ['xiaohongshu'],
    preflight: async () => {}, publish: async () => ({ status: 'handed_off' }), fetchStatus: async value => value };
  const policy = { supportsVideo: true, requiresImageFiles: false, validate() {} };
  registry.register({ kind: 'manual', platforms: ['xiaohongshu'], contentPolicy: policy,
    supportsMetrics: false, create(options) { received = options; return adapter; } });
  assert.equal(registry.resolve('xiaohongshu', 'manual', { trial: true }), adapter);
  assert.deepEqual(received, { trial: true });
  assert.throws(() => registry.register({ kind: 'manual', platforms: ['bilibili', 'xiaohongshu'],
    contentPolicy: policy, supportsMetrics: false, create: () => adapter }));
  assert.equal(registry.has('bilibili', 'manual'), false);
  assert.equal(registry.resolve('xiaohongshu', 'manual'), adapter);
});

test('声明的发布平台、通道或成效能力与工厂结果不符时拒绝解析', () => {
  const policy = { supportsVideo: true, requiresImageFiles: false, validate() {} };
  for (const adapter of [
    { kind: 'official', platforms: ['bilibili'] },
    { kind: 'manual', platforms: ['xiaohongshu'] },
    { kind: 'manual', platforms: ['bilibili'], fetchMetrics() {} },
  ]) {
    const registry = new AdapterRegistry([{ kind: 'manual', platforms: ['bilibili'], contentPolicy: policy,
      supportsMetrics: false, create: () => adapter }]);
    assert.throws(() => registry.resolve('bilibili', 'manual'), ChannelNotConfiguredError);
  }
});

test('官方内容策略在排期与适配器预检中使用相同限制，人工通道保留自身规则', async () => {
  const registry = createDefaultAdapterRegistry();
  const policy = registry.registration('bilibili', 'official').contentPolicy;
  const variant = { title: '标题', body: '正文'.repeat(110), tags: [], imageCount: 0,
    platformFields: { category: 100, summary: '摘要'.repeat(100) } };
  assert.equal(policy.supportsVideo, false);
  assert.equal(policy.requiresImageFiles, true);
  assert.doesNotThrow(() => policy.validate(variant));
  const invalid = { ...variant, title: '标'.repeat(41) };
  assert.throws(() => policy.validate(invalid), /1–40/);
  await assert.rejects(registry.resolve('bilibili', 'official', {
    bilibili: { clientId: 'fixture', clientSecret: 'fixture' },
  }).preflight({ variant: invalid, account: { credentials: { access_token: 'fixture' } } }), /1–40/);
  const handoff = registry.registration('bilibili', 'manual').contentPolicy;
  assert.equal(handoff.supportsVideo, true);
  assert.doesNotThrow(() => handoff.validate(invalid));
});
