import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type MetricsSource } from '@prisma/client';
import { config } from '../../config';
import { PrismaService } from '../../prisma/prisma.service';
import { runBounded } from '../../worker/concurrency';
import { requirePublishedWork, taskRelations, WorkMetricsInput } from '../domain/task-policy';
import { databaseTime, lockRow } from '../infrastructure/task-locks';
import { TaskPlatformService } from '../infrastructure/task-platform.service';

@Injectable()
export class TaskMetricsService {
  private readonly logger = new Logger(TaskMetricsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platforms: TaskPlatformService,
  ) { }

  async saveMetrics(workspaceId: string, id: string, userId: string | null, input: WorkMetricsInput,
    source: MetricsSource = 'manual', remoteId?: string, automaticSince?: Date) {
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockRow(tx, 'task', workspaceId, id))) throw new NotFoundException('任务不存在');
      const task = await tx.publishTask.findUniqueOrThrow({ where: { id }, include: { result: true } });
      const result = requirePublishedWork(task, task.result);
      if (remoteId !== undefined && result.remoteId !== remoteId) throw new ConflictException('作品已变更，请重新同步');
      const now = await databaseTime(tx);
      const { recordedAt, ...metrics } = input;
      if (recordedAt) {
        if (recordedAt.getTime() > now.getTime() + 86_400_000) throw new BadRequestException('统计日期不能晚于今天');
        if (recordedAt.getTime() < now.getTime() - 366 * 86_400_000) throw new BadRequestException('统计日期仅支持最近一年内');
      }
      const effectiveAt = recordedAt ?? now;
      if (automaticSince) {
        const latest = await tx.publicationMetrics.findUnique({ where: { taskId: id } });
        if (latest && latest.recordedAt >= automaticSince) return latest;
      }
      const data = { ...metrics, source, recordedById: userId, recordedAt: effectiveAt };
      await tx.publicationMetricSnapshot.create({ data: { taskId: id, ...data }, select: { id: true } });
      const currentLatest = await tx.publicationMetrics.findUnique({ where: { taskId: id } });
      if (!currentLatest || effectiveAt >= currentLatest.recordedAt) {
        return tx.publicationMetrics.upsert({ where: { taskId: id }, create: { taskId: id, ...data }, update: data });
      }
      return currentLatest;
    }, { isolationLevel: 'ReadCommitted' });
  }

  async metricHistory(workspaceId: string, id: string, days?: number) {
    const task = await this.prisma.publishTask.findFirst({ where: { id, workspaceId }, include: { result: true } });
    if (!task) throw new NotFoundException('任务不存在');
    requirePublishedWork(task, task.result);
    const since = days ? new Date(Date.now() - days * 86_400_000) : undefined;
    const snapshots = await this.prisma.publicationMetricSnapshot.findMany({
      where: { taskId: id, ...(since ? { recordedAt: { gte: since } } : {}) },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      take: 120,
      select: {
        id: true, views: true, likes: true, comments: true, favorites: true, shares: true,
        source: true, recordedAt: true, recordedById: true,
        recordedBy: { select: { id: true, name: true, email: true } },
      },
    });
    return snapshots.reverse();
  }

  async syncMetrics(workspaceId: string, id: string, userId: string | null, automaticSince?: Date) {
    const task = await this.prisma.publishTask.findFirst({
      where: { workspaceId, id },
      include: { ...taskRelations, account: true },
    });
    if (!task) throw new NotFoundException('任务不存在');
    const { remoteId } = requirePublishedWork(task, task.result);
    if (!remoteId || !this.platforms.supportsMetrics(task.variant.platform, task.executionChannel, task.variant)) {
      throw new ConflictException('此作品暂不支持同步平台数据，可以手动录入');
    }
    const metrics = await this.platforms.fetchMetrics(task.account, remoteId);
    return this.saveMetrics(workspaceId, id, userId, metrics, 'platform', remoteId, automaticSince);
  }

  async syncDueArticleMetrics() {
    if (config.sandboxChannel) return;
    const now = await databaseTime(this.prisma);
    const hour = 3_600_000;
    const due: Prisma.PublishTaskWhereInput = {
      status: 'published', executionChannel: 'official', workspace: { trialOwnerId: null },
      AND: [this.platforms.metricsScope(now)],
      result: {
        state: 'published', remoteId: { not: null }, recordedAt: { gte: new Date(now.getTime() - 30 * 24 * hour) },
        OR: [{ metrics: null }, { metrics: { recordedAt: { lte: new Date(now.getTime() - 6 * hour) } } }]
      },
      OR: [{ metricsSyncAttemptedAt: null }, { metricsSyncAttemptedAt: { lte: new Date(now.getTime() - hour / 2) } }],
    };
    const tasks = await this.prisma.publishTask.findMany({
      where: due,
      orderBy: [{ metricsSyncAttemptedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      select: { id: true, workspaceId: true }, take: 4
    });
    let synced = 0;
    await runBounded(tasks, config.worker.metricsConcurrency, async ({ id, workspaceId }) => {
      const { count } = await this.prisma.publishTask.updateMany({ where: { ...due, id }, data: { metricsSyncAttemptedAt: now } });
      if (!count) return;
      try {
        await this.syncMetrics(workspaceId, id, null, now);
        synced++;
      } catch {
        this.logger.warn(`B 站专栏成效自动同步未完成 · ${id}`);
      }
    });
    return synced;
  }
}
