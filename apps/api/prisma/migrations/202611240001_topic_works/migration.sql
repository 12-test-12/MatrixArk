ALTER TABLE "Manuscript" ADD COLUMN "referenceUrl" TEXT;

CREATE TABLE "TopicWork" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "creatorId" TEXT,
    "creator" TEXT,
    "description" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "publishedOn" DATE,
    "likes" INTEGER,
    "comments" INTEGER,
    "importedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "savedAt" TIMESTAMPTZ(3),
    "note" TEXT,
    CONSTRAINT "TopicWork_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TopicWork_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TopicWork_metrics_check" CHECK (("likes" IS NULL OR "likes" >= 0) AND ("comments" IS NULL OR "comments" >= 0))
);

CREATE UNIQUE INDEX "TopicWork_workspaceId_platform_externalId_key" ON "TopicWork"("workspaceId", "platform", "externalId");
CREATE INDEX "TopicWork_workspaceId_importedAt_id_idx" ON "TopicWork"("workspaceId", "importedAt" DESC, "id" DESC);
CREATE INDEX "TopicWork_workspaceId_savedAt_id_idx" ON "TopicWork"("workspaceId", "savedAt" DESC, "id" DESC);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'matrixark_app') THEN
        GRANT SELECT, INSERT, UPDATE ON TABLE "TopicWork" TO matrixark_app;
    END IF;
END
$$;
