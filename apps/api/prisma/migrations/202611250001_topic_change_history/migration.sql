CREATE TABLE "TopicChange" (
    "id" TEXT PRIMARY KEY,
    "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "entityType" TEXT NOT NULL CHECK ("entityType" IN ('work', 'source')),
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT,
    "actorEmail" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "TopicChange_entity_time_idx" ON "TopicChange"("workspaceId", "entityType", "entityId", "createdAt" DESC, "id" DESC);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'matrixark_app') THEN
        GRANT SELECT, INSERT ON TABLE "TopicChange" TO matrixark_app;
    END IF;
END
$$;
