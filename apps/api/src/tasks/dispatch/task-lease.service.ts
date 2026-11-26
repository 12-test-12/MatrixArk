import { Injectable } from '@nestjs/common';
import { config } from '../../config';
import { PrismaService } from '../../prisma/prisma.service';
import { databaseTime, lockRow } from '../infrastructure/task-locks';
import { TaskReceiptService } from './task-receipt.service';

@Injectable()
export class TaskLeaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly receipts: TaskReceiptService,
  ) { }

  async renewLease(
    workspaceId: string,
    taskId: string,
    leaseId: string,
    extendMs = config.worker.leaseDurationMs,
  ): Promise<boolean> {
    const now = await databaseTime(this.prisma);
    const { count } = await this.prisma.publishTask.updateMany({
      where: {
        id: taskId,
        workspaceId,
        status: 'dispatching',
        leaseId,
        leaseExpiresAt: { gt: now },
      },
      data: {
        leaseExpiresAt: new Date(now.getTime() + extendMs),
      },
    });
    return count > 0;
  }

  async recoverExpiredClaims() {
    const now = await databaseTime(this.prisma);
    const expired = await this.prisma.publishTask.findMany({
      where: { status: 'dispatching', executionChannel: { in: ['official', 'sandbox'] }, leaseExpiresAt: { lte: now } },
      orderBy: { leaseExpiresAt: 'asc' },
      take: 50,
      select: { id: true, workspaceId: true },
    });
    let recovered = 0;
    for (const { id, workspaceId } of expired) {
      await this.prisma.$transaction(async (tx) => {
        if (!(await lockRow(tx, 'task', workspaceId, id))) return;
        const current = await tx.publishTask.findUniqueOrThrow({ where: { id } });
        if (current.status !== 'dispatching' || !current.leaseExpiresAt || current.leaseExpiresAt > now) return;
        await this.receipts.storeAutomaticResult(tx, current, { status: 'unknown', message: '领取已超时，请核实平台记录' }, now);
        recovered++;
      });
    }
    return recovered;
  }
}
