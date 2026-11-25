import type { PrismaService } from '../prisma/prisma.service';
import { NotFoundException } from '@nestjs/common';
import { screenLegacyTopics } from './topic-visibility';

const day = 86_400_000;
const titleOf = (description: string) => description.split('\n', 1)[0]!.trim();
const titleKey = (description: string) => titleOf(description).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const sampleLimit = 200;

export async function topicInsights(db: PrismaService, workspaceId: string, id: string) {
  await screenLegacyTopics(db, workspaceId);
  const visible = { workspaceId, legacyRuleRejected: false };
  const item = await db.topicWork.findFirst({
    where: { ...visible, id }, select: {
      description: true, platform: true, mediaType: true, publishedOn: true, creatorId: true, creator: true, views: true, likes: true,
    },
  });
  if (!item) throw new NotFoundException('参考作品不存在');
  const date = item.publishedOn?.getTime();
  const windowFor = (days: number) => date === undefined ? undefined
    : { gte: new Date(date - days * day), lte: new Date(date + days * day) };
  const metric = item.views !== null ? 'views' : 'likes';
  const value = item[metric] === null ? null : Number(item[metric]);
  const sameCreator = item.creatorId ? { creatorId: item.creatorId } : item.creator ? { creator: item.creator } : {};
  const creatorScoped = Object.keys(sameCreator).length > 0;
  const key = titleKey(item.description);
  const [peers, matches] = await Promise.all([
    value !== null && date !== undefined && item.mediaType !== 'other' ? db.topicWork.findMany({
      where: { ...visible, id: { not: id }, platform: item.platform, mediaType: item.mediaType,
        publishedOn: windowFor(3), [metric]: { not: null }, ...sameCreator },
      select: { views: true, likes: true }, orderBy: [{ publishedOn: 'desc' }, { id: 'desc' }], take: sampleLimit,
    }) : [],
    key.length >= 8 && date !== undefined ? db.topicWork.findMany({
      where: { ...visible, platform: { not: item.platform }, mediaType: item.mediaType, publishedOn: windowFor(7) },
      orderBy: [{ publishedOn: 'desc' }, { id: 'desc' }], take: sampleLimit,
      select: { id: true, platform: true, creator: true, description: true, sourceUrl: true, publishedOn: true },
    }) : [],
  ]);
  const values = peers.map((row) => Number(row[metric])).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  const median = values.length >= 3 ? (values[middle]! + values[Math.floor((values.length - 1) / 2)]!) / 2 : null;
  const ratio = value !== null && median !== null && median > 0 ? value / median : null;
  const abovePeers = value === null ? 0 : values.filter((peer) => peer < value).length;
  const signal = ratio === null ? 'insufficient' : ratio >= 2 && abovePeers / values.length >= .75 ? 'high' : 'typical';
  return {
    heat: { signal, metric, value, median, peers: values.length, ratio, creatorScoped },
    matches: matches.filter((match) => titleKey(match.description) === key).slice(0, 8)
      .map(({ description, ...match }) => ({ ...match, title: titleOf(description) })),
  };
}
