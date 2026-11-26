import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import sharp from 'sharp';
import { config } from '../config';
import { ContentService } from '../content/content.service';
import { StorageService } from '../content/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';

@Injectable()
export class TrialWorkspaceService {
  constructor(private readonly db: PrismaService, private readonly content: ContentService,
    private readonly storage: StorageService, private readonly tasks: TasksService) {}

  async enter(userId: string) {
    if (!config.trialAvailable) throw new NotFoundException('当前环境未开放试用工作室');
    const savedFiles: string[] = [];
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`trial-workspace:${userId}`}, 0))::text`;
        const existing = await tx.workspace.findUnique({ where: { trialOwnerId: userId }, select: { id: true, name: true } });
        if (existing) return { ...existing, role: 'owner' as const, trial: true as const, manuscriptId: null };
        const workspace = await tx.workspace.create({
          data: { name: '试用工作室', trialOwnerId: userId, memberships: { create: { userId, role: 'owner' } } },
          select: { id: true, name: true },
        });
        const workspaceId = workspace.id;
        const now = new Date();
        const accounts = await tx.channelAccount.createManyAndReturn({ data: [
          { workspaceId, platform: 'xiaohongshu', channelKind: 'manual', accessMethod: 'manual_uid', displayName: '小红书 · 演示账号', externalId: 'trial-xiaohongshu', authCheckedAt: now, authStatus: 'active' },
          { workspaceId, platform: 'bilibili', channelKind: 'sandbox', accessMethod: 'sandbox', displayName: 'B 站 · 沙箱账号', externalId: 'trial-bilibili', authCheckedAt: now, authStatus: 'active' },
        ] });
        const image = await sharp({ create: { width: 480, height: 640, channels: 3, background: '#5240d0' } }).png().toBuffer();
        const createManuscript = async (title: string, body: string) => {
          const manuscript = await tx.manuscript.create({ data: { workspaceId, title, body, tags: ['工作台演练'], createdById: userId } });
          const filename = '演示封面.png';
          const { key } = await this.storage.save(workspaceId, filename, image);
          savedFiles.push(key);
          await tx.asset.create({ data: { workspaceId, manuscriptId: manuscript.id, storageKey: key, filename,
            kind: 'manuscript_image', mimeType: 'image/png', size: image.length, uploadedById: userId } });
          return manuscript.id;
        };
        const sampleId = await createManuscript('周末桌面整理小记', '先留出一块空桌面，把常用物品放回顺手的位置，再给剩余物品找固定位置。');
        const variants = await this.content.generateDrafts({ workspaceId, manuscriptId: sampleId, userId,
          platforms: ['xiaohongshu', 'bilibili'] }, tx);
        for (const variant of variants) {
          await this.content.confirm({ workspaceId, variantId: variant.id, userId, note: '试用工作室预置示例' }, tx);
        }
        await this.tasks.schedule(workspaceId, userId, { accountIds: accounts.map(({ id }) => id),
          variantIds: variants.map(({ id }) => id), scheduledAt: now }, tx);

        const manuscriptId = await createManuscript('给通勤包做一次减法', '把每天都会用到的东西放在外层。连续一周没用到的物品先拿出来，下周再决定要不要放回去。');
        await this.content.generateDrafts({ workspaceId, manuscriptId, userId, platforms: ['xiaohongshu'] }, tx);
        return { ...workspace, role: 'owner' as const, trial: true as const, manuscriptId };
      });
    } catch (error) {
      await Promise.allSettled(savedFiles.map((key) => this.storage.remove(key)));
      throw error;
    }
  }
}
