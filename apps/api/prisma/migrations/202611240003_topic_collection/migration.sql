CREATE TABLE "TopicSource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "keyword" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
    "nextRunAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMPTZ(3),
    "lastAttemptAt" TIMESTAMPTZ(3),
    "lastSuccessAt" TIMESTAMPTZ(3),
    "lastCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    CONSTRAINT "TopicSource_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TopicSource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TopicSource_workspaceId_provider_target_keyword_key" ON "TopicSource"("workspaceId", "provider", "target", "keyword");
CREATE INDEX "TopicSource_enabled_nextRunAt_idx" ON "TopicSource"("enabled", "nextRunAt");

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'matrixark_app') THEN
        GRANT SELECT, INSERT, UPDATE ON TABLE "TopicSource" TO matrixark_app;
    END IF;
END
$$;
