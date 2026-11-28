import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';

process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1/matrixark_modes_test';
process.env.BILIBILI_OFFICIAL_ENABLED = 'true';
process.env.BILIBILI_CLIENT_ID = 'fixture';
process.env.BILIBILI_CLIENT_SECRET = 'fixture';
process.env.BILIBILI_CREDENTIALS_KEY = 'a'.repeat(64);
process.env.SANDBOX_CHANNEL = 'false';
const { AdapterRegistry } = await import('@matrixark/adapters');
const { scheduleTasksSchema } = await import('@matrixark/shared');
const { TaskPlatformService } = await import('../dist/tasks/infrastructure/task-platform.service.js');
const { config } = await import('../dist/config.js');
const now = new Date();
const account = { id: 'account', workspaceId: 'workspace', platform: 'bilibili', channelKind: 'official',
  accessMethod: 'oauth', externalId: 'openid-not-a-uid', displayName: 'Fixture', authCheckedAt: now,
  authStatus: 'active', authExpiresAt: new Date(now.getTime() + 3_600_000),
  authScope: ['ATC_BASE', 'ATC_DATA'], credentialsKeyId: 'bilibili-v1', credentialsCiphertext: 'cipher',
  archivedAt: null, rateLimitedUntil: null };
const variant = { id: 'variant', workspaceId: 'workspace', platform: 'bilibili', assets: [], title: 'Fixture', body: 'body', tags: [] };
function setup() {
  let app = true, busy = false, browserReady = true;
  const calls = [];
  const platform = { platform: 'bilibili', credentials: () => ({ access_token: 'fixture' }),
    options: async () => app ? {} : undefined, errors: { unavailableApplication: '应用配置失效' },
    dispatchScope: () => [], applicationReady: async () => app };
  const registry = new AdapterRegistry(['official', 'manual', 'sandbox'].map((kind) => ({
    kind, platforms: ['bilibili'], contentPolicy: { supportsVideo: kind !== 'official', validate() {} },
    supportsMetrics: kind === 'official', create: () => ({ kind }),
  })));
  const tx = { publishTask: { findFirst: async () => busy ? { id: 'unfinished' } : null } };
  const profiles = { requireVerified: async (...args) => {
    calls.push(args); if (!browserReady) throw new (await import('@nestjs/common')).ConflictException('Profile 不可用');
  } };
  const service = new TaskPlatformService(tx, registry, [platform], profiles);
  return { service, tx, calls, setApp: (value) => { app = value; }, setBusy: (value) => { busy = value; },
    setBrowser: (value) => { browserReady = value; } };
}

test('排期发布方式须精确覆盖所选账号，非法模式与额外账号均拒绝', () => {
  const id = randomUUID(), other = randomUUID();
  const input = { variantIds: [randomUUID()], accountIds: [id], scheduledAt: now.toISOString() };
  assert.equal(scheduleTasksSchema.safeParse(input).success, true, '历史调用仍兼容');
  for (const accountModes of [{}, { [id]: 'browser' }, { [id]: 'manual_handoff', [other]: 'sandbox' }]) {
    assert.equal(scheduleTasksSchema.safeParse({ ...input, accountModes }).success, false);
  }
  assert.equal(scheduleTasksSchema.safeParse({ ...input, accountModes: { [id]: 'local_browser' } }).success, true);
});

test('官方专栏优先，视频官方投稿禁用；OAuth 失效仍可主动人工交接', async () => {
  const { service, tx } = setup();
  assert.equal((await service.publishOptions(tx, account, variant, now, false)).recommended, 'official_api');
  const video = await service.publishOptions(tx, account, { ...variant, videoAssetId: 'video' }, now, false);
  assert.equal(video.recommended, 'manual_handoff');
  assert.match(video.modes.find((item) => item.mode === 'official_api').reason, /未实现视频投稿/);
  const expired = { ...account, authStatus: 'revoked', authExpiresAt: now, credentialsCiphertext: null, credentialsKeyId: null };
  assert.equal(await service.requireReady(tx, expired, variant, now, false, 'manual_handoff'), 'manual');
  await assert.rejects(() => service.requireReady(tx, expired, variant, now, false, 'official_api'), /授权已失效/);
  assert.equal(expired.channelKind, 'official', '执行方式不能改写账号接入身份');
});

test('浏览器推荐依赖本机已核验 Profile；OAuth openid 不能冒充 UID', async () => {
  const { service, tx, calls, setBrowser } = setup();
  const browser = { ...account, channelKind: 'manual', accessMethod: 'cookie', externalId: 'bili-web-uid:123' };
  assert.equal((await service.publishOptions(tx, browser, variant, now, false)).recommended, 'local_browser');
  assert.deepEqual(calls[0], ['workspace', 'account', '123']);
  setBrowser(false);
  assert.equal((await service.publishOptions(tx, browser, variant, now, false)).recommended, 'manual_handoff');
  await assert.rejects(() => service.requireReady(tx, account, variant, now, false, 'local_browser'), /openid/);
  for (const patch of [{ archivedAt: now }, { authCheckedAt: null }, { rateLimitedUntil: new Date(now.getTime() + 10_000) },
    { channelKind: 'sandbox' }, { channelKind: 'manual', accessMethod: 'manual_uid', externalId: 'manual-bili-uid:123' }]) {
    await assert.rejects(() => service.requireReady(tx, { ...browser, ...patch }, variant, now, false, 'manual_handoff'));
  }
});

test('应用、Scope、待核实任务和试用边界均在后端预检', async () => {
  const { service, tx, setApp, setBusy } = setup();
  setApp(false);
  await assert.rejects(() => service.requireReady(tx, account, variant, now, false, 'official_api'), /应用配置失效/);
  assert.equal(await service.requireReady(tx, account, variant, now, false, 'manual_handoff'), 'manual');
  setApp(true);
  await assert.rejects(() => service.requireReady(tx, { ...account, authScope: ['USER_INFO'] }, variant, now, false, 'official_api'), /Scope/);
  setBusy(true);
  await assert.rejects(() => service.requireReady(tx, account, variant, now, false, 'manual_handoff'), /未完成的发布任务/);
  const existing = await service.publishOptions(tx, account, variant, now, false);
  assert.equal(existing.existingTaskId, 'unfinished');
  assert.equal(existing.recommended, null);
  assert.ok(existing.modes.every((mode) => !mode.available));
  setBusy(false);
  const previous = config.trialAvailable;
  try {
    config.trialAvailable = true;
    await assert.rejects(() => service.requireReady(tx, account, variant, now, true, 'manual_handoff'));
    await assert.rejects(() => service.requireReady(tx, account, variant, now, true, 'official_api'));
    assert.equal(await service.requireReady(tx, { ...account, channelKind: 'sandbox' }, variant, now, true, 'sandbox'), 'sandbox');
  } finally { config.trialAvailable = previous; }
});
