import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import prismaClient from '@prisma/client';

test('原样保存保留审批与排期，换图才暂停旧任务，历史版本仍可重审', async (t) => {
  const url = process.env.DATABASE_URL;
  assert(url && new URL(url).pathname === '/matrixark_upgrade_test', 'Use infra/ci/check-database.sh');
  const { ContentService } = await import('../dist/content/content.service.js');
  const { VariantsController } = await import('../dist/content/variants.controller.js');
  const prisma = new prismaClient.PrismaClient({ datasourceUrl: url });
  t.after(() => prisma.$disconnect());
  const content = new ContentService(prisma);
  const controller = new VariantsController(prisma, content);
  const manuscript = await prisma.manuscript.findUniqueOrThrow({
    where: { id: 'legacy-ms' },
    include: { createdBy: true },
  });
  const { id: manuscriptId, workspaceId, createdBy: user } = manuscript;
  const editor = { role: 'owner' };
  const revise = (id, body) => controller.revise(editor, workspaceId, id, user, body);
  const confirm = (id, note) => controller.confirm(editor, workspaceId, id, user, { note });

  const createImage = (name) => prisma.asset.create({
    data: {
      workspaceId,
      manuscriptId,
      kind: 'manuscript_image',
      storageKey: `${workspaceId}/${name}.png`,
      filename: `${name}.png`,
      mimeType: 'image/png',
      size: 100,
    },
  });
  await createImage('first');
  const [variant] = await content.generateDrafts({
    workspaceId, manuscriptId, userId: user.id, platforms: ['xiaohongshu'],
  });
  const { approval } = await confirm(variant.id, '首次确认');
  assert.equal(approval.snapshotHash, variant.contentHash);
  assert.deepEqual((await confirm(variant.id, '重复确认')).approval, approval);
  const account = await prisma.channelAccount.create({
    data: { workspaceId, platform: 'xiaohongshu', channelKind: 'manual', displayName: '测试账号' },
  });
  const task = await prisma.publishTask.create({
    data: {
      workspaceId, accountId: account.id, variantId: variant.id, variantContentHash: variant.contentHash,
      scheduledAt: new Date(), createdById: user.id, idempotencyKey: 'snapshot-test',
    },
  });

  await assert.rejects(revise(variant.id, {}), { status: 400 });
  await assert.rejects(revise(variant.id, { note: '只填备注' }), { status: 400 });
  await assert.rejects(revise(variant.id, { title: variant.title, assetIds: variant.assets.map((asset) => asset.assetId) }),
    (error) => error.status === 400 && error.getResponse().code === 'variant_unchanged');
  const current = await prisma.variant.findUniqueOrThrow({ where: { id: variant.id }, include: { approval: true } });
  assert.equal(current.status, 'approved');
  assert.deepEqual(current.approval, approval);
  assert.equal(await prisma.variant.count({ where: { manuscriptId, platform: 'xiaohongshu' } }), 1);
  assert.equal((await prisma.publishTask.findUniqueOrThrow({ where: { id: task.id } })).status, 'scheduled');
  assert.equal(await prisma.taskEvent.count({ where: { taskId: task.id } }), 0);

  const otherImage = await createImage('second');
  const edited = await revise(variant.id, { assetIds: [otherImage.id] });
  assert.equal(edited.pausedTaskCount, 1);
  assert.equal(edited.variant.version, variant.version + 1);
  assert.notEqual(edited.variant.contentHash, variant.contentHash);
  assert.equal(edited.variant.approval, null);
  assert.deepEqual(edited.variant.assets, [{ assetId: otherImage.id, position: 0, isCover: true }]);
  assert.equal((await prisma.variant.findUniqueOrThrow({ where: { id: variant.id } })).status, 'superseded');
  assert.equal((await prisma.publishTask.findUniqueOrThrow({ where: { id: task.id } })).status, 'paused');
  const events = await prisma.taskEvent.findMany({ where: { taskId: task.id } });
  assert.deepEqual(events.map(({ kind, actorId }) => [kind, actorId]), [['paused', user.id]]);
  assert.equal((await confirm(edited.variant.id)).approval.snapshotHash, edited.variant.contentHash);

  await assert.rejects(confirm('legacy-version'), { status: 409 });
  const restored = (await revise('legacy-version', { assetIds: [otherImage.id], coverAssetId: null })).variant;
  assert.equal(restored.snapshotVersion, 1);
  assert.equal(restored.approval, null);
  assert.equal((await prisma.approval.findUniqueOrThrow({ where: { variantId: 'legacy-version' } })).snapshotHash, null);
  assert.equal((await confirm(restored.id)).approval.snapshotHash, restored.contentHash);
  await assert.rejects(revise(restored.id, { assetIds: [otherImage.id] }),
    (error) => error.status === 400 && error.getResponse().code === 'variant_unchanged');
});
