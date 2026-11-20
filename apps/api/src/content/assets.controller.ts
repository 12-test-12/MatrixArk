import { Controller, Get, NotFoundException, Param, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
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
    const asset = await this.prisma.asset.findFirst({ where: { id, workspaceId } });
    if (!asset) throw new NotFoundException('文件不存在');
    const data = await this.storage.read(asset.storageKey);
    res.setHeader('content-type', asset.mimeType);
    res.setHeader('cache-control', 'private, max-age=300');
    res.send(data);
  }
}
