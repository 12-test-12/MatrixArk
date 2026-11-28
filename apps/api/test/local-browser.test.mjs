import 'reflect-metadata';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1/matrixark_browser_test';
const { LocalBrowserProfiles } = await import('../dist/accounts/local-browser-profiles.js');
const { BilibiliBrowserService } = await import('../dist/accounts/bilibili-browser.service.js');
const { BilibiliBrowserController } = await import('../dist/accounts/bilibili-browser.controller.js');
const {
  BILIBILI_ARTICLE_EDIT_URL,
  BILIBILI_VIDEO_UPLOAD_URL,
  extractBilibiliPublishedWork,
  prefillBilibiliDraft,
} = await import('../dist/accounts/bilibili-browser-prefill.js');

async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'matrixark-browser-test-')));
  const options = { root, enabled: true, channel: 'msedge' };
  const profiles = new LocalBrowserProfiles(options);
  const launches = [];
  const contexts = [];
  let reply = { code: 0, data: { isLogin: true, mid: '111', uname: 'Fixture' } };
  profiles.launch = async (directory) => {
    launches.push(directory);
    const context = new EventEmitter();
    context.pages = () => [{ goto: async () => {} }];
    context.request = { get: async () => ({ ok: () => true, json: async () => reply, dispose: async () => {} }) };
    context.close = async () => { context.emit('close'); };
    contexts.push(context);
    return context;
  };
  t.after(async () => { await profiles.onModuleDestroy(); await rm(root, { recursive: true, force: true }); });
  return { root, options, profiles, launches, contexts, setReply: (value) => { reply = value; } };
}

test('publishing rechecks the bound UID before opening creator center and never submits', async (t) => {
  const { profiles, contexts, setReply, launches } = await setup(t);
  const account = { id: 'account-1', workspaceId: 'ws-1', platform: 'bilibili', channelKind: 'manual',
    externalId: 'bili-web-uid:111', authCheckedAt: new Date(), archivedAt: null };
  const session = await profiles.open('ws-1', account.id, '111');
  await profiles.check('ws-1', session.id, async () => account.id);
  const visited = [];
  contexts[0].pages = () => [{ goto: async (url) => visited.push(url) }];
  const service = new BilibiliBrowserService({ channelAccount: { findFirst: async () => account } }, {}, profiles);
  assert.equal((await service.openPublishing('ws-1', account.id)).sessionId, session.id);
  assert.deepEqual(visited, ['https://member.bilibili.com/']);
  assert.equal(launches.length, 1, 'already-open profile is reused');
  setReply({ code: 0, data: { isLogin: true, mid: '222', uname: 'Wrong' } });
  await assert.rejects(() => service.openPublishing('ws-1', account.id), /不一致/);
  assert.equal(visited.length, 1, 'wrong account never opens creator center');
  assert.equal((await profiles.get('ws-1', session.id)).status, 'mismatch');
  await assert.rejects(() => profiles.requireVerified('ws-1', account.id, '111'), /尚未核验或已失效/);
});

test('independent profiles persist across close and service restart; deleting one preserves the other', async (t) => {
  const { profiles, launches, options } = await setup(t);
  const first = await profiles.open('ws-1', 'account-1', '111');
  await writeFile(join(launches[0], 'fixture-cookie'), 'session-one');
  await profiles.check('ws-1', first.id, async () => 'account-1');
  await profiles.close('ws-1', first.id);
  const second = await profiles.open('ws-1', 'account-2', '222');
  await assert.rejects(() => profiles.requireVerified('ws-1', 'account-1', '111'), /其他账号浏览器/);
  await writeFile(join(launches[1], 'fixture-cookie'), 'session-two');
  await profiles.close('ws-1', second.id);
  assert.notEqual(launches[0], launches[1]);

  const restarted = new LocalBrowserProfiles(options);
  restarted.launch = profiles.launch;
  t.after(() => restarted.onModuleDestroy());
  const saved = await restarted.list('ws-1');
  assert.equal(saved.length, 2);
  assert.equal(saved.find((item) => item.id === first.id).verifiedUid, '111');
  assert.ok(saved.every((item) => !item.opened));
  await restarted.open('ws-1', 'account-1', '111', first.id);
  assert.equal(launches[2], launches[0]);
  assert.equal(await readFile(join(launches[2], 'fixture-cookie'), 'utf8'), 'session-one');
  await restarted.close('ws-1', first.id);
  await restarted.remove('ws-1', first.id);
  assert.equal((await restarted.list('ws-1')).length, 1);
  assert.equal(await readFile(join(launches[1], 'fixture-cookie'), 'utf8'), 'session-two');
});

