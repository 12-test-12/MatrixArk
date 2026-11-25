import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { createManuscriptSchema } from '@matrixark/shared';
import type { Prisma, Role } from '@prisma/client';
import { z } from 'zod';
import { CurrentRole, CurrentUser } from '../auth/decorators';
import type { SessionUser } from '../auth/session.service';
import { assertCan } from '../common/permissions';
import { parse } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceGuard } from '../workspaces/workspace.guard';
import { TopicAiService, topicAiRequestSchema, topicAiSettingSchema } from './topic-ai.service';
import { TopicCollector } from './topic-collector.service';
import { getFeed, topicProviders, topicSourceSchema } from './topic-feeds';
import { hasValidTopicEvidence, screenLegacyTopics } from './topic-visibility';
import { topicChange } from './topic-change';
import { topicInsights } from './topic-insights';

const referencePlatforms = z.enum(['bilibili', 'xiaohongshu', 'douyin', 'kuaishou', 'shipinhao', 'rednote', 'tiktok', 'instagram', 'twitter', ...topicProviders]);
const mediaType = z.enum(['video', 'images', 'text', 'other']);
const day = z.string().date();
const metric = z.number().int().min(0).max(2_147_483_647).nullable();
const sourceUrl = z.string().max(2048).refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
}, '作品链接须为普通 HTTP 或 HTTPS 地址');
const work = z.object({
  platform: referencePlatforms,
  externalId: z.string().trim().min(1).max(128),
  creatorId: z.string().trim().min(1).max(128).nullable(),
  creator: z.string().trim().min(1).max(120).nullable(),
  description: z.string().trim().max(2000),
  mediaType,
  sourceUrl: sourceUrl.nullable(),
  publishedOn: day.nullable(),
  likes: metric,
  comments: metric,
  views: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
}).strict();
const importSchema = z.object({ works: z.array(work).min(1).max(50) }).strict();
const emptyToUndefined = (v: unknown) => (typeof v === 'string' && !v.trim() ? undefined : v);

const listSchema = z.object({
  platform: z.preprocess(emptyToUndefined, referencePlatforms.optional()),
  mediaType: z.preprocess(emptyToUndefined, mediaType.optional()),
  creator: z.preprocess(emptyToUndefined, z.string().trim().max(120).optional()),
  from: z.preprocess(emptyToUndefined, day.optional()),
  to: z.preprocess(emptyToUndefined, day.optional()),
  saved: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).optional()),
}).refine(({ from, to }) => !from || !to || from <= to, '起始日期须早于或等于结束日期');
const saveSchema = z.object({
  saved: z.boolean().optional(),
  note: z.preprocess((v) => (typeof v === 'string' && !v.trim() ? null : v), z.string().trim().max(1000).nullable().optional()),
}).strict().refine(({ saved, note }) => saved !== undefined || note !== undefined, '请提供收藏状态或选题备注');

@Controller('workspaces/:workspaceId/topics')
@UseGuards(WorkspaceGuard)
export class TopicsController {
  constructor(private readonly prisma: PrismaService, private readonly collector: TopicCollector, private readonly ai: TopicAiService) {}

  @Get('ai')
  aiStatus(@CurrentRole() role: Role, @Param('workspaceId') workspaceId: string) {
    assertCan(role, 'content:write');
    return this.ai.status(workspaceId);
  }

  @Patch('ai')
  configureAi(@CurrentRole() role: Role, @Param('workspaceId') workspaceId: string, @Body() body: unknown) {
    assertCan(role, 'workspace:settings');
    return this.ai.configure(workspaceId, parse(topicAiSettingSchema, body));
  }

  @Post('ai/test')
  testAi(@CurrentRole() role: Role, @Param('workspaceId') workspaceId: string, @Body() body: unknown) {
    assertCan(role, 'workspace:settings');
    return this.ai.testConnection(workspaceId, parse(topicAiSettingSchema, body));
  }

  @Post('works/:id/analyze')
  analyze(@CurrentRole() role: Role, @CurrentUser() user: SessionUser,
    @Param('workspaceId') workspaceId: string, @Param('id') id: string, @Body() body: unknown) {
    assertCan(role, 'content:write');
    const { goal } = parse(topicAiRequestSchema, body);
    return this.ai.analyze(workspaceId, id, user.id, goal);
  }

  @Get('works/:id/analyses')
  analyses(@CurrentRole() role: Role, @CurrentUser() user: SessionUser,
    @Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    assertCan(role, 'content:write');
    return this.ai.history(workspaceId, id, user.id);
  }

  @Get('sources')
  sources(@CurrentRole() role: Role, @Param('workspaceId') workspaceId: string) {
    assertCan(role, 'content:write');
    return this.prisma.topicSource.findMany({ where: { workspaceId, deletedAt: null }, orderBy: [{ provider: 'asc' }, { target: 'asc' }] });
  }

