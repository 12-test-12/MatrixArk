CREATE TABLE "TopicAiSetting" (
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL CHECK ("provider" IN ('deepseek', 'openai')),
    "keyCiphertext" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "TopicAiSetting_pkey" PRIMARY KEY ("workspaceId"),
    CONSTRAINT "TopicAiSetting_workspaceId_fkey" FOREIGN KEY ("workspaceId")
        REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'matrixark_app') THEN
        GRANT SELECT, INSERT, UPDATE ON TABLE "TopicAiSetting" TO matrixark_app;
    END IF;
END
$$;