test('wrong UID is rejected before connecting an account; expired and network errors stay distinguishable', async (t) => {
  const { profiles, contexts, setReply } = await setup(t);
  const session = await profiles.open('ws-1', 'account-1', '222');
  let connected = 0;
  const connect = async () => { connected++; return 'account-1'; };
  await assert.rejects(() => profiles.check('ws-1', session.id, connect), /UID 111.*UID 222/);
  assert.equal(connected, 0);
  assert.equal((await profiles.get('ws-1', session.id)).status, 'mismatch');
  setReply({ code: -101, data: null });
  assert.equal((await profiles.check('ws-1', session.id, connect)).status, 'expired');
  setReply({ code: 0, data: { isLogin: false, mid: 0, uname: '' } });
  assert.equal((await profiles.check('ws-1', session.id, connect)).status, 'expired');
  contexts[0].request.get = async () => { throw new Error('network with private details'); };
  await assert.rejects(() => profiles.check('ws-1', session.id, connect), /暂时无法核验/);
  assert.equal((await profiles.get('ws-1', session.id)).status, 'unverified');
  assert.equal(connected, 0);
});

test('global browser lock covers separate manager instances and browser exit releases it', async (t) => {
  const { profiles, options, contexts } = await setup(t);
  const other = new LocalBrowserProfiles(options);
  other.launch = profiles.launch;
  t.after(() => other.onModuleDestroy());
  const first = await profiles.open('ws-1', null, null);
  await assert.rejects(() => other.open('ws-2', null, null), /已有浏览器/);
  await profiles.close('ws-1', first.id);
  const second = await other.open('ws-2', null, null);
  contexts.at(-1).emit('close');
  // 等待 close 事件的异步锁释放，而非依赖固定时间。
  await other.onModuleDestroy();
  const third = await profiles.open('ws-1', null, null);
  await profiles.close('ws-1', third.id);
  await assert.rejects(() => profiles.check('ws-1', first.id, async () => 'unused'), /先打开/);
  assert.equal((await other.get('ws-2', second.id)).accountId, null);
});

test('parallel opens, unsafe IDs and cross-workspace access are rejected', async (t) => {
  const { profiles } = await setup(t);
  const results = await Promise.allSettled([profiles.open('ws-1', null, null), profiles.open('ws-1', null, null)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const session = results.find((result) => result.status === 'fulfilled').value;
  await assert.rejects(() => profiles.get('ws-2', session.id), /不存在/);
  await assert.rejects(() => profiles.close('ws-2', session.id), /不存在/);
  await assert.rejects(() => profiles.remove('ws-2', session.id), /不存在/);
  await assert.rejects(() => profiles.get('ws-1', '../outside'), /ID 无效/);
  await assert.rejects(() => profiles.remove('ws-1', session.id), /先关闭/);
});

test('a failed launch preserves a retryable session and does not leak browser errors or keep the lock', async (t) => {
  const { profiles } = await setup(t);
  const launch = profiles.launch;
  profiles.launch = async () => { throw new Error('secret absolute profile path'); };
  await assert.rejects(() => profiles.open('ws-1', null, null), (error) => error.getStatus() === 502 && !error.message.includes('secret'));
  const [session] = await profiles.list('ws-1');
  profiles.launch = launch;
  await profiles.open('ws-1', null, null, session.id);
});

test('profile directory links cannot escape the local data directory', async (t) => {
  const { profiles, launches, root } = await setup(t);
  const session = await profiles.open('ws-1', null, null);
  await profiles.close('ws-1', session.id);
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'keep'), 'unrelated');
  await rm(launches[0], { recursive: true });
  await symlink(outside, launches[0], process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => profiles.open('ws-1', null, null, session.id), /不安全/);
  assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'unrelated');
});

test('service reuses an account profile and refuses duplicate verified UID profiles without changing the account', async (t) => {
  const { profiles } = await setup(t);
  const account = { id: 'account-1', workspaceId: 'ws-1', platform: 'bilibili', channelKind: 'manual', externalId: 'bili-web-uid:111' };
  const db = { channelAccount: { findFirst: async () => account } };
  let binds = 0;
  const onboarding = { connectBilibiliBrowserAccount: async () => { binds++; return account.id; } };
  const service = new BilibiliBrowserService(db, onboarding, profiles);
  const first = await service.open('ws-1', { accountId: account.id });
  await service.check('ws-1', 'user-1', first.id);
  assert.equal(binds, 1);
  await service.close('ws-1', first.id);
  assert.equal((await service.open('ws-1', { accountId: account.id })).id, first.id);
  await service.close('ws-1', first.id);
  const duplicate = await service.open('ws-1', {});
  await assert.rejects(() => service.check('ws-1', 'user-1', duplicate.id), /已有独立浏览器会话/);
  assert.equal(binds, 1);
});

