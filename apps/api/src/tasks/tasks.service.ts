import { randomUUID } from 'node:crypto';
import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type ChannelAccount, type MetricsSource, type Platform, type PublicationMetrics, type PublishResult, type PublishTask, type Role, type TaskStatus } from '@prisma/client';
import { BilibiliAdapter, ManualHandoffAdapter, SandboxAdapter, resolveAdapter, validateBilibiliArticle, type PublishInput, type PublishReceipt } from '@matrixark/adapters';
import { assertTransition, COMMITTED_STATUSES, idempotencyKey, type cancelTaskSchema, type recordResultSchema, type scheduleTasksSchema, type verifyTaskSchema } from '@matrixark/shared';
import type { z } from 'zod';
import { AccountRiskService } from '../accounts/account-risk.service';
import { platformKeyId } from '../accounts/platform-app';
import { bilibiliAppOptions, bilibiliCredentials, bilibiliManualProfile, isUnverifiedBilibiliAccount, publishChannel } from '../accounts/publish-account';
import { config } from '../config';
import { inspectSnapshot, variantSnapshot } from '../content/content.service';
import { StorageService } from '../content/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

const lockTables = {
  manuscript: Prisma.sql`"Manuscript"`,
  variant: Prisma.sql`"Variant"`,
  account: Prisma.sql`"ChannelAccount"`,
  task: Prisma.sql`"PublishTask"`,
};
const bilibiliAuthorizationRequired = 'B 站账号尚未通过官方授权，请连接已授权账号后重新安排发布';

