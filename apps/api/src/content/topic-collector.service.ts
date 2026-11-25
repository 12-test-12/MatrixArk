import { Injectable } from '@nestjs/common';
import type { TopicSource } from '@prisma/client';
import type { SessionUser } from '../auth/session.service';
import { PrismaService } from '../prisma/prisma.service';
import { collectTopicFeed, topicSourceSchema } from './topic-feeds';
import { screenLegacyTopics } from './topic-visibility';
import { topicChange } from './topic-change';

const minute = 60_000;

@Injectable()
export class TopicCollector {
  constructor(private readonly prisma: PrismaService) {}

  async runDue(signal: AbortSignal) {
    if (signal.aborted) return;
    const now = new Date();
    const sources = await this.prisma.topicSource.findMany({
      where: { deletedAt: null, enabled: true, nextRunAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
      orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
      take: 3,
    });
    await Promise.all(sources.map((source) => this.collect(source, false)));
  }

  async collect(source: TopicSource, manual: boolean, actor?: SessionUser) {
    await screenLegacyTopics(this.prisma, source.workspaceId);
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + minute);
    const { id, workspaceId } = source;
    const claimed = await this.prisma.topicSource.updateMany({
      where: {
        id, workspaceId, deletedAt: null, enabled: true,
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
        ...(manual ? { AND: [{ OR: [
          { lastAttemptAt: null }, { lastAttemptAt: { lte: new Date(now.getTime() - minute) } },
        ] }] } : { nextRunAt: { lte: now } }),
      },
      data: { leaseUntil, lastAttemptAt: now },
    });
    if (!claimed.count) return { status: 'busy' as const };

    const lease = { id, workspaceId, deletedAt: null, enabled: true, leaseUntil };
    try {
      const { provider, target, keyword } = source;
      const records = await collectTopicFeed(topicSourceSchema.parse({ provider, target, keyword }));
      const items = new Map(records.map((record) => [record.externalId, record]));
      const updated = await this.prisma.$transaction(async (tx) => {
        const importedAt = new Date();
        const completed = await tx.topicSource.updateMany({
          where: { ...lease, AND: { leaseUntil: { gt: importedAt } } },
          data: { leaseUntil: null, nextRunAt: new Date(importedAt.getTime() + 30 * minute),
            lastSuccessAt: importedAt, lastCount: items.size, lastError: null },
        });
        if (!completed.count) return false;
        for (const key of [...items.keys()].sort()) {
          const { evidence, ...item } = items.get(key)!;
          const saved = await tx.topicWork.upsert({
            where: { workspaceId_platform_externalId: { workspaceId, platform: item.platform, externalId: key } },
            create: { workspaceId, ...item, origin: 'feed', legacyRuleRejected: false, importedAt },
            update: { ...item, origin: 'feed', legacyRuleRejected: false, sourceUrl: item.sourceUrl ?? undefined,
              coverUrl: item.coverUrl ?? undefined, importedAt },
            select: { id: true },
          });
          const identity = { workspaceId, sourceId: id, workId: saved.id };
          const match = { ...evidence, seenAt: importedAt };
          await tx.topicMatch.upsert({
            where: { workspaceId_sourceId_workId: identity },
            create: { ...identity, ...match },
            update: match,
          });
        }
        if (manual || !source.lastSuccessAt || source.lastCount !== items.size || source.lastError) {
          await tx.topicChange.create({
            data: topicChange(workspaceId, 'source', id, 'source_collected', actor, { count: items.size }),
          });
        }
        return true;
      });
      return updated ? { status: 'ok' as const, count: items.size } : { status: 'busy' as const };
    } catch (error) {
      const reason = error instanceof Error && /^(订阅源|来源)/u.test(error.message)
        ? error.message.slice(0, 200) : '采集未完成，请检查订阅格式或稍后再试';
      const completed = await this.prisma.$transaction(async (tx) => {
        const result = await tx.topicSource.updateMany({
          where: lease,
          data: { leaseUntil: null, nextRunAt: new Date(Date.now() + 30 * minute), lastError: reason },
        });
        if (result.count && (manual || reason !== source.lastError)) await tx.topicChange.create({
          data: topicChange(workspaceId, 'source', id, 'source_failed', actor, { reason }),
        });
        return result;
      });
      return completed.count ? { status: 'failed' as const, reason } : { status: 'busy' as const };
    }
  }
}
