import { type PublishReceipt } from '@matrixark/adapters';
import { assertTransition } from '@matrixark/shared';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type PublishTask } from '@prisma/client';
import { AccountRiskService } from '../../accounts/account-risk.service';
import { config } from '../../config';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomaticClaim, receiptDetails } from '../domain/task-policy';
import { transitionTask } from '../domain/task-transition';
import { databaseTime, hasLateAcceptance, lockRow } from '../infrastructure/task-locks';
import { TaskPlatformService } from '../infrastructure/task-platform.service';
import { TaskLeaseService } from './task-lease.service';
import { TaskReceiptService } from './task-receipt.service';

export type SubmitClaimOptions = {
  leaseRenewIntervalMs?: number;
  leaseExtendMs?: number;
};

@Injectable()
export class TaskExecutorService {
  private readonly logger = new Logger(TaskExecutorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly risks: AccountRiskService,
    private readonly receipts: TaskReceiptService,
    private readonly platforms: TaskPlatformService,
    private readonly leases: TaskLeaseService,
  ) { }

  async submitClaim({ task, variant, account, channel, leaseId, trial }: AutomaticClaim, options: SubmitClaimOptions = {}) {
    const claim = { task, variant, account, channel, leaseId, trial };
    let leaseLost = false;
    const { adapter, input } = await this.platforms.createExecution(claim, async () => {
      if (leaseLost) return false;
      const now = await databaseTime(this.prisma);
      const lease = await this.prisma.publishTask.findFirst({
        where: {
          id: task.id, status: 'dispatching', leaseId, leaseExpiresAt: { gt: now },
          account: {
            archivedAt: null, authStatus: 'active', credentialsUpdatedAt: account.credentialsUpdatedAt,
            authExpiresAt: { gt: now }, OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lte: now } }]
          }
        },
        select: { id: true },
      });
      return Boolean(lease) && (task.attempts === 0 || !await hasLateAcceptance(this.prisma, task.id));
    });

    const renewMs = options.leaseRenewIntervalMs ?? config.worker.leaseRenewIntervalMs;
    const extendMs = options.leaseExtendMs ?? config.worker.leaseDurationMs;
    let renewing = false;
    const heartbeat = renewMs > 0 ? setInterval(() => {
      if (renewing || leaseLost) return;
      renewing = true;
      void this.leases.renewLease(task.workspaceId, task.id, leaseId, extendMs)
        .then((kept) => {
          if (!kept) leaseLost = true;
        })
        .catch((error: unknown) => {
          this.logger.warn(`任务租约心跳续期失败 · ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          renewing = false;
        });
    }, renewMs) : undefined;
    heartbeat?.unref();

    let failure: PublishReceipt | undefined;
    let receipt: PublishReceipt;
    try {
      try {
        await this.platforms.preflight(adapter, input, claim);
      } catch (error) {
        failure = {
          status: 'failed',
          message: error instanceof Error && error.message
            ? error.message
            : '投稿前检查失败，文章尚未提交。请检查授权、专栏字段和图片格式',
        };
      }
      receipt = failure ?? await adapter.publish(input).catch((): PublishReceipt => ({
        status: 'unknown', message: '提交结果未确认，请核实平台记录',
      }));
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
    const captchaBroken = channel === 'official' && receipt.status === 'failed' && this.isCaptchaCircuitBreak(receipt);
    await this.prisma.$transaction(async (tx) => {
      if (!(await lockRow(tx, 'task', task.workspaceId, task.id))) return;
      const current = await tx.publishTask.findUniqueOrThrow({ where: { id: task.id } });
      const now = await databaseTime(tx);
      if (current.status !== 'dispatching' || current.leaseId !== leaseId
        || !current.leaseExpiresAt || current.leaseExpiresAt <= now) {
        await tx.taskEvent.create({
          data: {
            taskId: task.id, workspaceId: task.workspaceId, kind: 'late_receipt', leaseId,
            reason: receipt.message, details: receiptDetails(receipt)
          },
        });
        return;
      }
      if (captchaBroken) {
        await this.circuitBreakToManual(tx, current, receipt, now, trial);
        return;
      }
      await this.receipts.storeAutomaticResult(tx, current, receipt, now);
    });
    if (captchaBroken) {
      await this.risks.recordRisk({
        workspaceId: task.workspaceId,
        accountId: account.id,
        level: 'risk',
        kind: 'verification_required',
        message: receipt.message || '发布触发平台验证码或安全验证，任务已自动熔断并转入人工交接（绝不自动绕过验证）',
        forceNotify: true,
      }).catch(() => undefined);
    } else if (channel === 'official' && receipt.status === 'failed') {
      await this.risks.recordRisk({
        workspaceId: task.workspaceId,
        accountId: account.id,
        level: 'risk',
        kind: 'publish_failed',
        message: receipt.message || '官方通道投稿失败，请检查账号授权与平台状态',
      }).catch(() => undefined);
    }
  }

  private isCaptchaCircuitBreak(receipt: PublishReceipt) {
    const raw = receipt.raw && typeof receipt.raw === 'object' ? receipt.raw as Record<string, unknown> : null;
    if (raw?.captchaRequired === true) return true;
    const text = receipt.message ?? '';
    return /验证码|captcha|滑块|安全验证|人机校验|风险校验/iu.test(text);
  }

  private async circuitBreakToManual(
    tx: Prisma.TransactionClient,
    task: PublishTask,
    receipt: PublishReceipt,
    now: Date,
    trial: boolean,
  ) {
    assertTransition(task.status, 'handed_off');
    const reason = receipt.message?.trim()
      || '触发平台验证码或安全验证，任务已自动熔断并转入人工交接（系统绝不自动绕过验证码）';
    await transitionTask(
      tx,
      task,
      {
        status: 'handed_off',
        handedOffAt: now,
        leaseId: null,
        leaseExpiresAt: null,
        lastError: reason,
      },
      {
        kind: 'circuit_break',
        leaseId: task.leaseId,
        reason,
        details: {
          circuitBreak: true,
          policy: 'never_bypass_captcha',
          previousChannel: task.executionChannel,
          newChannel: 'manual',
          ...receiptDetails(receipt),
        },
      },
    );

    await this.notifications.enqueueHandoff(tx, task.workspaceId, task.id, now, trial);
  }

}
