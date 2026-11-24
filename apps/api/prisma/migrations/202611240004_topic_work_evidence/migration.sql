ALTER TABLE "TopicWork" ADD COLUMN "coverUrl" TEXT,
    ADD COLUMN "views" BIGINT CHECK ("views" BETWEEN 0 AND 9007199254740991),
    ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'legacy';

CREATE UNIQUE INDEX "TopicSource_workspaceId_id_key" ON "TopicSource"("workspaceId", "id");
CREATE UNIQUE INDEX "TopicWork_workspaceId_id_key" ON "TopicWork"("workspaceId", "id");

CREATE TABLE "TopicMatch" (
    "workspaceId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "workId" TEXT NOT NULL,
    "field" TEXT NOT NULL CHECK ("field" IN ('source', 'title', 'summary')),
    "excerpt" TEXT,
    "seenAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "TopicMatch_pkey" PRIMARY KEY ("workspaceId", "sourceId", "workId"),
    CONSTRAINT "TopicMatch_workspaceId_sourceId_fkey" FOREIGN KEY ("workspaceId", "sourceId")
        REFERENCES "TopicSource"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TopicMatch_workspaceId_workId_fkey" FOREIGN KEY ("workspaceId", "workId")
        REFERENCES "TopicWork"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "TopicMatch_workspaceId_workId_seenAt_idx" ON "TopicMatch"("workspaceId", "workId", "seenAt" DESC);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'matrixark_app') THEN
        GRANT SELECT, INSERT, UPDATE ON TABLE "TopicMatch" TO matrixark_app;
    END IF;
END
$$;
