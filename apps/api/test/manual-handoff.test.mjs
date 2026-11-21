import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import sharp from 'sharp';

test('单账号排期去重、并发交接、回填及截图隔离', async (t) => {
  const url = process.env.DATABASE_URL;
  assert(url && new URL(url).pathname === '/matrixark_upgrade_test' && process.env.STORAGE_LOCAL_DIR,
    'Use infra/ci/check-database.sh');
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

  const { data: account } = await post(own + '/accounts', {
    platform: 'xiaohongshu', channelKind: 'manual', displayName: '人工测试账号',
  });
  const { data: manuscript } = await post(own + '/manuscripts', { title: '审核标题', body: '已审核正文', tags: ['样例'] });
  const source = own + '/manuscripts/' + manuscript.id;
  const filename = '稿件封面 Café 🌿.png';
  const { data: image } = await post(source + '/assets', file(sourcePng, filename));
  assert.equal(image.filename, filename);
  const prisma = api.get(PrismaService);
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
    const { data: bilibili } = await post(own + '/accounts', {
      platform: 'bilibili', channelKind: 'manual', displayName: '专栏人工账号',
    });
    const { data: official } = await post(own + '/accounts', {
      platform: 'bilibili', channelKind: 'official', displayName: '专栏官方账号',
    });
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
});
