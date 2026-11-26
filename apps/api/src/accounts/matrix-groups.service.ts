import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { cleanTags } from './account-secrets';
import { resolveAccountCapabilities } from './account-capabilities';

export const matrixGroupColors = ['blue', 'rose', 'emerald', 'amber', 'violet', 'cyan', 'slate'] as const;

export const createMatrixGroupSchema = z.object({
  name: z.string().trim().min(1, '请输入矩阵组名称').max(40, '矩阵组名称不能超过 40 字'),
  color: z.enum(matrixGroupColors).default('blue'),
  description: z.string().trim().max(160, '说明不能超过 160 字').default(''),
  sortOrder: z.number().int().min(-9999).max(9999).default(0),
}).strict();

export const updateMatrixGroupSchema = createMatrixGroupSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  '请至少修改一项矩阵组配置',
);

export const batchAccountsSchema = z.object({
  accountIds: z.array(z.string().min(1)).min(1, '请至少选择一个账号').max(200),
  action: z.enum(['set_group', 'set_operator', 'set_pinned', 'add_tags', 'clear_tags']),
  groupId: z.string().min(1).nullable().optional(),
  operator: z.string().trim().max(40).optional(),
  pinned: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1).max(24)).max(12).optional(),
}).strict();

@Injectable()
export class MatrixGroupsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string, trial = false) {
    const [groups, accounts] = await Promise.all([
      this.prisma.matrixGroup.findMany({
        where: { workspaceId },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.channelAccount.findMany({
        where: { workspaceId, archivedAt: null },
      }),
    ]);
    const now = new Date();
    const counts = new Map<string, { total: number; available: number; risk: number }>();
    for (const account of accounts) {
      if (!account.groupId) continue;
      const entry = counts.get(account.groupId) ?? { total: 0, available: 0, risk: 0 };
      entry.total += 1;
      if (resolveAccountCapabilities(account, now, trial).channel) entry.available += 1;
      if (account.riskStatus !== 'normal') entry.risk += 1;
      counts.set(account.groupId, entry);
    }
    return groups.map((group) => {
      const stat = counts.get(group.id) ?? { total: 0, available: 0, risk: 0 };
      return {
        id: group.id,
        name: group.name,
        color: group.color,
        description: group.description,
        sortOrder: group.sortOrder,
        accountCount: stat.total,
        availableCount: stat.available,
        riskCount: stat.risk,
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
      };
    });
  }

  async create(workspaceId: string, input: z.infer<typeof createMatrixGroupSchema>) {
    try {
      const group = await this.prisma.matrixGroup.create({
        data: {
          id: randomUUID(),
          workspaceId,
          name: input.name,
          color: input.color,
          description: input.description,
          sortOrder: input.sortOrder,
        },
      });
      return { ...group, accountCount: 0, availableCount: 0, riskCount: 0 };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`矩阵组「${input.name}」已存在`);
      }
      throw error;
    }
  }

  async update(workspaceId: string, groupId: string, input: z.infer<typeof updateMatrixGroupSchema>) {
    const existing = await this.prisma.matrixGroup.findFirst({ where: { id: groupId, workspaceId } });
    if (!existing) throw new NotFoundException('矩阵组不存在');
    try {
      return await this.prisma.matrixGroup.update({
        where: { id: groupId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.color !== undefined && { color: input.color }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`矩阵组「${input.name}」已存在`);
      }
      throw error;
    }
  }

  async remove(workspaceId: string, groupId: string) {
    return this.prisma.$transaction(async (tx) => {
      const [group] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "MatrixGroup" WHERE id = ${groupId} AND "workspaceId" = ${workspaceId} FOR UPDATE
      `;
      if (!group) throw new NotFoundException('矩阵组不存在');
      const cleared = await tx.channelAccount.updateMany({
        where: { workspaceId, groupId },
        data: { groupId: null },
      });
      await tx.matrixGroup.delete({ where: { id: groupId } });
      return { ok: true, clearedAccounts: cleared.count };
    });
  }

  async assertWorkspaceGroup(tx: Prisma.TransactionClient, workspaceId: string, groupId: string | null | undefined) {
    if (!groupId) return null;
    const found = await tx.matrixGroup.findFirst({
      where: { id: groupId, workspaceId },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('指定的矩阵组不存在或不属于当前工作室');
    return found.id;
  }

  async batchUpdate(workspaceId: string, input: z.infer<typeof batchAccountsSchema>) {
    const ids = [...new Set(input.accountIds)];
    return this.prisma.$transaction(async (tx) => {
      const accounts = await tx.channelAccount.findMany({
        where: { workspaceId, id: { in: ids } },
        select: { id: true, tags: true },
      });
      if (accounts.length !== ids.length) throw new NotFoundException('部分勾选账号不存在或不属于当前工作室');

      if (input.action === 'set_group') {
        const groupId = await this.assertWorkspaceGroup(tx, workspaceId, input.groupId);
        // Single-group invariant: setting groupId replaces any previous group membership.
        await tx.channelAccount.updateMany({
          where: { workspaceId, id: { in: ids } },
          data: { groupId },
        });
        return { ok: true, updated: ids.length };
      }

      if (input.action === 'set_operator') {
        await tx.channelAccount.updateMany({
          where: { workspaceId, id: { in: ids } },
          data: { operator: input.operator?.trim() || null },
        });
        return { ok: true, updated: ids.length };
      }

      if (input.action === 'set_pinned') {
        await tx.channelAccount.updateMany({
          where: { workspaceId, id: { in: ids } },
          data: { pinned: Boolean(input.pinned) },
        });
        return { ok: true, updated: ids.length };
      }

      if (input.action === 'clear_tags') {
        await tx.channelAccount.updateMany({
          where: { workspaceId, id: { in: ids } },
          data: { tags: [] },
        });
        return { ok: true, updated: ids.length };
      }

      const incoming = cleanTags(input.tags ?? []);
      for (const account of accounts) {
        const merged = cleanTags([...account.tags, ...incoming]);
        await tx.channelAccount.update({
          where: { id: account.id },
          data: { tags: merged },
        });
      }
      return { ok: true, updated: ids.length };
    });
  }
}
