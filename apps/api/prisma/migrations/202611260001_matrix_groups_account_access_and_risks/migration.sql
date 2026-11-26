BEGIN;

CREATE TYPE "AccountAccessMethod" AS ENUM ('manual_uid', 'qr_login', 'password', 'cookie', 'oauth', 'sandbox');
CREATE TYPE "AccountRiskStatus" AS ENUM ('normal', 'warning', 'risk');

CREATE TABLE "MatrixGroup" (
  "id"          text PRIMARY KEY,
  "workspaceId" text NOT NULL REFERENCES "Workspace"("id") ON DELETE RESTRICT,
  "name"        text NOT NULL,
  "color"       text NOT NULL DEFAULT 'blue',
  "description" text NOT NULL DEFAULT '',
  "sortOrder"   integer NOT NULL DEFAULT 0,
  "createdAt"   timestamptz(3) NOT NULL DEFAULT now(),
  "updatedAt"   timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT "MatrixGroup_name_check" CHECK (length(btrim("name")) > 0),
  CONSTRAINT "MatrixGroup_color_check" CHECK ("color" IN ('blue', 'rose', 'emerald', 'amber', 'violet', 'cyan', 'slate')),
  CONSTRAINT "MatrixGroup_workspace_name_key" UNIQUE ("workspaceId", "name"),
  CONSTRAINT "MatrixGroup_workspace_id_key" UNIQUE ("workspaceId", "id")
);

CREATE INDEX "MatrixGroup_workspace_order_idx"
  ON "MatrixGroup"("workspaceId", "sortOrder", "createdAt");

ALTER TABLE "ChannelAccount"
  ADD COLUMN "accessMethod"       "AccountAccessMethod" NOT NULL DEFAULT 'manual_uid',
  ADD COLUMN "groupId"            text,
  ADD COLUMN "alias"              text,
  ADD COLUMN "tags"               text[] NOT NULL DEFAULT '{}',
  ADD COLUMN "pinned"             boolean NOT NULL DEFAULT false,
  ADD COLUMN "loginIdentifier"    text,
  ADD COLUMN "passwordCiphertext" text,
  ADD COLUMN "passwordKeyId"      text,
  ADD COLUMN "cookieCiphertext"   text,
  ADD COLUMN "cookieKeyId"        text,
  ADD COLUMN "cookieUpdatedAt"    timestamptz(3),
  ADD COLUMN "riskStatus"         "AccountRiskStatus" NOT NULL DEFAULT 'normal',
  ADD COLUMN "riskReason"         text,
  ADD COLUMN "riskDetectedAt"     timestamptz(3),
  ADD CONSTRAINT "ChannelAccount_workspace_id_key" UNIQUE ("workspaceId", "id"),
  ADD CONSTRAINT "ChannelAccount_group_fkey"
    FOREIGN KEY ("workspaceId", "groupId") REFERENCES "MatrixGroup"("workspaceId", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "ChannelAccount_password_pair_check"
    CHECK (("passwordCiphertext" IS NULL) = ("passwordKeyId" IS NULL)),
  ADD CONSTRAINT "ChannelAccount_cookie_pair_check"
    CHECK (("cookieCiphertext" IS NULL) = ("cookieKeyId" IS NULL));

UPDATE "ChannelAccount"
SET "accessMethod" = CASE
  WHEN "channelKind" = 'sandbox' THEN 'sandbox'::"AccountAccessMethod"
  WHEN "channelKind" = 'official' THEN 'oauth'::"AccountAccessMethod"
  ELSE 'manual_uid'::"AccountAccessMethod"
END;

CREATE INDEX "ChannelAccount_group_idx" ON "ChannelAccount"("workspaceId", "groupId");
CREATE INDEX "ChannelAccount_risk_idx" ON "ChannelAccount"("workspaceId", "riskStatus");

CREATE TABLE "AccountRiskEvent" (
  "id"           text PRIMARY KEY,
  "workspaceId"  text NOT NULL REFERENCES "Workspace"("id") ON DELETE RESTRICT,
  "accountId"    text NOT NULL,
  "level"        "AccountRiskStatus" NOT NULL,
  "kind"         text NOT NULL,
  "message"      text NOT NULL,
  "feishuStatus" text NOT NULL DEFAULT 'skipped',
  "feishuError"  text,
  "actorId"      text REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "resolvedAt"   timestamptz(3),
  "resolvedById" text REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "createdAt"    timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT "AccountRiskEvent_account_fkey"
    FOREIGN KEY ("workspaceId", "accountId") REFERENCES "ChannelAccount"("workspaceId", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "AccountRiskEvent_feishu_status_check"
    CHECK ("feishuStatus" IN ('sent', 'failed', 'skipped')),
  CONSTRAINT "AccountRiskEvent_text_check"
    CHECK (length(btrim("kind")) > 0 AND length(btrim("message")) > 0)
);

CREATE INDEX "AccountRiskEvent_workspace_time_idx"
  ON "AccountRiskEvent"("workspaceId", "createdAt" DESC, "id" DESC);
CREATE INDEX "AccountRiskEvent_account_time_idx"
  ON "AccountRiskEvent"("workspaceId", "accountId", "createdAt" DESC, "id" DESC);

ALTER TABLE "NotificationSetting"
  ADD COLUMN "riskAlertEnabled" boolean NOT NULL DEFAULT true;

COMMIT;
