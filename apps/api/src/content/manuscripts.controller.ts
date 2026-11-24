import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { generateVariantsSchema, updateManuscriptSchema, createManuscriptSchema } from '@matrixark/shared';
import { CurrentMembership, CurrentUser } from '../auth/decorators';
import type { SessionUser } from '../auth/session.service';
import { assertCan } from '../common/permissions';
import { parse } from '../common/zod';
import type { Prisma, Role } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceGuard } from '../workspaces/workspace.guard';
import { ContentService, variantRejections, variantSnapshot } from './content.service';
import { IMAGE_UPLOAD_LIMIT, VIDEO_UPLOAD_LIMIT, StorageService, imageDisplayName, validateImageUpload } from './storage.service';

const listSchema = z.object({
  archived: z.enum(['true', 'false']).optional(),
  review: z.enum(['all', 'pending', 'returned']).optional(),
  cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

@Controller('workspaces/:workspaceId/manuscripts')
@UseGuards(WorkspaceGuard)
export class ManuscriptsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly content: ContentService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string, @CurrentUser() user: SessionUser, @Query() query: unknown) {
    const { archived, review, cursor, limit } = parse(listSchema, query);
    const reviewFilter = review === 'all' ? undefined : review;
    const paged = limit !== undefined || review !== undefined || cursor !== undefined;
    const pageSize = limit ?? (paged ? 20 : 100);
    const authorId = reviewFilter === 'returned' ? user.id : undefined;
    const scope = JSON.stringify([workspaceId, archived === 'true', reviewFilter, authorId]);
    let after: Prisma.ManuscriptWhereInput = {};
    if (cursor) {
      try {
        const [cursorScope, timestamp, id]: unknown[] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (cursorScope !== scope || typeof timestamp !== 'string' || typeof id !== 'string' || !id) throw new Error();
        const createdAt = new Date(timestamp);
        if (createdAt.toISOString() !== timestamp) throw new Error();
        after = { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }] };
      } catch {
        throw new BadRequestException('原稿分页游标无效');
      }
    }
    const manuscripts = await this.prisma.manuscript.findMany({
      where: {
        workspaceId, archivedAt: archived === 'true' ? { not: null } : null, createdById: authorId,
        ...(reviewFilter && { variants: { some: {
          status: 'draft',
          rejections: reviewFilter === 'pending' ? { none: {} } : { some: {} },
        } } }),
        ...after,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: pageSize + (paged ? 1 : 0),
      include: {
        variants: {
          where: { status: { not: 'superseded' } },
          select: {
            id: true, platform: true, version: true, status: true,
            rejections: { take: 1, select: { id: true } },
          },
        },
        _count: { select: { assets: { where: { kind: 'manuscript_image' } } } },
      },
    });

    const items = manuscripts.slice(0, pageSize).map((m) => ({
      id: m.id,
      title: m.title,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      archivedAt: m.archivedAt,
      assetCount: m._count.assets,
      videoAssetId: m.videoAssetId,
      variants: m.variants.map((v) => ({
        id: v.id,
        platform: v.platform,
        version: v.version,
        status: v.status,
        returned: v.status === 'draft' && v.rejections.length > 0,
      })),
    }));
    if (!paged) return items;
    const last = items.at(-1);
    return {
      items,
      nextCursor: manuscripts.length > pageSize && last
        ? Buffer.from(JSON.stringify([scope, last.createdAt.toISOString(), last.id])).toString('base64url')
        : null,
    };
  }

  @Post()
  async create(
    @CurrentMembership() membership: { role: Role },
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
    @Body() body: unknown,
  ) {
    assertCan(membership.role, 'content:write');
    const input = parse(createManuscriptSchema, body);
    const manuscript = await this.prisma.manuscript.create({
      data: { workspaceId, title: input.title, body: input.body, tags: input.tags, createdById: user.id },
    });
    return manuscript;
  }

  @Get(':id')
  async detail(@Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    const manuscript = await this.prisma.manuscript.findFirst({
      where: { id, workspaceId },
      include: {
        assets: { where: { kind: 'manuscript_image' }, orderBy: { createdAt: 'asc' } },
        videoAsset: { select: { id: true, filename: true, size: true } },
        variants: {
          include: { ...variantSnapshot, rejections: variantRejections },
          orderBy: [{ platform: 'asc' }, { version: 'desc' }],
        },
      },
    });
    if (!manuscript) throw new NotFoundException('稿件不存在');

    const imageCount = manuscript.assets.filter((a) => a.mimeType.startsWith('image/')).length;
    return {
      id: manuscript.id,
      title: manuscript.title,
      body: manuscript.body,
      tags: manuscript.tags,
      createdAt: manuscript.createdAt,
      updatedAt: manuscript.updatedAt,
      archivedAt: manuscript.archivedAt,
      videoAsset: manuscript.videoAsset,
      imageCount,
      assets: manuscript.assets.map((asset) => ({ ...asset, filename: imageDisplayName(asset.filename) })),
      variants: manuscript.variants.map((v) => ({
        id: v.id,
        platform: v.platform,
        version: v.version,
        title: v.title,
        body: v.body,
        tags: v.tags,
        assets: v.assets,
        videoAsset: v.videoAsset,
        platformFields: v.platformFields,
        generationSource: v.generationSource,
        snapshotVersion: v.snapshotVersion,
        sealedAt: v.sealedAt,
        status: v.status,
        returned: v.status === 'draft' && v.rejections.length > 0,
        rejections: v.rejections,
        isCurrent: v.status !== 'superseded',
        createdAt: v.createdAt,
        approval: v.approval
          ? {
            approvedById: v.approval.approvedById,
            approvedAt: v.approval.approvedAt,
            note: v.approval.note,
            snapshotHash: v.approval.snapshotHash,
          }
          : null,
      })),
    };
  }

  @Patch(':id')
  async update(
    @CurrentMembership() membership: { role: Role },
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    assertCan(membership.role, 'content:write');
    const input = parse(updateManuscriptSchema, body);
    return this.content.updateManuscript(workspaceId, id, input);
  }

  @Delete(':id')
  async remove(
    @CurrentMembership() membership: { role: Role },
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
  ) {
    assertCan(membership.role, 'content:write');
    return this.content.archiveManuscript(workspaceId, id, user.id, true);
  }

  @Patch(':id/restore')
  restore(@CurrentMembership() membership: { role: Role }, @Param('workspaceId') workspaceId: string,
    @Param('id') id: string, @CurrentUser() user: SessionUser) {
    assertCan(membership.role, 'content:write');
    return this.content.archiveManuscript(workspaceId, id, user.id, false);
  }

  @Post(':id/generate')
  async generate(
    @CurrentMembership() membership: { role: Role },
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
    @Body() body: unknown,
  ) {
    assertCan(membership.role, 'content:write');
    const input = parse(generateVariantsSchema, body);
    const variants = await this.content.generateDrafts({
      workspaceId,
      manuscriptId: id,
      platforms: input.platforms,
      userId: user.id,
    });
    return variants;
  }

  @Post(':id/assets')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMAGE_UPLOAD_LIMIT } }))
  async uploadAsset(
    @CurrentMembership() membership: { role: Role },
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @UploadedFile() upload: Express.Multer.File | undefined,
  ) {
    assertCan(membership.role, 'content:write');
    const { file, filename, mimeType } = validateImageUpload(upload);
    return this.prisma.$transaction(async (tx) => {
      await this.content.lockManuscript(tx, workspaceId, id);
      const { key } = await this.storage.save(workspaceId, filename, file.buffer);
      try {
        return await tx.asset.create({ data: { workspaceId, manuscriptId: id, kind: 'manuscript_image',
          storageKey: key, filename, mimeType, size: file.size } });
      } catch (error) {
        await this.storage.remove(key).catch(() => undefined);
        throw error;
      }
    });
  }

  @Put(':id/video')
  async uploadVideo(@CurrentMembership() membership: { role: Role }, @CurrentUser() user: SessionUser,
    @Param('workspaceId') workspaceId: string, @Param('id') id: string, @Query('filename') filename: string,
    @Req() request: Request) {
    assertCan(membership.role, 'content:write');
    const contentType = request.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'video/mp4') throw new UnsupportedMediaTypeException('请选择 MP4 视频');
    const size = Number(request.get('x-video-size'));
    if (!Number.isSafeInteger(size) || size <= 0) throw new BadRequestException('视频大小无效');
    if (size > VIDEO_UPLOAD_LIMIT) throw new PayloadTooLargeException('视频不能超过 100 MiB');
    if (typeof filename !== 'string' || !/^[^\u0000-\u001f/\\]{1,180}\.mp4$/iu.test(filename)) {
      throw new BadRequestException('视频文件名无效');
    }
    const manuscript = await this.prisma.manuscript.findFirst({ where: { id, workspaceId, archivedAt: null }, select: { id: true } });
    if (!manuscript) throw new NotFoundException('在用原稿不存在');
    const file = await this.storage.saveVideo(workspaceId, request, size);
    try {
      const result = await this.content.replaceVideo(workspaceId, id, user.id, { ...file, filename });
      if (!result.changed) await this.storage.remove(file.storageKey).catch(() => undefined);
      return result;
    } catch (error) {
      // Preserve the file when the database cannot confirm whether the transaction committed.
      const stored = await this.prisma.asset.findUnique({ where: { storageKey: file.storageKey } }).catch(() => undefined);
      if (stored === null) await this.storage.remove(file.storageKey).catch(() => undefined);
      throw error;
    }
  }
}
