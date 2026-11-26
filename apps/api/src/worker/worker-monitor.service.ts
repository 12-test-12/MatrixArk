import { Injectable } from '@nestjs/common';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { databaseTime } from '../tasks/infrastructure/task-locks';

export type WorkerMonitorSnapshot = {
  checkedAt: string;
  status: 'healthy' | 'warning' | 'degraded';
  warnings: string[];
  workers: {
    activeCount: number;
    staleCount: number;
    items: {
      workerId: string;
      hostname: string;
      pid: number;
      status: string;
      stale: boolean;
      maxConcurrency: number;
      activeTasks: number;
      lastHeartbeatAt: string;
      expiresAt: string;
      lastError: string | null;
      loopStates: unknown;
    }[];
  };
  backlog: {
    dueScheduledTasks: number;
    dispatchingTasks: number;
    expiredLeaseTasks: number;
    overdueHandoffTasks: number;
    dueNotifications: number;
    dueTopicSources: number;
    oldestDueScheduledAgeSeconds: number | null;
  };
};

@Injectable()
export class WorkerMonitorService {
  constructor(private readonly prisma: PrismaService) {}

  async getSnapshot(workspaceId?: string): Promise<WorkerMonitorSnapshot> {
    const now = await databaseTime(this.prisma);
    const fourHoursAgo = new Date(now.getTime() - 4 * 3_600_000);
    const recentWindow = new Date(now.getTime() - 24 * 3_600_000);
    const scope = workspaceId ? { workspaceId } : {};

    const [
      workers,
      dueScheduledTasks,
      oldestDueScheduled,
      dispatchingTasks,
      expiredLeaseTasks,
      overdueHandoffTasks,
      dueNotifications,
      dueTopicSources,
    ] = await Promise.all([
      this.prisma.workerHeartbeat.findMany({
        where: { lastHeartbeatAt: { gte: recentWindow } },
        orderBy: [{ lastHeartbeatAt: 'desc' }],
        take: 20,
      }),
      this.prisma.publishTask.count({
        where: { ...scope, status: 'scheduled', scheduledAt: { lte: now } },
      }),
      this.prisma.publishTask.findFirst({
        where: { ...scope, status: 'scheduled', scheduledAt: { lte: now } },
        orderBy: [{ scheduledAt: 'asc' }],
        select: { scheduledAt: true },
      }),
      this.prisma.publishTask.count({
        where: { ...scope, status: 'dispatching' },
      }),
      this.prisma.publishTask.count({
        where: {
          ...scope,
          status: 'dispatching',
          executionChannel: { in: ['official', 'sandbox'] },
          leaseExpiresAt: { lte: now },
        },
      }),
      this.prisma.publishTask.count({
        where: { ...scope, status: 'handed_off', handedOffAt: { lte: fourHoursAgo } },
      }),
      this.prisma.notificationDelivery.count({
        where: {
          ...scope,
          OR: [
            { status: 'pending', nextAttemptAt: { lte: now } },
            { status: 'sending', leaseExpiresAt: { lte: now } },
          ],
        },
      }),
      this.prisma.topicSource.count({
        where: { ...scope, enabled: true, deletedAt: null, nextRunAt: { lte: now } },
      }),
    ]);

    const workerItems = workers.map((item) => {
      const stale = item.status !== 'stopped' && item.expiresAt <= now;
      return {
        workerId: item.workerId,
        hostname: item.hostname,
        pid: item.pid,
        status: item.status,
        stale,
        maxConcurrency: item.maxConcurrency,
        activeTasks: item.activeTasks,
        lastHeartbeatAt: item.lastHeartbeatAt.toISOString(),
        expiresAt: item.expiresAt.toISOString(),
        lastError: item.lastError,
        loopStates: item.loopStates,
      };
    });

    const activeCount = workerItems.filter((w) => w.status === 'running' && !w.stale).length;
    const staleCount = workerItems.filter((w) => w.stale).length;
    const oldestDueScheduledAgeSeconds = oldestDueScheduled
      ? Math.max(0, Math.floor((now.getTime() - oldestDueScheduled.scheduledAt.getTime()) / 1000))
      : null;

    const warnings: string[] = [];
    if (expiredLeaseTasks > 0) {
      warnings.push(`存在 ${expiredLeaseTasks} 个已过期但尚未恢复的任务租约`);
    }
    if (dueScheduledTasks >= config.worker.backlogWarningThreshold) {
      warnings.push(`待派发到期任务积压 ${dueScheduledTasks} 个，超过阈值 ${config.worker.backlogWarningThreshold}`);
    }
    if (oldestDueScheduledAgeSeconds !== null && oldestDueScheduledAgeSeconds >= 300) {
      warnings.push(`存在已到期超过 ${oldestDueScheduledAgeSeconds} 秒尚未领取的任务`);
    }
    if (activeCount === 0 && (dueScheduledTasks > 0 || dueNotifications > 0 || expiredLeaseTasks > 0)) {
      warnings.push('当前存在待处理队列任务，但没有活跃的在线 Worker 心跳');
    }
    if (staleCount > 0) {
      warnings.push(`检测到 ${staleCount} 个 Worker 心跳已超时失效`);
    }

    const status: WorkerMonitorSnapshot['status'] = expiredLeaseTasks > 0
      || (activeCount === 0 && (dueScheduledTasks > 0 || dueNotifications > 0))
      ? 'degraded'
      : warnings.length > 0
        ? 'warning'
        : 'healthy';

    return {
      checkedAt: now.toISOString(),
      status,
      warnings,
      workers: {
        activeCount,
        staleCount,
        items: workerItems,
      },
      backlog: {
        dueScheduledTasks,
        dispatchingTasks,
        expiredLeaseTasks,
        overdueHandoffTasks,
        dueNotifications,
        dueTopicSources,
        oldestDueScheduledAgeSeconds,
      },
    };
  }
}
