import { AdapterRegistry } from '@matrixark/adapters';
import { assertTransition } from '@matrixark/shared';
import { Injectable } from '@nestjs/common';
import { type PublishTask } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { isUnverifiedBilibiliAccount } from '../../accounts/publish-account';
import { config } from '../../config';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomaticClaim, bilibiliAuthorizationRequired, hasApproval, publishableVariant, publishVariant } from '../domain/task-policy';
import { transitionTask } from '../domain/task-transition';
import { databaseTime, hasLateAcceptance, lockRow } from '../infrastructure/task-locks';
import { TaskPlatformService } from '../infrastructure/task-platform.service';
import { TaskReceiptService } from './task-receipt.service';

@Injectable()
export class TaskClaimService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly receipts: TaskReceiptService,
    private readonly platforms: TaskPlatformService,
    private readonly adapters: AdapterRegistry,
  ) { }

  async claim(candidate: Pick<PublishTask, 'id' | 'workspaceId' | 'accountId' | 'variantId'>
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
      if (task.attempts > 0 && await hasLateAcceptance(tx, id)) {
        await this.receipts.storeAutomaticResult(tx, task, { status: 'unknown', message: '收到原尝试的迟到受理回执，请先核对作品' }, now);
        return false;
      }

      const variant = await tx.variant.findUniqueOrThrow({ where: { id: variantId }, include: publishableVariant });
      const account = await tx.channelAccount.findUniqueOrThrow({ where: { id: accountId } });
      const trial = Boolean(task.workspace.trialOwnerId);
      const channel = this.platforms.channelFor(account, now, trial, task.selectedMode);
      if (task.executionChannel && channel && task.executionChannel !== channel) return false;
      if (await tx.publishTask.findFirst({ where: { accountId, id: { not: id },
        OR: [
          { status: 'dispatching' },
          { status: { in: ['handed_off', 'unknown', 'submitted', 'under_review'] },
            ...(task.selectedMode ? {} : { selectedMode: { not: null } }) },
        ],
      }, select: { id: true } })) return false;
      // 网页配置的应用凭据读不出来时先暂停，避免把待发任务直接烧成失败。
      let modeError: string | undefined;
      if (task.selectedMode) {
        try { await this.platforms.requireReady(tx, account, variant, now, trial, task.selectedMode, task.id); }
        catch (error) { modeError = (error as Error).message; }
      }
      const appReady = !modeError && await this.platforms.applicationReady(tx, account, channel);
      if (!appReady || !hasApproval(variant) || variant.contentHash !== task.variantContentHash
        || account.platform !== variant.platform || !channel || !this.platforms.supportsContent(account.platform, channel, variant)) {
        const reason = modeError ?? (isUnverifiedBilibiliAccount(account) ? bilibiliAuthorizationRequired
          : appReady ? '审核快照失效或发布账号不可用' : 'B 站开放平台应用凭据不可用，请负责人重新保存');
        assertTransition(task.status, 'paused');
        await transitionTask(
          tx,
          task,
          {
            status: 'paused',
            lastError: reason,
          },
          {
            kind: 'paused',
            reason,
          },
        );

        return false;
      }
      const leaseId = randomUUID();
      assertTransition(task.status, 'dispatching');
      await transitionTask(
        tx,
        task,
        {
          status: 'dispatching',
          executionChannel: channel,
          claimedAt: now,
          attempts: { increment: 1 },
          leaseId,
          leaseExpiresAt: new Date(now.getTime() + config.worker.leaseDurationMs),
        },
        {
          kind: 'claimed',
          leaseId,
          details: { executionChannel: channel, selectedMode: task.selectedMode },
        },
      );

      if (channel !== 'manual') return { task, variant, account, channel, leaseId, trial };

      // 人工交接只产生本地回执，与领取在同一事务提交。
      const receipt = await this.adapters.resolve(account.platform, 'manual').publish({
        variant: publishVariant(variant),
        account: { id: accountId, displayName: account.displayName, platform: account.platform, channelKind: 'manual' },
        slot: { scheduledAt: task.scheduledAt.toISOString(), idempotencyKey: task.idempotencyKey },
      });
      if (receipt.status !== 'handed_off') throw new Error('人工通道返回了无效交接状态');
      assertTransition('dispatching', receipt.status);
      await transitionTask(
        tx,
        {
          ...task,
          status: 'dispatching',
        },
        {
          status: receipt.status,
          handedOffAt: now,
          leaseId: null,
          leaseExpiresAt: null,
          lastError: null,
        },
        {
          kind: 'handed_off',
          leaseId,
          reason: receipt.message,
        },
      );

      await this.notifications.enqueueHandoff(tx, workspaceId, id, now, trial);
      return true;
    }, { isolationLevel: 'ReadCommitted' });
  }
}
