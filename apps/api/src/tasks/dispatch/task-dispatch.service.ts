import { Injectable, Logger } from '@nestjs/common';
import { config } from '../../config';
import { PrismaService } from '../../prisma/prisma.service';
import { runBounded } from '../../worker/concurrency';
import { type AutomaticClaim } from '../domain/task-policy';
import { databaseTime } from '../infrastructure/task-locks';
import { TaskPlatformService } from '../infrastructure/task-platform.service';
import { TaskClaimService } from './task-claim.service';
import { TaskExecutorService, type SubmitClaimOptions } from './task-executor.service';
import { TaskLeaseService } from './task-lease.service';

export type DispatchDueOptions = SubmitClaimOptions & {
  concurrency?: number;
  onActiveChange?: (delta: number) => void;
};

@Injectable()
export class TaskDispatchService {
  private readonly logger = new Logger(TaskDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly claims: TaskClaimService,
    private readonly executor: TaskExecutorService,
    private readonly leases: TaskLeaseService,
    private readonly platforms: TaskPlatformService,
  ) { }

  async dispatchDue(options: DispatchDueOptions = {}) {
    await this.leases.recoverExpiredClaims();
    const concurrency = options.concurrency ?? config.worker.dispatchConcurrency;
    const candidates = await this.prisma.publishTask.findMany({
      where: {
        status: 'scheduled', scheduledAt: { lte: await databaseTime(this.prisma) },
        ...this.platforms.dispatchScope(),
      },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      take: 50,
      select: { id: true, workspaceId: true, accountId: true, variantId: true, variant: { select: { manuscriptId: true } } },
    });

    let dispatched = 0;
    const busyAccounts = new Set<string>();
    let cursor = 0;
    // 每轮只领取一个并发量的自动任务并立刻提交。领取后排队等执行会让租约在提交前过期，
    // 提交前检查会把任务判成「领取已失效」，任务被记成需人工核实。
    while (cursor < candidates.length) {
      const automaticClaims: AutomaticClaim[] = [];
      while (cursor < candidates.length && automaticClaims.length < concurrency) {
        const candidate = candidates[cursor++]!;
        if (busyAccounts.has(candidate.accountId)) continue;
        const outcome = await this.claims.claim(candidate);
        if (!outcome) continue;
        dispatched++;
        if (outcome === true) continue;
        busyAccounts.add(candidate.accountId);
        automaticClaims.push(outcome);
      }
      await runBounded(automaticClaims, concurrency, async (claim) => {
        options.onActiveChange?.(1);
        try {
          await this.executor.submitClaim(claim, {
            leaseRenewIntervalMs: options.leaseRenewIntervalMs,
            leaseExtendMs: options.leaseExtendMs,
          });
        } catch (error) {
          this.logger.error(
            `执行自动发布任务失败 · ${claim.task.id}`,
            error instanceof Error ? error.stack : String(error),
          );
        } finally {
          options.onActiveChange?.(-1);
        }
      });
    }

    return dispatched;
  }
}
