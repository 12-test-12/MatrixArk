CREATE TYPE "WorkerStatus" AS ENUM ('running', 'draining', 'stopped');

CREATE TABLE "WorkerHeartbeat" (
  "workerId" TEXT NOT NULL,
  "hostname" TEXT NOT NULL,
  "pid" INTEGER NOT NULL,
  "status" "WorkerStatus" NOT NULL DEFAULT 'running',
  "maxConcurrency" INTEGER NOT NULL DEFAULT 4,
  "activeTasks" INTEGER NOT NULL DEFAULT 0,
  "loopStates" JSONB NOT NULL DEFAULT '{}',
  "lastError" TEXT,
  "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastHeartbeatAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("workerId")
);

CREATE INDEX "WorkerHeartbeat_status_expiresAt_idx"
  ON "WorkerHeartbeat"("status", "expiresAt");
