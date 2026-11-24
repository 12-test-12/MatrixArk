import 'reflect-metadata';
import { setTimeout as delay } from 'node:timers/promises';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TopicCollector } from './content/topic-collector.service';
import { NotificationsService } from './notifications/notifications.service';
import { TasksModule } from './tasks/tasks.module';
import { TasksService } from './tasks/tasks.service';

const logger = new Logger('PublishWorker');

async function poll(signal: AbortSignal, run: () => Promise<unknown>, failure: string, interval = 5_000) {
  while (!signal.aborted) {
    try {
      await run();
    } catch (error) {
      logger.error(failure, error instanceof Error ? error.stack : String(error));
    }
    await delay(interval, undefined, { signal }).catch((error: unknown) => {
      if (!signal.aborted) throw error;
    });
  }
}

async function main() {
  const stopped = new AbortController();
  process.once('SIGINT', () => stopped.abort());
  process.once('SIGTERM', () => stopped.abort());
  const app = await NestFactory.createApplicationContext(TasksModule, { abortOnError: false });
  const tasks = app.get(TasksService);
  const notifications = app.get(NotificationsService);
  const topics = app.get(TopicCollector);
  logger.log('发布任务 Worker 已启动');
  try {
    await Promise.all([
      poll(stopped.signal, () => tasks.dispatchDue(), '任务派发轮询失败，下轮重试'),
      poll(stopped.signal, () => tasks.pollAutomaticResults(), '平台回执轮询失败，下轮重试'),
      poll(stopped.signal, () => notifications.deliverDue(stopped.signal), '飞书投递轮询失败，下轮重试'),
      poll(stopped.signal, () => topics.runDue(stopped.signal), '选题采集轮询失败，下轮重试', 15_000),
    ]);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  logger.error('发布任务 Worker 启动失败', error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
