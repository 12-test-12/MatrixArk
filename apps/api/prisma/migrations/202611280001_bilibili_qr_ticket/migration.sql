-- CreateTable
CREATE TABLE "BilibiliQrTicket" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "groupId" TEXT,
    "verificationUrl" TEXT NOT NULL,
    "qrcodeKeyCiphertext" TEXT,
    "qrcodeKeyKeyId" TEXT,
    "tempCookieCiphertext" TEXT,
    "tempCookieKeyId" TEXT,
    "tempMid" TEXT,
    "tempUname" TEXT,
    "state" TEXT NOT NULL DEFAULT 'WAITING_SCAN',
    "lastBiliCode" INTEGER,
    "lastError" TEXT,
    "accountId" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "nextPollAt" TIMESTAMPTZ(3) NOT NULL,
    "lockedUntil" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BilibiliQrTicket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BilibiliQrTicket_workspaceId_userId_createdAt_idx" ON "BilibiliQrTicket"("workspaceId", "userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "BilibiliQrTicket_expiresAt_idx" ON "BilibiliQrTicket"("expiresAt");

-- AddForeignKey
ALTER TABLE "BilibiliQrTicket" ADD CONSTRAINT "BilibiliQrTicket_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BilibiliQrTicket" ADD CONSTRAINT "BilibiliQrTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
