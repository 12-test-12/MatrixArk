import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Platform, Prisma } from '@prisma/client';
import {
  PLATFORM_LABELS,
  contentHash,
  generateVariantDraft,
  validateVariant,
  type ValidationIssue,
} from '@matrixark/shared';
import { PrismaService } from '../prisma/prisma.service';

export interface VersionInput {
  title: string;
  body: string;
  tags: string[];
}

@Injectable()
export class ContentService {
  constructor(private readonly prisma: PrismaService) {}

  /** 每个平台当前的版本（version 最大的那条，且未被取代） */
  async currentVariants(manuscriptId: string) {
    const variants = await this.prisma.variant.findMany({
      where: { manuscriptId, status: { not: 'superseded' } },
      include: { approval: true },
      orderBy: [{ platform: 'asc' }, { version: 'desc' }],
    });
    const seen = new Set<Platform>();
    return variants.filter((variant) => {
      if (seen.has(variant.platform)) return false;
      seen.add(variant.platform);
      return true;
    });
  }

  async imageCount(manuscriptId: string): Promise<number> {
    const assets = await this.prisma.asset.findMany({
      where: { manuscriptId },
      select: { mimeType: true },
    });
    return assets.filter((asset) => asset.mimeType.startsWith('image/')).length;
  }

  /** 新建一个版本行；同一平台的上一版会被标记 superseded，内容永不原地修改 */
  async createVersion(
    tx: Prisma.TransactionClient | PrismaService,
    params: {
      workspaceId: string;
      manuscriptId: string;
      platform: Platform;
      input: VersionInput;
      userId: string;
    },
  ) {
    const last = await tx.variant.findFirst({
      where: { manuscriptId: params.manuscriptId, platform: params.platform },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    return tx.variant.create({
      data: {
        workspaceId: params.workspaceId,
        manuscriptId: params.manuscriptId,
        platform: params.platform,
        version: (last?.version ?? 0) + 1,
        title: params.input.title,
        body: params.input.body,
        tags: params.input.tags,
        contentHash: contentHash({ platform: params.platform, ...params.input }),
        createdById: params.userId,
      },
      include: { approval: true },
    });
  }

  /**
   * 改稿 = 生成新版本 + 旧版本作废 + 暂停旧版本上尚未提交的任务。
   * 已交接/已提交的任务不动（内容已经在外面了，暂停没有意义）。
   */
  async reviseVariant(
    params: {
      variantId: string;
      workspaceId: string;
      userId: string;
      input: VersionInput;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.variant.findFirst({
        where: { id: params.variantId, workspaceId: params.workspaceId },
      });
      if (!current) throw new NotFoundException('版本不存在');
      if (current.status === 'superseded') throw new BadRequestException('该版本已被新版本取代，请改最新版');

      const next = await this.createVersion(tx, {
        workspaceId: current.workspaceId,
        manuscriptId: current.manuscriptId,
        platform: current.platform,
        input: params.input,
        userId: params.userId,
      });

      await tx.variant.update({
        where: { id: current.id },
        data: { status: 'superseded', supersededAt: new Date() },
      });

      const paused = await tx.publishTask.updateMany({
        where: { variantId: current.id, status: { in: ['scheduled', 'paused'] } },
        data: { status: 'paused', lastError: '版本已修改，等待重新确认后排期' },
      });

      return { variant: next, supersededVariantId: current.id, pausedTaskCount: paused.count };
    });
  }

  /** 生成平台草稿：规则版，无模型也能跑 */
  async generateDrafts(params: {
    workspaceId: string;
    manuscriptId: string;
    platforms: Platform[];
    userId: string;
  }) {
    const manuscript = await this.prisma.manuscript.findFirst({
      where: { id: params.manuscriptId, workspaceId: params.workspaceId },
    });
    if (!manuscript) throw new NotFoundException('稿件不存在');

    return this.prisma.$transaction(async (tx) => {
      const created = [];
      for (const platform of params.platforms) {
        const draft = generateVariantDraft(
          { title: manuscript.title, body: manuscript.body, tags: manuscript.tags },
          platform,
        );
        const variant = await this.createVersion(tx, {
          workspaceId: params.workspaceId,
          manuscriptId: manuscript.id,
          platform,
          input: draft,
          userId: params.userId,
        });
        // 重新生成时把上一版作废，避免同一平台出现两条"当前版本"
        await tx.variant.updateMany({
          where: {
            manuscriptId: manuscript.id,
            platform,
            status: { not: 'superseded' },
            id: { not: variant.id },
          },
          data: { status: 'superseded', supersededAt: new Date() },
        });
        created.push(variant);
      }
      return created;
    });
  }

  async assertPublishable(variantId: string): Promise<{
    issues: ValidationIssue[];
    imageCount: number;
  }> {
    const variant = await this.prisma.variant.findUnique({ where: { id: variantId } });
    if (!variant) throw new NotFoundException('版本不存在');
    const imageCount = await this.imageCount(variant.manuscriptId);
    const issues = validateVariant(variant.platform, {
      title: variant.title,
      body: variant.body,
      tags: variant.tags,
      imageCount,
    });
    return { issues, imageCount };
  }

  /** 确认：写 approval + 标记 approved，两者在同一个事务里 */
  async confirm(params: { variantId: string; workspaceId: string; userId: string; note?: string }) {
    const variant = await this.prisma.variant.findFirst({
      where: { id: params.variantId, workspaceId: params.workspaceId },
    });
    if (!variant) throw new NotFoundException('版本不存在');
    if (variant.status === 'superseded') throw new BadRequestException('该版本已被新版本取代');

    const { issues } = await this.assertPublishable(variant.id);
    if (issues.length > 0) {
      throw new BadRequestException({
        message: `${PLATFORM_LABELS[variant.platform]}版本还有 ${issues.length} 个问题不能确认`,
        issues,
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const approval = await tx.approval.upsert({
        where: { variantId: variant.id },
        create: {
          workspaceId: params.workspaceId,
          variantId: variant.id,
          approvedById: params.userId,
          note: params.note,
        },
        update: { approvedById: params.userId, approvedAt: new Date(), note: params.note },
      });
      const updated = await tx.variant.update({
        where: { id: variant.id },
        data: { status: 'approved' },
      });
      return { variant: updated, approval };
    });
  }
}
