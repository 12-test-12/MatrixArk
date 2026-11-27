import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAccountStatusView } from './account-status.ts';
import type { Account } from './api.ts';

const now = new Date('2026-11-27T12:00:00Z');

const baseAccount: Account = {
  id: 'acc-1',
  platform: 'bilibili',
  channelKind: 'manual',
  accessMethod: 'qr_login',
  displayName: '测试账号',
  identityVerified: false,
  identityCheckedAt: null,
  availableForHandoff: false,
  availableForOfficial: false,
  availableForMetrics: false,
};

test('AccountStatusView 覆盖全部核心账号状态场景且不误判登录成功', () => {
  // 1. 只有账号密码、没有 Cookie
  const pwdOnly = buildAccountStatusView({
    ...baseAccount,
    platform: 'xiaohongshu',
    accessMethod: 'password',
    loginIdentifier: '138****8000',
    hasPassword: true,
    hasCookie: false,
    availableForHandoff: true,
  }, false, undefined, now);
  assert.equal(pwdOnly.identity.label, '待核验');
  assert.equal(pwdOnly.session.category, 'unverified');
  assert.match(pwdOnly.session.label, /账号密码/);
  assert.equal(pwdOnly.capability.label, '支持人工交接');

  // 2. UID 登记但尚未核验（B 站）
  const biliUid = buildAccountStatusView({
    ...baseAccount,
    accessMethod: 'manual_uid',
    platformUid: '123456',
    capabilityReason: 'auth_unverified',
  }, false, undefined, now);
  assert.equal(biliUid.identity.label, '待核验');
  assert.equal(biliUid.capability.label, '当前无法排期');
  assert.match(biliUid.capability.unavailableReason ?? '', /待核验/);

  // 3. 官方 OAuth 已授权
  const officialOk = buildAccountStatusView({
    ...baseAccount,
    channelKind: 'official',
    accessMethod: 'oauth',
    authStatus: 'active',
    authExpiresAt: '2026-12-20T12:00:00Z',
    authCheckedAt: '2026-11-27T10:00:00Z',
    identityVerified: true,
    identityCheckedAt: '2026-11-27T10:00:00Z',
    hasCredentials: true,
    availableForOfficial: true,
    availableForMetrics: true,
    envCheckedAt: '2026-11-27T11:00:00Z',
  }, false, undefined, now);
  assert.equal(officialOk.session.label, '已获得官方授权');
  assert.equal(officialOk.capability.label, '官方自动投稿');
  assert.ok(officialOk.capability.canExecute.includes('自动同步作品成效'));

  // 4. 官方授权过期
  const officialExpired = buildAccountStatusView({
    ...baseAccount,
    channelKind: 'official',
    accessMethod: 'oauth',
    authStatus: 'expired',
    authExpiresAt: '2026-11-26T12:00:00Z',
    hasCredentials: true,
    capabilityReason: 'auth_unverified',
  }, false, undefined, now);
  assert.equal(officialExpired.session.label, '官方授权已过期');
  assert.equal(officialExpired.session.category, 'expired');
  assert.equal(officialExpired.capability.label, '当前无法排期');

  // 5. Cookie 存在但有效期未知、且尚未体检
  const cookieUnknownExpiry = buildAccountStatusView({
    ...baseAccount,
    platform: 'xiaohongshu',
    accessMethod: 'cookie',
    hasCookie: true,
    cookieExpiresAt: null,
    envCheckedAt: null,
    availableForHandoff: true,
  }, false, undefined, now);
  assert.equal(cookieUnknownExpiry.session.category, 'unknown');
  assert.match(cookieUnknownExpiry.session.label, /有效期未知/);
  assert.equal(cookieUnknownExpiry.riskEnv.envLabel, '未体检');

  // 6. 沙箱账号
  const sandbox = buildAccountStatusView({
    ...baseAccount,
    channelKind: 'sandbox',
    accessMethod: 'sandbox',
    availableForOfficial: true,
  }, false, undefined, now);
  assert.equal(sandbox.capability.label, '沙箱演示');
  assert.equal(sandbox.identity.category, 'unknown');

  // 7. 风险预警与体检探测失败区分
  const probeFailed = buildAccountStatusView({
    ...baseAccount,
    hasCookie: true,
    envCheckedAt: '2026-11-27T11:30:00Z',
    riskStatus: 'warning',
    riskReason: '连接 B 站账号体检接口超时',
  }, false, {
    loginState: 'probe_error',
    cookieState: 'valid',
    egressIp: null,
    egressIpCollision: false,
    siblingCollisions: 0,
    profileLabel: null,
    readWriteSeparated: false,
    cookieExpiresAt: null,
    checkedAt: '2026-11-27T11:30:00Z',
  }, now);
  assert.equal(probeFailed.session.category, 'failed');
  assert.equal(probeFailed.riskEnv.riskLabel, '预警提醒');

  // 8. 已归档账号
  const archived = buildAccountStatusView({
    ...baseAccount,
    archivedAt: '2026-11-27T08:00:00Z',
  }, true, undefined, now);
  assert.equal(archived.capability.label, '已归档');
  assert.equal(archived.identity.label, '已归档');

  // 9. 读写分离手工账号 + 未体检 normal 风险（不得误报所有功能健康或自动投稿）
  const readWriteSep = buildAccountStatusView({
    ...baseAccount,
    platform: 'xiaohongshu',
    accessMethod: 'qr_login',
    identityVerified: true,
    identityCheckedAt: '2026-11-27T09:00:00Z',
    hasCookie: true,
    hasReadCookie: true,
    readWriteSeparated: true,
    riskStatus: 'normal',
    envCheckedAt: null,
    availableForHandoff: true,
    availableForOfficial: false,
  }, false, undefined, now);
  assert.equal(readWriteSep.identity.label, '已核验');
  assert.equal(readWriteSep.capability.label, '支持人工交接');
  assert.equal(readWriteSep.riskEnv.envLabel, '未体检');
  assert.equal(readWriteSep.riskEnv.category, 'unverified');
  assert.match(readWriteSep.summaryHint, /支持人工交接/);
  assert.match(readWriteSep.summaryHint, /尚未执行环境体检/);
  assert.match(readWriteSep.riskEnv.detail, /不代表所有功能健康/);
});
