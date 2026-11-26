import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Injectable } from '@nestjs/common';
import type { Prisma, WorkerStatus } from '@prisma/client';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { databaseTime } from '../tasks/infrastructure/task-locks';

export type LoopState = {
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
  lastError: string | null;
};

@Injectable()
export class WorkerHeartbeatService {
  readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly host = hostname();
  private activeTasks = 0;
  private lastError: string | null = null;
  private readonly loops: Record<string, LoopState> = {};

  constructor(private readonly prisma: PrismaService) {}

  trackActive = (delta: number) => {
    this.activeTasks = Math.max(0, this.activeTasks + delta);
  };

  getActiveCount() {
    return this.activeTasks;
  }

  recordLoopResult(name: string, result: { startedAt: Date; completedAt: Date; ok: boolean; error?: string | null }) {
    const prev = this.loops[name];
    const errorMessage = result.ok ? null : (result.error ?? '未知错误').slice(0, 300);
    if (errorMessage) this.lastError = errorMessage;
    this.loops[name] = {
      lastStartedAt: result.startedAt.toISOString(),
      lastCompletedAt: result.completedAt.toISOString(),
      lastDurationMs: Math.max(0, result.completedAt.getTime() - result.startedAt.getTime()),
      consecutiveFailures: result.ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1,
      lastError: errorMessage,
    };
  }

  async beat(status: WorkerStatus = 'running', ttlMs = config.worker.heartbeatTtlMs) {
    const now = await databaseTime(this.prisma);
    const expiresAt = new Date(now.getTime() + ttlMs);
    const loopStates = this.loops as unknown as Prisma.InputJsonObject;
    return this.prisma.workerHeartbeat.upsert({
      where: { workerId: this.workerId },
      create: {
        workerId: this.workerId,
        hostname: this.host,
        pid: process.pid,
        status,
        maxConcurrency: config.worker.dispatchConcurrency,
        activeTasks: this.activeTasks,
        loopStates,
        lastError: this.lastError,
        startedAt: now,
        lastHeartbeatAt: now,
        expiresAt,
      },
      update: {
        status,
        maxConcurrency: config.worker.dispatchConcurrency,
        activeTasks: this.activeTasks,
        loopStates,
        lastError: this.lastError,
        lastHeartbeatAt: now,
        expiresAt,
      },
    });
  }
}
