import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { config } from './config';
import { WorkerModule } from './worker/worker.module';
import { WorkerRunnerService } from './worker/worker-runner.service';

const logger = new Logger('PublishWorker');

async function main() {
  const stopped = new AbortController();
  process.once('SIGINT', () => stopped.abort());
  process.once('SIGTERM', () => stopped.abort());
  const app = await NestFactory.createApplicationContext(WorkerModule, { abortOnError: false });
  const runner = app.get(WorkerRunnerService);
  logger.log(`发布任务 Worker 已启动（并发上限=${config.worker.dispatchConcurrency}，租约续期=${config.worker.leaseRenewIntervalMs}ms）`);
  try {
    await runner.run(stopped.signal);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  logger.error('发布任务 Worker 启动失败', error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
