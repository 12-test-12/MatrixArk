import { Controller, Get, NotFoundException, Param, Res, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import sharp from 'sharp';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceGuard } from '../workspaces/workspace.guard';
import { StorageService } from './storage.service';

@Controller('workspaces/:workspaceId/assets')
@UseGuards(WorkspaceGuard)
export class AssetsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  @Get(':id')
  async download(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { data, mimeType } = await this.readAsset(workspaceId, id);
    res.setHeader('content-type', mimeType);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'private, max-age=300');
    res.send(data);
  }

  @Get(':id/video')
  async video(@Param('workspaceId') workspaceId: string, @Param('id') id: string, @Res() res: Response) {
    const asset = await this.prisma.asset.findFirst({ where: { id, workspaceId, kind: 'manuscript_video' } });
    if (!asset) throw new NotFoundException('视频不存在');
    res.setHeader('content-type', 'video/mp4');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'private, max-age=300');
    res.sendFile(this.storage.videoPath(workspaceId, asset.storageKey), { acceptRanges: true });
  }

  @Get(':id/thumbnail')
  async thumbnail(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { data } = await this.readAsset(workspaceId, id);
    const thumbnail = await sharp(data, { limitInputPixels: 40_000_000 })
      .autoOrient()
      .resize(320, 320, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 76 })
      .toBuffer()
      .catch(() => { throw new UnprocessableEntityException('无法生成图片预览'); });
    res.setHeader('content-type', 'image/webp');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'private, no-cache');
    res.send(thumbnail);
  }

  private async readAsset(workspaceId: string, id: string) {
    const asset = await this.prisma.asset.findFirst({ where: { id, workspaceId, kind: 'manuscript_image' } });
    if (!asset) throw new NotFoundException('文件不存在');
    return this.storage.readImage(workspaceId, asset.storageKey);
  }
}
