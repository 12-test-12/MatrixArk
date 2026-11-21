import {
  Body,
  Controller,
  ConflictException,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { Role } from '@prisma/client';
import { CurrentMembership, CurrentUser } from '../auth/decorators';
import type { SessionUser } from '../auth/session.service';
import { assertCan } from '../common/permissions';
import { parse } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceGuard } from '../workspaces/workspace.guard';
import { publishChannel } from './publish-account';
import { XiaohongshuIdentityService } from './xiaohongshu-identity.service';

const updateAccountSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  operator: z.string().trim().max(40).optional(),
}).strict();

@Controller('workspaces/:workspaceId/accounts')
@UseGuards(WorkspaceGuard)
export class AccountsController {
  constructor(private readonly prisma: PrismaService, private readonly xiaohongshu: XiaohongshuIdentityService) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string) {
    const accounts = await this.prisma.channelAccount.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { tasks: true } } },
    });
    const now = new Date();
    return accounts.map((account) => {
      const channel = publishChannel(account, now);
      return {
        id: account.id,
        platform: account.platform,
        channelKind: account.channelKind,
        displayName: account.displayName,
        operator: account.operator,
        identityVerified: Boolean(account.externalId && account.authCheckedAt),
        identityCheckedAt: account.authCheckedAt,
        availableForHandoff: channel === 'manual',
        availableForOfficial: channel === 'official' || channel === 'sandbox',
        hasCredentials: Boolean(account.credentialsCiphertext || account.credentials),
        taskCount: account._count.tasks,
        createdAt: account.createdAt,
      };
    });
  }

  @Post()
  create(@CurrentMembership() membership: { role: Role }) {
    assertCan(membership.role, 'account:manage');
    throw new ConflictException('通过平台授权核验身份后才能添加发布账号。');
  }

  @Post('xiaohongshu/authorize')
  authorizeXiaohongshu(
    @CurrentMembership() membership: { role: Role },
    @CurrentUser() user: SessionUser,
    @Param('workspaceId') workspaceId: string,
  ) {
    assertCan(membership.role, 'account:manage');
    return this.xiaohongshu.start(workspaceId, user.id);
  }

  @Post('xiaohongshu/authorize/:id/poll')
  @HttpCode(200)
  pollXiaohongshu(
    @CurrentMembership() membership: { role: Role },
    @CurrentUser() user: SessionUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    assertCan(membership.role, 'account:manage');
    return this.xiaohongshu.poll(workspaceId, user.id, id);
  }

  @Patch(':id')
  async update(
    @CurrentMembership() membership: { role: Role },
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    assertCan(membership.role, 'account:manage');
    const input = parse(updateAccountSchema, body);
    const existing = await this.prisma.channelAccount.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('账号不存在');
    if (existing.externalId && existing.authCheckedAt && input.displayName !== undefined) {
      throw new ConflictException('已核验账号使用平台昵称。');
    }
    return this.prisma.channelAccount.update({
      where: { id }, data: input, select: { id: true, platform: true, channelKind: true, displayName: true, operator: true },
    });
  }

  @Delete(':id')
  async remove(
    @CurrentMembership() membership: { role: Role },
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    assertCan(membership.role, 'account:manage');
    const existing = await this.prisma.channelAccount.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('账号不存在');
    const active = await this.prisma.publishTask.count({
      where: { accountId: id, status: { in: ['scheduled', 'dispatching', 'handed_off', 'submitted', 'under_review'] } },
    });
    if (active > 0) throw new NotFoundException('该账号还有未完成的任务，先处理完再删除');
    await this.prisma.channelAccount.delete({ where: { id } });
    return { ok: true };
  }
}
