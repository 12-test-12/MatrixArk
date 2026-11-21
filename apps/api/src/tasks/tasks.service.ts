import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type ChannelAccount, type PublishResult, type PublishTask, type TaskStatus } from '@prisma/client';
import { ManualHandoffAdapter, resolveAdapter, validateBilibiliArticle, type PublishInput, type PublishReceipt } from '@matrixark/adapters';
import { assertTransition, COMMITTED_STATUSES, idempotencyKey, type recordResultSchema, type scheduleTasksSchema } from '@matrixark/shared';
import type { z } from 'zod';
import { bilibiliCredentials, publishChannel } from '../accounts/publish-account';
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
  account: { select: { id: true, platform: true, displayName: true, operator: true, channelKind: true } },
  variant: { select: { id: true, manuscriptId: true, platform: true, version: true, title: true } },
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
  manuscriptId?: string;
  cursor?: string;
  limit: number;
};

@Injectable()
export class TasksService {
  private readonly manual = new ManualHandoffAdapter();

  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService,
    private readonly notifications: NotificationsService) {}

  async schedule(workspaceId: string, userId: string, input: z.infer<typeof scheduleTasksSchema>) {
    const variantIds = [...new Set(input.variantIds)];
    const accountIds = [...new Set(input.accountIds)];
    return this.prisma.$transaction(async (tx) => {
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
      const pending: Prisma.PublishTaskCreateManyInput[] = [];
      for (const variant of variants) {
        const targets = accounts.filter(({ id, platform }) =>
          platform === variant.platform && !existingPairs.has(`${id}:${variant.id}`));
        if (targets.length === 0) continue;
        if (!hasApproval(variant)) throw new ConflictException('版本需要有效审核');
        for (const account of targets) {
          this.requireAvailableAccount(account, variant, now);
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
    }, { isolationLevel: 'ReadCommitted' });
  }

  private requireAvailableAccount(account: ChannelAccount, variant: PublishableVariant, now: Date) {
    if (!account.externalId || !account.authCheckedAt) throw new ConflictException(`账号「${account.displayName}」尚未通过平台身份核验`);
    const channel = publishChannel(account, now);
    if (!channel) throw new ConflictException(`账号「${account.displayName}」当前不可排期，请检查授权和通道配置`);
    if (channel === 'official') {
      if (!bilibiliCredentials(account)) throw new ConflictException('无法读取该账号的 B 站授权');
      try {
        validateBilibiliArticle(publishVariant(variant));
      } catch (error) {
        throw new BadRequestException((error as Error).message);
      }
    }
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
      await tx.notificationDelivery.updateMany({
        where: { taskId: id, status: 'pending' },
        data: { status: 'skipped', nextAttemptAt: null, lastError: '任务已回填' },
      });
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
    await this.recoverExpiredClaims();
    const enabledChannels: Array<'manual' | 'official' | 'sandbox'> = ['manual'];
    if (config.bilibili.enabled) enabledChannels.push('official');
    if (config.sandboxChannel) enabledChannels.push('sandbox');
    const candidates = await this.prisma.publishTask.findMany({
      where: {
        status: 'scheduled', scheduledAt: { lte: await databaseTime(this.prisma) },
        account: { channelKind: { in: enabledChannels } },
        OR: [{ executionChannel: null }, { executionChannel: { in: enabledChannels } }],
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
      const task = await tx.publishTask.findUniqueOrThrow({ where: { id } });
      const now = await databaseTime(tx);
      if (task.status !== 'scheduled' || task.scheduledAt > now || task.accountId !== accountId
        || task.variantId !== variantId) return false;

      const variant = await tx.variant.findUniqueOrThrow({ where: { id: variantId }, include: publishableVariant });
      const account = await tx.channelAccount.findUniqueOrThrow({ where: { id: accountId } });
      const channel = publishChannel(account, now);
      if (task.executionChannel && task.executionChannel !== account.channelKind) return false;
      if (!hasApproval(variant) || variant.contentHash !== task.variantContentHash
        || account.platform !== variant.platform || !channel) {
        const reason = '审核快照失效或发布账号不可用';
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
      if (channel !== 'manual') return { task, variant, account, channel, leaseId };

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
      await this.notifications.enqueueHandoff(tx, workspaceId, id, now);
      return true;
    }, { isolationLevel: 'ReadCommitted' });
  }

  private async submitClaim({ task, variant, account, channel, leaseId }: AutomaticClaim) {
    const adapter = resolveAdapter(account.platform, channel, { bilibili: config.bilibili });
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
        return Boolean(lease);
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
    const channels: Array<'official' | 'sandbox'> = [];
    if (config.bilibili.enabled) channels.push('official');
    if (config.sandboxChannel) channels.push('sandbox');
    if (!channels.length) return;
    const now = await databaseTime(this.prisma);
    const pending = await this.prisma.publishTask.findMany({
      where: {
        status: { in: ['submitted', 'under_review'] }, executionChannel: { in: channels },
        updatedAt: { lte: new Date(now.getTime() - 10_000) },
        result: { remoteId: { not: null } }, account: { platform: 'bilibili' },
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      include: { account: true, result: true },
      take: 5,
    });
    await Promise.all(pending.map(async (task) => {
      // Advance the polling timestamp once across Worker replicas before the read-only network request.
      const { count } = await this.prisma.publishTask.updateMany({
        where: { id: task.id, status: task.status, updatedAt: task.updatedAt },
        data: { updatedAt: now },
      });
      if (!count || !task.result?.remoteId || !task.executionChannel
        || publishChannel(task.account, now) !== task.executionChannel) return;
      const credentials = task.executionChannel === 'official' ? bilibiliCredentials(task.account) : undefined;
      if (task.executionChannel === 'official' && !credentials) return;
      const adapter = resolveAdapter(task.account.platform, task.executionChannel, { bilibili: config.bilibili });
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
      note: receipt.message ?? null, recordedAt: now,
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
