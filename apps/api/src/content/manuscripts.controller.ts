import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UnsupportedMediaTypeException,
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
import { ContentService } from './content.service';
import { StorageService } from './storage.service';

@Controller('workspaces/:workspaceId/manuscripts')
@UseGuards(WorkspaceGuard)
export class ManuscriptsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly content: ContentService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string) {
    const manuscripts = await this.prisma.manuscript.findMany({
      where: { workspaceId },
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
        variants: { include: { approval: true }, orderBy: [{ platform: 'asc' }, { version: 'desc' }] },
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
      imageCount,
      assets: manuscript.assets,
      variants: manuscript.variants.map((v) => ({
        id: v.id,
        platform: v.platform,
        version: v.version,
        title: v.title,
        body: v.body,
        tags: v.tags,
        status: v.status,
        isCurrent: v.status !== 'superseded',
        createdAt: v.createdAt,
        approval: v.approval
          ? { approvedById: v.approval.approvedById, approvedAt: v.approval.approvedAt, note: v.approval.note }
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
    const existing = await this.prisma.manuscript.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('稿件不存在');
    return this.prisma.manuscript.update({ where: { id }, data: input });
  }

  @Delete(':id')
  async remove(
    @CurrentMembership() membership: { role: Role },
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    assertCan(membership.role, 'content:write');
    const existing = await this.prisma.manuscript.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('稿件不存在');
    await this.prisma.manuscript.delete({ where: { id } });
    return { ok: true };
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
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async uploadAsset(
    @CurrentMembership() membership: { role: Role },
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    assertCan(membership.role, 'content:write');
    if (!file) throw new NotFoundException('没有收到文件');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype) || file.size === 0) {
      throw new UnsupportedMediaTypeException('只接受非空的 JPEG、PNG 或 WebP 图片');
    }
    const manuscript = await this.prisma.manuscript.findFirst({ where: { id, workspaceId } });
    if (!manuscript) throw new NotFoundException('稿件不存在');

    const { key } = await this.storage.save(workspaceId, file.originalname, file.buffer);
    return this.prisma.asset.create({
      data: {
        workspaceId,
        manuscriptId: id,
        kind: 'manuscript_image',
        storageKey: key,
        filename: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
      },
    });
  }
}
