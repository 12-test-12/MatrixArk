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
  process.env.NOTIFICATION_CREDENTIALS_KEY = '';
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

  await t.test('作品成效只统计已发布的真实作品，区分零与缺失，并限制写权限', async () => {
    const metricsPath = path + '/metrics';
    const performancePath = own + '/tasks/performance';
    await call(metricsPath, { method: 'PATCH', cookie, body: {}, status: 400 });
    await call(metricsPath, { method: 'PATCH', cookie, body: { views: -1 }, status: 400 });
    await call(own + '/tasks/' + future.items[0].id + '/metrics', { method: 'PATCH', cookie, body: { views: 2 }, status: 409 });
    await call(foreign + '/tasks/' + task.id + '/metrics', { method: 'PATCH', cookie: otherCookie, body: { views: 2 }, status: 404 });
    const membership = await prisma.membership.create({ data: { workspaceId, userId: other.user.id, role: 'viewer' } });
    try {
      await call(metricsPath, { method: 'PATCH', cookie: otherCookie, body: { views: 2 }, status: 403 });
      const { data: metrics } = await call(metricsPath, { method: 'PATCH', cookie, body: { views: 0, likes: 3 } });
      assert.equal(metrics.source, 'manual');
      assert.equal(metrics.views, 0);
      assert.equal(metrics.comments, null);
      assert.equal(metrics.recordedById, owner.user.id);
      const { data: performance } = await call(performancePath + '?platform=xiaohongshu&accountId=' + account.id, { cookie: otherCookie });
      assert.deepEqual(performance.items.map(({ id }) => id), [task.id]);
      assert.equal(performance.items[0].result.metrics.views, 0);
      assert.deepEqual(performance.summary, [
        { content: 'article', published: 1, tracked: 1, views: 0, likes: 3, comments: null, favorites: null, shares: null },
        { content: 'video', published: 0, tracked: 0, views: null, likes: null, comments: null, favorites: null, shares: null },
      ]);
      assert.equal((await call(performancePath + '?content=video', { cookie })).data.items.length, 0);
      assert.equal((await call(performancePath + '?platform=bilibili', { cookie })).data.items.length, 0);
      await call(metricsPath, { method: 'PATCH', cookie, body: { views: 19, likes: 6 } });
      const { data: history } = await call(metricsPath + '/history', { cookie: otherCookie });
      assert.deepEqual(history.map(({ views, comments, source }) => [views, comments, source]),
        [[0, null, 'manual'], [19, null, 'manual']]);
      assert.ok(history[0].recordedAt <= history[1].recordedAt);
      await call(foreign + '/tasks/' + task.id + '/metrics/history', { cookie: otherCookie, status: 404 });
      await post(metricsPath + '/sync', {}, 409);
    } finally {
      await prisma.membership.delete({ where: { id: membership.id } });
    }
  });

  await t.test('待发任务调期与取消保留原 ID，交接后仅负责人凭核对依据可取消和更正', async () => {
    const futurePath = own + '/tasks/' + future.items[0].id;
    const original = await prisma.publishTask.findUniqueOrThrow({ where: { id: future.items[0].id } });
    const newTime = new Date(Date.now() + 2 * 3600_000).toISOString();
    await call(futurePath + '/schedule', { method: 'PATCH', cookie, body: { scheduledAt: scheduledAt }, status: 400 });
    await call(foreign + '/tasks/' + original.id + '/schedule', { method: 'PATCH', cookie: otherCookie,
      body: { scheduledAt: newTime }, status: 404 });
    const change = () => call(futurePath + '/schedule', { method: 'PATCH', cookie, body: { scheduledAt: newTime } });
    const { data: changed } = await change();
    assert.equal(changed.id, original.id);
    assert.equal(changed.idempotencyKey, original.idempotencyKey);
    await change();
    const scheduleEvents = (await call(futurePath, { cookie })).data.events.filter(({ kind }) => kind === 'rescheduled');
    assert.equal(scheduleEvents.length, 1);
    assert.deepEqual(scheduleEvents[0].details, { previousScheduledAt: original.scheduledAt.toISOString(), scheduledAt: newTime });
    assert.equal(scheduleEvents[0].actorId, owner.user.id);

    const membership = await prisma.membership.create({ data: { workspaceId, userId: other.user.id, role: 'editor' } });
    try {
      await prisma.publishTask.update({ where: { id: original.id }, data: { scheduledAt: new Date(scheduledAt) } });
      assert.equal(await worker.get(TasksService).dispatchDue(), 1);
      await call(futurePath + '/cancel', { method: 'POST', cookie: otherCookie,
        body: { reason: '安排有误', verification: '核对尚未发布' }, status: 403 });
      await post(futurePath + '/cancel', { reason: '安排有误' }, 400);
      const { data: canceled } = await post(futurePath + '/cancel', { reason: '安排有误', verification: '查平台后台尚未发布' }, 200);
      assert.equal(canceled.canceledById, owner.user.id);
      await post(futurePath + '/cancel', { reason: '再次提交' }, 409);
      await post(futurePath + '/retry', { scheduledAt: newTime }, 409);
      const evidence = { state: 'published', reason: '运营反馈交接后实际已发布', remoteUrl: 'https://example.test/corrected' };
      await call(futurePath + '/result', { method: 'POST', cookie: otherCookie, body: evidence, status: 403 });
      await post(futurePath + '/result', { ...evidence, reason: ' ' }, 400);
      const { data: { assetId } } = await post(futurePath + '/evidence', file(png, '更正凭证.png'));
      const corrections = await Promise.all(Array.from({ length: 2 }, () => fetch(base + futurePath + '/result', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ...evidence, evidenceAssetId: assetId }),
      })));
      assert.deepEqual(corrections.map(({ status }) => status).sort(), [200, 409]);
      const { data: corrected } = await call(futurePath, { cookie });
      assert.equal(corrected.status, 'published');
      assert.equal(corrected.executionChannel, 'manual');
      assert.equal(corrected.idempotencyKey, original.idempotencyKey);
      assert.equal(corrected.canceledAt, null);
      assert.equal(corrected.result.evidenceAssetId, assetId);
      assert.ok(corrected.notificationDeliveries.every((delivery) => delivery.status === 'skipped'));
      const correctionsLogged = corrected.events.filter(({ kind }) => kind === 'corrected');
      assert.equal(correctionsLogged.length, 1);
      assert.equal(correctionsLogged[0].details.previous.cancelReason, '安排有误');
      assert.equal(correctionsLogged[0].details.previous.canceledById, owner.user.id);
      assert.equal(correctionsLogged[0].details.next.evidenceAssetId, assetId);
    } finally {
      await prisma.membership.delete({ where: { id: membership.id } });
    }
  });

  await t.test('结果不明必须先核对，原任务可重试一次并保留旧回执与截图', async () => {
    const { data: draft } = await post(own + '/manuscripts', { title: '核对与重试', body: '待发布内容' });
    const draftPath = own + '/manuscripts/' + draft.id;
    await post(draftPath + '/assets', file(sourcePng));
    const { data: [version] } = await post(draftPath + '/generate', { platforms: ['xiaohongshu'] });
    await post(own + '/variants/' + version.id + '/confirm', {});
    const { data: { items: [item] } } = await post(own + '/tasks',
      { accountIds: [account.id], variantIds: [version.id], scheduledAt });
    const taskPath = own + '/tasks/' + item.id;
    const newTime = new Date(Date.now() + 3 * 3600_000).toISOString();
    const original = await prisma.publishTask.findUniqueOrThrow({ where: { id: item.id } });
    const dispatch = worker.get(TasksService);
    assert.equal(await dispatch.dispatchDue(), 1);
    const { data: { assetId: previousEvidence } } = await post(taskPath + '/evidence', file(png, '首次核对.png'));
    await post(taskPath + '/result', { state: 'unknown', note: '结果未知', evidenceAssetId: previousEvidence }, 200);
    await post(taskPath + '/retry', { scheduledAt: newTime }, 409);
    await post(taskPath + '/verify', { outcome: 'unresolved', reason: '暂未找到原作品，继续查看后台' }, 200);
    assert.equal((await call(taskPath, { cookie })).data.status, 'unknown');
    await post(taskPath + '/verify', { outcome: 'published', reason: '查到作品' }, 400);
    await post(taskPath + '/verify', { outcome: 'not_received', reason: '核对后台和操作记录，确认未发布' }, 200);
    const retries = await Promise.all(Array.from({ length: 2 }, () => fetch(base + taskPath + '/retry', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ scheduledAt: newTime }),
    })));
    assert.deepEqual(retries.map(({ status }) => status).sort(), [200, 409]);
    const { data: retried } = await call(taskPath, { cookie });
    assert.equal(retried.idempotencyKey, original.idempotencyKey);
    assert.equal(retried.handedOffAt, null);
    assert.equal(retried.result.evidenceAssetId, previousEvidence);
    assert.equal(retried.events.filter(({ kind }) => kind === 'retried').length, 1);
    await prisma.publishTask.update({ where: { id: item.id }, data: { scheduledAt: new Date(scheduledAt) } });
    assert.equal(await dispatch.dispatchDue(), 1);
    await post(taskPath + '/result', { state: 'failed', note: '确认第二次失败' }, 200);
    await post(taskPath + '/retry', { scheduledAt: newTime }, 409);
    await post(taskPath + '/result', { state: 'published', reason: '补发成功', remoteUrl: 'https://example.test/published' }, 200);
    const { data: finished } = await call(taskPath, { cookie });
    assert.equal(finished.status, 'published');
    const secondResult = finished.events.filter((event) => event.fromStatus === 'handed_off' && event.kind === 'result').at(-1);
    assert.equal(secondResult.actorId, owner.user.id);
    assert.equal(secondResult.details.previous.evidenceAssetId, previousEvidence);
    const historical = await fetch(base + taskPath + '/evidence?assetId=' + previousEvidence, { headers: { cookie } });
    assert.equal(historical.status, 200);
    assert.deepEqual(Buffer.from(await historical.arrayBuffer()), png);
  });

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

  await t.test('旧稿可分页审核，退回与确认互斥，作者修改后重新送审', async (reviewTest) => {
    const membership = await prisma.membership.create({
      data: { workspaceId, userId: other.user.id, role: 'viewer' },
    });
    reviewTest.after(() => prisma.membership.delete({ where: { id: membership.id } }));
    const oldTime = new Date('2020-01-01T00:00:00.000Z');
    const draftData = { workspaceId, createdById: owner.user.id, title: '旧待审核稿', body: '待修改正文', createdAt: oldTime };
    const old = await prisma.manuscript.create({ data: draftData });
    const sameTime = await prisma.manuscript.create({ data: { ...draftData, title: '同刻待审核稿' } });
    await prisma.manuscript.createMany({ data: Array.from({ length: 101 }, (_, index) => ({
      ...draftData, createdAt: new Date('2021-01-01T00:00:00.000Z'), title: `新原稿 ${index}`,
    })) });
    const generate = async (id) => (await post(`${own}/manuscripts/${id}/generate`, { platforms: ['bilibili'] })).data[0];
    const version = await generate(old.id);
    const sibling = await generate(sameTime.id);
    const path = own + '/variants/' + version.id;
    const list = (query, session = cookie, status = 200) => call(own + '/manuscripts?' + query, { cookie: session, status });
    assert.ok(!(await list('')).data.some(({ id }) => id === old.id));
    const first = await list('review=pending&limit=1', otherCookie);
    assert.ok(first.data.nextCursor);
    await list('review=returned&cursor=' + first.data.nextCursor, otherCookie, 400);
    await call(foreign + '/manuscripts?review=pending&cursor=' + first.data.nextCursor, { cookie: otherCookie, status: 400 });
    const ids = [];
    let page = first.data;
    while (true) {
      ids.push(...page.items.map(({ id }) => id));
      if (!page.nextCursor) break;
      assert.ok(ids.length < 20);
      page = (await list('review=pending&limit=1&cursor=' + page.nextCursor, otherCookie)).data;
    }
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids.slice(-2), [old.id, sameTime.id].sort().reverse());

    const reject = (target, reason, session, status) => call(target + '/reject', {
      cookie: session, method: 'POST', body: { reason }, status,
    });
    await reject(path, '调整标题', otherCookie, 403);
    await prisma.membership.update({ where: { id: membership.id }, data: { role: 'reviewer' } });
    await reject(foreign + '/variants/' + version.id, '跨工作室', otherCookie, 404);
    await reject(path, '  ', otherCookie, 400);
    const { data: rejected } = await reject(path, '  调整标题  ', otherCookie, 201);
    assert.equal(rejected.reason, '调整标题');
    assert.equal(rejected.reviewerId, other.user.id);
    assert.ok(rejected.createdAt);
    await reject(path, '重复退回', otherCookie, 409);
    await post(path + '/confirm', {}, 409);
    assert.ok(!(await list('review=pending')).data.items.some(({ id }) => id === old.id));
    assert.deepEqual((await list('review=returned')).data.items.map(({ id }) => id), [old.id]);
    assert.deepEqual((await list('review=returned', otherCookie)).data.items, []);
    const detail = () => call(own + '/manuscripts/' + old.id, { cookie });
    const { data: returned } = await detail();
    assert.equal(returned.variants[0].returned, true);
    assert.deepEqual(returned.variants[0].rejections, [rejected]);
    const { data: { variant: revised } } = await call(path, { cookie, method: 'PATCH', body: { title: '修订后标题' } });
    assert.ok((await list('review=pending')).data.items.some(({ id }) => id === old.id));
    assert.deepEqual((await list('review=returned')).data.items, []);
    await post(own + '/variants/' + revised.id + '/confirm', {});
    await reject(own + '/variants/' + revised.id, '已确认', otherCookie, 409);
    assert.deepEqual((await detail()).data.variants.find(({ id }) => id === version.id).rejections, [rejected]);

    const siblingPath = base + own + '/variants/' + sibling.id;
    const [confirmed, declined] = await Promise.all([
      fetch(siblingPath + '/confirm', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' }),
      fetch(siblingPath + '/reject', { method: 'POST', headers: { cookie: otherCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ reason: '并发退回' }) }),
    ]);
    assert.deepEqual([confirmed.status, declined.status].sort(), [201, 409]);
    await Promise.all([confirmed.json(), declined.json()]);
  });

  await t.test('只能通过小红书官方身份核验新增账号', async (test) => {
    let approved = false;
    let webScanEnabled = false;
    const settingsPath = own + '/accounts/platform-settings';
    const settingsSecret = 'xiaohongshu-workspace-test-secret';
    const application = { appId: process.env.XIAOHONGSHU_APP_ID, appSecret: settingsSecret };
    await call(settingsPath + '/xiaohongshu', { cookie: otherCookie, method: 'PATCH', body: application, status: 403 });
    await call(settingsPath + '/xiaohongshu', { cookie, method: 'PATCH', body: { ...application, appSecret: '' }, status: 400 });
    assert.deepEqual((await call(settingsPath + '/xiaohongshu', { cookie, method: 'PATCH', body: application })).data,
      { configured: true });
    assert.deepEqual((await call(settingsPath, { cookie })).data,
      { xiaohongshu: true, bilibili: true, bilibiliSandbox: false });
    const storedApp = await prisma.platformAppSetting.findUniqueOrThrow({
      where: { workspaceId_platform: { workspaceId, platform: 'xiaohongshu' } },
    });
    assert.equal(storedApp.updatedById, owner.user.id);
    assert.ok(!storedApp.secretCiphertext.includes(settingsSecret));
    await call(settingsPath + '/xiaohongshu', {
      cookie, method: 'PATCH', body: { ...application, appId: 'a-different-app' }, status: 409,
    });
    const localFetch = globalThis.fetch;
    test.mock.method(globalThis, 'fetch', (input, options) => {
      const url = new URL(input);
      if (url.origin !== 'https://openaccount.xiaohongshu.com') return localFetch(input, options);
      const body = JSON.parse(options.body);
      const result = (data) => Response.json({ code: 0, success: true, data });
      switch (url.pathname.split('/').at(-1)) {
        case 'code':
          assert.deepEqual(body.scopes, ['basic_info']);
          assert.equal(body.app_secret, settingsSecret);
          if (!webScanEnabled) return Response.json({ code: 37007, success: false, data: null });
          return result({
            device_code: 'private-device-fixture',
            verification_uri_complete: 'https://openaccount.xiaohongshu.com/device?user_code=ABCD-EFGH',
            user_code: 'ABCD-EFGH', expires_in: 600, interval: 1,
          });
        case 'token':
          assert.equal(body.app_secret, settingsSecret);
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
    assert.match((await post(path, {}, 409)).data.message, /尚未开通 Web 扫码/u);
    webScanEnabled = true;
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
    let appSecret = process.env.BILIBILI_CLIENT_SECRET;
    const token = 'bili-token-fixture';
    t.mock.method(https, 'request', (input, options, callback) => {
      const url = new URL(input);
      assert.equal(url.origin, 'https://member.bilibili.com');
      const { headers, method } = options;
      assert.equal(headers['Access-Token'], token);
      assert.equal(headers['x-bili-content-md5'], 'd41d8cd98f00b204e9800998ecf8427e');
      const signed = Object.keys(headers).filter((key) => key.startsWith('x-bili-')).sort();
      const payload = signed.map((key) => key + ':' + headers[key]).join('\n');
      assert.equal(headers.Authorization, createHmac('sha256', appSecret).update(payload).digest('hex'));
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
                data = { '5467': { id: 5467, state: pollCount === 1 ? 1 : 0, publish_time: pollCount === 1 ? 0 : 1638521942,
                  stats: { view: 1500, reply: 0, like: 12, favorite: 7 } } };
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
    const { data: stats } = await post(path + '/metrics/sync', {}, 200);
    assert.equal(stats.source, 'platform');
    assert.equal(stats.views, 1500);
    assert.equal(stats.comments, 0);
    assert.equal(stats.shares, null);
    assert.equal((await call(path + '/metrics/history', { cookie })).data[0].source, 'platform');
    const { data: performance } = await call(own + '/tasks/performance?platform=bilibili&content=article', { cookie });
    assert.equal(performance.items.find((item) => item.id === task.id).result.metrics.favorites, 7);
    assert.equal(performance.summary[0].views, 1500);

    const unknown = await scheduleArticle('缺少文章 ID');
    incomplete = true;
    assert.equal(await dispatch.dispatchDue(), 1);
    assert.equal(await replica.dispatchDue(), 0);
    const unknownResult = await prisma.publishResult.findUniqueOrThrow({ where: { taskId: unknown.id } });
    assert.equal(unknownResult.state, 'unknown');
    assert.equal(unknownResult.remoteId, null);
    assert.equal(submissionCount, 2);
    const unknownPath = own + '/tasks/' + unknown.id;
    const futureTime = new Date(Date.now() + 3_600_000).toISOString();
    await post(unknownPath + '/retry', { scheduledAt: futureTime }, 409);
    await post(unknownPath + '/verify', { outcome: 'accepted', reason: '在 B 站找到了投稿', remoteId: '5467' }, 200);
    assert.equal((await call(unknownPath, { cookie })).data.result.remoteId, '5467');
    await prisma.publishTask.update({ where: { id: unknown.id }, data: { updatedAt: new Date(0) } });
    await dispatch.pollAutomaticResults();
    assert.equal((await call(unknownPath, { cookie })).data.status, 'published');
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
    await post(own + '/tasks/' + late.id + '/verify', { outcome: 'not_received', reason: '尝试核对' }, 409);
    assert.equal(submissionCount, 3);

    appSecret = 'bilibili-workspace-test-secret';
    const { config } = await import('../dist/config.js');
    config.bilibili.enabled = false;
    t.after(() => { config.bilibili.enabled = true; });
    await call(own + '/accounts/platform-settings/bilibili', { cookie, method: 'PATCH',
      body: { appId: process.env.BILIBILI_CLIENT_ID, appSecret } });
    assert.deepEqual((await call(foreign + '/accounts/platform-settings', { cookie: otherCookie })).data,
      { xiaohongshu: true, bilibili: false, bilibiliSandbox: false });
    const bind = own + '/accounts/bilibili/bind';
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await post(bind, { accessToken: token, expiresAt }, 502);
    matchingIdentity = true;
    assert.deepEqual((await post(bind, { accessToken: token, expiresAt })).data, { id });
    const managedAccount = await prisma.channelAccount.findUniqueOrThrow({ where: { id } });
    assert.equal(managedAccount.credentialsKeyId, 'platform-local-v1');
    assert.ok(!managedAccount.credentialsCiphertext.includes(token));
    assert.equal(bilibiliCredentials({ ...managedAccount, workspaceId: other.workspaces[0].id }), undefined);
    assert.equal((await call(own + '/accounts', { cookie })).data.find((account) => account.id === id).availableForOfficial, true);
    lateTaskId = undefined;
    const managedTask = await scheduleArticle('网页配置后的专栏');
    assert.equal(await dispatch.dispatchDue(), 1);
    assert.equal((await call(own + '/tasks/' + managedTask.id, { cookie })).data.status, 'submitted');
    await prisma.publishTask.update({ where: { id: managedTask.id }, data: { updatedAt: new Date(0) } });
    await dispatch.pollAutomaticResults();
    assert.equal((await call(own + '/tasks/' + managedTask.id, { cookie })).data.status, 'published');

    await prisma.platformAppSetting.delete({ where: { workspaceId_platform: { workspaceId, platform: 'bilibili' } } });
    const stranded = await scheduleArticle('应用凭据缺失的专栏');
    assert.equal(await dispatch.dispatchDue(), 0);
    const paused = (await call(own + '/tasks/' + stranded.id, { cookie })).data;
    assert.equal(paused.status, 'paused');
    assert.match(paused.lastError, /应用凭据不可用/u);
    const pausedPath = own + '/tasks/' + stranded.id;
    await post(pausedPath + '/resume', { scheduledAt: futureTime }, 409);
    await call(own + '/accounts/platform-settings/bilibili', { cookie, method: 'PATCH',
      body: { appId: process.env.BILIBILI_CLIENT_ID, appSecret } });
    const { data: resumed } = await post(pausedPath + '/resume', { scheduledAt: futureTime }, 200);
    assert.equal(resumed.id, stranded.id);
    assert.equal(resumed.status, 'scheduled');
    await post(pausedPath + '/cancel', { reason: '结束恢复验收' }, 200);

    const delayed = await scheduleArticle('核对后收到迟到回执');
    const delayedPath = own + '/tasks/' + delayed.id;
    incomplete = true;
    assert.equal(await dispatch.dispatchDue(), 1);
    await post(delayedPath + '/verify', { outcome: 'not_received', reason: '当时后台尚无投稿记录' }, 200);
    await post(delayedPath + '/retry', { scheduledAt: futureTime }, 200);
    await prisma.taskEvent.create({ data: { workspaceId, taskId: delayed.id, kind: 'late_receipt',
      details: { state: 'submitted', remoteId: '5467' } } });
    await prisma.publishTask.update({ where: { id: delayed.id }, data: { scheduledAt: new Date(scheduledAt) } });
    const attempts = submissionCount;
    assert.equal(await dispatch.dispatchDue(), 0);
    assert.equal(submissionCount, attempts);
    assert.equal((await call(delayedPath, { cookie })).data.status, 'unknown');

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
      enabled: true, webhookConfigured: true, signatureConfigured: true,
    });
    const stored = await prisma.notificationSetting.findUniqueOrThrow({ where: { workspaceId } });
    assert.equal(stored.webhookKeyId, 'notification-local-v1');
    assert.equal(stored.signSecretKeyId, 'notification-local-v1');
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

    await call(path + '/test', { method: 'POST', cookie: otherCookie, body: {}, status: 403 });
    await post(path + '/test', {}, 400);
    behavior = 'success';
    assert.deepEqual((await post(path + '/test', {}, 200)).data, { sent: true });
    assert.match(sends.at(-1), /MatrixArk 测试提醒/u);
  });

  await t.test('登录用户可更正姓名和邮箱，换邮箱校验当前密码', async () => {
    await call('/auth/me', { method: 'PATCH', body: { name: '改名', email: owner.user.email }, status: 401 });
    const edit = (body, status = 200) => call('/auth/me', { method: 'PATCH', cookie, body, status });
    const changed = { name: '新的负责人姓名', email: 'changed-owner@example.test' };
    await edit(changed, 400);
    await edit({ ...changed, currentPassword: 'incorrect' }, 400);
    await edit({ ...changed, email: other.user.email, currentPassword: 'fixture-password' }, 409);
    const { data: saved } = await edit({ ...changed, currentPassword: 'fixture-password' });
    assert.deepEqual(saved, { id: owner.user.id, ...changed });
    assert.deepEqual((await call('/auth/me', { cookie })).data.user, saved);
    assert.equal((await call('/auth/me', { cookie: otherCookie })).data.user.email, other.user.email);
  });

  await t.test('稿件和账号归档可恢复，暂停待发任务并保留历史版本及回执', async () => {
    const platform = 'bilibili';
    const archivedCandidate = await prisma.channelAccount.create({
      data: { workspaceId, platform, channelKind: 'manual', displayName: '归档夹具账号',
        externalId: 'archive-account-fixture', authCheckedAt: new Date(), authStatus: 'active' },
    });
    async function createTask(title, at) {
      const { data: draft } = await post(own + '/manuscripts', { title, body: '归档测试正文', tags: [] });
      const path = own + '/manuscripts/' + draft.id;
      const { data: asset } = await post(path + '/assets', file(sourcePng));
      const { data: [variant] } = await post(path + '/generate', { platforms: [platform] });
      await post(own + '/variants/' + variant.id + '/confirm', {});
      const { data: { items: [task] } } = await post(own + '/tasks', {
        variantIds: [variant.id], accountIds: [archivedCandidate.id], scheduledAt: at,
      });
      return { draft, variant, task, asset, path };
    }
    const historical = await createTask('历史发布稿', scheduledAt);
    assert.equal(await worker.get(TasksService).dispatchDue(), 1);
    const historyPath = own + '/tasks/' + historical.task.id;
    await post(historyPath + '/result', { state: 'published', remoteUrl: 'https://example.test/archive-history' }, 200);
    const future = await createTask('放弃待发原稿', new Date(Date.now() + 60_000).toISOString());
    const accountPath = own + '/accounts/' + archivedCandidate.id;
    await call(accountPath, { method: 'DELETE', cookie, status: 409 });
    await call(future.path, { method: 'DELETE', cookie });
    await call(future.path, { method: 'DELETE', cookie });
    const { data: paused } = await call(own + '/tasks/' + future.task.id, { cookie });
    assert.equal(paused.status, 'paused');
    assert.equal(paused.events.filter(({ kind }) => kind === 'paused').length, 1);
    await call(future.path, { method: 'PATCH', cookie, body: { title: '归档稿件不可编辑' }, status: 409 });
    await post(future.path + '/assets', file(sourcePng), 409);
    await call(historical.path, { method: 'DELETE', cookie });
    await call(accountPath, { method: 'DELETE', cookie });
    assert.equal((await call(own + '/accounts', { cookie })).data.some(({ id }) => id === archivedCandidate.id), false);
    assert.equal((await call(own + '/accounts?archived=true', { cookie })).data.some(({ id }) => id === archivedCandidate.id), true);
    const duplicate = await prisma.channelAccount.create({
      data: { workspaceId, platform, channelKind: 'manual', displayName: '归档夹具账号',
        externalId: 'archive-account-duplicate', authCheckedAt: new Date(), authStatus: 'active' },
    });
    await call(accountPath + '/restore', { method: 'PATCH', cookie, status: 409 });
    await prisma.channelAccount.delete({ where: { id: duplicate.id } });
    assert.equal((await call(own + '/manuscripts', { cookie })).data.some(({ id }) => id === historical.draft.id), false);
    assert.equal((await call(own + '/manuscripts?archived=true', { cookie })).data.some(({ id }) => id === historical.draft.id), true);
    assert.equal((await call(historyPath, { cookie })).data.result.remoteUrl, 'https://example.test/archive-history');
    const { data: handoff } = await call(historyPath + '/handoff', { cookie });
    assert.equal(handoff.assets[0].assetId, historical.asset.id);
    await call(future.path + '/restore', { method: 'PATCH', cookie });
    await call(accountPath + '/restore', { method: 'PATCH', cookie });
    assert.equal((await call(own + '/tasks/' + future.task.id, { cookie })).data.status, 'paused');
    assert.equal((await call(future.path, { cookie })).data.archivedAt, null);
    assert.equal((await call(own + '/accounts', { cookie })).data.find(({ id }) => id === archivedCandidate.id).availableForHandoff, true);
  });

  await t.test('一份视频可用于两个平台版本，换片时保留历史交接并暂停旧待发任务', async () => {
    const { data: draft } = await post(own + '/manuscripts', { title: '共用视频', body: '视频简介', tags: [] });
    const source = own + '/manuscripts/' + draft.id;
    const { data: cover } = await post(source + '/assets', file(sourcePng));
    function box(type, payload) {
      const header = Buffer.alloc(8);
      header.writeUInt32BE(header.length + payload.length);
      header.write(type, 4, 'ascii');
      return Buffer.concat([header, payload]);
    }
    const video = (value) => Buffer.concat([
      box('ftyp', Buffer.from('isom\0\0\0\0mp42')), box('moov', Buffer.from('fixture')),
      box('mdat', Buffer.alloc(16, value)),
    ]);
    async function upload(bytes, want = 200) {
      const response = await fetch(base + source + '/video?filename=' + encodeURIComponent('共用视频.mp4'), {
        method: 'PUT', headers: { cookie, 'content-type': 'video/mp4', 'x-video-size': String(bytes.length) }, body: bytes,
      });
      const result = await response.json();
      assert.equal(response.status, want, JSON.stringify(result));
      return result;
    }
    await upload(Buffer.from('fake mp4'), 415);
    const uploaded = await upload(video(1));
    assert.equal((await upload(video(1))).changed, false);
    const assetPath = own + '/assets/' + uploaded.video.id + '/video';
    const bytes = await fetch(base + assetPath, { headers: { cookie, range: 'bytes=0-7' } });
    assert.equal(bytes.status, 206);
    assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), video(1).subarray(0, 8));
    await call(foreign + '/assets/' + uploaded.video.id + '/video', { cookie: otherCookie, status: 404 });
    const { data: variants } = await post(source + '/generate', { platforms: ['bilibili', 'xiaohongshu'] });
    for (const item of variants) {
      assert.equal(item.videoAsset.id, uploaded.video.id);
      assert.equal(item.assets[0].assetId, cover.id);
      await post(own + '/variants/' + item.id + '/confirm', {});
    }
    const accounts = await prisma.channelAccount.findMany({ where: {
      workspaceId, channelKind: 'manual', archivedAt: null, authCheckedAt: { not: null },
      displayName: { in: ['人工测试账号', '专栏人工账号'] },
    } });
    assert.equal(accounts.length, 2);
    const { data: queued } = await post(own + '/tasks', { variantIds: variants.map(({ id }) => id),
      accountIds: accounts.map(({ id }) => id), scheduledAt: new Date(Date.now() + 5 * 60_000).toISOString() });
    assert.equal(queued.items.length, 2);
    const initialTask = queued.items[0];
    await prisma.publishTask.update({ where: { id: initialTask.id }, data: { scheduledAt: new Date(0) } });
    assert.equal(await worker.get(TasksService).dispatchDue(), 1);
    const replacement = await upload(video(2));
    assert.equal(replacement.pausedTaskCount, 1);
    const { data: revised } = await call(source, { cookie });
    assert.equal(revised.assets.length, 1);
    assert.equal(revised.videoAsset.id, replacement.video.id);
    const drafts = revised.variants.filter(({ status }) => status === 'draft');
    assert.equal(drafts.length, 2);
    assert.ok(drafts.every(({ videoAsset }) => videoAsset.id === replacement.video.id));
    const { data: handoff } = await call(own + '/tasks/' + initialTask.id + '/handoff', { cookie });
    assert.equal(handoff.video.id, uploaded.video.id);
    await assert.rejects(prisma.variant.update({ where: { id: variants[0].id }, data: { videoAssetId: replacement.video.id } }));
  });
});
