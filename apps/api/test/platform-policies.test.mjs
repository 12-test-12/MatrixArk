import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1/matrixark_policy_test';
process.env.BILIBILI_OFFICIAL_ENABLED = 'true';
process.env.BILIBILI_CLIENT_ID = 'fixture';
process.env.BILIBILI_CLIENT_SECRET = 'fixture';
process.env.BILIBILI_CREDENTIALS_KEY = 'a'.repeat(64);
process.env.SANDBOX_CHANNEL = 'false';

const { config } = await import('../dist/config.js');
const { derivePlatformUid, resolveAccountCapabilities } = await import('../dist/accounts/account-capabilities.js');
const { publishChannel } = await import('../dist/accounts/publish-account.js');
const { AdapterRegistry, createDefaultAdapterRegistry } = await import('@matrixark/adapters');
const { TaskPlatformService } = await import('../dist/tasks/infrastructure/task-platform.service.js');
const now = new Date('2026-11-26T10:00:00Z');
const account = {
  platform: 'bilibili', channelKind: 'manual', accessMethod: 'qr_login', externalId: 'bili-web-uid:123',
  authCheckedAt: now, authStatus: 'active', archivedAt: null, rateLimitedUntil: null,
};

test('账号能力沿用 UID、扫码、Cookie、密码、OAuth 与试用账号的原有边界', () => {
  for (const accessMethod of ['qr_login', 'cookie', 'password']) {
    const current = { ...account, accessMethod };
    const capabilities = resolveAccountCapabilities(current, now);
    assert.equal(capabilities.channel, 'manual');
    assert.equal(capabilities.availableForHandoff, true);
    assert.equal(capabilities.availableForMetrics, false);
    assert.equal(capabilities.identityVerified, accessMethod !== 'password');
    assert.equal(publishChannel(current, now), capabilities.channel);
  }
  assert.equal(resolveAccountCapabilities({ ...account, accessMethod: 'manual_uid' }, now).channel, undefined);
  assert.equal(resolveAccountCapabilities({ ...account, externalId: 'manual-bili-uid:123' }, now).channel, undefined);
  assert.equal(resolveAccountCapabilities({ ...account, platform: 'xiaohongshu', accessMethod: 'manual_uid' }, now).channel, 'manual');
  const official = { ...account, channelKind: 'official', accessMethod: 'oauth', credentialsKeyId: 'bilibili-v1',
    credentialsCiphertext: 'encrypted', authExpiresAt: new Date(now.getTime() + 3600_000), authScope: ['ATC_BASE', 'ATC_DATA'] };
  assert.equal(resolveAccountCapabilities(official, now).availableForMetrics, true);
  for (const patch of [
    { authExpiresAt: now }, { authScope: ['ATC_BASE'] }, { credentialsCiphertext: null },
    { archivedAt: now }, { externalId: null }, { authCheckedAt: null },
    { rateLimitedUntil: new Date(now.getTime() + 1000) }, { authStatus: 'expired' },
  ]) assert.equal(resolveAccountCapabilities({ ...official, ...patch }, now).channel, undefined);
  assert.equal(resolveAccountCapabilities({ ...official, platform: 'xiaohongshu' }, now).channel, undefined);
  assert.equal(resolveAccountCapabilities(official, now, true).channel, undefined);
  const previous = config.trialAvailable;
  try {
    config.trialAvailable = true;
    assert.equal(resolveAccountCapabilities({ ...account, channelKind: 'sandbox' }, now, true).channel, 'sandbox');
    assert.equal(resolveAccountCapabilities({ ...account, channelKind: 'sandbox', platform: 'xiaohongshu' }, now, true).channel, undefined);
    config.trialAvailable = false;
    assert.equal(resolveAccountCapabilities(account, now, true).channel, undefined);
    assert.equal(resolveAccountCapabilities(account, now, true).capabilityReason, 'trial_restricted');
  } finally { config.trialAvailable = previous; }
  assert.equal(resolveAccountCapabilities(account, now).capabilityReason, null);
  assert.equal(resolveAccountCapabilities({ ...account, externalId: null }, now).capabilityReason, 'missing_external_id');
  assert.equal(resolveAccountCapabilities({ ...account, accessMethod: 'manual_uid' }, now).capabilityReason, 'auth_unverified');
  assert.equal(resolveAccountCapabilities({ ...account, rateLimitedUntil: new Date(now.getTime() + 1000) }, now).capabilityReason, 'rate_limited');
  assert.equal(resolveAccountCapabilities({ ...official, platform: 'xiaohongshu' }, now).capabilityReason, 'platform_policy');
  assert.equal(resolveAccountCapabilities(official, now, true).capabilityReason, 'trial_restricted');
  assert.equal(derivePlatformUid({ platform: 'bilibili', externalId: 'bili-web-uid:45678', profileUrl: null }), '45678');
  assert.equal(derivePlatformUid({ platform: 'bilibili', externalId: 'manual-bili-uid:123', profileUrl: null }), '123');
  assert.equal(derivePlatformUid({ platform: 'bilibili', externalId: 'pwd-123', profileUrl: null }), null);
  assert.equal(derivePlatformUid({ platform: 'bilibili', externalId: '123', profileUrl: null }), null,
    'numeric OAuth openid must not be inferred as UID');
  assert.equal(derivePlatformUid({
    platform: 'xiaohongshu',
    externalId: 'xhs-cookie:abcdef',
    profileUrl: 'https://www.xiaohongshu.com/user/profile/609b1234000000000100cafe?xsec_token=demo',
  }), '609b1234000000000100cafe');
});

