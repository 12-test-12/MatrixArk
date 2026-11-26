import { createHash } from 'node:crypto';
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
      /** 只有 Worker 自身的服务端日志视图带主机名；工作室接口按进程哈希脱敏 */
      hostname?: string;
      pid?: number;
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

/** 把 `主机名:pid:随机串` 换成稳定但不可反推的节点标识。 */
function publicWorkerId(workerId: string) {
  return `worker-${createHash('sha256').update(workerId).digest('hex').slice(0, 8)}`;
}

/** 保留耗时与失败次数，去掉每条轮询记录里的错误原文。 */
function publicLoopStates(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, raw]) => {
    const state = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    return [name, {
      lastStartedAt: typeof state.lastStartedAt === 'string' ? state.lastStartedAt : null,
      lastCompletedAt: typeof state.lastCompletedAt === 'string' ? state.lastCompletedAt : null,
      lastDurationMs: typeof state.lastDurationMs === 'number' ? state.lastDurationMs : null,
      consecutiveFailures: typeof state.consecutiveFailures === 'number' ? state.consecutiveFailures : 0,
    }];
  }));
}

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

    // 工作室视图只给节点状态、并发和轮询耗时：主机名、PID 和错误原文留在服务端日志里，
    // 不传给任何工作室成员。未传 workspaceId 的调用方是 Worker 自身的积压日志。
    const tenantView = Boolean(workspaceId);
    const workerItems = workers.map((item) => {
      const stale = item.status !== 'stopped' && item.expiresAt <= now;
      return {
        workerId: tenantView ? publicWorkerId(item.workerId) : item.workerId,
        ...(tenantView ? {} : { hostname: item.hostname, pid: item.pid }),
        status: item.status,
        stale,
        maxConcurrency: item.maxConcurrency,
        activeTasks: item.activeTasks,
        lastHeartbeatAt: item.lastHeartbeatAt.toISOString(),
        expiresAt: item.expiresAt.toISOString(),
        lastError: tenantView ? null : item.lastError,
        loopStates: tenantView ? publicLoopStates(item.loopStates) : item.loopStates,
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
