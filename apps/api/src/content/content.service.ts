import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { GenerationSource, Manuscript, Platform, Prisma, Variant } from '@prisma/client';
import {
  PLATFORM_LABELS,
  contentHash,
  generateVariantDraft,
  validateVariant,
  type updateManuscriptSchema,
  type updateVariantSchema,
} from '@matrixark/shared';
import type { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';

export const variantSnapshot = {
  approval: true,
  videoAsset: { select: { id: true, filename: true, size: true } },
  assets: {
    orderBy: { position: 'asc' },
    select: { assetId: true, position: true, isCover: true },
  },
} as const satisfies Prisma.VariantInclude;

export const variantRejections = {
  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  select: { id: true, reviewerId: true, reviewer: { select: { name: true } }, reason: true, createdAt: true },
} as const satisfies Prisma.Variant$rejectionsArgs;

type Snapshot = Prisma.VariantGetPayload<{ include: typeof variantSnapshot }>;
type ImageScope = Pick<Manuscript, 'id' | 'workspaceId'>;

const imageTypes = ['image/jpeg', 'image/png', 'image/webp'];
const pauseReason = '旧版本已被取代，须确认新版本后重新排期';

export function inspectSnapshot(variant: Snapshot) {
  const imageCount = variant.assets.length;
  const issues = validateVariant(variant.platform, { ...variant, imageCount });
  const invalidOrder = variant.assets.some(({ position }, index) => position !== index);
  const invalidCover = variant.platform === 'xiaohongshu' && imageCount > 0 && !variant.assets[0]?.isCover;
  if (variant.videoAssetId && !variant.assets.some(({ isCover }) => isCover)) {
    issues.push({ field: 'images', code: 'video_cover_required', message: '视频稿件需要选择封面' });
  }
  if (variant.snapshotVersion !== 1 || !variant.sealedAt) {
    issues.push({ field: 'snapshot', code: 'snapshot_required', message: '请保存为新版本后重新确认' });
  } else if (invalidOrder || invalidCover || contentHash(variant) !== variant.contentHash) {
    issues.push({ field: 'snapshot', code: 'snapshot_mismatch', message: '版本快照与内容指纹不一致' });
  }
  return { issues, imageCount };
}

@Injectable()
export class ContentService {
  constructor(private readonly prisma: PrismaService) {}

  async lockManuscript(tx: Prisma.TransactionClient, workspaceId: string, id: string, allowArchived = false) {
    const [manuscript] = await tx.$queryRaw<Manuscript[]>`
      SELECT * FROM "Manuscript" WHERE "workspaceId" = ${workspaceId} AND id = ${id} FOR UPDATE
    `;
    if (!manuscript) throw new NotFoundException('稿件不存在');
    if (manuscript.archivedAt && !allowArchived) throw new ConflictException('请先恢复已归档稿件');
    return manuscript;
  }

  async updateManuscript(workspaceId: string, id: string, input: z.infer<typeof updateManuscriptSchema>) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockManuscript(tx, workspaceId, id);
      return tx.manuscript.update({ where: { id }, data: input });
    });
  }

  async archiveManuscript(workspaceId: string, id: string, userId: string, archive: boolean) {
    return this.prisma.$transaction(async (tx) => {
      const manuscript = await this.lockManuscript(tx, workspaceId, id, true);
      if (archive === Boolean(manuscript.archivedAt)) return { ok: true };
      await tx.manuscript.update({ where: { id }, data: {
        archivedAt: archive ? new Date() : null, archivedById: archive ? userId : null,
      } });
      if (archive) {
        await this.pauseScheduledTasks(tx, workspaceId, { variant: { manuscriptId: id } }, '原稿已归档，待发任务已暂停', userId);
      }
      return { ok: true };
    });
  }

  private async pauseScheduledTasks(tx: Prisma.TransactionClient, workspaceId: string,
    target: Prisma.PublishTaskWhereInput, reason: string, userId: string) {
    const paused = await tx.publishTask.updateManyAndReturn({
      where: { ...target, workspaceId, status: 'scheduled' },
      data: { status: 'paused', lastError: reason },
      select: { id: true },
    });
    if (paused.length) await tx.taskEvent.createMany({
      data: paused.map(({ id: taskId }) => ({ workspaceId, taskId, kind: 'paused',
        fromStatus: 'scheduled', toStatus: 'paused', actorId: userId, reason })),
    });
    return paused.length;
  }

  private async lockCurrentVariant(tx: Prisma.TransactionClient, workspaceId: string, id: string) {
    const existing = await tx.variant.findFirst({
      where: { id, workspaceId },
      select: { manuscriptId: true },
    });
    if (!existing) throw new NotFoundException('版本不存在');
    await this.lockManuscript(tx, workspaceId, existing.manuscriptId);
    await tx.$queryRaw`
      SELECT id FROM "Variant" WHERE "workspaceId" = ${workspaceId} AND id = ${id} FOR UPDATE
    `;
    const variant = await this.findSnapshot(tx, workspaceId, id);
    if (variant.status === 'superseded') throw new ConflictException('该版本已被取代，请使用最新版本');
    return variant;
  }

  private async findSnapshot(tx: Prisma.TransactionClient, workspaceId: string, id: string) {
    const variant = await tx.variant.findFirst({ where: { id, workspaceId }, include: variantSnapshot });
    if (!variant) throw new NotFoundException('版本不存在');
    return variant;
  }

  private async manuscriptImages(tx: Prisma.TransactionClient, manuscript: ImageScope, assetIds?: string[]) {
    return tx.asset.findMany({
      where: {
        workspaceId: manuscript.workspaceId,
        manuscriptId: manuscript.id,
        kind: 'manuscript_image',
        mimeType: { in: imageTypes },
        id: assetIds && { in: assetIds },
      },
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  private async createVersion(
    tx: Prisma.TransactionClient,
    manuscript: ImageScope,
    platform: Platform,
    input: Pick<Variant, 'title' | 'body' | 'tags'> & {
      assetIds: string[];
      coverAssetId: string | null;
      platformFields: Prisma.JsonObject;
      videoAssetId?: string | null;
    },
    generationSource: GenerationSource,
    userId: string,
    previousSnapshotHash?: string,
  ) {
    const { title, body, tags, assetIds, coverAssetId, platformFields, videoAssetId } = input;
    if (coverAssetId !== null && !assetIds.includes(coverAssetId)) {
      throw new BadRequestException('封面必须来自版本图片');
    }
    if (platform === 'xiaohongshu') {
      if (coverAssetId !== (assetIds[0] ?? null)) throw new BadRequestException('小红书封面须为第一张图片');
      if (Object.keys(platformFields).length > 0) throw new BadRequestException('小红书首版暂不支持平台扩展字段');
    }
    const assets = assetIds.map((assetId, position) => ({ assetId, position, isCover: assetId === coverAssetId }));
    const hash = contentHash({ platform, title, body, tags, assets, platformFields, videoAssetId });
    if (hash === previousSnapshotHash) {
      throw new BadRequestException({ code: 'variant_unchanged', message: '版本内容未变化' });
    }
    const last = await tx.variant.findFirst({
      where: { manuscriptId: manuscript.id, platform },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = await tx.variant.create({
      data: {
        workspaceId: manuscript.workspaceId,
        manuscriptId: manuscript.id,
        platform,
        version: (last?.version ?? 0) + 1,
        title,
        body,
        tags,
        platformFields,
        videoAssetId,
        generationSource,
        snapshotVersion: 1,
        contentHash: hash,
        createdById: userId,
      },
    });
    if (assets.length) {
      await tx.variantAsset.createMany({ data: assets.map((asset) => ({ ...asset, variantId: version.id })) });
    }
    return tx.variant.update({
      where: { id: version.id },
      data: { sealedAt: new Date() },
      include: variantSnapshot,
    });
  }

  private async supersedeVersions(
    tx: Prisma.TransactionClient,
    manuscript: ImageScope,
    platforms: Platform[],
    newVersionIds: string[],
    userId: string,
  ) {
    const superseded = await tx.variant.updateManyAndReturn({
      where: {
        workspaceId: manuscript.workspaceId,
        manuscriptId: manuscript.id,
        platform: { in: platforms },
        status: { not: 'superseded' },
        id: { notIn: newVersionIds },
      },
      data: { status: 'superseded', supersededAt: new Date() },
      select: { id: true },
    });
    return this.pauseScheduledTasks(tx, manuscript.workspaceId,
      { variantId: { in: superseded.map(({ id }) => id) } }, pauseReason, userId);
  }

  async reviseVariant(params: {
    variantId: string;
    workspaceId: string;
    userId: string;
    input: z.infer<typeof updateVariantSchema>;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.lockCurrentVariant(tx, params.workspaceId, params.variantId);
      const manuscript = { id: current.manuscriptId, workspaceId: current.workspaceId };
      const { input } = params;
      const assetIds = input.assetIds ?? (current.snapshotVersion === 0
        ? (await this.manuscriptImages(tx, manuscript)).map(({ id }) => id)
        : current.assets.map(({ assetId }) => assetId));
      const allowed = await this.manuscriptImages(tx, manuscript, assetIds);
      if (allowed.length !== assetIds.length) throw new BadRequestException('图片必须来自同一原稿');

      const previousCover = current.assets.find(({ isCover }) => isCover)?.assetId;
      let defaultCover = assetIds[0] ?? null;
      if (current.platform === 'bilibili' && current.snapshotVersion === 1
        && (!previousCover || assetIds.includes(previousCover))) {
        defaultCover = previousCover ?? null;
      }
      const platformFields = input.platformFields ?? current.platformFields;
      if (!platformFields || typeof platformFields !== 'object' || Array.isArray(platformFields)) {
        throw new BadRequestException('平台扩展字段须为 JSON 对象');
      }
      const previousSnapshotHash = current.snapshotVersion === 1 && current.sealedAt ? current.contentHash : undefined;
      const variant = await this.createVersion(tx, manuscript, current.platform, {
        title: input.title ?? current.title,
        body: input.body ?? current.body,
        tags: input.tags ?? current.tags,
        assetIds,
        coverAssetId: input.coverAssetId === undefined ? defaultCover : input.coverAssetId,
        platformFields,
        videoAssetId: current.videoAssetId,
      }, 'manual', params.userId, previousSnapshotHash);
      const pausedTaskCount = await this.supersedeVersions(tx, manuscript, [current.platform], [variant.id], params.userId);
      return { variant, supersededVariantId: current.id, pausedTaskCount };
    }, { isolationLevel: 'ReadCommitted' });
  }

  async generateDrafts(params: {
    workspaceId: string;
    manuscriptId: string;
    platforms: Platform[];
    userId: string;
  }, transaction?: Prisma.TransactionClient) {
    const generate = async (tx: Prisma.TransactionClient) => {
      const manuscript = await this.lockManuscript(tx, params.workspaceId, params.manuscriptId);
      const assetIds = (await this.manuscriptImages(tx, manuscript)).map(({ id }) => id);
      const platforms = [...new Set(params.platforms)];
      const created = [];
      for (const platform of platforms) {
        const draft = generateVariantDraft(manuscript, platform);
        created.push(await this.createVersion(tx, manuscript, platform, {
          ...draft,
          assetIds,
          coverAssetId: assetIds[0] ?? null,
          platformFields: {},
          videoAssetId: manuscript.videoAssetId,
        }, 'rule', params.userId));
      }
      await this.supersedeVersions(tx, manuscript, platforms, created.map(({ id }) => id), params.userId);
      return created;
    };
    return transaction ? generate(transaction) : this.prisma.$transaction(generate, { isolationLevel: 'ReadCommitted' });
  }

  async replaceVideo(workspaceId: string, manuscriptId: string, userId: string,
    file: { storageKey: string; size: number; checksum: string; filename: string }) {
    return this.prisma.$transaction(async (tx) => {
      const manuscript = await this.lockManuscript(tx, workspaceId, manuscriptId);
      if (manuscript.videoAssetId) {
        const current = await tx.asset.findUniqueOrThrow({ where: { id: manuscript.videoAssetId } });
        if (current.checksum === file.checksum) {
          const { id, filename, size } = current;
          return { video: { id, filename, size }, changed: false, pausedTaskCount: 0 };
        }
      }
      const video = await tx.asset.create({
        data: { ...file, workspaceId, manuscriptId, uploadedById: userId, kind: 'manuscript_video', mimeType: 'video/mp4' },
        select: { id: true, filename: true, size: true },
      });
      await tx.manuscript.update({ where: { id: manuscriptId }, data: { videoAssetId: video.id } });
      const current = await tx.variant.findMany({
        where: { workspaceId, manuscriptId, status: { not: 'superseded' } }, include: variantSnapshot,
        orderBy: [{ platform: 'asc' }, { version: 'desc' }],
      });
      const platforms = [...new Set(current.map(({ platform }) => platform))];
      const replacements = [];
      const sourceImages = current.some(({ snapshotVersion }) => snapshotVersion === 0)
        ? (await this.manuscriptImages(tx, manuscript)).map(({ id }) => id) : [];
      for (const platform of platforms) {
        const version = current.find((item) => item.platform === platform)!;
        const assetIds = version.snapshotVersion === 0 ? sourceImages : version.assets.map(({ assetId }) => assetId);
        const previousCover = version.assets.find(({ isCover }) => isCover)?.assetId;
        replacements.push(await this.createVersion(tx, manuscript, platform, {
          title: version.title, body: version.body, tags: version.tags, assetIds,
          coverAssetId: platform === 'xiaohongshu' ? assetIds[0] ?? null : previousCover ?? assetIds[0] ?? null,
          platformFields: version.platformFields as Prisma.JsonObject, videoAssetId: video.id,
        }, 'manual', userId));
      }
      const pausedTaskCount = await this.supersedeVersions(tx, manuscript, platforms, replacements.map(({ id }) => id), userId);
      return { video, changed: true, pausedTaskCount };
    }, { isolationLevel: 'ReadCommitted' });
  }

  async check(workspaceId: string, variantId: string) {
    const variant = await this.findSnapshot(this.prisma, workspaceId, variantId);
    return { variant, ...inspectSnapshot(variant) };
  }

  async reject(params: { variantId: string; workspaceId: string; userId: string; reason: string }) {
    return this.prisma.$transaction(async (tx) => {
      const { workspaceId, variantId, userId, reason } = params;
      const variant = await this.lockCurrentVariant(tx, workspaceId, variantId);
      if (variant.status !== 'draft' || variant.approval) throw new ConflictException('只有待审核的版本可以退回');
      await this.assertNotReturned(tx, variant.id);
      return tx.variantRejection.create({
        data: { workspaceId, variantId, reviewerId: userId, reason },
        select: variantRejections.select,
      });
    }, { isolationLevel: 'ReadCommitted' });
  }

  private async assertNotReturned(tx: Prisma.TransactionClient, variantId: string) {
    if (await tx.variantRejection.findFirst({ where: { variantId }, select: { id: true } })) {
      throw new ConflictException('该版本已退回，请保存新版本后重新审核');
    }
  }

  async confirm(params: { variantId: string; workspaceId: string; userId: string; note?: string }, transaction?: Prisma.TransactionClient) {
    const confirmIn = async (tx: Prisma.TransactionClient) => {
      const variant = await this.lockCurrentVariant(tx, params.workspaceId, params.variantId);
      await this.assertNotReturned(tx, variant.id);
      const { issues } = inspectSnapshot(variant);
      if (issues.some(({ field }) => field === 'snapshot')) {
        throw new ConflictException({ message: '版本快照无效，请保存为新版本后重新确认', issues });
      }
      if (variant.approval) {
        if (variant.status !== 'approved' || variant.approval.snapshotHash !== variant.contentHash) {
          throw new ConflictException('审批记录与版本快照不一致');
        }
        return { variant, approval: variant.approval };
      }
      if (issues.length > 0) {
        throw new BadRequestException({
          message: `${PLATFORM_LABELS[variant.platform]}版本还有 ${issues.length} 项问题，无法确认`,
          issues,
        });
      }
      const [inserted] = await tx.approval.createManyAndReturn({
        skipDuplicates: true,
        data: [{
          workspaceId: params.workspaceId,
          variantId: variant.id,
          approvedById: params.userId,
          note: params.note,
          snapshotHash: variant.contentHash,
        }],
      });
      const approval = inserted ?? await tx.approval.findUniqueOrThrow({ where: { variantId: variant.id } });
      if (approval.snapshotHash !== variant.contentHash) throw new ConflictException('审批记录与版本快照不一致');
      const updated = await tx.variant.update({
        where: { id: variant.id },
        data: { status: 'approved' },
        include: variantSnapshot,
      });
      return { variant: updated, approval };
    };
    return transaction ? confirmIn(transaction) : this.prisma.$transaction(confirmIn, { isolationLevel: 'ReadCommitted' });
  }
}
