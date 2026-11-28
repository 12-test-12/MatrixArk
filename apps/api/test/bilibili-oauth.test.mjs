import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1/matrixark_oauth_test';
process.env.BILIBILI_OFFICIAL_ENABLED = 'true';
process.env.BILIBILI_CLIENT_ID = 'app-fixture';
process.env.BILIBILI_CLIENT_SECRET = 'secret-fixture';
process.env.BILIBILI_CREDENTIALS_KEY = 'a'.repeat(64);
process.env.SANDBOX_CHANNEL = 'false';
const { config } = await import('../dist/config.js');
const { BilibiliOAuthService } = await import('../dist/accounts/bilibili-oauth.js');
const { BilibiliAdapter } = await import('@matrixark/adapters');
const { AccountRiskService } = await import('../dist/accounts/account-risk.service.js');
const { encryptAccountSecret } = await import('../dist/accounts/account-secrets.js');

function matches(row, where = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'workspace' || value === undefined) return true;
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('not' in value && row[key] === value.not) return false;
      if ('gt' in value && !(row[key] > value.gt)) return false;
      if ('lte' in value && !(row[key] <= value.lte)) return false;
      return true;
    }
    return row[key] === value;
  });
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'matrixark-oauth-test-'));
  const previousDir = config.storage.localDir;
  config.storage.localDir = root;
  t.after(async () => { config.storage.localDir = previousDir; await rm(root, { recursive: true, force: true }); });
  const fixture = { accounts: new Map(), states: new Map(), role: 'owner', dispatching: false, failWrite: false,
    expiresIn: 3600,
    identity: { openid: 'openid-one', name: 'Same nickname', scopes: ['USER_INFO', 'ATC_BASE', 'ATC_DATA'] } };
  const model = (rows, defaults) => ({
    findFirst: async ({ where }) => [...rows.values()].find((row) => matches(row, where)) ?? null,
    findMany: async ({ where = {} } = {}) => [...rows.values()].filter((row) => matches(row, where)),
    create: async ({ data }) => {
      if (fixture.failWrite) throw new Error('simulated write failure');
      const row = { id: randomUUID(), ...defaults, ...data }; rows.set(row.id, row); return row;
    },
    update: async ({ where, data }) => {
      if (fixture.failWrite) throw new Error('simulated write failure');
      const row = rows.get(where.id); Object.assign(row, data); return row;
    },
    updateMany: async ({ where, data }) => {
      let count = 0;
      for (const row of rows.values()) if (matches(row, where)) { Object.assign(row, data); count++; }
      return { count };
    },
    deleteMany: async ({ where }) => {
      let count = 0;
      for (const [id, row] of rows) if (matches(row, where)) { rows.delete(id); count++; }
      return { count };
    },
  });
  const db = {
    oAuthState: model(fixture.states, { consumedAt: null, pendingGrantCiphertext: null, createdAt: new Date() }),
    channelAccount: model(fixture.accounts, { archivedAt: null }),
    membership: { findUnique: async () => ({ role: fixture.role }) },
    platformAppSetting: { findUnique: async () => undefined },
    publishTask: { findFirst: async () => fixture.dispatching ? { id: 'dispatching-task' } : null },
    $queryRaw: async () => [],
    async $transaction(run) {
      if (Array.isArray(run)) return Promise.all(run);
      const accounts = structuredClone(fixture.accounts), states = structuredClone(fixture.states);
      try { return await run(db); } catch (error) {
        fixture.accounts.clear(); accounts.forEach((value, key) => fixture.accounts.set(key, value));
        fixture.states.clear(); states.forEach((value, key) => fixture.states.set(key, value));
        throw error;
      }
    },
  };
  let exchanges = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(String(url), 'https://api.bilibili.com/x/account-oauth2/v1/token');
    exchanges++;
    return Response.json({ code: 0, data: { access_token: 'private-fixture-token', expires_in: fixture.expiresIn } });
  });
  t.mock.method(BilibiliAdapter.prototype, 'authorizedAccount', async () => fixture.identity);
  const service = new BilibiliOAuthService(db);
  async function authorize(accountId) {
    const started = await service.start('ws-1', 'user-1', undefined, accountId);
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    const result = await service.finish('user-1', state, 'code-fixture');
    assert.equal(result.status, 'pending');
    const [pending] = await service.pending('ws-1', 'user-1');
    return { state, pending };
  }
  return { ...fixture, fixture, db, service, authorize, exchanges: () => exchanges };
}

