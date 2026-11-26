import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import type { Role } from '@prisma/client';
import { z } from 'zod';
import { CurrentRole, CurrentUser } from '../auth/decorators';
import type { SessionUser } from '../auth/session.service';
import { assertCan } from '../common/permissions';
import { parse } from '../common/zod';
import { WorkspaceGuard } from '../workspaces/workspace.guard';
import { feishuWebhook } from './feishu';
import { NotificationsService } from './notifications.service';

const settingSchema = z.object({
  enabled: z.boolean(),
  riskAlertEnabled: z.boolean().optional(),
  webhook: z.string().trim().regex(feishuWebhook, '请填写飞书自定义机器人的 HTTPS Webhook 地址').optional(),
  signSecret: z.string().trim().min(1).max(256).nullable().optional(),
}).strict();

@Controller('workspaces/:workspaceId/notifications/feishu')
@UseGuards(WorkspaceGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  get(@Param('workspaceId') workspaceId: string, @CurrentRole() role: Role) {
    assertCan(role, 'workspace:settings');
    return this.notifications.setting(workspaceId);
  }

  @Patch()
  update(@Param('workspaceId') workspaceId: string, @CurrentRole() role: Role,
    @CurrentUser() user: SessionUser, @Body() body: unknown) {
    assertCan(role, 'workspace:settings');
    return this.notifications.updateSetting(workspaceId, user.id, parse(settingSchema, body));
  }

  @Post('test')
  @HttpCode(200)
  test(@Param('workspaceId') workspaceId: string, @CurrentRole() role: Role) {
    assertCan(role, 'workspace:settings');
    return this.notifications.testDelivery(workspaceId);
  }
}
