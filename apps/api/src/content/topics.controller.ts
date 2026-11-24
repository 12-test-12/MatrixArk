import { Body, Controller, Get, NotFoundException, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { createManuscriptSchema } from '@matrixark/shared';
import type { Prisma, Role } from '@prisma/client';
import { z } from 'zod';
import { CurrentRole, CurrentUser } from '../auth/decorators';
import type { SessionUser } from '../auth/session.service';
import { assertCan } from '../common/permissions';
import { parse } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceGuard } from '../workspaces/workspace.guard';

const referencePlatforms = z.enum(['bilibili', 'xiaohongshu', 'douyin', 'kuaishou', 'shipinhao', 'rednote', 'tiktok', 'instagram', 'twitter']);
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
  sourceUrl,
  publishedOn: day.nullable(),
  likes: metric,
  comments: metric,
}).strict();
const importSchema = z.object({ works: z.array(work).min(1).max(50) }).strict();
const listSchema = z.object({
  platform: referencePlatforms.optional(),
  mediaType: mediaType.optional(),
  creator: z.string().trim().max(120).optional(),
  from: day.optional(),
  to: day.optional(),
  saved: z.enum(['true', 'false']).optional(),
}).refine(({ from, to }) => !from || !to || from <= to, '起始日期须早于或等于结束日期');
const saveSchema = z.object({ saved: z.boolean(), note: z.string().trim().max(1000).optional() }).strict();

@Controller('workspaces/:workspaceId/topics/works')
@UseGuards(WorkspaceGuard)
export class TopicsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@CurrentRole() role: Role, @Param('workspaceId') workspaceId: string, @Query() query: unknown) {
    assertCan(role, 'content:write');
    const filters = parse(listSchema, query);
    const saved = filters.saved === 'true';
    const where: Prisma.TopicWorkWhereInput = {
      workspaceId, platform: filters.platform, mediaType: filters.mediaType,
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
      }),
      this.prisma.topicWork.count({ where }),
    ], { isolationLevel: 'RepeatableRead' });
    return { items, total };
  }

  @Post('import')
  async importWorks(@CurrentRole() role: Role, @Param('workspaceId') workspaceId: string, @Body() body: unknown) {
    assertCan(role, 'content:write');
    const { works } = parse(importSchema, body);
    const records = new Map(works.map((item) => [JSON.stringify([item.platform, item.externalId]), item]));
    const importedAt = new Date();
    await this.prisma.$transaction([...records.keys()].sort().map((key) => {
      const item = records.get(key)!;
      const data = { ...item, publishedOn: item.publishedOn ? new Date(item.publishedOn) : null, importedAt };
      return this.prisma.topicWork.upsert({
        where: { workspaceId_platform_externalId: { workspaceId, platform: item.platform, externalId: item.externalId } },
        create: { workspaceId, ...data },
        update: data,
        select: { id: true },
      });
    }));
    return { imported: records.size };
  }

  @Patch(':id')
  async save(@CurrentRole() role: Role, @Param('workspaceId') workspaceId: string, @Param('id') id: string, @Body() body: unknown) {
    assertCan(role, 'content:write');
    const { saved, note } = parse(saveSchema, body);
    const { count } = await this.prisma.topicWork.updateMany({
      where: { id, workspaceId },
      data: { savedAt: saved ? new Date() : null, note },
    });
    if (!count) throw new NotFoundException('参考作品不存在');
    return { ok: true };
  }

  @Post(':id/manuscript')
  async draft(@CurrentRole() role: Role, @CurrentUser() user: SessionUser,
    @Param('workspaceId') workspaceId: string, @Param('id') id: string, @Body() body: unknown) {
    assertCan(role, 'content:write');
    const input = parse(createManuscriptSchema, body);
    const reference = await this.prisma.topicWork.findFirst({ where: { id, workspaceId }, select: { sourceUrl: true } });
    if (!reference) throw new NotFoundException('参考作品不存在');
    return this.prisma.manuscript.create({
      data: { ...input, workspaceId, createdById: user.id, referenceUrl: reference.sourceUrl },
      select: { id: true },
    });
  }
}