test('browser endpoints require account management permission and reject trial, arbitrary paths and ambiguous targets', async () => {
  let called = false;
  const controller = new BilibiliBrowserController({ open: async () => { called = true; } });
  assert.throws(() => controller.open('ws-1', { role: 'viewer' }, false, {}), (error) => error.getStatus() === 403);
  assert.throws(() => controller.open('ws-1', { role: 'owner' }, true, {}), /试用/);
  assert.throws(() => controller.open('ws-1', { role: 'owner' }, false, { path: 'C:/Users' }));
  assert.throws(() => controller.open('ws-1', { role: 'owner' }, false, { accountId: 'one', sessionId: 'b9741826-f895-4f55-945a-a723d3def3da' }));
  assert.equal(called, false);
});

test('an exited API process lock can be recovered; disabled mode never opens a browser', async (t) => {
  const { profiles, root, options } = await setup(t);
  await writeFile(join(root, 'browser.lock'), JSON.stringify({ pid: 2147483647, nonce: 'stale-process' }));
  const session = await profiles.open('ws-1', null, null);
  await profiles.close('ws-1', session.id);
  options.enabled = false;
  assert.deepEqual(await profiles.list('ws-1'), []);
  await assert.rejects(() => profiles.open('ws-1', null, null), /未启用/);
});

test('damaged metadata is visible and removable without touching another session', async (t) => {
  const { profiles, launches } = await setup(t);
  const session = await profiles.open('ws-1', null, null);
  await writeFile(join(launches[0], '..', 'session.json'), '{broken');
  const [damaged] = await profiles.list('ws-1');
  assert.match(damaged.error, /记录损坏/);
  assert.equal(damaged.opened, true);
  await profiles.close('ws-1', session.id);
  await profiles.remove('ws-1', session.id);
  assert.deepEqual(await profiles.list('ws-1'), []);
});

test('prefillBilibiliDraft fills article and video fields without ever clicking submit', async () => {
  const actions = [];
  const makePage = (matchedSelectors) => {
    const page = {
      async goto(url) { actions.push(['goto', url]); },
      locator(selector) {
        return {
          first() {
            return {
              async waitFor() {
                if (!matchedSelectors.includes(selector)) throw new Error('not found');
              },
              async fill(value) { actions.push(['fill', selector, value]); },
              async press(key) { actions.push(['press', selector, key]); },
              async setInputFiles(files) { actions.push(['files', selector, files]); },
            };
          },
        };
      },
      frames() { return []; },
      async waitForTimeout() {},
    };
    return page;
  };

  const articleResult = await prefillBilibiliDraft(
    makePage(['textarea[placeholder*="标题"]', '.ql-editor[contenteditable="true"]', 'textarea[placeholder*="摘要"]', 'input[type="file"][accept*="image"]']),
    {
      taskId: 'task-art',
      kind: 'article',
      title: '专栏测试标题',
      body: '专栏正文内容',
      tags: ['科技'],
      summary: '专栏摘要',
      imagePaths: ['C:/tmp/cover.png'],
    },
  );
  assert.equal(articleResult.targetUrl, BILIBILI_ARTICLE_EDIT_URL);
  assert.deepEqual(articleResult.filled, ['专栏标题', '专栏正文', '专栏摘要', '专栏图片']);
  assert.ok(actions.some(([op, sel, val]) => op === 'fill' && sel.includes('标题') && val === '专栏测试标题'));
  assert.ok(!actions.some(([op]) => op === 'click'));

  actions.length = 0;
  const videoResult = await prefillBilibiliDraft(
    makePage(['input[type="file"][accept*="mp4"]', 'input[placeholder*="标题"]', 'input[placeholder*="回车"]', 'textarea[placeholder*="简介"]']),
    {
      taskId: 'task-vid',
      kind: 'video',
      title: '视频测试标题',
      body: '视频简介',
      tags: ['测评', '数码'],
      imagePaths: [],
      videoPath: 'C:/tmp/demo.mp4',
    },
  );
  assert.equal(videoResult.targetUrl, BILIBILI_VIDEO_UPLOAD_URL);
  assert.deepEqual(videoResult.filled, ['视频文件（已加入上传队列）', '视频标题', '视频标签', '视频简介']);
  assert.ok(actions.some(([op, , files]) => op === 'files' && files === 'C:/tmp/demo.mp4'));
  assert.ok(actions.some(([op, , key]) => op === 'press' && key === 'Enter'));
});

