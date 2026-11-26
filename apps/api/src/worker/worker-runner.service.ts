import { setTimeout as delay } from 'node:timers/promises';
import { Injectable, Logger } from '@nestjs/common';
import { AccountRiskService } from '../accounts/account-risk.service';
import { config } from '../config';
import { TopicCollector } from '../content/topic-collector.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TaskMetricsService } from '../tasks/application/task-metrics.service';
import { TaskDispatchService } from '../tasks/dispatch/task-dispatch.service';
import { TaskReceiptService } from '../tasks/dispatch/task-receipt.service';
import { WorkerHeartbeatService } from './worker-heartbeat.service';
import { WorkerMonitorService } from './worker-monitor.service';

@Injectable()
export class WorkerRunnerService {
  private readonly logger = new Logger(WorkerRunnerService.name);

  constructor(
    private readonly dispatch: TaskDispatchService,
    private readonly receipts: TaskReceiptService,
    private readonly metrics: TaskMetricsService,
    private readonly notifications: NotificationsService,
    private readonly topics: TopicCollector,
    private readonly accountRisks: AccountRiskService,
    private readonly heartbeats: WorkerHeartbeatService,
    private readonly monitor: WorkerMonitorService,
  ) {}

  private async loop(
    signal: AbortSignal,
    name: string,
    run: () => Promise<unknown>,
    failure: string,
    interval: number,
  ) {
    while (!signal.aborted) {
      const startedAt = new Date();
      try {
        await run();
        this.heartbeats.recordLoopResult(name, { startedAt, completedAt: new Date(), ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.heartbeats.recordLoopResult(name, { startedAt, completedAt: new Date(), ok: false, error: message });
        this.logger.error(failure, error instanceof Error ? error.stack : message);
      }
      await delay(interval, undefined, { signal }).catch((error: unknown) => {
        if (!signal.aborted) throw error;
      });
    }
  }

  async checkBacklog() {
    const snapshot = await this.monitor.getSnapshot();
    if (snapshot.warnings.length > 0) {
      this.logger.warn(`队列积压/健康预警 (${snapshot.status}): ${snapshot.warnings.join('；')}`);
    }
    return snapshot;
  }

  async run(signal: AbortSignal) {
    await this.heartbeats.beat('running').catch((error: unknown) => {
      this.logger.warn(`初始心跳写入失败: ${error instanceof Error ? error.message : String(error)}`);
    });

    const onAbort = () => {
      void this.heartbeats.beat('draining').catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      await Promise.all([
        this.loop(
          signal,
          'dispatch',
          () => this.dispatch.dispatchDue({ onActiveChange: this.heartbeats.trackActive }),
          '任务派发轮询失败，下轮重试',
          5_000,
        ),
        this.loop(
          signal,
          'receipts',
          () => this.receipts.pollAutomaticResults(),
          '平台回执轮询失败，下轮重试',
          5_000,
        ),
        this.loop(
          signal,
          'metrics',
          () => this.metrics.syncDueArticleMetrics(),
          '作品成效同步轮询失败，下轮重试',
          60_000,
        ),
        this.loop(
          signal,
          'notifications',
          () => this.notifications.deliverDue(signal),
          '飞书投递轮询失败，下轮重试',
          5_000,
        ),
        this.loop(
          signal,
          'topics',
          () => this.topics.runDue(signal),
          '选题采集轮询失败，下轮重试',
          15_000,
        ),
        this.loop(
          signal,
          'accountRisks',
          () => this.accountRisks.scanDueAccountHealth(),
          '账号健康体检轮询失败，下轮重试',
          600_000,
        ),
        this.loop(
          signal,
          'heartbeat',
          () => this.heartbeats.beat(signal.aborted ? 'draining' : 'running'),
          'Worker 心跳上报失败，下轮重试',
          config.worker.heartbeatIntervalMs,
        ),
        this.loop(
          signal,
          'monitor',
          () => this.checkBacklog(),
          'Worker 积压监控巡检失败，下轮重试',
          config.worker.monitorIntervalMs,
        ),
      ]);
    } finally {
      signal.removeEventListener('abort', onAbort);
      await this.heartbeats.beat('stopped', 0).catch(() => undefined);
    }
  }
}
