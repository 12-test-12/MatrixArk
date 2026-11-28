import { Body, Controller, Delete, Get, Header, Param, Post, UseGuards, ConflictException } from '@nestjs/common';
import type { Role } from '@prisma/client';
import { z } from 'zod';
import { CurrentMembership, CurrentTrial, CurrentUser } from '../auth/decorators';
import type { SessionUser } from '../auth/session.service';
import { assertCan } from '../common/permissions';
import { parse } from '../common/zod';
import { WorkspaceGuard } from '../workspaces/workspace.guard';
import { BilibiliBrowserService } from './bilibili-browser.service';

const openSchema = z.object({ accountId: z.string().min(1).optional(), sessionId: z.string().uuid().optional() })
  .strict().refine((input) => !(input.accountId && input.sessionId), '不能同时指定账号和会话');

@Controller('workspaces/:workspaceId/accounts/bilibili/browser')
@UseGuards(WorkspaceGuard)
export class BilibiliBrowserController {
  constructor(private readonly browsers: BilibiliBrowserService) {}

  private authorize(role: Role, trial: boolean) {
    assertCan(role, 'account:manage');
    if (trial) throw new ConflictException('试用工作室不支持真实浏览器登录，请切换到正式工作室');
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Param('workspaceId') workspaceId: string, @CurrentMembership() membership: { role: Role }, @CurrentTrial() trial: boolean) {
    this.authorize(membership.role, trial);
    return this.browsers.list(workspaceId);
  }

  @Post('open')
  open(@Param('workspaceId') workspaceId: string, @CurrentMembership() membership: { role: Role },
    @CurrentTrial() trial: boolean, @Body() body: unknown) {
    this.authorize(membership.role, trial);
    return this.browsers.open(workspaceId, parse(openSchema, body));
  }

  @Post(':id/check')
  check(@Param('workspaceId') workspaceId: string, @Param('id') id: string,
    @CurrentMembership() membership: { role: Role }, @CurrentTrial() trial: boolean, @CurrentUser() user: SessionUser) {
    this.authorize(membership.role, trial);
    return this.browsers.check(workspaceId, user.id, id);
  }

  @Post(':id/close')
  close(@Param('workspaceId') workspaceId: string, @Param('id') id: string,
    @CurrentMembership() membership: { role: Role }, @CurrentTrial() trial: boolean) {
    this.authorize(membership.role, trial);
    return this.browsers.close(workspaceId, id);
  }

  @Delete(':id')
  remove(@Param('workspaceId') workspaceId: string, @Param('id') id: string,
    @CurrentMembership() membership: { role: Role }, @CurrentTrial() trial: boolean) {
    this.authorize(membership.role, trial);
    return this.browsers.remove(workspaceId, id);
  }
}
