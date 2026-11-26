ALTER TABLE "Workspace" ADD COLUMN "trialOwnerId" TEXT;
CREATE UNIQUE INDEX "Workspace_trialOwnerId_key" ON "Workspace"("trialOwnerId");
