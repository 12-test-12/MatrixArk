import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type ChannelAccount, type PublishResult, type PublishTask, type TaskStatus } from '@prisma/client';
import { ManualHandoffAdapter } from '@matrixark/adapters';
import { assertTransition, COMMITTED_STATUSES, idempotencyKey, type recordResultSchema } from '@matrixark/shared';
import type { z } from 'zod';
import { inspectSnapshot, variantSnapshot } from '../content/content.service';
import { PrismaService } from '../prisma/prisma.service';

const lockTables = {
  manuscript: Prisma.sql`"Manuscript"`,
  variant: Prisma.sql`"Variant"`,
  account: Prisma.sql`"ChannelAccount"`,
  task: Prisma.sql`"PublishTask"`,
};

async function lockRow(tx: Prisma.TransactionClient, table: keyof typeof lockTables, workspaceId: string, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM ${lockTables[table]} WHERE "workspaceId" = ${workspaceId} AND id = ${id} FOR UPDATE
  `;
  return rows.length !== 0;
}

const taskRelations = {
  account: { select: { id: true, platform: true, displayName: true, operator: true } },
  variant: { select: { id: true, manuscriptId: true, platform: true, version: true, title: true } },
  result: true,
} as const satisfies Prisma.PublishTaskInclude;

const publishableVariant = {
  ...variantSnapshot,
  manuscript: { select: { archivedAt: true } },
} as const satisfies Prisma.VariantInclude;

function canUseAccount(account: ChannelAccount, now: Date) {
  return account.channelKind === 'manual'
    && !account.archivedAt && ['active', 'pending'].includes(account.authStatus)
    && (!account.rateLimitedUntil || account.rateLimitedUntil <= now);
}

function hasApproval(variant: Prisma.VariantGetPayload<{ include: typeof publishableVariant }>) {
  return !variant.manuscript.archivedAt && variant.status === 'approved'
    && variant.approval?.workspaceId === variant.workspaceId
    && variant.approval.snapshotHash === variant.contentHash
    && inspectSnapshot(variant).issues.length === 0;
}

function presentTask<T extends PublishTask & { result?: PublishResult | null }>(task: T) {
  const wasDispatched = task.claimedAt || task.handedOffAt || task.attempts > 0 || task.result
    || COMMITTED_STATUSES.includes(task.status);
  const executionChannelStatus = task.executionChannel ? 'known'
    : wasDispatched ? 'historical_unknown' : 'not_dispatched';
  return { ...task, executionChannelStatus, isSandbox: task.executionChannel ? task.executionChannel === 'sandbox' : null };
}

function assetUrl(workspaceId: string, assetId: string) {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}`;
}

async function databaseTime(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return row!.now;
}

type TaskFilters = {
  status?: TaskStatus;
  accountId?: string;
  manuscriptId?: string;
  cursor?: string;
  limit: number;
};

@Injectable()
export class TasksService {
  private readonly manual = new ManualHandoffAdapter();

  constructor(private readonly prisma: PrismaService) {}

  async schedule(workspaceId: string, userId: string, variantId: string, accountId: string, scheduledAt: Date) {
    return this.prisma.$transaction(async (tx) => {
      const source = await tx.variant.findFirst({ where: { id: variantId, workspaceId }, select: { manuscriptId: true } });
      if (!source || !(await lockRow(tx, 'manuscript', workspaceId, source.manuscriptId))
        || !(await lockRow(tx, 'variant', workspaceId, variantId))) throw new NotFoundException('版本不存在');
      if (!(await lockRow(tx, 'account', workspaceId, accountId))) throw new NotFoundException('账号不存在');
      const variant = await tx.variant.findUniqueOrThrow({ where: { id: variantId }, include: publishableVariant });
      const account = await tx.channelAccount.findUniqueOrThrow({ where: { id: accountId } });
      if (account.platform !== variant.platform) {
        throw new BadRequestException('平台版本与发布账号必须属于同一平台');
      }
      const existing = await tx.publishTask.findUnique({ where: { accountId_variantId: { accountId, variantId } } });
      if (existing) return { task: existing, disposition: 'existing' as const };
      if (!hasApproval(variant)) throw new ConflictException('版本需要有效审核');
      if (!account.externalId || !account.authCheckedAt) throw new ConflictException('账号尚未通过平台身份核验。');
      if (!canUseAccount(account, await databaseTime(tx))) throw new ConflictException('该账号当前无法用于人工交接');

      const task = await tx.publishTask.create({
        data: {
          workspaceId, accountId, variantId, scheduledAt, createdById: userId,
          variantContentHash: variant.contentHash,
          idempotencyKey: idempotencyKey({ accountId, variantId, hash: variant.contentHash }),
        },
      });
      await tx.taskEvent.create({
        data: { workspaceId, taskId: task.id, kind: 'created', actorId: userId, toStatus: 'scheduled' },
      });
      return { task, disposition: 'created' as const };
    }, { isolationLevel: 'ReadCommitted' });
  }

