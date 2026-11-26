import {
  Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Res,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { adjustTaskScheduleSchema, cancelTaskSchema, recordResultSchema, scheduleTasksSchema, TASK_STATUSES, verifyTaskSchema } from '@matrixark/shared';
import type { Role } from '@prisma/client';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentRole, CurrentUser } from '../auth/decorators';
import type { SessionUser } from '../auth/session.service';
import { assertCan } from '../common/permissions';
import { parse } from '../common/zod';
import { IMAGE_UPLOAD_LIMIT, validateImageUpload } from '../content/storage.service';
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
  groupId: z.string().min(1).max(128).optional(),
  content: z.enum(['article', 'video']).optional(),
  days: z.coerce.number().int().min(1).max(365).optional(),
});
const metricCount = z.number().int().min(0).max(2_147_483_647).nullable().default(null);
const metricsSchema = z.object({
  views: metricCount, likes: metricCount, comments: metricCount, favorites: metricCount, shares: metricCount,
  recordedAt: z.string().datetime({ offset: true }).transform((value) => new Date(value)).optional(),
}).strict().refine((value) => (
  value.views !== null || value.likes !== null || value.comments !== null
  || value.favorites !== null || value.shares !== null
), '请填写至少一项成效数据');
const historyQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional(),
});

@Controller('workspaces/:workspaceId/tasks')
@UseGuards(WorkspaceGuard)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

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

  @Patch(':id/schedule')
  reschedule(@CurrentRole() role: Role, @CurrentUser() user: SessionUser, @Param('workspaceId') workspaceId: string,
    @Param('id') id: string, @Body() body: unknown) {
    assertCan(role, 'task:manage');
    return this.tasks.changeSchedule(workspaceId, id, user.id, parse(adjustTaskScheduleSchema, body).scheduledAt, 'reschedule');
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentRole() role: Role, @CurrentUser() user: SessionUser, @Param('workspaceId') workspaceId: string,
    @Param('id') id: string, @Body() body: unknown) {
    assertCan(role, 'task:manage');
    return this.tasks.cancel(workspaceId, id, user.id, role, parse(cancelTaskSchema, body));
  }

  @Post(':id/verify')
  @HttpCode(200)
  verify(@CurrentRole() role: Role, @CurrentUser() user: SessionUser, @Param('workspaceId') workspaceId: string,
    @Param('id') id: string, @Body() body: unknown) {
    assertCan(role, 'task:result');
    return this.tasks.verify(workspaceId, id, user.id, parse(verifyTaskSchema, body));
  }

  @Post(':id/resume')
  @HttpCode(200)
  resume(@CurrentRole() role: Role, @CurrentUser() user: SessionUser, @Param('workspaceId') workspaceId: string,
    @Param('id') id: string, @Body() body: unknown) {
    assertCan(role, 'task:manage');
    return this.tasks.changeSchedule(workspaceId, id, user.id, parse(adjustTaskScheduleSchema, body).scheduledAt, 'resume');
  }

  @Post(':id/retry')
  @HttpCode(200)
  retry(@CurrentRole() role: Role, @CurrentUser() user: SessionUser, @Param('workspaceId') workspaceId: string,
    @Param('id') id: string, @Body() body: unknown) {
    assertCan(role, 'task:manage');
    return this.tasks.changeSchedule(workspaceId, id, user.id, parse(adjustTaskScheduleSchema, body).scheduledAt, 'retry');
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
    return this.tasks.attachEvidence(workspaceId, id, user.id, role, {
      filename, size: file.size, mimeType, buffer: file.buffer,
    });
  }

  @Get(':id/evidence')
  async downloadEvidence(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Query('assetId') assetId: unknown,
    @Res() response: Response,
  ) {
    const { data, mimeType } = await this.tasks.readEvidence(workspaceId, id, parse(z.string().uuid().optional(), assetId));
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
    return this.tasks.recordResult(workspaceId, id, user.id, role, parse(recordResultSchema, body));
  }

  @Patch(':id/metrics')
  recordMetrics(@CurrentRole() role: Role, @CurrentUser() user: SessionUser, @Param('workspaceId') workspaceId: string,
    @Param('id') id: string, @Body() body: unknown) {
    assertCan(role, 'task:result');
    return this.tasks.saveMetrics(workspaceId, id, user.id, parse(metricsSchema, body));
  }

  @Get(':id/metrics/history')
  metricHistory(@Param('workspaceId') workspaceId: string, @Param('id') id: string, @Query() query: unknown) {
    const { days } = parse(historyQuerySchema, query);
    return this.tasks.metricHistory(workspaceId, id, days);
  }

  @Post(':id/metrics/sync')
  @HttpCode(200)
  syncMetrics(@CurrentRole() role: Role, @CurrentUser() user: SessionUser, @Param('workspaceId') workspaceId: string,
    @Param('id') id: string) {
    assertCan(role, 'task:result');
    return this.tasks.syncMetrics(workspaceId, id, user.id);
  }
}