test('OAuth callback stores encrypted pending credentials; confirmation is required and cannot replay', async (t) => {
  const { service, accounts, states, authorize, exchanges } = await setup(t);
  const { state, pending } = await authorize();
  assert.equal(accounts.size, 0);
  assert.equal(exchanges(), 1);
  assert.ok([...states.values()][0].pendingGrantCiphertext);
  assert.ok(!JSON.stringify([...states.values()]).includes('private-fixture-token'));
  assert.ok(!JSON.stringify(pending).includes('private-fixture-token'));
  assert.equal((await service.finish('user-1', state, 'code-fixture')).status, 'expired');
  assert.equal(exchanges(), 1);
  const { id } = await service.confirm('ws-1', 'user-1', pending.id, false);
  assert.equal(accounts.size, 1);
  assert.equal(accounts.get(id).externalId, 'openid-one');
  assert.equal(states.get(pending.id).pendingGrantCiphertext, null);
  await assert.rejects(() => service.confirm('ws-1', 'user-1', pending.id, false), /已过期、取消或已保存/);
});

test('same nickname and selected UID cannot merge identities; separate save preserves the UID record and history', async (t) => {
  const { service, accounts, authorize } = await setup(t);
  const original = { id: 'uid-account', workspaceId: 'ws-1', platform: 'bilibili', channelKind: 'manual',
    externalId: 'bili-web-uid:111', displayName: 'Same nickname', cookieCiphertext: 'web-secret', archivedAt: null,
    history: ['old-published-task'] };
  accounts.set(original.id, structuredClone(original));
  const { pending } = await authorize(original.id);
  assert.equal(pending.accountId, original.id);
  assert.equal(pending.requiresSeparate, true);
  await assert.rejects(() => service.confirm('ws-1', 'user-1', pending.id, false), /不能直接合并 UID/);
  assert.deepEqual(accounts.get(original.id), original);
  const saved = await service.confirm('ws-1', 'user-1', pending.id, true);
  assert.notEqual(saved.id, original.id);
  assert.deepEqual(accounts.get(original.id), original);
});

test('renewing the same openid preserves the original ID, Cookie and history; another openid cannot replace it', async (t) => {
  const { service, accounts, authorize, fixture } = await setup(t);
  const original = { id: 'official-account', workspaceId: 'ws-1', platform: 'bilibili', channelKind: 'official',
    externalId: 'openid-one', displayName: 'Official', archivedAt: null, cookieCiphertext: 'unchanged-web-cookie', history: ['old-task'] };
  accounts.set(original.id, structuredClone(original));
  let pending = (await authorize(original.id)).pending;
  assert.equal(pending.requiresSeparate, false);
  assert.equal((await service.confirm('ws-1', 'user-1', pending.id, false)).id, original.id);
  assert.equal(accounts.get(original.id).cookieCiphertext, original.cookieCiphertext);
  assert.deepEqual(accounts.get(original.id).history, original.history);
  fixture.identity = { ...fixture.identity, openid: 'openid-two' };
  pending = (await authorize(original.id)).pending;
  await assert.rejects(() => service.confirm('ws-1', 'user-1', pending.id, false), /不能直接合并/);
  assert.equal(accounts.get(original.id).externalId, 'openid-one');
});

test('pending authorization is bound to user, workspace, time and application revision', async (t) => {
  const { service, states, accounts, authorize } = await setup(t);
  const { pending } = await authorize();
  assert.deepEqual(await service.pending('ws-2', 'user-1'), []);
  assert.deepEqual(await service.pending('ws-1', 'user-2'), []);
  await assert.rejects(() => service.confirm('ws-2', 'user-1', pending.id, false));
  await assert.rejects(() => service.confirm('ws-1', 'user-2', pending.id, false));
  const secret = config.bilibili.clientSecret;
  try {
    config.bilibili.clientSecret = 'changed-secret';
    await assert.rejects(() => service.confirm('ws-1', 'user-1', pending.id, false), /应用配置已变化/);
  } finally { config.bilibili.clientSecret = secret; }
  states.get(pending.id).expiresAt = new Date(0);
  await assert.rejects(() => service.confirm('ws-1', 'user-1', pending.id, false), /已过期/);
  assert.deepEqual(await service.pending('ws-1', 'user-1'), []);
  assert.equal(states.get(pending.id).pendingGrantCiphertext, null);
  assert.equal(accounts.size, 0);
});

