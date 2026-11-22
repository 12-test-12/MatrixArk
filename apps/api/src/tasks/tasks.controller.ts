import {
  Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Res,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { recordResultSchema, scheduleTasksSchema, TASK_STATUSES } from '@matrixark/shared';
import type { Role } from '@prisma/client';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentRole, CurrentUser } from '../auth/decorators';
import type { SessionUser } from '../auth/session.service';
import { assertCan } from '../common/permissions';
import { parse } from '../common/zod';
import { IMAGE_UPLOAD_LIMIT, StorageService, validateImageUpload } from '../content/storage.service';
import { WorkspaceGuard } from '../workspaces/workspace.guard';
import { TasksService } from './tasks.service';

const listSchema = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  accountId: z.string().min(1).max(128).optional(),
  manuscriptId: z.string().min(1).max(128).optional(),
  cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const performanceSchema = listSchema.pick({ accountId: true, cursor: true, limit: true }).extend({
  platform: z.enum(['bilibili', 'xiaohongshu']).optional(),
  content: z.enum(['article', 'video']).optional(),
});
const metricCount = z.number().int().min(0).max(2_147_483_647).nullable().default(null);
const metricsSchema = z.object({
  views: metricCount, likes: metricCount, comments: metricCount, favorites: metricCount, shares: metricCount,
}).strict().refine((value) => Object.values(value).some((count) => count !== null), '请填写至少一项成效数据');

@Controller('workspaces/:workspaceId/tasks')
@UseGuards(WorkspaceGuard)
export class TasksController {
  constructor(private readonly tasks: TasksService, private readonly storage: StorageService) {}

  @Post()
  async schedule(
    @CurrentRole() role: Role,
    @CurrentUser() user: SessionUser,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    assertCan(role, 'task:schedule');
    const input = parse(scheduleTasksSchema, body);
    const items = await this.tasks.schedule(workspaceId, user.id, input);
    response.status(items.some(({ disposition }) => disposition === 'created') ? 201 : 200);
    return { items };
  }

  @Get()
  list(@Param('workspaceId') workspaceId: string, @Query() query: unknown) {
    return this.tasks.list(workspaceId, parse(listSchema, query));
  }

  @Get('performance')
  performance(@Param('workspaceId') workspaceId: string, @Query() query: unknown) {
    return this.tasks.list(workspaceId, { ...parse(performanceSchema, query), performance: true });
  }

  @Get(':id')
  detail(@Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    return this.tasks.detail(workspaceId, id);
  }

  @Get(':id/handoff')
  handoff(@CurrentRole() role: Role, @Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    assertCan(role, 'task:result');
    return this.tasks.handoff(workspaceId, id);
  }

  @Post(':id/evidence')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMAGE_UPLOAD_LIMIT } }))
  async uploadEvidence(
    @CurrentRole() role: Role,
    @CurrentUser() user: SessionUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @UploadedFile() upload: Express.Multer.File | undefined,
  ) {
    assertCan(role, 'task:result');
    const { file, filename, mimeType } = validateImageUpload(upload);
    const task = await this.tasks.evidenceTarget(workspaceId, id);
    this.tasks.requireHandoff(task);
    const { key } = await this.storage.save(workspaceId, filename, file.buffer);
    return this.tasks.attachEvidence(workspaceId, id, user.id, {
      storageKey: key, filename, size: file.size, mimeType,
    });
  }

  @Get(':id/evidence')
  async downloadEvidence(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Res() response: Response,
  ) {
    const task = await this.tasks.evidenceTarget(workspaceId, id);
    const image = task.result?.evidenceAsset;
    if (!image || image.workspaceId !== workspaceId || image.taskId !== task.id || image.kind !== 'task_evidence') {
      throw new NotFoundException('回执截图不存在');
    }
    const { data, mimeType } = await this.storage.readImage(workspaceId, image.storageKey);
    response.setHeader('content-type', mimeType);
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('cache-control', 'private, no-store');
    response.send(data);
  }

  @Post(':id/result')
  @HttpCode(200)
  recordResult(
    @CurrentRole() role: Role,
    @CurrentUser() user: SessionUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    assertCan(role, 'task:result');
    return this.tasks.recordResult(workspaceId, id, user.id, parse(recordResultSchema, body));
  }

  @Patch(':id/metrics')
  recordMetrics(@CurrentRole() role: Role, @CurrentUser() user: SessionUser, @Param('workspaceId') workspaceId: string,
    @Param('id') id: string, @Body() body: unknown) {
    assertCan(role, 'task:result');
    return this.tasks.saveMetrics(workspaceId, id, user.id, parse(metricsSchema, body));
  }

  @Get(':id/metrics/history')
  metricHistory(@Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    return this.tasks.metricHistory(workspaceId, id);
  }

  @Post(':id/metrics/sync')
  @HttpCode(200)
  syncMetrics(@CurrentRole() role: Role, @CurrentUser() user: SessionUser, @Param('workspaceId') workspaceId: string,
    @Param('id') id: string) {
    assertCan(role, 'task:result');
    return this.tasks.syncMetrics(workspaceId, id, user.id);
  }
}
