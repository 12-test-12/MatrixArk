CREATE TABLE "TopicAiAnalysis" (
    "id" TEXT PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "workId" TEXT NOT NULL,
    "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "inputHash" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "analysis" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TopicAiAnalysis_workspaceId_workId_fkey"
        FOREIGN KEY ("workspaceId", "workId") REFERENCES "TopicWork"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TopicAiAnalysis_input_key" ON "TopicAiAnalysis"("workspaceId", "workId", "userId", "inputHash");
CREATE INDEX "TopicAiAnalysis_history_idx" ON "TopicAiAnalysis"("workspaceId", "workId", "userId", "createdAt" DESC, "id" DESC);
CREATE INDEX "TopicAiAnalysis_userId_idx" ON "TopicAiAnalysis"("userId");

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'matrixark_app') THEN
        GRANT SELECT, INSERT ON TABLE "TopicAiAnalysis" TO matrixark_app;
    END IF;
END
$$;
