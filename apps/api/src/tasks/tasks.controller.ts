import {
  BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Res,
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
    const variants = [...new Set(input.variantIds)];
    const accounts = [...new Set(input.accountIds)];
    if (variants.length !== 1 || accounts.length !== 1) throw new BadRequestException('每次排期请选择一个版本和一个账号');
    const { task, disposition } = await this.tasks.schedule(workspaceId, user.id, variants[0]!, accounts[0]!, input.scheduledAt);
    const { id, accountId, variantId, status, scheduledAt } = task;
    response.status(disposition === 'created' ? 201 : 200);
    return { items: [{ id, accountId, variantId, status, scheduledAt, disposition }] };
  }

  @Get()
  list(@Param('workspaceId') workspaceId: string, @Query() query: unknown) {
    return this.tasks.list(workspaceId, parse(listSchema, query));
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
    const { file, mimeType } = validateImageUpload(upload);
    const task = await this.tasks.evidenceTarget(workspaceId, id);
    this.tasks.requireHandoff(task);
    const { key } = await this.storage.save(workspaceId, file.originalname, file.buffer);
    return this.tasks.attachEvidence(workspaceId, id, user.id, {
      storageKey: key, filename: file.originalname, size: file.size, mimeType,
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
}