test('任务编排通过注入的注册工厂执行，平台凭据与成效接口保留注册上下文', async () => {
  let requestedOptions;
  let published;
  const credentials = { access_token: 'fixture' };
  const metrics = { views: 1, likes: 0, comments: null, favorites: null, shares: null };
  const adapter = {
    kind: 'official', platforms: ['bilibili'], preflight: async () => {},
    publish: async input => { published = input; return { status: 'submitted', remoteId: '123' }; },
    fetchStatus: async receipt => ({ ...receipt, status: 'published' }),
    fetchMetrics: async () => metrics,
  };
  const registry = new AdapterRegistry([{ kind: 'official', platforms: ['bilibili'], supportsMetrics: true,
    contentPolicy: { supportsVideo: false, requiresImageFiles: false, validate() {} },
    create: options => { requestedOptions = options; return adapter; } }]);
  const runtime = { platform: 'bilibili', credentials: () => credentials,
    options: async () => ({ bilibili: { clientId: 'fixture-app' } }), errors: {} };
  const service = new TaskPlatformService({ $queryRaw: async () => [{ now }] }, registry, [runtime]);
  const official = { ...account, channelKind: 'official', credentialsKeyId: 'bilibili-v1',
    authScope: ['ATC_BASE', 'ATC_DATA'], authExpiresAt: new Date(now.getTime() + 1000), credentialsCiphertext: 'fixture' };
  const claim = { account: official, channel: 'official', trial: false,
    variant: { workspaceId: 'workspace', id: 'version', assets: [], title: 'fixture', body: 'body', tags: [] },
    task: { idempotencyKey: 'key', scheduledAt: now } };
  const beforeSubmit = async () => true;
  const execution = await service.createExecution(claim, beforeSubmit);
  assert.equal(execution.adapter, adapter);
  await execution.adapter.publish(execution.input);
  assert.equal(published.beforeSubmit, beforeSubmit);
  assert.deepEqual(published.account.credentials, credentials);
  assert.equal(requestedOptions.bilibili.clientId, 'fixture-app');
  assert.deepEqual(await service.fetchMetrics(official, '123'), metrics);
  assert.equal((await service.fetchStatus(official, 'official', false, { status: 'submitted', remoteId: '123' }, now)).status, 'published');
  assert.equal(service.supportsContent('bilibili', 'official', { videoAssetId: 'video' }), false);
  assert.throws(() => new TaskPlatformService({}, createDefaultAdapterRegistry(), [runtime, runtime]), /重复注册/);
});