  @Post('sources')
  addSource(@CurrentRole() role: Role, @CurrentUser() user: SessionUser,
    @Param('workspaceId') workspaceId: string, @Body() body: unknown) {
    assertCan(role, 'content:write');
    const input = parse(topicSourceSchema, body);
    const target = input.provider === 'google-trends' ? input.target.toUpperCase()
      : input.provider === 'mastodon' ? input.target.toLowerCase() : input.target;
    const source = { ...input, target };
    getFeed(source);
    const data = { workspaceId, ...source };
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.topicSource.createMany({ data, skipDuplicates: true });
      const restored = count ? null : await tx.topicSource.updateMany({
        where: { ...data, deletedAt: { not: null } },
        data: { deletedAt: null, enabled: true, nextRunAt: new Date(), leaseUntil: null, lastAttemptAt: null, lastError: null },
      });
      const item = await tx.topicSource.findUniqueOrThrow({ where: { workspaceId_provider_target_keyword: data } });
      if (count || restored?.count) {
        await tx.topicChange.create({ data: topicChange(workspaceId, 'source', item.id, count ? 'source_created' : 'source_restored', user) });
      }
      return item;
    });
  }

  @Patch('sources/:id')
  async switchSource(@CurrentRole() role: Role, @CurrentUser() user: SessionUser,
    @Param('workspaceId') workspaceId: string, @Param('id') id: string, @Body() body: unknown) {
    assertCan(role, 'content:write');
    const { enabled } = parse(z.object({ enabled: z.boolean() }).strict(), body);
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.topicSource.updateMany({
        where: { workspaceId, id, deletedAt: null, enabled: { not: enabled } },
        data: { enabled, leaseUntil: null, ...(enabled && { nextRunAt: new Date(), lastAttemptAt: null }) },
      });
      if (result.count) await tx.topicChange.create({ data: topicChange(workspaceId, 'source', id, enabled ? 'source_resumed' : 'source_paused', user) });
      else if (!await tx.topicSource.count({ where: { workspaceId, id, deletedAt: null } })) throw new NotFoundException('采集任务不存在');
      return { ok: true };
    });
  }

  @Delete('sources/:id')
  deleteSource(@CurrentRole() role: Role, @CurrentUser() user: SessionUser,
    @Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    assertCan(role, 'content:write');
    return this.prisma.$transaction(async (tx) => {
      const removed = await tx.topicSource.updateMany({
        where: { workspaceId, id, deletedAt: null },
        data: { deletedAt: new Date(), enabled: false, leaseUntil: null },
      });
      if (removed.count) await tx.topicChange.create({ data: topicChange(workspaceId, 'source', id, 'source_deleted', user) });
      else if (!await tx.topicSource.count({ where: { workspaceId, id } })) throw new NotFoundException('采集任务不存在');
      return { ok: true };
    });
  }

  @Post('sources/:id/sync')
  async syncSource(@CurrentRole() role: Role, @CurrentUser() user: SessionUser,
    @Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    assertCan(role, 'content:write');
    const source = await this.prisma.topicSource.findFirst({ where: { id, workspaceId, deletedAt: null } });
    if (!source) throw new NotFoundException('采集任务不存在');
    return this.collector.collect(source, true, user);
  }

  @Get('works/:id/insights')
  insights(@CurrentRole() role: Role, @Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    assertCan(role, 'content:write');
    return topicInsights(this.prisma, workspaceId, id);
  }

  @Get(':entity/:id/changes')
  async changes(@CurrentRole() role: Role, @Param('workspaceId') workspaceId: string,
    @Param('entity') entity: string, @Param('id') id: string) {
    assertCan(role, 'content:write');
    if (entity !== 'works' && entity !== 'sources') throw new NotFoundException();
    return this.prisma.topicChange.findMany({
      where: { workspaceId, entityType: entity === 'works' ? 'work' : 'source', entityId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 30,
    });
  }

  @Get('works')
  async list(@CurrentRole() role: Role, @Param('workspaceId') workspaceId: string, @Query() query: unknown) {
    assertCan(role, 'content:write');
    const filters = parse(listSchema, query);
    await screenLegacyTopics(this.prisma, workspaceId);
    const saved = filters.saved === 'true';
    const where: Prisma.TopicWorkWhereInput = {
      workspaceId, legacyRuleRejected: false, platform: filters.platform, mediaType: filters.mediaType,
      savedAt: saved ? { not: null } : undefined,
      publishedOn: filters.from || filters.to ? {
        gte: filters.from ? new Date(filters.from) : undefined,
        lte: filters.to ? new Date(filters.to) : undefined,
      } : undefined,
      OR: filters.creator ? [
        { creator: { contains: filters.creator, mode: 'insensitive' } },
        { creatorId: filters.creator },
      ] : undefined,
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.topicWork.findMany({
        where, take: 200, orderBy: [saved ? { savedAt: 'desc' } : { importedAt: 'desc' }, { id: 'desc' }],
        include: { matches: {
          orderBy: [{ seenAt: 'desc' }, { sourceId: 'desc' }],
          select: { field: true, excerpt: true, seenAt: true,
            source: { select: { id: true, provider: true, target: true, keyword: true } } },
        } },
      }),
      this.prisma.topicWork.count({ where }),
    ], { isolationLevel: 'RepeatableRead' });
    return { items: items.map(({ legacyRuleRejected: _rejected, views, matches, ...item }) => ({
      ...item, matches: matches.filter(hasValidTopicEvidence).slice(0, 5), views: views === null ? null : Number(views),
    })), total };
  }

  @Post('works/import')
  async importWorks(@CurrentRole() role: Role, @CurrentUser() user: SessionUser,
    @Param('workspaceId') workspaceId: string, @Body() body: unknown) {
    assertCan(role, 'content:write');
    const { works } = parse(importSchema, body);
    await screenLegacyTopics(this.prisma, workspaceId);
    const records = new Map(works.map((item) => [JSON.stringify([item.platform, item.externalId]), item]));
    const importedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      const changes = [];
      for (const key of [...records.keys()].sort()) {
        const { views, ...item } = records.get(key)!;
        const data = { ...item, views: views == null ? undefined : BigInt(views),
          publishedOn: item.publishedOn ? new Date(item.publishedOn) : null, importedAt };
        const result = await tx.topicWork.upsert({
          where: { workspaceId_platform_externalId: { workspaceId, platform: item.platform, externalId: item.externalId } },
          create: { workspaceId, ...data, origin: 'report', legacyRuleRejected: false },
          update: { ...data, legacyRuleRejected: false, sourceUrl: item.sourceUrl ?? undefined },
          select: { id: true },
        });
        changes.push(topicChange(workspaceId, 'work', result.id, 'report_imported', user));
      }
      await tx.topicChange.createMany({ data: changes });
    });
    return { imported: records.size };
  }

  @Patch('works/:id')
  async save(@CurrentRole() role: Role, @CurrentUser() user: SessionUser,
    @Param('workspaceId') workspaceId: string, @Param('id') id: string, @Body() body: unknown) {
    assertCan(role, 'content:write');
    const { saved, note } = parse(saveSchema, body);
    await screenLegacyTopics(this.prisma, workspaceId);
    return this.prisma.$transaction(async (tx) => {
      const [previous] = await tx.$queryRaw<{ savedAt: Date | null; note: string | null }[]>`
        SELECT "savedAt", "note" FROM "TopicWork"
        WHERE "id" = ${id} AND "workspaceId" = ${workspaceId} AND "legacyRuleRejected" = false FOR UPDATE`;
      if (!previous) throw new NotFoundException('参考作品不存在');
      const savedChanged = saved !== undefined && saved !== Boolean(previous.savedAt);
      const noteChanged = note !== undefined && note !== previous.note;
      if (savedChanged || noteChanged) {
        await tx.topicWork.update({ where: { id }, data: { savedAt: savedChanged ? saved ? new Date() : null : undefined, note } });
        const details = { ...(savedChanged && { saved: { before: Boolean(previous.savedAt), after: saved! } }),
          ...(noteChanged && { note: { before: previous.note, after: note! } }) };
        await tx.topicChange.create({ data: topicChange(workspaceId, 'work', id, 'work_edited', user, details) });
      }
      return { ok: true };
    });
  }

  @Post('works/:id/manuscript')
  async draft(@CurrentRole() role: Role, @CurrentUser() user: SessionUser,
    @Param('workspaceId') workspaceId: string, @Param('id') id: string, @Body() body: unknown) {
    assertCan(role, 'content:write');
    const input = parse(createManuscriptSchema, body);
    await screenLegacyTopics(this.prisma, workspaceId);
    const reference = await this.prisma.topicWork.findFirst({
      where: { id, workspaceId, legacyRuleRejected: false }, select: { sourceUrl: true },
    });
    if (!reference) throw new NotFoundException('参考作品不存在');
    return this.prisma.$transaction(async (tx) => {
      const draft = await tx.manuscript.create({
        data: { ...input, workspaceId, createdById: user.id, referenceUrl: reference.sourceUrl },
        select: { id: true },
      });
      await tx.topicChange.create({ data: topicChange(workspaceId, 'work', id, 'draft_created', user, { manuscriptId: draft.id }) });
      return draft;
    });
  }
}