test('extractBilibiliPublishedWork parses canonical video and article URLs and ignores editor URLs', () => {
  assert.deepEqual(extractBilibiliPublishedWork('https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=333'), {
    detectedUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    detectedId: 'BV1xx411c7mD',
  });
  assert.deepEqual(extractBilibiliPublishedWork('https://www.bilibili.com/read/cv12345678'), {
    detectedUrl: 'https://www.bilibili.com/read/cv12345678',
    detectedId: '12345678',
  });
  assert.equal(extractBilibiliPublishedWork('https://member.bilibili.com/platform/upload/video/frame'), null);
  assert.equal(extractBilibiliPublishedWork('https://example.com/video/BV1xx411c7mD'), null);
});

test('openPublishing supports prefill, passive result URL capture, and sequential account switching', async (t) => {
  const { profiles, contexts, setReply } = await setup(t);
  const visited = [];
  const origLaunch = profiles.launch;
  profiles.launch = async (directory) => {
    const context = await origLaunch(directory);
    const page = new EventEmitter();
    let currentUrl = 'https://member.bilibili.com/platform/upload/text/edit';
    const mainFrame = { url: () => currentUrl };
    page.url = () => currentUrl;
    page.mainFrame = () => mainFrame;
    page.goto = async (url) => { currentUrl = url; visited.push(url); };
    context.pages = () => [page];
    return context;
  };

  const accounts = new Map([
    ['acc-1', { id: 'acc-1', workspaceId: 'ws-1', platform: 'bilibili', channelKind: 'manual', externalId: 'bili-web-uid:111', authCheckedAt: new Date(), archivedAt: null }],
    ['acc-2', { id: 'acc-2', workspaceId: 'ws-1', platform: 'bilibili', channelKind: 'manual', externalId: 'bili-web-uid:222', authCheckedAt: new Date(), archivedAt: null }],
  ]);
  const db = { channelAccount: { findFirst: async ({ where }) => accounts.get(where.id) ?? null } };
  const service = new BilibiliBrowserService(db, {}, profiles);

  const s1 = await profiles.open('ws-1', 'acc-1', '111');
  await profiles.check('ws-1', s1.id, async () => 'acc-1');
  await profiles.close('ws-1', s1.id);

  setReply({ code: 0, data: { isLogin: true, mid: '222', uname: 'Second' } });
  const s2 = await profiles.open('ws-1', 'acc-2', '222');
  await profiles.check('ws-1', s2.id, async () => 'acc-2');
  await profiles.close('ws-1', s2.id);

  setReply({ code: 0, data: { isLogin: true, mid: '111', uname: 'First' } });
  const firstOpen = await service.openPublishing('ws-1', 'acc-1', {
    taskId: 'task-1', kind: 'article', title: 'T1', body: 'B1', tags: [], imagePaths: [],
  }, { switchAccount: true });
  assert.equal(firstOpen.targetUrl, BILIBILI_ARTICLE_EDIT_URL);
  assert.equal(visited.at(-1), BILIBILI_ARTICLE_EDIT_URL);

  // Simulate user clicking publish in Bilibili browser and navigating to published article URL.
  const activePage = contexts.at(-1).pages()[0];
  activePage.emit('framenavigated', { url: () => 'https://www.bilibili.com/video/BVignoreSubframe' });
  assert.equal(service.getTaskStatus('ws-1', 'task-1').capture, null);
  await activePage.goto('https://www.bilibili.com/read/cv987654');
  activePage.emit('framenavigated', activePage.mainFrame());
  const status1 = service.getTaskStatus('ws-1', 'task-1');
  assert.equal(status1.activeForTask, true);
  assert.equal(status1.capture?.detectedUrl, 'https://www.bilibili.com/read/cv987654');

  // Switch directly to account 2 without manual close first.
  setReply({ code: 0, data: { isLogin: true, mid: '222', uname: 'Second' } });
  const secondOpen = await service.openPublishing('ws-1', 'acc-2', {
    taskId: 'task-2', kind: 'video', title: 'T2', body: 'B2', tags: [], imagePaths: [],
  }, { switchAccount: true });
  assert.equal(secondOpen.targetUrl, BILIBILI_VIDEO_UPLOAD_URL);
  assert.equal(service.getTaskStatus('ws-1', 'task-1').activeForTask, false);
  assert.equal(service.getTaskStatus('ws-1', 'task-2').activeForTask, true);

  const closed = await service.closeTaskBrowser('ws-1', 'task-2');
  assert.equal(closed.closed, true);
  assert.equal(service.getTaskStatus('ws-1', 'task-2').opened, false);
});