test('canceling or losing management permission cannot save a pending grant', async (t) => {
  const { service, accounts, authorize, fixture } = await setup(t);
  const { pending } = await authorize();
  fixture.role = 'viewer';
  await assert.rejects(() => service.confirm('ws-1', 'user-1', pending.id, false), (error) => error.getStatus() === 403);
  fixture.role = 'owner';
  await service.discard('ws-1', 'user-1', pending.id);
  await assert.rejects(() => service.confirm('ws-1', 'user-1', pending.id, false), /已过期、取消或已保存/);
  assert.equal(accounts.size, 0);
});

test('failed writes roll back consumption, and archived identities are restored instead of duplicated', async (t) => {
  const { service, states, accounts, authorize, fixture } = await setup(t);
  const { pending } = await authorize();
  fixture.failWrite = true;
  await assert.rejects(() => service.confirm('ws-1', 'user-1', pending.id, false), /write failure/);
  assert.ok(states.get(pending.id).pendingGrantCiphertext);
  fixture.failWrite = false;
  accounts.set('archived', { id: 'archived', workspaceId: 'ws-1', platform: 'bilibili', channelKind: 'official', externalId: 'openid-one', archivedAt: new Date() });
  await assert.rejects(() => service.confirm('ws-1', 'user-1', pending.id, false), /归档/);
  assert.equal(accounts.size, 1);
});

test('disabling OAuth only removes official credentials and refuses a task currently submitting', async (t) => {
  const { service, accounts, fixture } = await setup(t);
  accounts.set('official', { id: 'official', workspaceId: 'ws-1', platform: 'bilibili', channelKind: 'official',
    archivedAt: null, externalId: 'openid-one', cookieCiphertext: 'keep-web-cookie', history: ['keep-task'], credentialsCiphertext: 'old-token' });
  fixture.dispatching = true;
  await assert.rejects(() => service.disable('ws-1', 'official'), /正在投稿/);
  assert.equal(accounts.get('official').credentialsCiphertext, 'old-token');
  fixture.dispatching = false;
  await service.disable('ws-1', 'official');
  const saved = accounts.get('official');
  assert.equal(saved.credentialsCiphertext, null);
  assert.equal(saved.authStatus, 'revoked');
  assert.equal(saved.cookieCiphertext, 'keep-web-cookie');
  assert.deepEqual(saved.history, ['keep-task']);
  assert.equal(saved.externalId, 'openid-one');
});

test('pending credentials are discarded when the Token expires before the confirmation window', async (t) => {
  const { service, states, authorize, fixture } = await setup(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  fixture.expiresIn = 1;
  const { pending } = await authorize();
  t.mock.timers.tick(2000);
  assert.deepEqual(await service.pending('ws-1', 'user-1'), []);
  assert.equal(states.get(pending.id).pendingGrantCiphertext, null);
});

test('Cookie health cannot expire valid OAuth or reactivate disabled OAuth', async (t) => {
  const { db, accounts } = await setup(t);
  for (const [authStatus, probe] of [['active', 'invalid'], ['revoked', 'ok']]) {
    const cookie = encryptAccountSecret('cookie', 'ws-1', 'official', 'SESSDATA=fixture');
    accounts.set('official', { id: 'official', workspaceId: 'ws-1', platform: 'bilibili', channelKind: 'official', archivedAt: null,
      authStatus, authExpiresAt: authStatus === 'active' ? new Date(Date.now() + 3 * 86400_000) : null,
      cookieCiphertext: cookie.ciphertext, cookieKeyId: cookie.keyId, riskStatus: 'normal' });
    const health = new AccountRiskService(db, {});
    health.probeBilibiliCookie = async () => ({ state: probe, reason: 'fixture', mid: '111', uname: 'Fixture' });
    t.mock.method(health, 'recordRisk', async () => ({ message: 'fixture', feishuStatus: 'skipped' }));
    await health.checkAccountHealth('ws-1', 'official');
    assert.equal(accounts.get('official').authStatus, authStatus);
  }
});
