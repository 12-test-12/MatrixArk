import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { addMemberSchema } from '@matrixark/shared';
import type { Role } from '@prisma/client';
import { z } from 'zod';
import { assertCan, ASSIGNABLE_ROLES, can } from '../common/permissions';
import { CurrentMembership, CurrentUser } from '../auth/decorators';
import type { SessionUser } from '../auth/session.service';
import { parse } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceGuard } from './workspace.guard';
import { WorkspacesService } from './workspaces.service';

@Controller('workspaces')
export class WorkspacesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly service: WorkspacesService,
  ) {}

  @Get()
  async list(@CurrentUser() user: SessionUser) {
    const memberships = await this.prisma.membership.findMany({
      where: { userId: user.id },
      include: { workspace: { include: { _count: { select: { manuscripts: true, accounts: true } } } } },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      role: m.role,
      manuscriptCount: m.workspace._count.manuscripts,
      accountCount: m.workspace._count.accounts,
    }));
  }

  @Post()
  async create(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const input = parse(z.object({ name: z.string().trim().min(1, '工作室名称不能为空').max(60) }), body);
    const workspace = await this.service.createForUser(user.id, input.name);
    return { id: workspace.id, name: workspace.name, role: 'owner' as const };
  }

  @Get(':workspaceId')
  @UseGuards(WorkspaceGuard)
  async detail(@Param('workspaceId') workspaceId: string) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        memberships: { include: { user: { select: { id: true, name: true, email: true } } } },
      },
    });
    if (!workspace) throw new NotFoundException('工作室不存在');
    return {
      id: workspace.id,
      name: workspace.name,
      members: workspace.memberships.map((m) => ({
        id: m.id,
        role: m.role,
        user: m.user,
      })),
    };
  }

  @Get(':workspaceId/members')
  @UseGuards(WorkspaceGuard)
  async members(@Param('workspaceId') workspaceId: string) {
    const memberships = await this.prisma.membership.findMany({
      where: { workspaceId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((m) => ({ id: m.id, role: m.role, user: m.user }));
  }

  @Get(':workspaceId/workbench-summary')
  @UseGuards(WorkspaceGuard)
  async workbenchSummary(@Param('workspaceId') workspaceId: string, @CurrentMembership() membership: { role: Role }) {
    const [tasks, pendingReview] = await Promise.all([
      this.prisma.publishTask.groupBy({ by: ['status'], where: { workspaceId }, _count: { _all: true } }),
      can(membership.role, 'content:approve') ? this.prisma.manuscript.count({
        where: { workspaceId, archivedAt: null, variants: { some: { status: 'draft', rejections: { none: {} } } } },
      }) : Promise.resolve(null),
    ]);
    return { taskCounts: Object.fromEntries(tasks.map((task) => [task.status, task._count._all])), pendingReview };
  }

  @Post(':workspaceId/members')
  @UseGuards(WorkspaceGuard)
  async addMember(
    @CurrentMembership() membership: { role: 'owner' | 'editor' | 'reviewer' | 'operator' | 'viewer' },
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    assertCan(membership.role, 'member:manage');
    const input = parse(addMemberSchema, body);
    if (!ASSIGNABLE_ROLES.includes(input.role)) throw new ForbiddenException('不能授予该角色');

    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (!user) throw new NotFoundException('该邮箱还没有注册，请对方先注册再添加');

    const existing = await this.prisma.membership.findUnique({
      where: { userId_workspaceId: { userId: user.id, workspaceId } },
    });
    if (existing) throw new ForbiddenException('该成员已在工作室里');

    const created = await this.prisma.membership.create({
      data: { userId: user.id, workspaceId, role: input.role },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    return { id: created.id, role: created.role, user: created.user };
  }

  @Patch(':workspaceId/members/:memberId')
  @UseGuards(WorkspaceGuard)
  async updateMemberRole(
    @CurrentMembership() membership: { role: 'owner' | 'editor' | 'reviewer' | 'operator' | 'viewer' },
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Body() body: unknown,
  ) {
    assertCan(membership.role, 'member:manage');
    const input = parse(z.object({ role: z.enum(['editor', 'reviewer', 'operator', 'viewer']) }), body);
    const target = await this.prisma.membership.findFirst({ where: { id: memberId, workspaceId } });
    if (!target) throw new NotFoundException('成员不存在');
    if (target.role === 'owner') throw new ForbiddenException('不能修改负责人的角色');

    const updated = await this.prisma.membership.update({
      where: { id: memberId },
      data: { role: input.role },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    return { id: updated.id, role: updated.role, user: updated.user };
  }

  @Delete(':workspaceId/members/:memberId')
  @UseGuards(WorkspaceGuard)
  async removeMember(
    @CurrentMembership() membership: { role: 'owner' | 'editor' | 'reviewer' | 'operator' | 'viewer' },
    @CurrentUser() user: SessionUser,
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
  ) {
    assertCan(membership.role, 'member:manage');
    const target = await this.prisma.membership.findFirst({
      where: { id: memberId, workspaceId },
      include: { user: true },
    });
    if (!target) throw new NotFoundException('成员不存在');
    if (target.role === 'owner') throw new ForbiddenException('不能移除负责人');
    if (target.userId === user.id) throw new ForbiddenException('不能移除自己');
    await this.prisma.membership.delete({ where: { id: memberId } });
    return { ok: true };
  }
}
