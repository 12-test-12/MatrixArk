import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type PublishTask, type Role } from '@prisma/client';
import { isUnverifiedBilibiliAccount, resolveAccountProfileUrl } from '../../accounts/publish-account';
import { inspectSnapshot, variantSnapshot } from '../../content/content.service';
import { StorageService } from '../../content/storage.service';
import { PrismaService } from '../../prisma/prisma.service';
import { assetUrl, bilibiliAuthorizationRequired, requireHandoff, taskRelations } from '../domain/task-policy';
import { lockRow } from '../infrastructure/task-locks';

@Injectable()
export class TaskEvidenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) { }

  async handoff(workspaceId: string, id: string) {
    const task = await this.prisma.publishTask.findFirst({
      where: { id, workspaceId },
      include: {
        account: { select: { ...taskRelations.account.select, externalId: true, accessMethod: true, profileUrl: true } },
        variant: { include: variantSnapshot },
      },
    });
    if (!task) throw new NotFoundException('任务不存在');
    const { variant } = task;
    if (task.status === 'handed_off' && isUnverifiedBilibiliAccount(task.account)) {
      throw new ConflictException(bilibiliAuthorizationRequired);
    }
    if (!task.handedOffAt || (task.executionChannel !== 'manual' && task.status !== 'handed_off') || variant.contentHash !== task.variantContentHash
      || variant.approval?.workspaceId !== workspaceId || variant.approval.snapshotHash !== task.variantContentHash
      || inspectSnapshot(variant).issues.length) throw new ConflictException('任务尚无有效的人工交接包');
    const { externalId, accessMethod: _acc, profileUrl, ...account } = task.account;
    return {
      taskId: id, account, profileUrl: resolveAccountProfileUrl({ ...account, externalId, profileUrl }), variantId: variant.id, version: variant.version,
      title: variant.title, body: variant.body, tags: variant.tags,
      assets: variant.assets.map((asset) => ({ ...asset, url: assetUrl(workspaceId, asset.assetId) })),
      video: variant.videoAsset ? { ...variant.videoAsset, url: assetUrl(workspaceId, variant.videoAsset.id) + '/video' } : null,
    };
  }

  async readEvidence(workspaceId: string, id: string, assetId?: string) {
    const task = await this.prisma.publishTask.findFirst({ where: { id, workspaceId }, include: { result: true } });
    if (!task) throw new NotFoundException('任务不存在');
    const image = await this.prisma.asset.findFirst({
      where: { id: assetId ?? task.result?.evidenceAssetId ?? '', workspaceId, taskId: id, kind: 'task_evidence' },
    });
    if (!image) throw new NotFoundException('回执截图不存在');
    return this.storage.readImage(workspaceId, image.storageKey);
  }

  async attachEvidence(workspaceId: string, id: string, userId: string, role: Role,
    file: { filename: string; mimeType: string; buffer: Buffer; size: number }) {
    const existing = await this.prisma.publishTask.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('任务不存在');
    this.requireEvidenceWrite(existing, role);
    const { key } = await this.storage.save(workspaceId, file.filename, file.buffer);
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (!(await lockRow(tx, 'task', workspaceId, id))) throw new NotFoundException('任务不存在');
        const task = await tx.publishTask.findUniqueOrThrow({ where: { id } });
        this.requireEvidenceWrite(task, role);
        const asset = await tx.asset.create({
          data: {
            storageKey: key, filename: file.filename, mimeType: file.mimeType, size: file.size,
            workspaceId, taskId: id, kind: 'task_evidence', uploadedById: userId
          },
        });
        return { assetId: asset.id };
      }, { isolationLevel: 'ReadCommitted' });
    } catch (error) {
      const registered = await this.prisma.asset.findUnique({ where: { storageKey: key }, select: { id: true } }).catch(() => undefined);
      if (registered === null) await this.storage.remove(key).catch(() => undefined);
      throw error;
    }
  }

  private requireEvidenceWrite(task: PublishTask, role: Role) {
    if (task.status === 'canceled' && role !== 'owner') throw new ForbiddenException('仅负责人可以更正已取消的任务');
    if (task.status !== 'unknown' && task.status !== 'failed' && task.status !== 'canceled') requireHandoff(task);
  }

  async validateEvidence(tx: Prisma.TransactionClient, workspaceId: string, taskId: string, evidenceAssetId?: string) {
    if (evidenceAssetId && !(await tx.asset.findFirst({
      where: { id: evidenceAssetId, workspaceId, taskId, kind: 'task_evidence' }, select: { id: true },
    }))) throw new NotFoundException('本任务截图不存在');
    return evidenceAssetId ?? null;
  }
}
