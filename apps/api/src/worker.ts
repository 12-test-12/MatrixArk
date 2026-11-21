import 'reflect-metadata';
import { setTimeout as delay } from 'node:timers/promises';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TasksModule } from './tasks/tasks.module';
import { TasksService } from './tasks/tasks.service';

const logger = new Logger('PublishWorker');

async function main() {
  const stopped = new AbortController();
  process.once('SIGINT', () => stopped.abort());
  process.once('SIGTERM', () => stopped.abort());
  const app = await NestFactory.createApplicationContext(TasksModule, { abortOnError: false });
  const tasks = app.get(TasksService);
  logger.log('小红书人工交接 Worker 已启动');
  try {
    while (!stopped.signal.aborted) {
      try {
        await tasks.dispatchDue();
      } catch (error) {
        logger.error('交接轮询失败，下轮重试', error instanceof Error ? error.stack : String(error));
      }
      try {
        await tasks.pollAutomaticResults();
      } catch (error) {
        logger.error('平台回执轮询失败，下轮重试', error instanceof Error ? error.stack : String(error));
      }
      await delay(5_000, undefined, { signal: stopped.signal }).catch((error: unknown) => {
        if (!stopped.signal.aborted) throw error;
      });
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  logger.error('人工交接 Worker 启动失败', error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
