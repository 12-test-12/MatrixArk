import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type MetricsSource, type Platform } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { presentTask, TaskFilters, taskRelations } from '../domain/task-policy';

@Injectable()
export class TaskQueryService {
  constructor(private readonly prisma: PrismaService) { }

  async list(workspaceId: string, { status, accountId, groupId, manuscriptId, cursor, limit, performance, platform, content, days }: TaskFilters) {
    const scope = JSON.stringify(performance
      ? [workspaceId, 'performance', accountId, groupId, platform, content, days]
      : [workspaceId, status, accountId, manuscriptId]);
    let after: Prisma.PublishTaskWhereInput = {};
    if (cursor) {
      try {
        const [cursorScope, timestamp, id]: unknown[] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (cursorScope !== scope || typeof timestamp !== 'string' || typeof id !== 'string' || !id) throw new Error();
        const createdAt = new Date(timestamp);
        if (createdAt.toISOString() !== timestamp) throw new Error();
        after = { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }] };
      } catch {
        throw new BadRequestException('任务分页游标无效');
      }
    }
    const since = performance && days ? new Date(Date.now() - days * 86_400_000) : undefined;
    const where: Prisma.PublishTaskWhereInput = performance ? {
      workspaceId, accountId, status: 'published', executionChannel: { in: ['manual', 'official'] },
      ...(groupId ? { account: { groupId } } : {}),
      result: {
        is: since ? {
          state: 'published',
          OR: [
            { platformPublishedAt: { gte: since } },
            { platformPublishedAt: null, recordedAt: { gte: since } },
          ],
        } : { state: 'published' },
      },
      variant: { platform, videoAssetId: content === 'video' ? { not: null } : content === 'article' ? null : undefined },
    } : { workspaceId, status, accountId, variant: manuscriptId ? { manuscriptId } : undefined };
    const [rows, summary, accountSummary] = await Promise.all([this.prisma.publishTask.findMany({
      where: { ...where, ...after },
      include: {
        ...taskRelations,
        result: performance ? {
          include: { metrics: { include: { recordedBy: { select: { id: true, name: true, email: true } } } } },
        } : true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    }), performance ? this.performanceSummary(where, content) : undefined,
    performance ? this.accountPerformanceSummary(where) : undefined]);
    const items = rows.slice(0, limit).map(presentTask);
    const last = items.at(-1);
    return {
      items,
      ...(summary && { summary }),
      ...(accountSummary && { accountSummary }),
      nextCursor: rows.length > limit && last
        ? Buffer.from(JSON.stringify([scope, last.createdAt.toISOString(), last.id])).toString('base64url')
        : null,
    };
  }

  private async accountPerformanceSummary(where: Prisma.PublishTaskWhereInput) {
    const rows = await this.prisma.publishTask.findMany({
      where,
      select: {
        accountId: true,
        account: {
          select: {
            id: true, displayName: true, alias: true, platform: true, operator: true,
            group: { select: { id: true, name: true, color: true } },
          },
        },
        result: {
          select: {
            metrics: {
              select: {
                views: true, likes: true, comments: true, favorites: true, shares: true,
                source: true, recordedAt: true,
                recordedBy: { select: { id: true, name: true, email: true } },
              },
            },
          },
        },
      },
    });
    const map = new Map<string, {
      accountId: string; displayName: string; alias: string | null; platform: Platform; operator: string | null;
      group: { id: string; name: string; color: string } | null;
      published: number; tracked: number;
      views: number | null; likes: number | null; comments: number | null; favorites: number | null; shares: number | null;
      lastRecordedAt: Date | null; lastSource: MetricsSource | null;
      lastRecordedBy: { id: string; name: string; email: string } | null;
    }>();
    const sumOpt = (a: number | null, b: number | null) => b === null ? a : (a ?? 0) + b;
    for (const row of rows) {
      let entry = map.get(row.accountId);
      if (!entry) {
        entry = {
          accountId: row.account.id,
          displayName: row.account.displayName,
          alias: row.account.alias,
          platform: row.account.platform,
          operator: row.account.operator,
          group: row.account.group,
          published: 0,
          tracked: 0,
          views: null,
          likes: null,
          comments: null,
          favorites: null,
          shares: null,
          lastRecordedAt: null,
          lastSource: null,
          lastRecordedBy: null,
        };
        map.set(row.accountId, entry);
      }
      entry.published += 1;
      const m = row.result?.metrics;
      if (m) {
        entry.tracked += 1;
        entry.views = sumOpt(entry.views, m.views);
        entry.likes = sumOpt(entry.likes, m.likes);
        entry.comments = sumOpt(entry.comments, m.comments);
        entry.favorites = sumOpt(entry.favorites, m.favorites);
        entry.shares = sumOpt(entry.shares, m.shares);
        if (!entry.lastRecordedAt || m.recordedAt > entry.lastRecordedAt) {
          entry.lastRecordedAt = m.recordedAt;
          entry.lastSource = m.source;
          entry.lastRecordedBy = m.recordedBy;
        }
      }
    }
    return [...map.values()].sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || b.published - a.published);
  }

  private performanceSummary(where: Prisma.PublishTaskWhereInput, content: TaskFilters['content']) {
    const kinds = content ? [content] : ['article', 'video'] as const;
    return Promise.all(kinds.map(async (kind) => {
      const tasks = { AND: [where, { variant: { videoAssetId: kind === 'video' ? { not: null } : null } }] };
      const [published, metrics] = await Promise.all([
        this.prisma.publishTask.count({ where: tasks }),
        this.prisma.publicationMetrics.aggregate({
          where: { result: { task: tasks } }, _count: { _all: true },
          _sum: { views: true, likes: true, comments: true, favorites: true, shares: true },
        }),
      ]);
      return { content: kind, published, tracked: metrics._count._all, ...metrics._sum };
    }));
  }

  async detail(workspaceId: string, id: string) {
    const task = await this.prisma.publishTask.findFirst({
      where: { id, workspaceId },
      include: {
        ...taskRelations, events: { orderBy: { id: 'asc' } },
        notificationDeliveries: {
          orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
          select: { id: true, kind: true, status: true, attempts: true, scheduledAt: true, sentAt: true, lastError: true },
        },
      },
    });
    if (!task) throw new NotFoundException('任务不存在');
    const { events, ...view } = task;
    return {
      ...presentTask(view),
      events: events.map((event) => ({ ...event, id: event.id.toString() })),
    };
  }
}