async function lockRows(tx: Prisma.TransactionClient, table: keyof typeof lockTables, workspaceId: string, ids: string[]) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM ${lockTables[table]}
    WHERE "workspaceId" = ${workspaceId} AND id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE
  `;
  return rows.length === ids.length;
}

function lockRow(tx: Prisma.TransactionClient, table: keyof typeof lockTables, workspaceId: string, id: string) {
  return lockRows(tx, table, workspaceId, [id]);
}

const taskRelations = {
  account: { select: { id: true, platform: true, displayName: true, operator: true, channelKind: true, accessMethod: true } },
  variant: { select: { id: true, manuscriptId: true, platform: true, version: true, title: true, videoAssetId: true } },
  result: true,
} as const satisfies Prisma.PublishTaskInclude;

const publishableVariant = {
  ...variantSnapshot,
  manuscript: { select: { archivedAt: true } },
} as const satisfies Prisma.VariantInclude;

type PublishableVariant = Prisma.VariantGetPayload<{ include: typeof publishableVariant }>;

type AutomaticClaim = {
  task: PublishTask;
  variant: PublishableVariant;
  account: ChannelAccount;
  channel: 'official' | 'sandbox';
  leaseId: string;
  trial: boolean;
};

function hasApproval(variant: PublishableVariant) {
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

function publishVariant(variant: PublishableVariant): PublishInput['variant'] {
  return { ...variant, imageCount: variant.assets.length,
    imageUrls: variant.assets.map(({ assetId }) => assetUrl(variant.workspaceId, assetId)) };
}

async function databaseTime(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return row!.now;
}

type TaskFilters = {
  status?: TaskStatus;
  accountId?: string;
  groupId?: string;
  manuscriptId?: string;
  cursor?: string;
  limit: number;
  performance?: true;
  platform?: Platform;
  content?: 'article' | 'video';
  days?: number;
};

export type WorkMetrics = Pick<PublicationMetrics, 'views' | 'likes' | 'comments' | 'favorites' | 'shares'>;
export type WorkMetricsInput = WorkMetrics & { recordedAt?: Date };

function requirePublishedWork(task: Pick<PublishTask, 'status' | 'executionChannel'>, result: PublishResult | null) {
  if (!result || result.state !== 'published' || task.status !== 'published'
    || (task.executionChannel !== 'official' && task.executionChannel !== 'manual')) {
    throw new ConflictException('只有已确认发布的真实作品可以记录成效');
  }
  return result;
}

function receiptSnapshot(result: PublishResult | null) {
  return {
    state: result?.state ?? null,
    remoteId: result?.remoteId ?? null,
    remoteUrl: result?.remoteUrl ?? null,
    evidenceAssetId: result?.evidenceAssetId ?? null,
    note: result?.note ?? null,
    recordedById: result?.recordedById ?? null,
    recordedAt: result?.recordedAt.toISOString() ?? null,
    platformPublishedAt: result?.platformPublishedAt?.toISOString() ?? null,
  };
}

@Injectable()
export class TasksService {
  private readonly manual = new ManualHandoffAdapter();
  private readonly logger = new Logger(TasksService.name);

  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService,
    private readonly notifications: NotificationsService, private readonly risks: AccountRiskService) {}

  async schedule(workspaceId: string, userId: string, input: z.infer<typeof scheduleTasksSchema>, transaction?: Prisma.TransactionClient) {
    const variantIds = [...new Set(input.variantIds)];
    const accountIds = [...new Set(input.accountIds)];
    const scheduleIn = async (tx: Prisma.TransactionClient) => {
      const variantScope = { workspaceId, id: { in: variantIds } };
      const accountScope = { workspaceId, id: { in: accountIds } };
      const sources = await tx.variant.findMany({ where: variantScope, select: { manuscriptId: true } });
      const manuscriptIds = [...new Set(sources.map(({ manuscriptId }) => manuscriptId))];
      if (sources.length !== variantIds.length || !(await lockRows(tx, 'manuscript', workspaceId, manuscriptIds))
        || !(await lockRows(tx, 'variant', workspaceId, variantIds))) throw new NotFoundException('版本不存在');
      if (!(await lockRows(tx, 'account', workspaceId, accountIds))) throw new NotFoundException('账号不存在');
      const variants = await tx.variant.findMany({ where: variantScope, include: publishableVariant });
      const accounts = await tx.channelAccount.findMany({ where: accountScope });
      const platforms = new Set(variants.map(({ platform }) => platform));
      const accountPlatforms = new Set(accounts.map(({ platform }) => platform));
      if (platforms.size !== accountPlatforms.size || [...platforms].some((platform) => !accountPlatforms.has(platform))) {
        throw new BadRequestException('每个平台版本都需要同平台账号，每个账号也需要同平台版本');
      }

      const previous = await tx.publishTask.findMany({
        where: { workspaceId, variantId: { in: variantIds }, accountId: { in: accountIds } },
      });
      const existingPairs = new Set(previous.map(({ accountId, variantId }) => `${accountId}:${variantId}`));
      const now = await databaseTime(tx);
      const { trialOwnerId } = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { trialOwnerId: true } });
      const pending: Prisma.PublishTaskCreateManyInput[] = [];
      for (const variant of variants) {
        const targets = accounts.filter(({ id, platform }) =>
          platform === variant.platform && !existingPairs.has(`${id}:${variant.id}`));
        if (targets.length === 0) continue;
        if (!hasApproval(variant)) throw new ConflictException('版本需要有效审核');
        for (const account of targets) {
          this.requireAvailableAccount(account, variant, now, Boolean(trialOwnerId));
          pending.push({
            workspaceId, accountId: account.id, variantId: variant.id, scheduledAt: input.scheduledAt, createdById: userId,
            variantContentHash: variant.contentHash,
            idempotencyKey: idempotencyKey({ accountId: account.id, variantId: variant.id, hash: variant.contentHash }),
          });
        }
      }

      const created = pending.length ? await tx.publishTask.createManyAndReturn({ data: pending }) : [];
      if (created.length) await tx.taskEvent.createMany({
        data: created.map(({ id }) => ({ workspaceId, taskId: id, kind: 'created', actorId: userId, toStatus: 'scheduled' })),
      });
      const items = [
        ...created.map((task) => ({ task, disposition: 'created' as const })),
        ...previous.map((task) => ({ task, disposition: 'existing' as const })),
      ];
      return items.map(({ task: { id, accountId, variantId, status, scheduledAt }, disposition }) =>
        ({ id, accountId, variantId, status, scheduledAt, disposition }));
    };
    return transaction ? scheduleIn(transaction) : this.prisma.$transaction(scheduleIn, { isolationLevel: 'ReadCommitted' });
  }

  private requireAvailableAccount(account: ChannelAccount, variant: PublishableVariant, now: Date, trial: boolean) {
    if (isUnverifiedBilibiliAccount(account)) throw new ConflictException(bilibiliAuthorizationRequired);
    if (!account.externalId || !account.authCheckedAt) throw new ConflictException(`账号「${account.displayName}」尚未通过平台身份核验`);
    const channel = publishChannel(account, now, trial);
    if (!channel) throw new ConflictException(`账号「${account.displayName}」当前不可排期，请检查授权和通道配置`);
    if (channel === 'official') {
      if (variant.videoAssetId) throw new ConflictException('视频官方投稿未开通，请选择人工交接或沙箱账号');
      if (!bilibiliCredentials(account)) throw new ConflictException('无法读取该账号的 B 站授权');
      try {
        validateBilibiliArticle(publishVariant(variant));
      } catch (error) {
        throw new BadRequestException((error as Error).message);
      }
    }
    return channel;
  }

  async changeSchedule(workspaceId: string, id: string, userId: string, scheduledAt: Date,
    operation: 'reschedule' | 'resume' | 'retry') {
    const expected = { reschedule: 'scheduled', resume: 'paused', retry: 'verified' } as const;
    return this.prisma.$transaction(async (tx) => {
      const source = await tx.publishTask.findFirst({
        where: { id, workspaceId },
        select: { variantId: true, accountId: true, variant: { select: { manuscriptId: true } } },
      });
      if (!source || !(await lockRow(tx, 'manuscript', workspaceId, source.variant.manuscriptId))
        || !(await lockRow(tx, 'variant', workspaceId, source.variantId))
        || !(await lockRow(tx, 'account', workspaceId, source.accountId))
        || !(await lockRow(tx, 'task', workspaceId, id))) throw new NotFoundException('任务不存在');
      const task = await tx.publishTask.findUniqueOrThrow({ where: { id },
        include: { variant: { include: publishableVariant }, account: true, result: true,
          workspace: { select: { trialOwnerId: true } } } });
      if (task.status !== expected[operation]) throw new ConflictException('任务状态已变化，或尚未确认平台未受理');
      const now = await databaseTime(tx);
      if (scheduledAt <= now) throw new BadRequestException('请选择未来的计划时间');
      if (!hasApproval(task.variant) || task.variant.contentHash !== task.variantContentHash) {
        throw new ConflictException('原审核快照已失效，请审核当前版本后重新排期');
      }
      const channel = this.requireAvailableAccount(task.account, task.variant, now, Boolean(task.workspace.trialOwnerId));
      if (task.executionChannel && task.executionChannel !== channel) throw new ConflictException('发布通道已变化，无法重新安排原任务');
      if (channel === 'official' && !await bilibiliAppOptions(tx, task.account).catch(() => undefined)) {
        throw new ConflictException('B 站开放平台应用凭据不可用，请负责人重新保存');
      }
      if (operation === 'retry' || (operation === 'resume' && (task.attempts || task.claimedAt || task.handedOffAt || task.result || task.executionChannel))) {
        const verification = await tx.taskEvent.findFirst({
          where: { taskId: id, kind: 'verified', toStatus: 'verified' }, orderBy: { id: 'desc' },
        });
        const details = verification?.details as { outcome?: string; attempt?: number } | undefined;
        if (details?.outcome !== 'not_received' || details.attempt !== task.attempts) {
          throw new ConflictException('请先核对本次发布并确认平台未受理');
        }
        await this.requireNoAcceptance(tx, task);
      }
      if (operation === 'reschedule' && scheduledAt.getTime() === task.scheduledAt.getTime()) return presentTask(task);
      if (task.status !== 'scheduled') assertTransition(task.status, 'scheduled');
      const updated = await tx.publishTask.update({
        where: { id }, data: { status: 'scheduled', scheduledAt, lastError: null,
          ...(operation === 'reschedule' ? {} : { claimedAt: null, handedOffAt: null }) },
      });
      await tx.taskEvent.create({
        data: { workspaceId, taskId: id, actorId: userId, kind: operation === 'retry' ? 'retried' : 'rescheduled',
          fromStatus: task.status, toStatus: 'scheduled', reason: operation === 'resume' ? '恢复暂停任务' : undefined,
          details: { previousScheduledAt: task.scheduledAt.toISOString(), scheduledAt: scheduledAt.toISOString() } },
      });
      return presentTask(updated);
    }, { isolationLevel: 'ReadCommitted' });
  }

  async cancel(workspaceId: string, id: string, userId: string, role: Role, input: z.infer<typeof cancelTaskSchema>) {
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockRow(tx, 'task', workspaceId, id))) throw new NotFoundException('任务不存在');
      const task = await tx.publishTask.findUniqueOrThrow({ where: { id } });
      if (task.status === 'handed_off') {
        if (role !== 'owner') throw new ForbiddenException('仅负责人可以取消已经交接的任务');
        if (!input.verification) throw new BadRequestException('请填写确认尚未发布的核对依据');
      } else if (task.status !== 'scheduled' && task.status !== 'paused') {
        throw new ConflictException('当前状态不能取消，请先核对发布结果');
      }
      assertTransition(task.status, 'canceled');
      const canceledAt = await databaseTime(tx);
      const updated = await tx.publishTask.update({ where: { id }, data: {
        status: 'canceled', canceledAt, canceledById: userId, cancelReason: input.reason, lastError: null,
      } });
      await this.skipPendingReminders(tx, id, '任务已取消');
      await tx.taskEvent.create({
        data: { workspaceId, taskId: id, actorId: userId, kind: 'canceled', fromStatus: task.status, toStatus: 'canceled',
          reason: input.reason, details: { verification: input.verification ?? null } },
      });
      return presentTask(updated);
    }, { isolationLevel: 'ReadCommitted' });
  }

  private hasLateAcceptance(db: Prisma.TransactionClient, id: string) {
    return db.taskEvent.findFirst({
      where: { taskId: id, kind: 'late_receipt', OR: [
        ...['submitted', 'under_review', 'published'].map((state) => ({ details: { path: ['state'], equals: state } })),
        { details: { path: ['remoteId'], not: Prisma.AnyNull } },
      ] },
      select: { id: true },
    });
  }

  private async requireNoAcceptance(tx: Prisma.TransactionClient, task: PublishTask & { result: PublishResult | null }) {
    if (task.result?.remoteId || task.result?.remoteUrl || await this.hasLateAcceptance(tx, task.id)) {
      throw new ConflictException('已有平台受理或作品证据，请核对原作品，避免重复发布');
    }
  }

  async verify(workspaceId: string, id: string, userId: string, input: z.infer<typeof verifyTaskSchema>) {
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockRow(tx, 'task', workspaceId, id))) throw new NotFoundException('任务不存在');
      const task = await tx.publishTask.findUniqueOrThrow({
        where: { id },
        include: { result: true, account: { select: { ...taskRelations.account.select, externalId: true, accessMethod: true } } },
      });
      if (task.status !== 'unknown' && !(task.status === 'failed' && input.outcome === 'not_received')) {
        throw new ConflictException('任务当前状态不能提交此项核对');
      }
      if (input.outcome === 'published' && isUnverifiedBilibiliAccount(task.account)) {
        throw new ConflictException(bilibiliAuthorizationRequired);
      }
      if (input.outcome === 'unresolved') {
        await tx.taskEvent.create({ data: { workspaceId, taskId: id, actorId: userId, kind: 'verified',
          fromStatus: 'unknown', toStatus: 'unknown', reason: input.reason, details: { outcome: input.outcome } } });
        const { account: { externalId: _ext, accessMethod: _acc, ...account }, ...rest } = task;
        return presentTask({ ...rest, account });
      }
      if (input.outcome === 'not_received') await this.requireNoAcceptance(tx, task);
      if (input.outcome === 'accepted') {
        if (task.executionChannel !== 'official') throw new ConflictException('仅官方通道支持按文章 ID 继续回读');
        if (!/^[1-9]\d{0,19}$/u.test(input.remoteId)) throw new BadRequestException('请填写有效的 B 站文章 ID');
        if (task.result?.remoteId && task.result.remoteId !== input.remoteId) throw new ConflictException('文章 ID 与现有回执不一致');
      }
      assertTransition(task.status, 'verified');
      await tx.taskEvent.create({
        data: { workspaceId, taskId: id, actorId: userId, kind: 'verified', fromStatus: task.status, toStatus: 'verified',
          reason: input.reason, details: { outcome: input.outcome, attempt: task.attempts, previous: receiptSnapshot(task.result),
            ...('remoteId' in input && input.remoteId ? { remoteId: input.remoteId } : {}) } },
      });
      if (input.outcome === 'not_received') {
        const updated = await tx.publishTask.update({ where: { id }, data: { status: 'verified', lastError: null } });
        return presentTask(updated);
      }
      const state = input.outcome === 'accepted' ? 'submitted' : 'published';
      assertTransition('verified', state);
      const evidenceAssetId = await this.validateEvidence(tx, workspaceId, id, 'evidenceAssetId' in input ? input.evidenceAssetId : undefined);
      const receipt = {
        workspaceId, taskId: id, state, recordedById: userId, recordedAt: await databaseTime(tx), note: input.reason,
        remoteId: input.remoteId || task.result?.remoteId || null,
        remoteUrl: ('remoteUrl' in input ? input.remoteUrl : task.result?.remoteUrl) || null,
        evidenceAssetId: input.outcome === 'accepted' ? task.result?.evidenceAssetId ?? null : evidenceAssetId,
      } as const;
      const saved = await tx.publishResult.upsert({ where: { taskId: id }, create: receipt, update: receipt });
      const updated = await tx.publishTask.update({ where: { id }, data: { status: state, lastError: null } });
      await tx.taskEvent.create({ data: { workspaceId, taskId: id, actorId: userId, kind: 'result',
        fromStatus: 'verified', toStatus: state, reason: input.reason, details: receiptSnapshot(saved) } });
      return presentTask(updated);
    }, { isolationLevel: 'ReadCommitted' });
  }

  async list(workspaceId: string, { status, accountId, groupId, manuscriptId, cursor, limit, performance, platform, content, days }: TaskFilters) {
    const scope = JSON.stringify(performance
      ? [workspaceId, 'performance', accountId, groupId, platform, content, days]
      : [workspaceId, status, accountId, manuscriptId]);
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
    const since = performance && days ? new Date(Date.now() - days * 86_400_000) : undefined;
    const where: Prisma.PublishTaskWhereInput = performance ? {
      workspaceId, accountId, status: 'published', executionChannel: { in: ['manual', 'official'] },
      ...(groupId ? { account: { groupId } } : {}),
      result: {
        is: since ? {
          state: 'published',
          OR: [
            { platformPublishedAt: { gte: since } },
            { platformPublishedAt: null, recordedAt: { gte: since } },
          ],
        } : { state: 'published' },
      },
      variant: { platform, videoAssetId: content === 'video' ? { not: null } : content === 'article' ? null : undefined },
    } : { workspaceId, status, accountId, variant: manuscriptId ? { manuscriptId } : undefined };
    const [rows, summary, accountSummary] = await Promise.all([this.prisma.publishTask.findMany({
      where: { ...where, ...after },
      include: {
        ...taskRelations,
        result: performance ? {
          include: { metrics: { include: { recordedBy: { select: { id: true, name: true, email: true } } } } },
        } : true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    }), performance ? this.performanceSummary(where, content) : undefined,
    performance ? this.accountPerformanceSummary(where) : undefined]);
    const items = rows.slice(0, limit).map(presentTask);
    const last = items.at(-1);
    return {
      items,
      ...(summary && { summary }),
      ...(accountSummary && { accountSummary }),
      nextCursor: rows.length > limit && last
        ? Buffer.from(JSON.stringify([scope, last.createdAt.toISOString(), last.id])).toString('base64url')
        : null,
    };
  }

  private async accountPerformanceSummary(where: Prisma.PublishTaskWhereInput) {
    const rows = await this.prisma.publishTask.findMany({
      where,
      select: {
        accountId: true,
        account: {
          select: {
            id: true, displayName: true, alias: true, platform: true, operator: true,
            group: { select: { id: true, name: true, color: true } },
          },
        },
        result: {
          select: {
            metrics: {
              select: {
                views: true, likes: true, comments: true, favorites: true, shares: true,
                source: true, recordedAt: true,
                recordedBy: { select: { id: true, name: true, email: true } },
              },
            },
          },
        },
      },
    });
    const map = new Map<string, {
      accountId: string; displayName: string; alias: string | null; platform: Platform; operator: string | null;
      group: { id: string; name: string; color: string } | null;
      published: number; tracked: number;
      views: number | null; likes: number | null; comments: number | null; favorites: number | null; shares: number | null;
      lastRecordedAt: Date | null; lastSource: MetricsSource | null;
      lastRecordedBy: { id: string; name: string; email: string } | null;
    }>();
    const sumOpt = (a: number | null, b: number | null) => b === null ? a : (a ?? 0) + b;
    for (const row of rows) {
      let entry = map.get(row.accountId);
      if (!entry) {
        entry = {
          accountId: row.account.id,
          displayName: row.account.displayName,
          alias: row.account.alias,
          platform: row.account.platform,
          operator: row.account.operator,
          group: row.account.group,
          published: 0,
          tracked: 0,
          views: null,
          likes: null,
          comments: null,
          favorites: null,
          shares: null,
          lastRecordedAt: null,
          lastSource: null,
          lastRecordedBy: null,
        };
        map.set(row.accountId, entry);
      }
      entry.published += 1;
      const m = row.result?.metrics;
      if (m) {
        entry.tracked += 1;
        entry.views = sumOpt(entry.views, m.views);
        entry.likes = sumOpt(entry.likes, m.likes);
        entry.comments = sumOpt(entry.comments, m.comments);
        entry.favorites = sumOpt(entry.favorites, m.favorites);
        entry.shares = sumOpt(entry.shares, m.shares);
        if (!entry.lastRecordedAt || m.recordedAt > entry.lastRecordedAt) {
          entry.lastRecordedAt = m.recordedAt;
          entry.lastSource = m.source;
          entry.lastRecordedBy = m.recordedBy;
        }
      }
    }
    return [...map.values()].sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || b.published - a.published);
  }

  private performanceSummary(where: Prisma.PublishTaskWhereInput, content: TaskFilters['content']) {
    const kinds = content ? [content] : ['article', 'video'] as const;
    return Promise.all(kinds.map(async (kind) => {
      const tasks = { AND: [where, { variant: { videoAssetId: kind === 'video' ? { not: null } : null } }] };
      const [published, metrics] = await Promise.all([
        this.prisma.publishTask.count({ where: tasks }),
        this.prisma.publicationMetrics.aggregate({
          where: { result: { task: tasks } }, _count: { _all: true },
          _sum: { views: true, likes: true, comments: true, favorites: true, shares: true },
        }),
      ]);
      return { content: kind, published, tracked: metrics._count._all, ...metrics._sum };
    }));
  }

  async saveMetrics(workspaceId: string, id: string, userId: string | null, input: WorkMetricsInput,
    source: MetricsSource = 'manual', remoteId?: string, automaticSince?: Date) {
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockRow(tx, 'task', workspaceId, id))) throw new NotFoundException('任务不存在');
      const task = await tx.publishTask.findUniqueOrThrow({ where: { id }, include: { result: true } });
      const result = requirePublishedWork(task, task.result);
      if (remoteId !== undefined && result.remoteId !== remoteId) throw new ConflictException('作品已变更，请重新同步');
      const now = await databaseTime(tx);
      const { recordedAt, ...metrics } = input;
      if (recordedAt) {
        if (recordedAt.getTime() > now.getTime() + 86_400_000) throw new BadRequestException('统计日期不能晚于今天');
        if (recordedAt.getTime() < now.getTime() - 366 * 86_400_000) throw new BadRequestException('统计日期仅支持最近一年内');
      }
      const effectiveAt = recordedAt ?? now;
      if (automaticSince) {
        const latest = await tx.publicationMetrics.findUnique({ where: { taskId: id } });
        if (latest && latest.recordedAt >= automaticSince) return latest;
      }
      const data = { ...metrics, source, recordedById: userId, recordedAt: effectiveAt };
      await tx.publicationMetricSnapshot.create({ data: { taskId: id, ...data }, select: { id: true } });
      const currentLatest = await tx.publicationMetrics.findUnique({ where: { taskId: id } });
      if (!currentLatest || effectiveAt >= currentLatest.recordedAt) {
        return tx.publicationMetrics.upsert({ where: { taskId: id }, create: { taskId: id, ...data }, update: data });
      }
      return currentLatest;
    }, { isolationLevel: 'ReadCommitted' });
  }

  async metricHistory(workspaceId: string, id: string, days?: number) {
    const task = await this.prisma.publishTask.findFirst({ where: { id, workspaceId }, include: { result: true } });
    if (!task) throw new NotFoundException('任务不存在');
    requirePublishedWork(task, task.result);
    const since = days ? new Date(Date.now() - days * 86_400_000) : undefined;
    const snapshots = await this.prisma.publicationMetricSnapshot.findMany({
      where: { taskId: id, ...(since ? { recordedAt: { gte: since } } : {}) },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      take: 120,
      select: {
        id: true, views: true, likes: true, comments: true, favorites: true, shares: true,
        source: true, recordedAt: true, recordedById: true,
        recordedBy: { select: { id: true, name: true, email: true } },
      },
    });
    return snapshots.reverse();
  }

  async syncMetrics(workspaceId: string, id: string, userId: string | null, automaticSince?: Date) {
    const task = await this.prisma.publishTask.findFirst({
      where: { workspaceId, id },
      include: { ...taskRelations, account: true },
    });
    if (!task) throw new NotFoundException('任务不存在');
    const { remoteId } = requirePublishedWork(task, task.result);
    if (task.executionChannel !== 'official' || task.variant.platform !== 'bilibili' || task.variant.videoAssetId || !remoteId) {
      throw new ConflictException('此作品暂不支持同步平台数据，可以手动录入');
    }
    const credentials = bilibiliCredentials(task.account);
    if (!credentials || publishChannel(task.account, await databaseTime(this.prisma)) !== 'official') {
      throw new ConflictException('B 站账号授权当前不可用，请重新连接账号或手动录入');
    }
    const app = await bilibiliAppOptions(this.prisma, task.account);
    if (!app) throw new ConflictException('请先配置 B 站开放平台应用凭据');
    const metrics = await new BilibiliAdapter(app).fetchArticleMetrics(remoteId, { credentials });
    if (!metrics) throw new BadGatewayException('B 站未返回成效数据，请检查接口权限后重试');
    return this.saveMetrics(workspaceId, id, userId, metrics, 'platform', remoteId, automaticSince);
  }

  async syncDueArticleMetrics() {
    if (config.sandboxChannel) return;
    const now = await databaseTime(this.prisma);
    const hour = 3_600_000;
    const due: Prisma.PublishTaskWhereInput = {
      status: 'published', executionChannel: 'official', workspace: { trialOwnerId: null },
      variant: { platform: 'bilibili', videoAssetId: null },
      account: { authStatus: 'active', archivedAt: null, authExpiresAt: { gt: now },
        authScope: { hasEvery: ['ATC_BASE', 'ATC_DATA'] },
        OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lte: now } }] },
      result: { state: 'published', remoteId: { not: null }, recordedAt: { gte: new Date(now.getTime() - 30 * 24 * hour) },
        OR: [{ metrics: null }, { metrics: { recordedAt: { lte: new Date(now.getTime() - 6 * hour) } } }] },
      OR: [{ metricsSyncAttemptedAt: null }, { metricsSyncAttemptedAt: { lte: new Date(now.getTime() - hour / 2) } }],
    };
    const tasks = await this.prisma.publishTask.findMany({ where: due,
      orderBy: [{ metricsSyncAttemptedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      select: { id: true, workspaceId: true }, take: 4 });
    for (const { id, workspaceId } of tasks) {
      const { count } = await this.prisma.publishTask.updateMany({ where: { ...due, id }, data: { metricsSyncAttemptedAt: now } });
      if (!count) continue;
      try {
        await this.syncMetrics(workspaceId, id, null, now);
      } catch {
        this.logger.warn(`B 站专栏成效自动同步未完成 · ${id}`);
      }
    }
  }

  async detail(workspaceId: string, id: string) {
    const task = await this.prisma.publishTask.findFirst({
      where: { id, workspaceId },
      include: {
        ...taskRelations, events: { orderBy: { id: 'asc' } },
        notificationDeliveries: {
          orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
          select: { id: true, kind: true, status: true, attempts: true, scheduledAt: true, sentAt: true, lastError: true },
        },
      },
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
      include: {
        account: { select: { ...taskRelations.account.select, externalId: true, accessMethod: true } },
        variant: { include: variantSnapshot },
      },
    });
    if (!task) throw new NotFoundException('任务不存在');
    const { variant } = task;
    if (task.status === 'handed_off' && isUnverifiedBilibiliAccount(task.account)) {
      throw new ConflictException(bilibiliAuthorizationRequired);
    }
    if (!task.handedOffAt || task.executionChannel !== 'manual' || variant.contentHash !== task.variantContentHash
      || variant.approval?.workspaceId !== workspaceId || variant.approval.snapshotHash !== task.variantContentHash
      || inspectSnapshot(variant).issues.length) throw new ConflictException('任务尚无有效的人工交接包');
    const { externalId, accessMethod: _acc, ...account } = task.account;
    return {
      taskId: id, account, profileUrl: bilibiliManualProfile({ ...account, externalId }), variantId: variant.id, version: variant.version,
      title: variant.title, body: variant.body, tags: variant.tags,
      assets: variant.assets.map((asset) => ({ ...asset, url: assetUrl(workspaceId, asset.assetId) })),
      video: variant.videoAsset ? { ...variant.videoAsset, url: assetUrl(workspaceId, variant.videoAsset.id) + '/video' } : null,
    };
  }

  async readEvidence(workspaceId: string, id: string, assetId?: string) {
    const task = await this.prisma.publishTask.findFirst({ where: { id, workspaceId }, include: { result: true } });
    if (!task) throw new NotFoundException('任务不存在');
    const image = await this.prisma.asset.findFirst({
      where: { id: assetId ?? task.result?.evidenceAssetId ?? '', workspaceId, taskId: id, kind: 'task_evidence' },
    });
    if (!image) throw new NotFoundException('回执截图不存在');
    return this.storage.readImage(workspaceId, image.storageKey);
  }

  async attachEvidence(workspaceId: string, id: string, userId: string, role: Role,
    file: { filename: string; mimeType: string; buffer: Buffer; size: number }) {
    const existing = await this.prisma.publishTask.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('任务不存在');
    this.requireEvidenceWrite(existing, role);
    const { key } = await this.storage.save(workspaceId, file.filename, file.buffer);
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (!(await lockRow(tx, 'task', workspaceId, id))) throw new NotFoundException('任务不存在');
        const task = await tx.publishTask.findUniqueOrThrow({ where: { id } });
        this.requireEvidenceWrite(task, role);
        const asset = await tx.asset.create({
          data: { storageKey: key, filename: file.filename, mimeType: file.mimeType, size: file.size,
            workspaceId, taskId: id, kind: 'task_evidence', uploadedById: userId },
        });
        return { assetId: asset.id };
      }, { isolationLevel: 'ReadCommitted' });
    } catch (error) {
      const registered = await this.prisma.asset.findUnique({ where: { storageKey: key }, select: { id: true } }).catch(() => undefined);
      if (registered === null) await this.storage.remove(key).catch(() => undefined);
      throw error;
    }
  }

  private requireEvidenceWrite(task: PublishTask, role: Role) {
    if (task.status === 'canceled' && role !== 'owner') throw new ForbiddenException('仅负责人可以更正已取消的任务');
    if (task.status !== 'unknown' && task.status !== 'failed' && task.status !== 'canceled') this.requireHandoff(task);
  }

  private async validateEvidence(tx: Prisma.TransactionClient, workspaceId: string, taskId: string, evidenceAssetId?: string) {
    if (evidenceAssetId && !(await tx.asset.findFirst({
      where: { id: evidenceAssetId, workspaceId, taskId, kind: 'task_evidence' }, select: { id: true },
    }))) throw new NotFoundException('本任务截图不存在');
    return evidenceAssetId ?? null;
  }

  private skipPendingReminders(tx: Prisma.TransactionClient, taskId: string, reason: string) {
    return tx.notificationDelivery.updateMany({
      where: { taskId, status: 'pending' },
      data: { status: 'skipped', nextAttemptAt: null, lastError: reason },
    });
  }

  async recordResult(workspaceId: string, id: string, userId: string, role: Role, input: z.infer<typeof recordResultSchema>) {
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockRow(tx, 'task', workspaceId, id))) throw new NotFoundException('任务不存在');
      const task = await tx.publishTask.findUniqueOrThrow({
        where: { id },
        include: {
          result: true,
          account: { select: { ...taskRelations.account.select, externalId: true, accessMethod: true } },
        },
      });
      if (input.state === 'published' && isUnverifiedBilibiliAccount(task.account)) {
        throw new ConflictException(bilibiliAuthorizationRequired);
      }
      const corrected = task.status === 'failed' || task.status === 'canceled';
      if (corrected) {
        if (task.status === 'canceled' && role !== 'owner') throw new ForbiddenException('仅负责人可以更正已取消的任务');
        if (input.state !== 'published') throw new ConflictException('此处仅可凭作品证据更正为已发布');
        if (!input.reason) throw new BadRequestException('请填写更正原因');
      } else {
        this.requireHandoff(task);
      }
      const evidenceAssetId = await this.validateEvidence(tx, workspaceId, id, input.evidenceAssetId);
      assertTransition(task.status, input.state);
      const recordedAt = await databaseTime(tx);
      const resolvedChannel = task.executionChannel ?? task.account.channelKind;
      const receipt = {
        workspaceId, taskId: id, state: input.state, evidenceAssetId, recordedById: userId, recordedAt,
        remoteId: input.remoteId || (corrected ? task.result?.remoteId : null) || null,
        remoteUrl: input.remoteUrl || null, note: (corrected ? (input.reason || input.note) : input.note) ?? null, platformPublishedAt: null,
      };
      const result = await tx.publishResult.upsert({ where: { taskId: id }, create: receipt, update: receipt });
      await tx.publishTask.update({ where: { id }, data: { status: input.state, lastError: null,
        ...(!task.executionChannel && input.state === 'published' ? { executionChannel: resolvedChannel } : {}),
        ...(resolvedChannel === 'manual' && !task.handedOffAt && input.state === 'published' ? { handedOffAt: recordedAt } : {}),
        ...(task.status === 'canceled' ? { canceledAt: null, canceledById: null, cancelReason: null } : {}),
      } });
      await this.skipPendingReminders(tx, id, '任务已回填');
      const previous = { ...receiptSnapshot(task.result), taskStatus: task.status,
        canceledAt: task.canceledAt?.toISOString() ?? null, canceledById: task.canceledById, cancelReason: task.cancelReason };
      await tx.taskEvent.create({
        data: {
          workspaceId, taskId: id, kind: corrected ? 'corrected' : 'result', fromStatus: task.status, toStatus: input.state,
          actorId: userId, reason: corrected ? input.reason : input.note,
          details: corrected ? { previous, next: receiptSnapshot(result), reason: input.reason! }
            : { ...receiptSnapshot(result), ...(task.result ? { previous } : {}) },
        },
      });
      return result;
    }, { isolationLevel: 'ReadCommitted' });
  }

  private requireHandoff(task: PublishTask) {
    if (task.status !== 'handed_off' || task.executionChannel !== 'manual' || !task.handedOffAt) {
      throw new ConflictException('仅已交接且未回填的人工任务可以录入结果');
    }
  }

  async dispatchDue() {
    await this.recoverExpiredClaims();
    const candidates = await this.prisma.publishTask.findMany({
      where: {
        status: 'scheduled', scheduledAt: { lte: await databaseTime(this.prisma) },
        ...(!config.trialAvailable && { workspace: { trialOwnerId: null } }),
        OR: [
          { account: { channelKind: 'manual' }, executionChannel: { in: ['manual'] } },
          { account: { channelKind: 'manual' }, executionChannel: null },
          ...(!config.sandboxChannel ? [{ workspace: { trialOwnerId: null },
            account: { channelKind: 'official' as const, ...(config.bilibili.enabled ? {} : { credentialsKeyId: platformKeyId }) },
            OR: [{ executionChannel: null }, { executionChannel: 'official' as const }] }] : []),
          ...(config.sandboxChannel || config.trialAvailable ? [{
            ...(!config.sandboxChannel && { workspace: { trialOwnerId: { not: null } } }),
            account: { channelKind: 'sandbox' as const },
            OR: [{ executionChannel: null }, { executionChannel: 'sandbox' as const }],
          }] : []),
        ],
      },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      take: 50,
      select: { id: true, workspaceId: true, accountId: true, variantId: true, variant: { select: { manuscriptId: true } } },
    });
    let dispatched = 0;
    for (const candidate of candidates) {
      const outcome = await this.claim(candidate);
      if (!outcome) continue;
      if (outcome !== true) await this.submitClaim(outcome);
      dispatched++;
    }
    return dispatched;
  }

  private async claim(candidate: Pick<PublishTask, 'id' | 'workspaceId' | 'accountId' | 'variantId'>
    & { variant: { manuscriptId: string } }): Promise<boolean | AutomaticClaim> {
    const { id, workspaceId, accountId, variantId, variant: { manuscriptId } } = candidate;
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockRow(tx, 'manuscript', workspaceId, manuscriptId))
        || !(await lockRow(tx, 'variant', workspaceId, variantId))
        || !(await lockRow(tx, 'account', workspaceId, accountId))
        || !(await lockRow(tx, 'task', workspaceId, id))) return false;
      const task = await tx.publishTask.findUniqueOrThrow({ where: { id }, include: { workspace: { select: { trialOwnerId: true } } } });
      const now = await databaseTime(tx);
      if (task.status !== 'scheduled' || task.scheduledAt > now || task.accountId !== accountId
        || task.variantId !== variantId) return false;
      if (task.attempts > 0 && await this.hasLateAcceptance(tx, id)) {
        await this.storeAutomaticResult(tx, task, { status: 'unknown', message: '收到原尝试的迟到受理回执，请先核对作品' }, now);
        return false;
      }

      const variant = await tx.variant.findUniqueOrThrow({ where: { id: variantId }, include: publishableVariant });
      const account = await tx.channelAccount.findUniqueOrThrow({ where: { id: accountId } });
      const trial = Boolean(task.workspace.trialOwnerId);
      const channel = publishChannel(account, now, trial);
      if (task.executionChannel && task.executionChannel !== account.channelKind) return false;
      // 网页配置的应用凭据读不出来时先暂停，避免把待发任务直接烧成失败。
      const appReady = channel !== 'official' || account.credentialsKeyId !== platformKeyId
        || Boolean(await bilibiliAppOptions(tx, account).catch(() => undefined));
      if (!appReady || !hasApproval(variant) || variant.contentHash !== task.variantContentHash
        || account.platform !== variant.platform || !channel || (variant.videoAssetId && channel === 'official')) {
        const reason = isUnverifiedBilibiliAccount(account) ? bilibiliAuthorizationRequired
          : appReady ? '审核快照失效或发布账号不可用' : 'B 站开放平台应用凭据不可用，请负责人重新保存';
        assertTransition(task.status, 'paused');
        await tx.publishTask.update({ where: { id }, data: { status: 'paused', lastError: reason } });
        await tx.taskEvent.create({
          data: { workspaceId, taskId: id, kind: 'paused', fromStatus: task.status, toStatus: 'paused', reason },
        });
        return false;
      }
      if (await tx.publishTask.findFirst({
        where: { accountId, status: 'dispatching' },
        select: { id: true },
      })) return false;

      const leaseId = randomUUID();
      assertTransition(task.status, 'dispatching');
      await tx.publishTask.update({
        where: { id },
        data: {
          status: 'dispatching', executionChannel: channel, claimedAt: now,
          attempts: { increment: 1 }, leaseId, leaseExpiresAt: new Date(now.getTime() + 90_000),
        },
      });
      await tx.taskEvent.create({
        data: { workspaceId, taskId: id, kind: 'claimed', fromStatus: 'scheduled', toStatus: 'dispatching',
          leaseId, details: { executionChannel: channel } },
      });
      if (channel !== 'manual') return { task, variant, account, channel, leaseId, trial };

      // 人工交接只产生本地回执，与领取在同一事务提交。
      const receipt = await this.manual.publish({
        variant: publishVariant(variant),
        account: { id: accountId, displayName: account.displayName, platform: account.platform, channelKind: 'manual' },
        slot: { scheduledAt: task.scheduledAt.toISOString(), idempotencyKey: task.idempotencyKey },
      });
      if (receipt.status !== 'handed_off') throw new Error('人工通道返回了无效交接状态');
      assertTransition('dispatching', receipt.status);
      await tx.publishTask.update({
        where: { id },
        data: { status: receipt.status, handedOffAt: now, leaseId: null, leaseExpiresAt: null, lastError: null },
      });
      await tx.taskEvent.create({
        data: { workspaceId, taskId: id, kind: 'handed_off', fromStatus: 'dispatching', toStatus: 'handed_off',
          leaseId, reason: receipt.message },
      });
      await this.notifications.enqueueHandoff(tx, workspaceId, id, now, trial);
      return true;
    }, { isolationLevel: 'ReadCommitted' });
  }

  private async submitClaim({ task, variant, account, channel, leaseId, trial }: AutomaticClaim) {
    const bilibili = channel === 'official' ? await bilibiliAppOptions(this.prisma, account).catch(() => undefined) : undefined;
    const adapter = trial ? new SandboxAdapter(true) : resolveAdapter(account.platform, channel, { bilibili });
    const input: PublishInput = {
      variant: publishVariant(variant),
      account: { ...account, credentials: channel === 'official' ? bilibiliCredentials(account) : undefined },
      slot: { scheduledAt: task.scheduledAt.toISOString(), idempotencyKey: task.idempotencyKey },
      beforeSubmit: async () => {
        const now = await databaseTime(this.prisma);
        const lease = await this.prisma.publishTask.findFirst({
          where: { id: task.id, status: 'dispatching', leaseId, leaseExpiresAt: { gt: now },
            account: { archivedAt: null, authStatus: 'active', credentialsUpdatedAt: account.credentialsUpdatedAt,
              authExpiresAt: { gt: now }, OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lte: now } }] } },
          select: { id: true },
        });
        return Boolean(lease) && (task.attempts === 0 || !await this.hasLateAcceptance(this.prisma, task.id));
      },
    };
    let failure: PublishReceipt | undefined;
    try {
      if (channel === 'official') input.variant.images = await this.readPublishImages(variant);
      await adapter.preflight(input);
    } catch (error) {
      failure = {
        status: 'failed',
        message: error instanceof Error && error.message
          ? error.message
          : '投稿前检查失败，文章尚未提交。请检查授权、专栏字段和图片格式',
      };
    }
    const receipt = failure ?? await adapter.publish(input).catch((): PublishReceipt => ({
      status: 'unknown', message: '提交结果未确认，请核实平台记录',
    }));
    await this.prisma.$transaction(async (tx) => {
      if (!(await lockRow(tx, 'task', task.workspaceId, task.id))) return;
      const current = await tx.publishTask.findUniqueOrThrow({ where: { id: task.id } });
      const now = await databaseTime(tx);
      if (current.status !== 'dispatching' || current.leaseId !== leaseId
        || !current.leaseExpiresAt || current.leaseExpiresAt <= now) {
        await tx.taskEvent.create({
          data: { taskId: task.id, workspaceId: task.workspaceId, kind: 'late_receipt', leaseId,
            reason: receipt.message, details: this.receiptDetails(receipt) },
        });
        return;
      }
      await this.storeAutomaticResult(tx, current, receipt, now);
    });
    if (channel === 'official' && receipt.status === 'failed') {
      await this.risks.recordRisk({
        workspaceId: task.workspaceId,
        accountId: account.id,
        level: 'risk',
        kind: 'publish_failed',
        message: receipt.message || '官方通道投稿失败，请检查账号授权与平台状态',
      }).catch(() => undefined);
    }
  }

  private async readPublishImages(variant: PublishableVariant) {
    const { workspaceId, manuscriptId, assets } = variant;
    const files = await this.prisma.asset.findMany({
      where: { id: { in: assets.map(({ assetId }) => assetId) }, workspaceId, manuscriptId, kind: 'manuscript_image' },
      select: { id: true, storageKey: true, size: true },
    });
    const byId = new Map(files.map((file) => [file.id, file]));
    const images: { file: Blob; isCover: boolean }[] = [];
    for (const asset of assets) {
      const file = byId.get(asset.assetId);
      if (!file || file.size > 5 * 1024 * 1024) throw new Error('文章图片缺失或超出 B 站大小限制');
      const image = await this.storage.readImage(workspaceId, file.storageKey);
      images.push({ file: new Blob([new Uint8Array(image.data)], { type: image.mimeType }), isCover: asset.isCover });
    }
    return images;
  }

  private async recoverExpiredClaims() {
    const now = await databaseTime(this.prisma);
    const expired = await this.prisma.publishTask.findMany({
      where: { status: 'dispatching', executionChannel: { in: ['official', 'sandbox'] }, leaseExpiresAt: { lte: now } },
      orderBy: { leaseExpiresAt: 'asc' },
      take: 50,
      select: { id: true, workspaceId: true },
    });
    for (const { id, workspaceId } of expired) {
      await this.prisma.$transaction(async (tx) => {
        if (!(await lockRow(tx, 'task', workspaceId, id))) return;
        const current = await tx.publishTask.findUniqueOrThrow({ where: { id } });
        if (current.status !== 'dispatching' || !current.leaseExpiresAt || current.leaseExpiresAt > now) return;
        await this.storeAutomaticResult(tx, current, { status: 'unknown', message: '领取已超时，请核实平台记录' }, now);
      });
    }
  }

  async pollAutomaticResults() {
    const now = await databaseTime(this.prisma);
    const pending = await this.prisma.publishTask.findMany({
      where: {
        status: { in: ['submitted', 'under_review'] },
        updatedAt: { lte: new Date(now.getTime() - 10_000) },
        result: { remoteId: { not: null } },
        ...(!config.trialAvailable && { workspace: { trialOwnerId: null } }),
        account: { platform: 'bilibili' },
        OR: [
          ...(!config.sandboxChannel ? [{ workspace: { trialOwnerId: null }, executionChannel: 'official' as const,
            ...(config.bilibili.enabled ? {} : { account: { platform: 'bilibili' as const, credentialsKeyId: platformKeyId } }) }] : []),
          ...(config.sandboxChannel || config.trialAvailable ? [{ executionChannel: 'sandbox' as const,
            ...(!config.sandboxChannel && { workspace: { trialOwnerId: { not: null } } }) }] : []),
        ],
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      include: { account: true, result: true, workspace: { select: { trialOwnerId: true } } },
      take: 5,
    });
    await Promise.all(pending.map(async (task) => {
      // Advance the polling timestamp once across Worker replicas before the read-only network request.
      const { count } = await this.prisma.publishTask.updateMany({
        where: { id: task.id, status: task.status, updatedAt: task.updatedAt },
        data: { updatedAt: now },
      });
      if (!count || !task.result?.remoteId || !task.executionChannel
        || publishChannel(task.account, now, Boolean(task.workspace.trialOwnerId)) !== task.executionChannel) return;
      const credentials = task.executionChannel === 'official' ? bilibiliCredentials(task.account) : undefined;
      if (task.executionChannel === 'official' && !credentials) return;
      const bilibili = task.executionChannel === 'official'
        ? await bilibiliAppOptions(this.prisma, task.account).catch(() => undefined) : undefined;
      if (task.executionChannel === 'official' && !bilibili) return;
      const adapter = resolveAdapter(task.account.platform, task.executionChannel, { bilibili });
      const receipt = await adapter.fetchStatus(
        { status: task.result.state, remoteId: task.result.remoteId }, { ...task.account, credentials },
      );
      if (receipt.status === task.status) return;
      await this.prisma.$transaction(async (tx) => {
        if (!(await lockRow(tx, 'task', task.workspaceId, task.id))) return;
        const current = await tx.publishTask.findUniqueOrThrow({ where: { id: task.id }, include: { result: true } });
        if (current.status !== task.status || current.result?.remoteId !== task.result!.remoteId) return;
        await this.storeAutomaticResult(tx, current, receipt, await databaseTime(tx));
      });
    }));
  }

  private receiptDetails(receipt: PublishReceipt) {
    return {
      state: receipt.status, remoteId: receipt.remoteId ?? null, remoteUrl: receipt.remoteUrl ?? null,
      ...(receipt.raw ? { platform: receipt.raw as Prisma.InputJsonObject } : {}),
    };
  }

  private async storeAutomaticResult(tx: Prisma.TransactionClient, task: PublishTask, receipt: PublishReceipt, now: Date) {
    const state = receipt.status;
    if (state === 'handed_off') throw new Error('自动通道返回了人工交接回执');
    assertTransition(task.status, state);
    const result = {
      state, remoteId: receipt.remoteId, remoteUrl: receipt.remoteUrl,
      platformPublishedAt: receipt.platformPublishedAt ? new Date(receipt.platformPublishedAt) : undefined,
      note: receipt.message ?? null, recordedAt: now, recordedById: null,
    };
    await tx.publishResult.upsert({
      where: { taskId: task.id }, update: result,
      create: { ...result, workspaceId: task.workspaceId, taskId: task.id },
    });
    await tx.publishTask.update({
      where: { id: task.id },
      data: { status: state, leaseId: null, leaseExpiresAt: null,
        lastError: state === 'failed' || state === 'unknown' ? receipt.message : null },
    });
    await tx.taskEvent.create({
      data: { workspaceId: task.workspaceId, taskId: task.id, kind: 'result', fromStatus: task.status,
        toStatus: state, leaseId: task.leaseId, reason: receipt.message, details: this.receiptDetails(receipt) },
    });
  }
}
