import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { generateVariantsSchema, updateManuscriptSchema, createManuscriptSchema } from '@matrixark/shared';
import { CurrentMembership, CurrentUser } from '../auth/decorators';
import type { SessionUser } from '../auth/session.service';
import { assertCan } from '../common/permissions';
import { parse } from '../common/zod';
import type { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceGuard } from '../workspaces/workspace.guard';
import { ContentService, variantSnapshot } from './content.service';
import { IMAGE_UPLOAD_LIMIT, StorageService, imageDisplayName, validateImageUpload } from './storage.service';

@Controller('workspaces/:workspaceId/manuscripts')
@UseGuards(WorkspaceGuard)
export class ManuscriptsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly content: ContentService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string, @Query('archived') archived?: string) {
    const manuscripts = await this.prisma.manuscript.findMany({
      where: { workspaceId, archivedAt: archived === 'true' ? { not: null } : null },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        variants: {
          where: { status: { not: 'superseded' } },
          select: { id: true, platform: true, version: true, status: true },
        },
        _count: { select: { assets: true } },
      },
    });

    return manuscripts.map((m) => ({
      id: m.id,
      title: m.title,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      archivedAt: m.archivedAt,
      assetCount: m._count.assets,
      variants: m.variants.map((v) => ({
        id: v.id,
        platform: v.platform,
        version: v.version,
        status: v.status,
      })),
    }));
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
        assets: { orderBy: { createdAt: 'asc' } },
        variants: { include: variantSnapshot, orderBy: [{ platform: 'asc' }, { version: 'desc' }] },
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
        platformFields: v.platformFields,
        generationSource: v.generationSource,
        snapshotVersion: v.snapshotVersion,
        sealedAt: v.sealedAt,
        status: v.status,
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
}
