ALTER TYPE "TaskEventKind" ADD VALUE IF NOT EXISTS 'circuit_break';

ALTER TABLE "ChannelAccount"
  ADD COLUMN "readAccountId" TEXT,
  ADD COLUMN "readCookieCiphertext" TEXT,
  ADD COLUMN "readCookieKeyId" TEXT,
  ADD COLUMN "readCookieLabel" TEXT,
  ADD COLUMN "readCookieUpdatedAt" TIMESTAMPTZ(3),
  ADD COLUMN "egressIp" TEXT,
  ADD COLUMN "profileLabel" TEXT,
  ADD COLUMN "cookieExpiresAt" TIMESTAMPTZ(3),
  ADD COLUMN "envCheckedAt" TIMESTAMPTZ(3);

ALTER TABLE "ChannelAccount"
  ADD CONSTRAINT "ChannelAccount_workspaceId_readAccountId_fkey"
  FOREIGN KEY ("workspaceId", "readAccountId") REFERENCES "ChannelAccount"("workspaceId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE INDEX "ChannelAccount_workspaceId_platform_egressIp_idx"
  ON "ChannelAccount"("workspaceId", "platform", "egressIp");
