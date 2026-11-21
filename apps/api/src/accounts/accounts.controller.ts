import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { createAccountSchema } from '@matrixark/shared';
import { z } from 'zod';
import type { Role } from '@prisma/client';
import { CurrentMembership } from '../auth/decorators';
import { assertCan } from '../common/permissions';
import { parse } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceGuard } from '../workspaces/workspace.guard';

const updateAccountSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  operator: z.string().trim().max(40).optional(),
  channelKind: z.enum(['official', 'manual', 'sandbox']).optional(),
  credentials: z.record(z.string()).optional(),
});

@Controller('workspaces/:workspaceId/accounts')
@UseGuards(WorkspaceGuard)
export class AccountsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string) {
    const accounts = await this.prisma.channelAccount.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { tasks: true } } },
    });
    return accounts.map((account) => ({
      id: account.id,
      platform: account.platform,
      channelKind: account.channelKind,
      displayName: account.displayName,
      operator: account.operator,
      hasCredentials: Boolean(account.credentials),
      taskCount: account._count.tasks,
      createdAt: account.createdAt,
    }));
  }

  @Post()
  async create(
    @CurrentMembership() membership: { role: Role },
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    assertCan(membership.role, 'account:manage');
    const input = parse(createAccountSchema, body);
    return this.prisma.channelAccount.create({
      data: {
        workspaceId,
        platform: input.platform,
        channelKind: input.channelKind,
        authStatus: input.channelKind === 'manual' ? 'active' : 'pending',
        displayName: input.displayName,
        operator: input.operator,
        credentials: input.credentials,
      },
    });
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
    return this.prisma.channelAccount.update({ where: { id }, data: input });
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
