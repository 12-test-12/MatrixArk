import { assertTransition, idempotencyKey, type cancelTaskSchema, type recordResultSchema, type scheduleTasksSchema, type verifyTaskSchema } from '@matrixark/shared';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type PublishResult, type PublishTask, type Role } from '@prisma/client';
import { randomInt } from 'node:crypto';
import type { z } from 'zod';
import { isUnverifiedBilibiliAccount } from '../../accounts/publish-account';
import { PrismaService } from '../../prisma/prisma.service';
import { bilibiliAuthorizationRequired, hasApproval, presentTask, publishableVariant, receiptSnapshot, requireHandoff, taskRelations } from '../domain/task-policy';
import { transitionTask } from '../domain/task-transition';
import { databaseTime, hasLateAcceptance, lockRow, lockRows } from '../infrastructure/task-locks';
import { TaskPlatformService } from '../infrastructure/task-platform.service';
import { TaskEvidenceService } from './task-evidence.service';

@Injectable()
export class TaskCommandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly evidence: TaskEvidenceService,
    private readonly platforms: TaskPlatformService,
  ) { }

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
      const pending: (Prisma.PublishTaskCreateManyInput & { jitterSeconds?: number })[] = [];
      let cumulativeJitterSeconds = 0;
      const jitterEnabled = Boolean(input.jitter?.enabled);
      const minJitter = input.jitter?.minSeconds ?? 30;
      const maxJitter = input.jitter?.maxSeconds ?? 180;
      for (const variant of variants) {
        const targets = accounts.filter(({ id, platform }) =>
          platform === variant.platform && !existingPairs.has(`${id}:${variant.id}`));
        if (targets.length === 0) continue;
        if (!hasApproval(variant)) throw new ConflictException('版本需要有效审核');
        for (const account of targets) {
          this.platforms.requireAvailableAccount(account, variant, now, Boolean(trialOwnerId));
          let jitterSeconds = 0;
          if (jitterEnabled && pending.length > 0) {
            const step = maxJitter > minJitter ? randomInt(minJitter, maxJitter + 1) : minJitter;
            cumulativeJitterSeconds += step;
            jitterSeconds = cumulativeJitterSeconds;
          }
          const slotDate = jitterSeconds > 0
            ? new Date(input.scheduledAt.getTime() + jitterSeconds * 1000)
            : input.scheduledAt;
          pending.push({
            workspaceId, accountId: account.id, variantId: variant.id, scheduledAt: slotDate, createdById: userId,
            variantContentHash: variant.contentHash,
            idempotencyKey: idempotencyKey({ accountId: account.id, variantId: variant.id, hash: variant.contentHash }),
            jitterSeconds,
          });
        }
      }

      const created = pending.length
        ? await tx.publishTask.createManyAndReturn({
          data: pending.map(({ jitterSeconds: _jitter, ...row }) => row),
        })
        : [];
      if (created.length) {
        const jitterByKey = new Map(pending.map((row) => [row.idempotencyKey, row.jitterSeconds ?? 0]));
        await tx.taskEvent.createMany({
          data: created.map(({ id, scheduledAt, idempotencyKey: key }) => {
            const jitterSeconds = jitterByKey.get(key) ?? 0;
            return {
              workspaceId,
              taskId: id,
              kind: 'created',
              actorId: userId,
              toStatus: 'scheduled',
              ...(jitterSeconds > 0 ? {
                reason: `风控错峰延迟 +${jitterSeconds} 秒执行`,
                details: { jitterSeconds, scheduledAt: scheduledAt.toISOString() },
              } : {}),
            };
          }),
        });
      }
      const items = [
        ...created.map((task) => ({ task, disposition: 'created' as const })),
        ...previous.map((task) => ({ task, disposition: 'existing' as const })),
      ];
      return items.map(({ task: { id, accountId, variantId, status, scheduledAt }, disposition }) =>
        ({ id, accountId, variantId, status, scheduledAt, disposition }));
    };
    return transaction ? scheduleIn(transaction) : this.prisma.$transaction(scheduleIn, { isolationLevel: 'ReadCommitted' });
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
      const task = await tx.publishTask.findUniqueOrThrow({
        where: { id },
        include: {
          variant: { include: publishableVariant }, account: true, result: true,
          workspace: { select: { trialOwnerId: true } }
        }
      });
      if (task.status !== expected[operation]) throw new ConflictException('任务状态已变化，或尚未确认平台未受理');
      const now = await databaseTime(tx);
      if (scheduledAt <= now) throw new BadRequestException('请选择未来的计划时间');
      if (!hasApproval(task.variant) || task.variant.contentHash !== task.variantContentHash) {
        throw new ConflictException('原审核快照已失效，请审核当前版本后重新排期');
      }
      const channel = this.platforms.requireAvailableAccount(task.account, task.variant, now, Boolean(task.workspace.trialOwnerId));
      if (task.executionChannel && task.executionChannel !== channel) throw new ConflictException('发布通道已变化，无法重新安排原任务');
      await this.platforms.requireApplication(tx, task.account, channel);
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
      const updated = await transitionTask(
        tx,
        task,
        {
          status: 'scheduled',
          scheduledAt,
          lastError: null,
          ...(operation === 'reschedule' ? {} : { claimedAt: null, handedOffAt: null }),
        },
        {
          actorId: userId,
          kind: operation === 'retry' ? 'retried' : 'rescheduled',
          reason: operation === 'resume' ? '恢复暂停任务' : undefined,
          details: { previousScheduledAt: task.scheduledAt.toISOString(), scheduledAt: scheduledAt.toISOString() },
        },
      );

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
      const updated = await transitionTask(
        tx,
        task,
        {
          status: 'canceled',
          canceledAt,
          canceledById: userId,
          cancelReason: input.reason,
          lastError: null,
        },
        {
          actorId: userId,
          kind: 'canceled',
          reason: input.reason,
          details: { verification: input.verification ?? null },
        },
      );
      await this.skipPendingReminders(tx, id, '任务已取消');

      return presentTask(updated);
    }, { isolationLevel: 'ReadCommitted' });
  }

  private async requireNoAcceptance(tx: Prisma.TransactionClient, task: PublishTask & { result: PublishResult | null }) {
    if (task.result?.remoteId || task.result?.remoteUrl || await hasLateAcceptance(tx, task.id)) {
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
        await tx.taskEvent.create({
          data: {
            workspaceId, taskId: id, actorId: userId, kind: 'verified',
            fromStatus: 'unknown', toStatus: 'unknown', reason: input.reason, details: { outcome: input.outcome }
          }
        });
        const { account: { externalId: _ext, accessMethod: _acc, ...account }, ...rest } = task;
        return presentTask({ ...rest, account });
      }
      if (input.outcome === 'not_received') await this.requireNoAcceptance(tx, task);
      if (input.outcome === 'accepted') {
        if (task.executionChannel !== 'official') throw new ConflictException('仅官方通道支持按文章 ID 继续回读');
        this.platforms.validateRemoteId(task.account.platform, input.remoteId);
        if (task.result?.remoteId && task.result.remoteId !== input.remoteId) throw new ConflictException('文章 ID 与现有回执不一致');
      }
      const verified = await transitionTask(
        tx,
        task,
        {
          status: 'verified',
          lastError: null,
        },
        {
          actorId: userId,
          kind: 'verified',
          reason: input.reason,
          details: {
            outcome: input.outcome, attempt: task.attempts, previous: receiptSnapshot(task.result),
            ...('remoteId' in input && input.remoteId ? { remoteId: input.remoteId } : {})
          },
        },
      );
      if (input.outcome === 'not_received') {
        return presentTask(verified);
      }
      const state = input.outcome === 'accepted' ? 'submitted' : 'published';
      assertTransition('verified', state);
      const evidenceAssetId = await this.evidence.validateEvidence(tx, workspaceId, id, 'evidenceAssetId' in input ? input.evidenceAssetId : undefined);
      const receipt = {
        workspaceId, taskId: id, state, recordedById: userId, recordedAt: await databaseTime(tx), note: input.reason,
        remoteId: input.remoteId || task.result?.remoteId || null,
        remoteUrl: ('remoteUrl' in input ? input.remoteUrl : task.result?.remoteUrl) || null,
        evidenceAssetId: input.outcome === 'accepted' ? task.result?.evidenceAssetId ?? null : evidenceAssetId,
      } as const;
      const saved = await tx.publishResult.upsert({ where: { taskId: id }, create: receipt, update: receipt });
      const updated = await transitionTask(
        tx,
        verified,
        {
          status: state,
          lastError: null,
        },
        {
          actorId: userId,
          kind: 'result',
          reason: input.reason,
          details: receiptSnapshot(saved),
        },
      );

      return presentTask(updated);
    }, { isolationLevel: 'ReadCommitted' });
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
        requireHandoff(task);
      }
      const evidenceAssetId = await this.evidence.validateEvidence(tx, workspaceId, id, input.evidenceAssetId);
      assertTransition(task.status, input.state);
      const recordedAt = await databaseTime(tx);
      const resolvedChannel = task.executionChannel ?? task.account.channelKind;
      const receipt = {
        workspaceId, taskId: id, state: input.state, evidenceAssetId, recordedById: userId, recordedAt,
        remoteId: input.remoteId || (corrected ? task.result?.remoteId : null) || null,
        remoteUrl: input.remoteUrl || null, note: (corrected ? (input.reason || input.note) : input.note) ?? null, platformPublishedAt: null,
      };
      const result = await tx.publishResult.upsert({ where: { taskId: id }, create: receipt, update: receipt });
      const previous = {
        ...receiptSnapshot(task.result), taskStatus: task.status,
        canceledAt: task.canceledAt?.toISOString() ?? null, canceledById: task.canceledById, cancelReason: task.cancelReason
      };
      await transitionTask(
        tx,
        task,
        {
          status: input.state,
          lastError: null,
          ...(!task.executionChannel && input.state === 'published' ? { executionChannel: resolvedChannel } : {}),
          ...(resolvedChannel === 'manual' && !task.handedOffAt && input.state === 'published' ? { handedOffAt: recordedAt } : {}),
          ...(task.status === 'canceled' ? { canceledAt: null, canceledById: null, cancelReason: null } : {}),
        },
        {
          kind: corrected ? 'corrected' : 'result',
          actorId: userId,
          reason: corrected ? input.reason : input.note,
          details: corrected ? { previous, next: receiptSnapshot(result), reason: input.reason! }
            : { ...receiptSnapshot(result), ...(task.result ? { previous } : {}) },
        },
      );
      await this.skipPendingReminders(tx, id, '任务已回填');

      return result;
    }, { isolationLevel: 'ReadCommitted' });
  }

}
