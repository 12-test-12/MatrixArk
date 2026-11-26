import { type PublishReceipt } from '@matrixark/adapters';
import { assertTransition } from '@matrixark/shared';
import { Injectable } from '@nestjs/common';
import { Prisma, type PublishTask } from '@prisma/client';
import { config } from '../../config';
import { PrismaService } from '../../prisma/prisma.service';
import { runBounded } from '../../worker/concurrency';
import { receiptDetails } from '../domain/task-policy';
import { transitionTask } from '../domain/task-transition';
import { databaseTime, lockRow } from '../infrastructure/task-locks';
import { TaskPlatformService } from '../infrastructure/task-platform.service';

@Injectable()
export class TaskReceiptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly platforms: TaskPlatformService,
  ) { }

  async pollAutomaticResults() {
    const now = await databaseTime(this.prisma);
    const pending = await this.prisma.publishTask.findMany({
      where: {
        status: { in: ['submitted', 'under_review'] },
        updatedAt: { lte: new Date(now.getTime() - 10_000) },
        result: { remoteId: { not: null } },
        ...this.platforms.receiptScope(),
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      include: { account: true, result: true, workspace: { select: { trialOwnerId: true } } },
      take: 10,
    });
    let updated = 0;
    await runBounded(pending, config.worker.receiptConcurrency, async (task) => {
      // Advance the polling timestamp once across Worker replicas before the read-only network request.
      const { count } = await this.prisma.publishTask.updateMany({
        where: { id: task.id, status: task.status, updatedAt: task.updatedAt },
        data: { updatedAt: now },
      });
      if (!count || !task.result?.remoteId || !task.executionChannel) return;
      const receipt = await this.platforms.fetchStatus(task.account, task.executionChannel, Boolean(task.workspace.trialOwnerId),
        { status: task.result.state, remoteId: task.result.remoteId }, now);
      if (!receipt) return;
      if (receipt.status === task.status) return;
      await this.prisma.$transaction(async (tx) => {
        if (!(await lockRow(tx, 'task', task.workspaceId, task.id))) return;
        const current = await tx.publishTask.findUniqueOrThrow({ where: { id: task.id }, include: { result: true } });
        if (current.status !== task.status || current.result?.remoteId !== task.result!.remoteId) return;
        await this.storeAutomaticResult(tx, current, receipt, await databaseTime(tx));
        updated++;
      });
    });
    return updated;
  }

  async storeAutomaticResult(tx: Prisma.TransactionClient, task: PublishTask, receipt: PublishReceipt, now: Date) {
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
    await transitionTask(
      tx,
      task,
      {
        status: state,
        leaseId: null,
        leaseExpiresAt: null,
        lastError: state === 'failed' || state === 'unknown' ? receipt.message : null,
      },
      {
        kind: 'result',
        leaseId: task.leaseId,
        reason: receipt.message,
        details: receiptDetails(receipt),
      },
    );

  }
}
