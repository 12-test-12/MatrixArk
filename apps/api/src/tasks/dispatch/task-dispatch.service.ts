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
    const automaticClaims: AutomaticClaim[] = [];
    const busyAccounts = new Set<string>();

    for (const candidate of candidates) {
      if (busyAccounts.has(candidate.accountId)) continue;
      const outcome = await this.claims.claim(candidate);
      if (!outcome) continue;
      if (outcome !== true) {
        busyAccounts.add(candidate.accountId);
        automaticClaims.push(outcome);
      }
      dispatched++;
    }

    const concurrency = options.concurrency ?? config.worker.dispatchConcurrency;
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

    return dispatched;
  }
}
