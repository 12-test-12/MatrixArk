import type { PrismaService } from '../prisma/prisma.service';
import { matchingEvidence } from './topic-feeds';

export function hasValidTopicEvidence(match: {
  excerpt: string | null;
  source: { keyword: string };
}) {
  const { keyword } = match.source;
  return !keyword || Boolean(matchingEvidence(keyword, { title: '', summary: match.excerpt ?? '' }));
}

export async function screenLegacyTopics(prisma: PrismaService, workspaceId: string) {
  const pending = { workspaceId, legacyRuleRejected: null };
  for (;;) {
    const items = await prisma.topicWork.findMany({
      where: pending, orderBy: { id: 'asc' }, take: 200,
      select: {
        id: true, platform: true, origin: true, description: true, importedAt: true,
        matches: { select: { excerpt: true, source: { select: { keyword: true } } } },
      },
    });
    if (!items.length) return;

    const sourceKeywords = new Map<string, string | null>();
    if (items.some((item) => item.origin === 'legacy' && item.matches.length === 0)) {
      const sources = await prisma.topicSource.findMany({
        where: { workspaceId, lastSuccessAt: { not: null } },
        select: { provider: true, keyword: true, lastSuccessAt: true },
      });
      for (const source of sources) {
        const key = source.provider + ':' + source.lastSuccessAt?.getTime();
        sourceKeywords.set(key, sourceKeywords.has(key) ? null : source.keyword);
      }
    }

    const rejected: string[] = [];
    const usable: string[] = [];
    for (const item of items) {
      let invalid = false;
      if (item.origin !== 'report' && item.matches.length) {
        invalid = item.matches.every((match) => !hasValidTopicEvidence(match));
      } else if (item.origin === 'legacy') {
        const keyword = sourceKeywords.get(item.platform + ':' + item.importedAt.getTime());
        if (keyword) {
          const [title = '', ...rest] = item.description.split('\n');
          const fields = { title, summary: rest.join('\n') };
          invalid = !matchingEvidence(keyword, fields) && Boolean(matchingEvidence(keyword, fields, true));
        }
      }
      (invalid ? rejected : usable).push(item.id);
    }

    await prisma.$transaction([
      prisma.topicWork.updateMany({
        where: { ...pending, id: { in: rejected } }, data: { legacyRuleRejected: true },
      }),
      prisma.topicWork.updateMany({
        where: { ...pending, id: { in: usable } }, data: { legacyRuleRejected: false },
      }),
    ]);
  }
}