  async list(workspaceId: string, { status, accountId, manuscriptId, cursor, limit }: TaskFilters) {
    const scope = JSON.stringify([workspaceId, status, accountId, manuscriptId]);
    let after: Prisma.PublishTaskWhereInput = {};
    if (cursor) {
      try {
        const [cursorScope, timestamp, id]: unknown[] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (cursorScope !== scope || typeof timestamp !== 'string' || typeof id !== 'string' || !id) throw new Error();
        const createdAt = new Date(timestamp);
        if (createdAt.toISOString() !== timestamp) throw new Error();
        after = { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }] };
      } catch {
        throw new BadRequestException('任务分页游标无效');
      }
    }
    const rows = await this.prisma.publishTask.findMany({
      where: { workspaceId, status, accountId, variant: manuscriptId ? { manuscriptId } : undefined, ...after },
      include: taskRelations,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const items = rows.slice(0, limit).map(presentTask);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last
        ? Buffer.from(JSON.stringify([scope, last.createdAt.toISOString(), last.id])).toString('base64url')
        : null,
    };
  }

  async detail(workspaceId: string, id: string) {
    const task = await this.prisma.publishTask.findFirst({
      where: { id, workspaceId },
      include: { ...taskRelations, events: { orderBy: { id: 'asc' } } },
    });
    if (!task) throw new NotFoundException('任务不存在');
    const { events, ...view } = task;
    return {
      ...presentTask(view),
      events: events.map((event) => ({ ...event, id: event.id.toString() })),
    };
  }

  async handoff(workspaceId: string, id: string) {
    const task = await this.prisma.publishTask.findFirst({
      where: { id, workspaceId },
      include: { account: taskRelations.account, variant: { include: variantSnapshot } },
    });
    if (!task) throw new NotFoundException('任务不存在');
    const { variant } = task;
    if (!task.handedOffAt || task.executionChannel !== 'manual' || variant.contentHash !== task.variantContentHash
      || variant.approval?.workspaceId !== workspaceId || variant.approval.snapshotHash !== task.variantContentHash
      || inspectSnapshot(variant).issues.length) throw new ConflictException('任务尚无有效的人工交接包');
    return {
      taskId: id, account: task.account, variantId: variant.id, version: variant.version,
      title: variant.title, body: variant.body, tags: variant.tags,
      assets: variant.assets.map((asset) => ({ ...asset, url: assetUrl(workspaceId, asset.assetId) })),
    };
  }

  async evidenceTarget(workspaceId: string, id: string) {
    const task = await this.prisma.publishTask.findFirst({
      where: { id, workspaceId },
      include: { result: { include: { evidenceAsset: true } } },
    });
    if (!task) throw new NotFoundException('任务不存在');
    return task;
  }

  async attachEvidence(workspaceId: string, id: string, userId: string, metadata: {
    storageKey: string;
    filename: string;
    mimeType: string;
    size: number;
  }) {
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockRow(tx, 'task', workspaceId, id))) throw new NotFoundException('任务不存在');
      const task = await tx.publishTask.findUniqueOrThrow({ where: { id } });
      this.requireHandoff(task);
      const asset = await tx.asset.create({
        data: { ...metadata, workspaceId, taskId: id, kind: 'task_evidence', uploadedById: userId },
      });
      return { assetId: asset.id };
    }, { isolationLevel: 'ReadCommitted' });
  }

  async recordResult(workspaceId: string, id: string, userId: string, input: z.infer<typeof recordResultSchema>) {
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockRow(tx, 'task', workspaceId, id))) throw new NotFoundException('任务不存在');
      const task = await tx.publishTask.findUniqueOrThrow({ where: { id } });
      this.requireHandoff(task);
      const evidenceAssetId = input.evidenceAssetId ?? null;
      if (evidenceAssetId && !(await tx.asset.findFirst({
        where: { id: evidenceAssetId, workspaceId, taskId: id, kind: 'task_evidence' },
        select: { id: true },
      }))) throw new NotFoundException('本任务截图不存在');
      assertTransition(task.status, input.state);

      const result = await tx.publishResult.create({
        data: {
          workspaceId, taskId: id, state: input.state, evidenceAssetId, recordedById: userId,
          remoteId: input.remoteId || null, remoteUrl: input.remoteUrl || null, note: input.note,
        },
      });
      await tx.publishTask.update({ where: { id }, data: { status: input.state } });
      await tx.taskEvent.create({
        data: {
          workspaceId, taskId: id, kind: 'result', fromStatus: task.status, toStatus: input.state,
          actorId: userId, reason: input.note, details: { evidenceAssetId, remoteUrl: result.remoteUrl },
        },
      });
      return result;
    }, { isolationLevel: 'ReadCommitted' });
  }

  requireHandoff(task: PublishTask) {
    if (task.status !== 'handed_off' || task.executionChannel !== 'manual' || !task.handedOffAt) {
      throw new ConflictException('仅已交接且未回填的人工任务可以录入结果');
    }
  }

  async dispatchDue() {
    const candidates = await this.prisma.publishTask.findMany({
      where: {
        status: 'scheduled', scheduledAt: { lte: await databaseTime(this.prisma) },
        OR: [{ executionChannel: 'manual' }, { executionChannel: null, account: { channelKind: 'manual' } }],
      },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      take: 50,
      select: { id: true, workspaceId: true, accountId: true, variantId: true, variant: { select: { manuscriptId: true } } },
    });
    let handedOff = 0;
    for (const candidate of candidates) {
      if (await this.dispatch(candidate)) handedOff++;
    }
    return handedOff;
  }

  private async dispatch(candidate: Pick<PublishTask, 'id' | 'workspaceId' | 'accountId' | 'variantId'>
    & { variant: { manuscriptId: string } }) {
    const { id, workspaceId, accountId, variantId, variant: { manuscriptId } } = candidate;
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockRow(tx, 'manuscript', workspaceId, manuscriptId))
        || !(await lockRow(tx, 'variant', workspaceId, variantId))
        || !(await lockRow(tx, 'account', workspaceId, accountId))
        || !(await lockRow(tx, 'task', workspaceId, id))) return false;
      const task = await tx.publishTask.findUniqueOrThrow({ where: { id } });
      const now = await databaseTime(tx);
      if (task.status !== 'scheduled' || task.scheduledAt > now || task.accountId !== accountId
        || task.variantId !== variantId || (task.executionChannel && task.executionChannel !== 'manual')) return false;

      const variant = await tx.variant.findUniqueOrThrow({ where: { id: variantId }, include: publishableVariant });
      const account = await tx.channelAccount.findUniqueOrThrow({ where: { id: accountId } });
      if (!hasApproval(variant) || variant.contentHash !== task.variantContentHash
        || account.platform !== variant.platform || !canUseAccount(account, now)) {
        const reason = '审核快照失效或人工账号不可用';
        assertTransition(task.status, 'paused');
        await tx.publishTask.update({ where: { id }, data: { status: 'paused', lastError: reason } });
        await tx.taskEvent.create({
          data: { workspaceId, taskId: id, kind: 'paused', fromStatus: task.status, toStatus: 'paused', reason },
        });
        return false;
      }
      if (await tx.publishTask.findFirst({
        where: { accountId, status: 'dispatching', leaseExpiresAt: { gt: now } },
        select: { id: true },
      })) return false;

      // 人工适配器只生成本地回执，领取与交接在一个事务提交。
      const leaseId = randomUUID();
      assertTransition(task.status, 'dispatching');
      await tx.publishTask.update({
        where: { id },
        data: {
          status: 'dispatching', executionChannel: 'manual', claimedAt: now,
          attempts: { increment: 1 }, leaseId, leaseExpiresAt: new Date(now.getTime() + 45_000),
        },
      });
      const receipt = await this.manual.publish({
        variant: { ...variant, imageUrls: variant.assets.map(({ assetId }) => assetUrl(workspaceId, assetId)) },
        account: { id: accountId, displayName: account.displayName, platform: account.platform, channelKind: 'manual' },
        slot: { scheduledAt: task.scheduledAt.toISOString(), idempotencyKey: task.idempotencyKey },
      });
      if (receipt.status !== 'handed_off') throw new Error('人工通道返回了无效交接状态');
      assertTransition('dispatching', receipt.status);
      await tx.publishTask.update({
        where: { id },
        data: { status: receipt.status, handedOffAt: now, leaseId: null, leaseExpiresAt: null, lastError: null },
      });
      await tx.taskEvent.createMany({
        data: [
          { workspaceId, taskId: id, kind: 'claimed', fromStatus: 'scheduled', toStatus: 'dispatching',
            leaseId, details: { executionChannel: 'manual' } },
          { workspaceId, taskId: id, kind: 'handed_off', fromStatus: 'dispatching', toStatus: 'handed_off',
            leaseId, reason: receipt.message },
        ],
      });
      return true;
    }, { isolationLevel: 'ReadCommitted' });
  }
}
