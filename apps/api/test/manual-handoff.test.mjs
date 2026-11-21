import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import sharp from 'sharp';

test('单账号排期去重、并发交接、回填及截图隔离', async (t) => {
  const url = process.env.DATABASE_URL;
  assert(url && new URL(url).pathname === '/matrixark_upgrade_test' && process.env.STORAGE_LOCAL_DIR,
    'Use infra/ci/check-database.sh');
  process.env.XIAOHONGSHU_APP_ID = 'identity-fixture';
  process.env.XIAOHONGSHU_APP_SECRET = 'identity-fixture-secret';
  process.env.BILIBILI_OFFICIAL_ENABLED = 'true';
  process.env.BILIBILI_CLIENT_ID = 'bilibili-fixture';
  process.env.BILIBILI_CLIENT_SECRET = 'bilibili-fixture-secret';
  process.env.BILIBILI_CREDENTIALS_KEY = 'a'.repeat(64);
  process.env.NOTIFICATION_CREDENTIALS_KEY = 'b'.repeat(64);
  const { AppModule } = await import('../dist/app.module.js');
  const { PrismaService } = await import('../dist/prisma/prisma.service.js');
  const { TasksService } = await import('../dist/tasks/tasks.service.js');
  const { TasksModule } = await import('../dist/tasks/tasks.module.js');
  const api = await NestFactory.create(AppModule, { logger: ['error'], abortOnError: false });
  t.after(() => api.close());
  api.setGlobalPrefix('api');
  api.use(cookieParser());
  await api.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${api.getHttpServer().address().port}/api`;
  const worker = await NestFactory.createApplicationContext(TasksModule, { logger: ['error'], abortOnError: false });
  t.after(() => worker.close());

  async function call(path, { cookie, body, method = 'GET', status = 200 } = {}) {
    const headers = cookie ? { cookie } : {};
    if (body && !(body instanceof FormData)) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const response = await fetch(base + path, { method, headers, body });
    const data = await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    return { data, cookie: response.headers.getSetCookie()[0]?.split(';')[0] };
  }
  const register = (name) => call('/auth/register', {
    method: 'POST', status: 201, body: { name, email: `${name}@example.test`, password: 'fixture-password' },
  });
  const { data: owner, cookie } = await register('handoff-owner');
  const { data: other, cookie: otherCookie } = await register('handoff-other');
  const own = `/workspaces/${owner.workspaces[0].id}`;
  const foreign = `/workspaces/${other.workspaces[0].id}`;
  const post = (path, body, status = 201) => call(path, { cookie, method: 'POST', body, status });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5+0AAAAASUVORK5CYII=', 'base64');
  const sourcePng = await sharp({ create: { width: 640, height: 960, channels: 3, background: '#4839b9' } }).png().toBuffer();
  const file = (bytes = png, filename = 'sample.png') => {
    const form = new FormData();
    form.set('file', new Blob([bytes], { type: 'image/png' }), filename);
    return form;
  };

  const prisma = api.get(PrismaService);
  const workspaceId = owner.workspaces[0].id;
  const fixtureAccount = (platform, channelKind, displayName, verified = true) => prisma.channelAccount.create({
    data: {
      workspaceId, platform, channelKind, displayName,
      externalId: verified ? `fixture-${platform}-${channelKind}` : null,
      authCheckedAt: verified ? new Date() : null,
    },
  });
  const account = await fixtureAccount('xiaohongshu', 'manual', '人工测试账号');
  const unverified = await fixtureAccount('xiaohongshu', 'manual', '旧未核验账号', false);
  const { data: manuscript } = await post(own + '/manuscripts', { title: '审核标题', body: '已审核正文', tags: ['样例'] });
  const source = own + '/manuscripts/' + manuscript.id;
  const filename = '稿件封面 Café 🌿.png';
  const { data: image } = await post(source + '/assets', file(sourcePng, filename));
  assert.equal(image.filename, filename);
  const legacyName = Buffer.from(filename, 'utf8').toString('latin1');
  await prisma.asset.update({ where: { id: image.id }, data: { filename: legacyName } });
  const { data: withLegacyImage } = await call(source, { cookie });
  assert.equal(withLegacyImage.assets[0].filename, filename);
  assert.equal((await prisma.asset.findUniqueOrThrow({ where: { id: image.id } })).filename, legacyName);
  const { data: [variant] } = await post(source + '/generate', { platforms: ['xiaohongshu'] });
  const scheduledAt = new Date(Date.now() - 10_000).toISOString();
  const schedule = { accountIds: [account.id], variantIds: [variant.id], scheduledAt };
  await post(own + '/tasks', schedule, 409);
  await post(own + '/variants/' + variant.id + '/confirm', {});
  await post(own + '/tasks', { ...schedule, accountIds: [unverified.id] }, 409);

  const both = await Promise.all(Array.from({ length: 2 }, () => fetch(base + own + '/tasks', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(schedule),
  })));
  assert.deepEqual(both.map(({ status }) => status).sort(), [200, 201]);
  const [created, duplicate] = await Promise.all(both.map((response) => response.json()));
  const task = created.items[0];
  assert.equal(duplicate.items[0].id, task.id);
  const { data: repeated } = await post(own + '/tasks', { ...schedule, scheduledAt: '2035-01-01T10:30:00+08:00' }, 200);
  assert.equal(repeated.items[0].scheduledAt, scheduledAt);
  assert.equal(repeated.items[0].disposition, 'existing');

  const path = own + '/tasks/' + task.id;
  await call(path + '/handoff', { cookie, status: 409 });
  await post(path + '/result', { state: 'published', remoteUrl: 'https://example.test/note' }, 409);
  assert.deepEqual((await Promise.all([api.get(TasksService).dispatchDue(), worker.get(TasksService).dispatchDue()])).sort(), [0, 1]);
  const { data: next } = await call(own + '/variants/' + variant.id, {
    method: 'PATCH', cookie, body: { title: '新版标题' },
  });
  assert.equal(next.pausedTaskCount, 0);
  await post(own + '/variants/' + next.variant.id + '/confirm', {});
  const { data: future } = await post(own + '/tasks', {
    ...schedule, variantIds: [next.variant.id], scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  assert.equal(await worker.get(TasksService).dispatchDue(), 0);
  await call(own + '/tasks/' + future.items[0].id + '/handoff', { cookie, status: 409 });
  const { data: handoff } = await call(path + '/handoff', { cookie });
  assert.equal(handoff.title, '审核标题');
  assert.equal(handoff.variantId, variant.id);
  assert.equal(handoff.assets[0].assetId, image.id);
  assert.equal(handoff.assets[0].isCover, true);
  await call(path + '/handoff', { cookie: otherCookie, status: 403 });
  await call(foreign + '/tasks/' + task.id, { cookie: otherCookie, status: 404 });
  const downloaded = await fetch(new URL(handoff.assets[0].url, base), { headers: { cookie } });
  assert.equal(downloaded.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), sourcePng);
  const thumbnailUrl = new URL(handoff.assets[0].url + '/thumbnail', base);
  const thumbnail = await fetch(thumbnailUrl, { headers: { cookie } });
  assert.equal(thumbnail.status, 200);
  assert.equal(thumbnail.headers.get('content-type'), 'image/webp');
  assert.equal(thumbnail.headers.get('cache-control'), 'private, no-cache');
  const { width, height } = await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata();
  assert.equal(height, 320);
  assert.ok(width < height);
  await call(own + '/assets/' + image.id + '/thumbnail', { cookie: otherCookie, status: 403 });
  await call(foreign + '/assets/' + image.id + '/thumbnail', { cookie: otherCookie, status: 404 });

  await post(path + '/result', { state: 'published' }, 400);
  await post(path + '/result', { state: 'published', remoteUrl: 'javascript:alert(1)' }, 400);
  await post(path + '/result', { state: 'published', evidenceAssetId: image.id }, 404);
  const mislabeled = new FormData();
  mislabeled.set('file', new Blob(['<svg></svg>'], { type: 'image/png' }), 'fake.png');
  await post(path + '/evidence', mislabeled, 415);
  const evidenceName = '发布回执.png';
  const { data: { assetId } } = await post(path + '/evidence', file(png, evidenceName));
  assert.equal((await prisma.asset.findUniqueOrThrow({ where: { id: assetId } })).filename, evidenceName);
  const { data: result } = await post(path + '/result', { state: 'published', evidenceAssetId: assetId }, 200);
  assert.equal(result.recordedById, owner.user.id);
  assert.equal(result.evidenceAssetId, assetId);
  await post(path + '/result', { state: 'failed' }, 409);
  const { data: detail } = await call(path, { cookie });
  assert.equal(detail.status, 'published');
  assert.equal(detail.isSandbox, false);
  assert.deepEqual(detail.events.map(({ kind }) => kind), ['created', 'claimed', 'handed_off', 'result']);
  assert(detail.events.every(({ id }) => typeof id === 'string'));
  const evidence = await fetch(base + path + '/evidence', { headers: { cookie } });
  assert.equal(evidence.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await evidence.arrayBuffer()), png);
  await call(path + '/evidence', { cookie: otherCookie, status: 403 });
  const { data: list } = await call(own + '/tasks?status=published', { cookie });
  assert.deepEqual(list.items.map(({ id }) => id), [task.id]);
  const { data: firstPage } = await call(own + '/tasks?limit=1', { cookie });
  const { data: lastPage } = await call(own + '/tasks?limit=1&cursor=' + firstPage.nextCursor, { cookie });
  assert.deepEqual(firstPage.items.map(({ id }) => id), [future.items[0].id]);
  assert.deepEqual(lastPage.items.map(({ id }) => id), [task.id]);
  assert.equal(lastPage.nextCursor, null);
  await call(own + '/tasks?status=scheduled&cursor=' + firstPage.nextCursor, { cookie, status: 400 });

  await t.test('B 站专栏用同平台人工账号交接及回填', async () => {
    const bilibili = await fixtureAccount('bilibili', 'manual', '专栏人工账号');
    const official = await fixtureAccount('bilibili', 'official', '专栏官方账号');
    const { data: [article] } = await post(source + '/generate', { platforms: ['bilibili'] });
    await post(own + '/variants/' + article.id + '/confirm', {});
    const articleSchedule = { variantIds: [article.id], accountIds: [bilibili.id], scheduledAt };
    await post(own + '/tasks', { ...articleSchedule, accountIds: [account.id] }, 400);
    await post(own + '/tasks', { ...articleSchedule, accountIds: [official.id] }, 409);
    const { data: { items: [articleTask] } } = await post(own + '/tasks', articleSchedule);
    const articlePath = own + '/tasks/' + articleTask.id;
    assert.equal(await worker.get(TasksService).dispatchDue(), 1);
    const { data: articleHandoff } = await call(articlePath + '/handoff', { cookie });
    assert.equal(articleHandoff.account.platform, 'bilibili');
    assert.equal(articleHandoff.variantId, article.id);
    const url = 'https://example.test/article';
    await post(articlePath + '/result', { state: 'published', remoteUrl: url }, 200);
    const { data: articleDetail } = await call(articlePath, { cookie });
    assert.equal(articleDetail.executionChannel, 'manual');
    assert.equal(articleDetail.status, 'published');
    assert.equal(articleDetail.result.remoteUrl, url);
  });

  await t.test('标题、正文、话题均为 1 且无图片时仍返回完整版本快照', async () => {
    const { data: textOnly } = await post(own + '/manuscripts', { title: '1', body: '1', tags: ['1'] });
    const textPath = own + '/manuscripts/' + textOnly.id;
    await post(textPath + '/generate', { platforms: ['xiaohongshu', 'bilibili'] });
    const { data } = await call(textPath, { cookie });
    assert.equal(data.variants.length, 2);
    for (const item of data.variants) {
      assert.deepEqual(item.assets, []);
      assert.equal(item.snapshotVersion, 1);
      const { data: check } = await call(own + '/variants/' + item.id + '/check', { cookie });
      assert.deepEqual(check.issues.map(({ code }) => code), item.platform === 'xiaohongshu' ? ['images_missing'] : []);
    }
  });

  await t.test('只能通过小红书官方身份核验新增账号', async (test) => {
    let approved = false;
    const localFetch = globalThis.fetch;
    test.mock.method(globalThis, 'fetch', (input, options) => {
      const url = new URL(input);
      if (url.origin !== 'https://openaccount.xiaohongshu.com') return localFetch(input, options);
      const body = JSON.parse(options.body);
      const result = (data) => Response.json({ code: 0, success: true, data });
      switch (url.pathname.split('/').at(-1)) {
        case 'code':
          assert.deepEqual(body.scopes, ['basic_info']);
          return result({
            device_code: 'private-device-fixture',
            verification_uri_complete: 'https://openaccount.xiaohongshu.com/device?user_code=ABCD-EFGH',
            user_code: 'ABCD-EFGH', expires_in: 600, interval: 1,
          });
        case 'token':
          assert.equal(body.device_code, 'private-device-fixture');
          return approved ? result({ access_token: 'private-token-fixture', open_id: 'verified-fixture', scope: ['basic_info'] })
            : Response.json({ code: 37002, success: false, data: null });
        case 'batch_get_min_user_info':
          assert.equal(options.headers.authorization, 'Bearer private-token-fixture');
          return result({ open_id: 'verified-fixture', nickname: '平台返回昵称' });
        default: assert.fail('Unexpected XiaoHongShu request');
      }
    });
    for (const platform of ['bilibili', 'xiaohongshu']) {
      await post(own + '/accounts', { platform, channelKind: 'manual', displayName: '任意账号' }, 409);
    }
    const path = own + '/accounts/xiaohongshu/authorize';
    const otherPath = foreign + '/accounts/xiaohongshu/authorize';
    const { data: ticket } = await post(path, {});
    assert.deepEqual(Object.keys(ticket).sort(), ['expiresAt', 'id', 'userCode', 'verificationUrl']);
    const poll = (id) => post(`${path}/${id}/poll`, {}, 200);
    await call(`${otherPath}/${ticket.id}/poll`, { method: 'POST', cookie: otherCookie, body: {}, status: 404 });
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.equal((await poll(ticket.id)).data.status, 'pending');
    assert.equal(await prisma.channelAccount.count({ where: { workspaceId, externalId: 'verified-fixture' } }), 0);
    approved = true;
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.equal((await poll(ticket.id)).data.status, 'connected');
    assert.equal((await poll(ticket.id)).data.status, 'connected');
    const { data: accounts } = await call(own + '/accounts', { cookie });
    const verified = accounts.find(({ displayName }) => displayName === '平台返回昵称');
    assert.equal(verified.identityVerified, true);
    assert.equal(verified.availableForHandoff, true);
    assert.equal(verified.availableForOfficial, false);
    const stored = await prisma.channelAccount.findUniqueOrThrow({ where: { id: verified.id } });
    assert.equal(stored.externalId, 'verified-fixture');
    assert.deepEqual(stored.authScope, ['basic_info']);
    assert.equal(stored.credentials, null);
    assert.equal(stored.credentialsCiphertext, null);
    await call(own + '/accounts/' + verified.id, {
      method: 'PATCH', cookie, body: { channelKind: 'manual' }, status: 400,
    });
    await prisma.channelAccount.update({ where: { id: verified.id }, data: { channelKind: 'official', authStatus: 'pending' } });
    const { data: repeated } = await post(path, {});
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.equal((await poll(repeated.id)).data.status, 'connected');
    assert.equal(await prisma.channelAccount.count({ where: { workspaceId, externalId: 'verified-fixture' } }), 1);
    assert.equal((await prisma.channelAccount.findUniqueOrThrow({ where: { id: verified.id } })).channelKind, 'manual');
  });

  await t.test('B 站官方投稿使用已审快照，领取去重，回执回读及超时恢复', async (t) => {
    const { BilibiliAdapter, SandboxAdapter } = await import('@matrixark/adapters');
    const { encryptBilibiliCredentials, bilibiliCredentials } = await import('../dist/accounts/publish-account.js');
    const id = randomUUID();
    const externalId = 'bili-fixture-open-id';
    const credentials = encryptBilibiliCredentials({ id, workspaceId, externalId }, 'bili-token-fixture');
    let submissionCount = 0;
    let pollCount = 0;
    let lateTaskId;
    let incomplete = false;
    let matchingIdentity = true;
    const token = 'bili-token-fixture';
    t.mock.method(https, 'request', (input, options, callback) => {
      const url = new URL(input);
      assert.equal(url.origin, 'https://member.bilibili.com');
      const { headers, method } = options;
      assert.equal(headers['Access-Token'], token);
      assert.equal(headers['x-bili-content-md5'], 'd41d8cd98f00b204e9800998ecf8427e');
      const signed = Object.keys(headers).filter((key) => key.startsWith('x-bili-')).sort();
      const payload = signed.map((key) => key + ':' + headers[key]).join('\n');
      assert.equal(headers.Authorization, createHmac('sha256', process.env.BILIBILI_CLIENT_SECRET).update(payload).digest('hex'));
      const req = new EventEmitter();
      req.end = (contents) => {
        void (async () => {
          let data;
          if (!contents) {
            assert.equal(method, 'GET');
            data = url.pathname.endsWith('/info')
              ? { openid: externalId, name: 'B 站授权账号' }
              : { openid: matchingIdentity ? externalId : 'different-open-id', scopes: ['USER_INFO', 'ATC_BASE', 'ATC_DATA'] };
          } else {
            assert.equal(headers['Content-Length'], contents.length);
            const form = await new Response(contents, { headers: { 'Content-Type': headers['Content-Type'] } }).formData();
            switch (url.pathname) {
              case '/arcopen/fn/article/upload/image':
                assert.equal(method, 'POST');
                assert.equal(form.get('file').type, 'image/png');
                assert.deepEqual(Buffer.from(await form.get('file').arrayBuffer()), sourcePng);
                data = { url: 'https://i0.hdslb.com/bfs/article/fixture.png' };
                break;
              case '/arcopen/fn/article/add':
                assert.equal(method, 'POST');
                assert.equal(form.get('category'), '100');
                assert.equal(form.get('template_id'), '4');
                assert.equal(form.get('image_urls'), 'https://i0.hdslb.com/bfs/article/fixture.png');
                assert.match(form.get('content'), /&lt;script&gt;/u);
                assert.match(form.get('content'), /<img src="https:\/\/i0\.hdslb\.com/u);
                assert.equal(form.has('client_token'), false);
                submissionCount++;
                data = incomplete ? {} : { id: 5467 };
                if (lateTaskId) await prisma.publishTask.update({
                  where: { id: lateTaskId }, data: { leaseExpiresAt: new Date(Date.now() - 1000) },
                });
                break;
              case '/arcopen/fn/data/art/stat':
                assert.equal(method, 'GET');
                assert.equal(form.get('ids'), '5467');
                pollCount++;
                data = { '5467': { id: 5467, state: pollCount === 1 ? 1 : 0, publish_time: pollCount === 1 ? 0 : 1638521942 } };
                break;
              default: assert.fail('Unexpected Bilibili request');
            }
          }
          const response = Readable.from([Buffer.from(JSON.stringify({ code: 0, request_id: 'fixture-trace', data }))]);
          response.statusCode = 200;
          callback(response);
        })().catch((error) => req.emit('error', error));
      };
      return req;
    });
    const adapter = new BilibiliAdapter({
      clientId: process.env.BILIBILI_CLIENT_ID, clientSecret: process.env.BILIBILI_CLIENT_SECRET,
    });
    const grant = await adapter.authorizedAccount(token);
    assert.equal(grant.openid, externalId);
    matchingIdentity = false;
    await assert.rejects(adapter.authorizedAccount(token), /身份核验失败/u);
    const biliAccount = await prisma.channelAccount.create({ data: {
      id, workspaceId, platform: 'bilibili', channelKind: 'official', displayName: grant.name, externalId,
      authCheckedAt: new Date(), authExpiresAt: new Date(Date.now() + 3_600_000),
      authStatus: 'active', authScope: grant.scopes, credentialsUpdatedAt: new Date(), ...credentials,
    } });
    assert.equal(bilibiliCredentials({ ...biliAccount, workspaceId: other.workspaces[0].id }), undefined);
    const { data: accounts } = await call(own + '/accounts', { cookie });
    assert.equal(accounts.find((account) => account.id === id).availableForOfficial, true);
    assert.ok(!JSON.stringify(accounts).includes(token));

    async function scheduleArticle(title) {
      const { data: [draft] } = await post(source + '/generate', { platforms: ['bilibili'] });
      const { data: { variant } } = await call(own + '/variants/' + draft.id, {
        method: 'PATCH', cookie, body: { title, body: '已审内容'.repeat(60) + '\n<script>', coverAssetId: image.id,
          platformFields: { category: 100, summary: '已审摘要'.repeat(60) } },
      });
      await post(own + '/variants/' + variant.id + '/confirm', {});
      const payload = { variantIds: [variant.id], accountIds: [id], scheduledAt };
      const { data: { items: [task] } } = await post(own + '/tasks', payload);
      const { data: { items: [duplicate] } } = await post(own + '/tasks', payload, 200);
      assert.equal(duplicate.id, task.id);
      return task;
    }
    const dispatch = worker.get(TasksService);
    const replica = api.get(TasksService);
    const task = await scheduleArticle('官方专栏');
    assert.deepEqual((await Promise.all([dispatch.dispatchDue(), replica.dispatchDue()])).sort(), [0, 1]);
    const path = own + '/tasks/' + task.id;
    const { data: submitted } = await call(path, { cookie });
    assert.equal(submitted.executionChannel, 'official');
    assert.equal(submitted.status, 'submitted');
    assert.equal(submitted.result.remoteId, '5467');
    assert.equal(submitted.result.remoteUrl, null);
    assert.equal(submitted.events.at(-1).details.platform.requestId, 'fixture-trace');
    assert.equal(submissionCount, 1);
    const makePollDue = () => prisma.publishTask.update({ where: { id: task.id }, data: { updatedAt: new Date(0) } });
    await makePollDue();
    await Promise.all([dispatch.pollAutomaticResults(), replica.pollAutomaticResults()]);
    assert.equal(pollCount, 1);
    assert.equal((await call(path, { cookie })).data.status, 'under_review');
    await makePollDue();
    await replica.pollAutomaticResults();
    const { data: published } = await call(path, { cookie });
    assert.equal(published.status, 'published');
    assert.equal(published.result.remoteUrl, 'https://www.bilibili.com/read/cv5467');
    assert.equal(published.result.platformPublishedAt, '2021-12-03T08:59:02.000Z');
    assert.equal(submissionCount, 1);

    const unknown = await scheduleArticle('缺少文章 ID');
    incomplete = true;
    assert.equal(await dispatch.dispatchDue(), 1);
    assert.equal(await replica.dispatchDue(), 0);
    const unknownResult = await prisma.publishResult.findUniqueOrThrow({ where: { taskId: unknown.id } });
    assert.equal(unknownResult.state, 'unknown');
    assert.equal(unknownResult.remoteId, null);
    assert.equal(submissionCount, 2);

    const late = await scheduleArticle('迟到回执');
    lateTaskId = late.id;
    incomplete = false;
    assert.equal(await dispatch.dispatchDue(), 1);
    assert.equal(await replica.dispatchDue(), 0);
    const { data: expired } = await call(own + '/tasks/' + late.id, { cookie });
    assert.equal(expired.status, 'unknown');
    assert.deepEqual(expired.events.map(({ kind }) => kind), ['created', 'claimed', 'late_receipt', 'result']);
    assert.equal(expired.events[2].details.remoteId, '5467');
    assert.equal(submissionCount, 3);

    const reviewing = await new SandboxAdapter().fetchStatus({ status: 'submitted', remoteId: 'sandbox-1' });
    const simulated = await new SandboxAdapter().fetchStatus(reviewing);
    assert.equal(reviewing.status, 'under_review');
    assert.equal(simulated.status, 'published');
    assert.equal(simulated.remoteUrl, 'https://example.invalid/sandbox-1');
  });

  await t.test('同一原稿跨平台排期 50 个账号，重发去重，任一账号无效时整批拒绝', async () => {
    const { data: draft } = await post(own + '/manuscripts', { title: '批量排期', body: '同一原稿', tags: [] });
    const draftPath = own + '/manuscripts/' + draft.id;
    await post(draftPath + '/assets', file(sourcePng));
    const { data: variants } = await post(draftPath + '/generate', { platforms: ['xiaohongshu', 'bilibili'] });
    for (const variant of variants) await post(own + '/variants/' + variant.id + '/confirm', {});
    const targets = await prisma.channelAccount.createManyAndReturn({
      data: Array.from({ length: 51 }, (_, index) => ({
        workspaceId, displayName: `批量账号 ${index + 1}`, externalId: `batch-fixture-${index}`,
        authCheckedAt: new Date(), authStatus: 'active', channelKind: 'manual',
        platform: index % 2 === 0 ? 'xiaohongshu' : 'bilibili',
      })),
    });
    const url = own + '/tasks';
    const variantIds = variants.map(({ id }) => id);
    const accountIds = targets.slice(0, 50).map(({ id }) => id);
    const payload = { variantIds, accountIds, scheduledAt: new Date(Date.now() + 3_600_000).toISOString() };
    const first = targets[0];
    const firstVariant = variants.find(({ platform }) => platform === first.platform);
    const firstPair = { ...payload, variantIds: [firstVariant.id], accountIds: [first.id] };
    const { data: { items: [existing] } } = await post(url, firstPair);

    await post(url, { ...payload, accountIds: [...accountIds, unverified.id] }, 409);
    assert.equal(await prisma.publishTask.count({ where: { variantId: { in: variantIds } } }), 1);
    await post(url, { ...payload, variantIds: [firstVariant.id] }, 400);
    const batch = await Promise.all([payload, {
      ...payload, variantIds: [...variantIds].reverse(), accountIds: [...accountIds].reverse(),
    }].map((body) => fetch(base + url, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })));
    assert.deepEqual(batch.map(({ status }) => status).sort(), [200, 201]);
    const created = await batch.find(({ status }) => status === 201).json();
    const repeated = await batch.find(({ status }) => status === 200).json();
    assert.equal(created.items.length, 50);
    assert.equal(created.items.filter(({ disposition }) => disposition === 'created').length, 49);
    assert.equal(created.items.find(({ disposition }) => disposition === 'existing').id, existing.id);
    assert.deepEqual(new Set(repeated.items.map(({ id }) => id)), new Set(created.items.map(({ id }) => id)));
    for (const task of created.items) {
      assert.equal(variants.find(({ id }) => id === task.variantId).platform,
        targets.find(({ id }) => id === task.accountId).platform);
    }
    const additional = targets[50];
    const { data: { items: [additionalTask] } } = await post(url, {
      ...firstPair, accountIds: [additional.id],
      variantIds: [variants.find(({ platform }) => platform === additional.platform).id],
    });
    assert.equal(additionalTask.accountId, additional.id);
    const { data: accounts } = await call(own + '/accounts', { cookie });
    assert.equal(accounts.find(({ id }) => id === additional.id).availableForHandoff, true);
    assert.equal(await prisma.taskEvent.count({
      where: { kind: 'created', task: { variantId: { in: variantIds } } },
    }), 51);
  });

  await t.test('飞书设置脱敏、两类提醒去重、限流重试和过期回收', async (t) => {
    const { NotificationsService } = await import('../dist/notifications/notifications.service.js');
    const path = own + '/notifications/feishu';
    const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/matrixark-test-fixture';
    const secret = 'matrixark-sign-fixture';
    const patch = (body, status = 200) => call(path, { method: 'PATCH', cookie, body, status });
    assert.equal((await call(path, { cookie })).data.enabled, false);
    await call(path, { cookie: otherCookie, status: 403 });
    await prisma.membership.create({ data: { workspaceId, userId: other.user.id, role: 'editor' } });
    await call(path, { method: 'PATCH', cookie: otherCookie, body: { enabled: false }, status: 403 });
    await patch({ enabled: true, webhook: 'https://open.feishu.cn.example.test/open-apis/bot/v2/hook/fixture' }, 400);
    await patch({ enabled: true }, 400);
    assert.deepEqual((await patch({ enabled: true, webhook, signSecret: secret })).data, {
      enabled: true, webhookConfigured: true, signatureConfigured: true, encryptionReady: true,
    });
    const stored = await prisma.notificationSetting.findUniqueOrThrow({ where: { workspaceId } });
    for (const value of [webhook, secret]) assert.ok(!JSON.stringify(stored).includes(value));

    const sends = [];
    let behavior = 'success';
    const localFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', (input, options) => {
      if (new URL(input).hostname !== 'open.feishu.cn') return localFetch(input, options);
      assert.equal(String(input), webhook);
      assert.equal(options.redirect, 'error');
      const { timestamp, sign, content } = JSON.parse(options.body);
      assert.equal(sign, createHmac('sha256', timestamp + '\n' + secret).digest('base64'));
      sends.push(content.text);
      if (behavior === 'throttle') return Promise.resolve(Response.json({ code: 11232 }));
      if (behavior === 'timeout') return Promise.reject(new Error('simulated timeout'));
      return Promise.resolve(Response.json({ code: 0 }));
    });
    const { data: draft } = await post(own + '/manuscripts', { title: '飞书测试稿', body: '提醒正文', tags: [] });
    await post(own + '/manuscripts/' + draft.id + '/assets', file(sourcePng));
    const { data: [variant] } = await post(own + '/manuscripts/' + draft.id + '/generate', { platforms: ['xiaohongshu'] });
    await post(own + '/variants/' + variant.id + '/confirm', {});
    const verified = await prisma.channelAccount.findFirstOrThrow({ where: { workspaceId, externalId: 'verified-fixture' } });
    const { data: { items } } = await post(own + '/tasks', {
      variantIds: [variant.id], accountIds: [verified.id, account.id], scheduledAt,
    });
    assert.equal(await worker.get(TasksService).dispatchDue(), 2);
    const first = items.find(({ accountId }) => accountId === verified.id);
    const second = items.find(({ accountId }) => accountId === account.id);
    const firstPath = own + '/tasks/' + first.id;
    const firstReady = () => prisma.notificationDelivery.findFirstOrThrow({ where: { taskId: first.id, kind: 'handoff_ready' } });
    const firstOverdue = await prisma.notificationDelivery.findFirstOrThrow({ where: { taskId: first.id, kind: 'overdue_reminder' } });
    assert.equal(firstOverdue.scheduledAt - (await firstReady()).scheduledAt, 4 * 60 * 60_000);
    const services = [worker.get(NotificationsService), api.get(NotificationsService)];
    behavior = 'throttle';
    await Promise.all(services.map((service) => service.deliverDue()));
    assert.equal(sends.length, 2);
    const retry = await firstReady();
    assert.equal(retry.status, 'pending');
    assert.equal(retry.attempts, 1);
    assert.ok(retry.nextAttemptAt > new Date(Date.now() + 55_000));
    await services[0].deliverDue();
    assert.equal(sends.length, 2);
    await prisma.notificationDelivery.update({ where: { id: retry.id }, data: { nextAttemptAt: new Date(0) } });
    behavior = 'success';
    await Promise.all(services.map((service) => service.deliverDue()));
    assert.equal(sends.length, 3);
    assert.equal((await firstReady()).status, 'sent');
    assert.match(sends.at(-1), /飞书测试稿/u);
    assert.ok(!sends.at(-1).includes('提醒正文'));

    const past = new Date(Date.now() - 4 * 60 * 60_000 - 1500);
    await prisma.publishTask.update({ where: { id: first.id }, data: { handedOffAt: past } });
    const due = new Date(past.getTime() + 4 * 60 * 60_000);
    await prisma.notificationDelivery.update({ where: { id: firstOverdue.id },
      data: { scheduledAt: due, nextAttemptAt: due, dedupeKey: 'overdue:' + past.toISOString() } });
    await services[0].deliverDue();
    assert.equal(sends.length, 4);
    assert.match(sends.at(-1), /4 小时仍未回填/u);
    const { data: detail } = await call(firstPath, { cookie });
    assert.deepEqual(detail.notificationDeliveries.map(({ status }) => status).sort(), ['sent', 'sent']);
    assert.ok(!JSON.stringify(detail).includes(webhook));

    const secondReady = await prisma.notificationDelivery.findFirstOrThrow({ where: { taskId: second.id, kind: 'handoff_ready' } });
    await prisma.notificationDelivery.update({ where: { id: secondReady.id }, data: { nextAttemptAt: new Date(0) } });
    behavior = 'timeout';
    await services[0].deliverDue();
    assert.equal(sends.length, 5);
    assert.equal((await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: secondReady.id } })).status, 'failed');
    const secondPath = own + '/tasks/' + second.id;
    await post(secondPath + '/result', { state: 'published', remoteUrl: 'https://example.test/feishu' }, 200);
    assert.equal((await call(secondPath, { cookie })).data.notificationDeliveries
      .find(({ kind }) => kind === 'overdue_reminder').status, 'skipped');
    await services[1].deliverDue();
    assert.equal(sends.length, 5);

    const seed = { taskId: first.id, workspaceId, kind: 'handoff_ready', scheduledAt: new Date(0) };
    const expired = await prisma.notificationDelivery.create({ data: { ...seed, dedupeKey: 'expired', nextAttemptAt: new Date(0) } });
    const interrupted = await prisma.notificationDelivery.create({ data: {
      ...seed, dedupeKey: 'interrupted', status: 'sending', attempts: 1, leaseId: randomUUID(), leaseExpiresAt: new Date(0),
    } });
    await patch({ enabled: false });
    await patch({ enabled: true });
    await services[1].deliverDue();
    assert.equal(sends.length, 5);
    assert.equal((await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: expired.id } })).status, 'skipped');
    const recovered = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: interrupted.id } });
    assert.equal(recovered.status, 'failed');
    assert.match(recovered.lastError, /投递结果未知/u);
  });
});
