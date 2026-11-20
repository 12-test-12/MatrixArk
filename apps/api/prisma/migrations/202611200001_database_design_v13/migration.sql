BEGIN;

-- DBX may have already executed the standalone enum examples. Verify their definitions before reuse.
DO $verify_enums$
DECLARE
  expected record;
  existing_type oid;
  existing_labels text[];
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('AssetKind', ARRAY['manuscript_image', 'task_evidence']::text[]),
    ('GenerationSource', ARRAY['import', 'rule', 'model', 'manual']::text[]),
    ('TaskEventKind', ARRAY['created', 'rescheduled', 'paused', 'claimed', 'handed_off', 'result', 'verified', 'canceled', 'retried', 'corrected', 'late_receipt', 'reminder', 'note']::text[]),
    ('NotificationKind', ARRAY['handoff_ready', 'overdue_reminder']::text[]),
    ('NotificationStatus', ARRAY['pending', 'sending', 'sent', 'failed', 'skipped']::text[]),
    ('PublishResultState', ARRAY['submitted', 'under_review', 'published', 'failed', 'unknown']::text[]),
    ('AuthStatus', ARRAY['pending', 'active', 'expired', 'revoked']::text[])
  ) AS types(name, labels)
  LOOP
    SELECT t.oid INTO existing_type
    FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = current_schema() AND t.typname = expected.name;

    IF existing_type IS NULL THEN
      EXECUTE format('CREATE TYPE %I.%I AS ENUM (%s)', current_schema(), expected.name,
        (SELECT string_agg(quote_literal(label), ', ' ORDER BY position)
         FROM unnest(expected.labels) WITH ORDINALITY AS values_in_order(label, position)));
    ELSE
      SELECT array_agg(enumlabel::text ORDER BY enumsortorder) INTO existing_labels
      FROM pg_catalog.pg_enum WHERE enumtypid = existing_type;
      IF existing_labels IS DISTINCT FROM expected.labels THEN
        RAISE EXCEPTION 'Incompatible enum %.%: expected %, found %',
          current_schema(), expected.name, expected.labels, existing_labels;
      END IF;
    END IF;
  END LOOP;
END;
$verify_enums$;

CREATE TABLE "NotificationSetting" (
  "workspaceId"          text PRIMARY KEY
                           REFERENCES "Workspace"("id") ON DELETE RESTRICT,
  "provider"             text NOT NULL DEFAULT 'feishu',
  "enabled"              boolean NOT NULL DEFAULT false,
  "webhookCiphertext"    text,
  "webhookKeyId"         text,
  "signSecretCiphertext" text,
  "signSecretKeyId"      text,
  "updatedById"          text REFERENCES "User"("id") ON DELETE RESTRICT,
  "updatedAt"            timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT "NotificationSetting_provider_check"
    CHECK ("provider" = 'feishu'),
  CONSTRAINT "NotificationSetting_webhook_check"
    CHECK (NOT "enabled" OR "webhookCiphertext" IS NOT NULL),
  CONSTRAINT "NotificationSetting_webhook_key_check"
    CHECK (("webhookCiphertext" IS NULL) = ("webhookKeyId" IS NULL)),
  CONSTRAINT "NotificationSetting_sign_key_check"
    CHECK (("signSecretCiphertext" IS NULL) = ("signSecretKeyId" IS NULL))
);

CREATE TABLE "OAuthState" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspaceId" text NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE,
  "accountId"   text NOT NULL REFERENCES "ChannelAccount"("id") ON DELETE CASCADE,
  "userId"      text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "platform"    "Platform" NOT NULL,
  "stateHash"   char(64) NOT NULL,
  "expiresAt"   timestamptz(3) NOT NULL,
  "consumedAt"  timestamptz(3),
  "createdAt"   timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT "OAuthState_hash_check" CHECK ("stateHash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "OAuthState_stateHash_key" ON "OAuthState"("stateHash");
CREATE INDEX "OAuthState_open_idx" ON "OAuthState"("expiresAt")
  WHERE "consumedAt" IS NULL;

CREATE TABLE "VariantAsset" (
  "variantId" text NOT NULL REFERENCES "Variant"("id") ON DELETE RESTRICT,
  "assetId"   text NOT NULL REFERENCES "Asset"("id") ON DELETE RESTRICT,
  "position"  integer NOT NULL,
  "isCover"   boolean NOT NULL DEFAULT false,
  CONSTRAINT "VariantAsset_pkey" PRIMARY KEY ("variantId", "assetId"),
  CONSTRAINT "VariantAsset_position_check" CHECK ("position" >= 0),
  CONSTRAINT "VariantAsset_unique_position" UNIQUE ("variantId", "position")
);

CREATE UNIQUE INDEX "VariantAsset_one_cover"
  ON "VariantAsset"("variantId") WHERE "isCover";
CREATE INDEX "VariantAsset_asset_idx" ON "VariantAsset"("assetId");

CREATE TABLE "VariantRejection" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspaceId" text NOT NULL REFERENCES "Workspace"("id") ON DELETE RESTRICT,
  "variantId"   text NOT NULL REFERENCES "Variant"("id") ON DELETE RESTRICT,
  "reviewerId"  text NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "reason"      text NOT NULL,
  "createdAt"   timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT "VariantRejection_reason_check"
    CHECK (length(btrim("reason")) > 0)
);

CREATE INDEX "VariantRejection_variant_idx"
  ON "VariantRejection"("variantId", "createdAt" DESC);

CREATE TABLE "TaskEvent" (
  "id"          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "workspaceId" text NOT NULL REFERENCES "Workspace"("id") ON DELETE RESTRICT,
  "taskId"      text NOT NULL REFERENCES "PublishTask"("id") ON DELETE RESTRICT,
  "kind"        "TaskEventKind" NOT NULL,
  "fromStatus"  "TaskStatus",
  "toStatus"    "TaskStatus",
  "actorId"     text REFERENCES "User"("id") ON DELETE RESTRICT,
  "reason"      text,
  "leaseId"     uuid,
  "details"     jsonb NOT NULL DEFAULT '{}'::jsonb,
  "createdAt"   timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT "TaskEvent_correction_details_check"
    CHECK ("kind" <> 'corrected'
           OR COALESCE(jsonb_typeof("details" -> 'previous') = 'object'
                   AND jsonb_typeof("details" -> 'next') = 'object'
                   AND jsonb_typeof("details" -> 'reason') = 'string'
                   AND btrim("details" ->> 'reason') <> '', false))
);

CREATE INDEX "TaskEvent_task_id_idx" ON "TaskEvent"("taskId", "id");
CREATE INDEX "TaskEvent_workspace_created_idx"
  ON "TaskEvent"("workspaceId", "createdAt" DESC);

CREATE TABLE "NotificationDelivery" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspaceId" text NOT NULL REFERENCES "Workspace"("id") ON DELETE RESTRICT,
  "taskId"      text NOT NULL REFERENCES "PublishTask"("id") ON DELETE RESTRICT,
  "kind"        "NotificationKind" NOT NULL,
  "dedupeKey"   text NOT NULL,
  "provider"    text NOT NULL DEFAULT 'feishu',
  "status"      "NotificationStatus" NOT NULL DEFAULT 'pending',
  "attempts"    integer NOT NULL DEFAULT 0,
  "scheduledAt" timestamptz(3) NOT NULL,
  "nextAttemptAt" timestamptz(3),
  "leaseId"     uuid,
  "leaseExpiresAt" timestamptz(3),
  "lastError"   text,
  "sentAt"      timestamptz(3),
  "createdAt"   timestamptz(3) NOT NULL DEFAULT now(),
  "updatedAt"   timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT "NotificationDelivery_unique"
    UNIQUE ("taskId", "kind", "dedupeKey"),
  CONSTRAINT "NotificationDelivery_attempts_check" CHECK ("attempts" BETWEEN 0 AND 4),
  CONSTRAINT "NotificationDelivery_next_attempt_check"
    CHECK (("status" = 'pending') = ("nextAttemptAt" IS NOT NULL)),
  CONSTRAINT "NotificationDelivery_lease_check"
    CHECK (("status" = 'sending') = ("leaseId" IS NOT NULL)
           AND ("leaseId" IS NULL) = ("leaseExpiresAt" IS NULL)),
  CONSTRAINT "NotificationDelivery_dedupe_check"
    CHECK (length(btrim("dedupeKey")) > 0),
  CONSTRAINT "NotificationDelivery_provider_check"
    CHECK ("provider" = 'feishu')
);

CREATE INDEX "NotificationDelivery_retry_idx"
  ON "NotificationDelivery"("nextAttemptAt", "id")
  WHERE "status" = 'pending';

ALTER TABLE "User"
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING ("createdAt" AT TIME ZONE 'UTC');
ALTER TABLE "Session"
  ALTER COLUMN "expiresAt" TYPE timestamptz(3) USING ("expiresAt" AT TIME ZONE 'UTC'),
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING ("createdAt" AT TIME ZONE 'UTC');
ALTER TABLE "Workspace"
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING ("createdAt" AT TIME ZONE 'UTC');
ALTER TABLE "Membership"
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING ("createdAt" AT TIME ZONE 'UTC');
ALTER TABLE "Manuscript"
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING ("createdAt" AT TIME ZONE 'UTC'),
  ALTER COLUMN "updatedAt" TYPE timestamptz(3) USING ("updatedAt" AT TIME ZONE 'UTC');
ALTER TABLE "Asset"
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING ("createdAt" AT TIME ZONE 'UTC');
ALTER TABLE "Variant"
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING ("createdAt" AT TIME ZONE 'UTC'),
  ALTER COLUMN "supersededAt" TYPE timestamptz(3) USING ("supersededAt" AT TIME ZONE 'UTC');
ALTER TABLE "Approval"
  ALTER COLUMN "approvedAt" TYPE timestamptz(3) USING ("approvedAt" AT TIME ZONE 'UTC');
ALTER TABLE "ChannelAccount"
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING ("createdAt" AT TIME ZONE 'UTC');
ALTER TABLE "PublishTask"
  ALTER COLUMN "scheduledAt" TYPE timestamptz(3) USING ("scheduledAt" AT TIME ZONE 'UTC'),
  ALTER COLUMN "handedOffAt" TYPE timestamptz(3) USING ("handedOffAt" AT TIME ZONE 'UTC'),
  ALTER COLUMN "claimedAt" TYPE timestamptz(3) USING ("claimedAt" AT TIME ZONE 'UTC'),
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING ("createdAt" AT TIME ZONE 'UTC'),
  ALTER COLUMN "updatedAt" TYPE timestamptz(3) USING ("updatedAt" AT TIME ZONE 'UTC');
ALTER TABLE "PublishResult"
  ALTER COLUMN "recordedAt" TYPE timestamptz(3) USING ("recordedAt" AT TIME ZONE 'UTC');

ALTER TABLE "Manuscript"
  ADD COLUMN "archivedAt"   timestamptz(3),
  ADD COLUMN "archivedById" text REFERENCES "User"("id") ON DELETE RESTRICT;

CREATE INDEX "Manuscript_active_idx"
  ON "Manuscript"("workspaceId", "createdAt" DESC)
  WHERE "archivedAt" IS NULL;

ALTER TABLE "Asset"
  ADD COLUMN "taskId"       text,
  ADD COLUMN "kind"         "AssetKind",
  ADD COLUMN "checksum"     char(64),
  ADD COLUMN "width"        integer,
  ADD COLUMN "height"       integer,
  ADD COLUMN "uploadedById" text REFERENCES "User"("id") ON DELETE RESTRICT;

-- 现有素材都是原稿图
UPDATE "Asset" SET "kind" = 'manuscript_image' WHERE "manuscriptId" IS NOT NULL;
ALTER TABLE "Asset" ALTER COLUMN "kind" SET NOT NULL;

-- 补上 workspace 外键
ALTER TABLE "Asset"
  ADD CONSTRAINT "Asset_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE RESTRICT NOT VALID;

ALTER TABLE "Asset"
  ADD CONSTRAINT "Asset_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "PublishTask"("id")
  ON DELETE RESTRICT NOT VALID;

-- 原稿删除改为 Restrict，原稿图不能被级联删掉
ALTER TABLE "Asset" DROP CONSTRAINT "Asset_manuscriptId_fkey";
ALTER TABLE "Asset"
  ADD CONSTRAINT "Asset_manuscriptId_fkey"
  FOREIGN KEY ("manuscriptId") REFERENCES "Manuscript"("id")
  ON DELETE RESTRICT;

ALTER TABLE "Asset"
  ADD CONSTRAINT "Asset_owner_check"
    CHECK (num_nonnulls("manuscriptId", "taskId") = 1),
  ADD CONSTRAINT "Asset_kind_owner_check"
    CHECK (("kind" = 'manuscript_image' AND "manuscriptId" IS NOT NULL)
        OR ("kind" = 'task_evidence'    AND "taskId" IS NOT NULL)),
  ADD CONSTRAINT "Asset_checksum_check"
    CHECK ("checksum" IS NULL OR "checksum" ~ '^[0-9a-f]{64}$');

ALTER TABLE "Asset"
  ADD CONSTRAINT "Asset_mime_check"
    CHECK ("mimeType" IN ('image/jpeg', 'image/png', 'image/webp')) NOT VALID,
  ADD CONSTRAINT "Asset_size_check"
    CHECK ("size" > 0 AND "size" <= 20971520) NOT VALID;

CREATE UNIQUE INDEX "Asset_storageKey_key" ON "Asset"("storageKey");
CREATE INDEX "Asset_task_idx" ON "Asset"("taskId");
CREATE INDEX "Asset_workspace_idx" ON "Asset"("workspaceId", "createdAt" DESC);

ALTER TABLE "Asset" VALIDATE CONSTRAINT "Asset_workspaceId_fkey";
ALTER TABLE "Asset" VALIDATE CONSTRAINT "Asset_taskId_fkey";

ALTER TABLE "Variant"
  ADD COLUMN "platformFields"   jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "generationSource" "GenerationSource" NOT NULL DEFAULT 'rule',
  ADD COLUMN "modelName"        text,
  ADD COLUMN "promptVersion"    text,
  ADD COLUMN "snapshotVersion"  integer NOT NULL DEFAULT 0,
  ADD COLUMN "sealedAt"         timestamptz(3);

ALTER TABLE "Variant"
  ADD CONSTRAINT "Variant_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "Variant_snapshot_version_check" CHECK ("snapshotVersion" >= 0),
  ADD CONSTRAINT "Variant_approved_sealed_check"
    CHECK ("snapshotVersion" <> 1 OR "status" <> 'approved' OR "sealedAt" IS NOT NULL),
  ADD CONSTRAINT "Variant_hash_check"
    CHECK ("contentHash" ~ '^[0-9a-f]{64}$');

CREATE INDEX "Variant_current_idx"
  ON "Variant"("workspaceId", "manuscriptId", "platform", "version" DESC);

-- 原稿删除改为 Restrict，版本不能被级联删掉
ALTER TABLE "Variant" DROP CONSTRAINT "Variant_manuscriptId_fkey";
ALTER TABLE "Variant"
  ADD CONSTRAINT "Variant_manuscriptId_fkey"
  FOREIGN KEY ("manuscriptId") REFERENCES "Manuscript"("id")
  ON DELETE RESTRICT;

ALTER TABLE "Approval"
  ADD COLUMN "snapshotHash" char(64);

ALTER TABLE "Approval"
  ADD CONSTRAINT "Approval_snapshot_hash_check"
    CHECK ("snapshotHash" IS NULL OR "snapshotHash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "Approval" DROP CONSTRAINT "Approval_variantId_fkey";
ALTER TABLE "Approval"
  ADD CONSTRAINT "Approval_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "Variant"("id")
  ON DELETE RESTRICT;

ALTER TABLE "ChannelAccount"
  ADD COLUMN "authStatus"           "AuthStatus" NOT NULL DEFAULT 'pending',
  ADD COLUMN "authScope"            text[] NOT NULL DEFAULT '{}',
  ADD COLUMN "authAuthorizedBy"     text,
  ADD COLUMN "authExpiresAt"        timestamptz(3),
  ADD COLUMN "authCheckedAt"        timestamptz(3),
  ADD COLUMN "rateLimitedUntil"     timestamptz(3),
  ADD COLUMN "lastError"            text,
  ADD COLUMN "archivedAt"           timestamptz(3),
  ADD COLUMN "archivedById"         text REFERENCES "User"("id") ON DELETE RESTRICT,
  ADD COLUMN "credentialsCiphertext" text,
  ADD COLUMN "credentialsKeyId"     text,
  ADD COLUMN "credentialsUpdatedAt" timestamptz(3);

-- 人工账号没有令牌有效期，默认可用；官方账号等重新授权
UPDATE "ChannelAccount"
SET "authStatus" = 'active', "authCheckedAt" = now()
WHERE "channelKind" = 'manual';

ALTER TABLE "ChannelAccount"
  ADD CONSTRAINT "ChannelAccount_credentials_check"
    CHECK (("credentialsCiphertext" IS NULL) = ("credentialsKeyId" IS NULL)),
  ADD CONSTRAINT "ChannelAccount_official_auth_check"
    CHECK ("channelKind" <> 'official'
           OR "authStatus" <> 'active'
           OR "authExpiresAt" IS NOT NULL);

-- 显示名只在“未归档”范围内唯一，归档后可以重新使用
CREATE UNIQUE INDEX "ChannelAccount_active_display_key"
  ON "ChannelAccount"("workspaceId", "platform", "displayName")
  WHERE "archivedAt" IS NULL;
ALTER TABLE "ChannelAccount"
  DROP CONSTRAINT IF EXISTS "ChannelAccount_workspaceId_platform_displayName_key";
DROP INDEX IF EXISTS "ChannelAccount_workspaceId_platform_displayName_key";

-- 平台侧账号 ID 在同一工作室同一平台内唯一
CREATE UNIQUE INDEX "ChannelAccount_external_key"
  ON "ChannelAccount"("workspaceId", "platform", "externalId")
  WHERE "externalId" IS NOT NULL AND "archivedAt" IS NULL;

CREATE INDEX "ChannelAccount_workspace_idx"
  ON "ChannelAccount"("workspaceId", "platform")
  WHERE "archivedAt" IS NULL;

ALTER TABLE "PublishTask"
  ADD COLUMN "variantContentHash" char(64),
  ADD COLUMN "executionChannel"   "ChannelKind",
  ADD COLUMN "leaseId"            uuid,
  ADD COLUMN "leaseExpiresAt"     timestamptz(3),
  ADD COLUMN "canceledAt"         timestamptz(3),
  ADD COLUMN "canceledById"       text REFERENCES "User"("id") ON DELETE RESTRICT,
  ADD COLUMN "cancelReason"       text;

-- 回填任务绑定的版本内容哈希
UPDATE "PublishTask" t
SET "variantContentHash" = v."contentHash"
FROM "Variant" v
WHERE v."id" = t."variantId";

ALTER TABLE "PublishTask" ALTER COLUMN "variantContentHash" SET NOT NULL;

-- 历史已取消任务补时间和原因（旧数据可能只把原因放在 note）
UPDATE "PublishTask"
SET "canceledAt" = "updatedAt"
WHERE "status" = 'canceled' AND "canceledAt" IS NULL;

UPDATE "PublishTask"
SET "cancelReason" = COALESCE(NULLIF(btrim("note"), ''), '历史取消，原因未记录')
WHERE "status" = 'canceled' AND "cancelReason" IS NULL;

ALTER TABLE "PublishTask"
  ADD CONSTRAINT "PublishTask_hash_check"
    CHECK ("variantContentHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "PublishTask_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "PublishTask_lease_check"
    CHECK (("status" = 'dispatching') = ("leaseId" IS NOT NULL)),
  ADD CONSTRAINT "PublishTask_lease_expiry_check"
    CHECK (("leaseId" IS NULL) = ("leaseExpiresAt" IS NULL)),
  ADD CONSTRAINT "PublishTask_cancel_check"
    CHECK (("status" = 'canceled') = ("canceledAt" IS NOT NULL)),
  ADD CONSTRAINT "PublishTask_cancel_reason_check"
    CHECK ("status" <> 'canceled' OR length(btrim(coalesce("cancelReason", ''))) > 0);

-- 任务到版本、账号改为 Restrict
ALTER TABLE "PublishTask" DROP CONSTRAINT "PublishTask_variantId_fkey";
ALTER TABLE "PublishTask"
  ADD CONSTRAINT "PublishTask_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE RESTRICT;

ALTER TABLE "PublishTask" DROP CONSTRAINT "PublishTask_accountId_fkey";
ALTER TABLE "PublishTask"
  ADD CONSTRAINT "PublishTask_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "ChannelAccount"("id") ON DELETE RESTRICT;

ALTER TABLE "PublishResult"
  ADD COLUMN "workspaceId"     text,
  ADD COLUMN "evidenceAssetId" text,
  ADD COLUMN "platformPublishedAt" timestamptz(3);

UPDATE "PublishResult" r
SET "workspaceId" = t."workspaceId"
FROM "PublishTask" t
WHERE t."id" = r."taskId";

ALTER TABLE "PublishResult" ALTER COLUMN "workspaceId" SET NOT NULL;

-- 在第 7 节切换窗口内，确认旧回执状态都能映射后执行
ALTER TABLE "PublishResult"
  ALTER COLUMN "state" TYPE "PublishResultState"
  USING "state"::text::"PublishResultState";

ALTER TABLE "PublishResult"
  ADD CONSTRAINT "PublishResult_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "PublishResult_evidence_fkey"
  FOREIGN KEY ("evidenceAssetId") REFERENCES "Asset"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "PublishResult_platform_published_check"
    CHECK ("platformPublishedAt" IS NULL
           OR ("state" = 'published' AND NULLIF(btrim("remoteId"), '') IS NOT NULL));

ALTER TABLE "PublishResult" DROP CONSTRAINT "PublishResult_taskId_fkey";
ALTER TABLE "PublishResult"
  ADD CONSTRAINT "PublishResult_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "PublishTask"("id") ON DELETE RESTRICT;

CREATE INDEX "PublishResult_workspace_idx"
  ON "PublishResult"("workspaceId", "recordedAt" DESC);

ALTER TABLE "PublishResult"
  ADD CONSTRAINT "PublishResult_published_evidence_check"
  CHECK ("state" <> 'published'
         OR NULLIF(btrim("remoteUrl"), '') IS NOT NULL
         OR "evidenceAssetId" IS NOT NULL
         OR ("platformPublishedAt" IS NOT NULL AND NULLIF(btrim("remoteId"), '') IS NOT NULL))
  NOT VALID;

ALTER TABLE "Membership"
  DROP CONSTRAINT "Membership_workspaceId_fkey",
  ADD CONSTRAINT "Membership_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Manuscript"
  DROP CONSTRAINT "Manuscript_workspaceId_fkey",
  ADD CONSTRAINT "Manuscript_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Variant"
  DROP CONSTRAINT "Variant_workspaceId_fkey",
  ADD CONSTRAINT "Variant_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChannelAccount"
  DROP CONSTRAINT "ChannelAccount_workspaceId_fkey",
  ADD CONSTRAINT "ChannelAccount_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PublishTask"
  DROP CONSTRAINT "PublishTask_workspaceId_fkey",
  ADD CONSTRAINT "PublishTask_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

REVOKE DELETE, TRUNCATE ON TABLE "Workspace" FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "TaskEvent" FROM PUBLIC;
DO $app_permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'matrixark_app') THEN
    REVOKE DELETE, TRUNCATE ON TABLE "Workspace" FROM matrixark_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "TaskEvent" FROM matrixark_app;
  END IF;
END;
$app_permissions$;

ALTER TABLE "Manuscript" ADD CONSTRAINT "Manuscript_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_approvedById_fkey"
  FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "PublishTask" ADD CONSTRAINT "PublishTask_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "PublishResult" ADD CONSTRAINT "PublishResult_recordedById_fkey"
  FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT NOT VALID;

-- Worker 扫到期任务：只扫 scheduled，按计划时间和 id 排序
CREATE INDEX "PublishTask_due_idx"
  ON "PublishTask"("scheduledAt", "id")
  WHERE "status" = 'scheduled';

-- 人工交接逾期扫描
CREATE INDEX "PublishTask_handoff_due_idx"
  ON "PublishTask"("handedOffAt")
  WHERE "status" = 'handed_off';

-- 工作台游标分页：创建时间降序，同一时间按 id 降序
CREATE INDEX "PublishTask_workspace_cursor_idx"
  ON "PublishTask"("workspaceId", "createdAt" DESC, "id" DESC);

-- 按状态筛选
CREATE INDEX "PublishTask_workspace_status_idx"
  ON "PublishTask"("workspaceId", "status", "createdAt" DESC, "id" DESC);

-- 账号页和归档检查
CREATE INDEX "PublishTask_account_status_idx"
  ON "PublishTask"("accountId", "status");

-- 同账号串行：同一时刻最多一条 dispatching
CREATE UNIQUE INDEX "PublishTask_one_dispatching_per_account"
  ON "PublishTask"("accountId")
  WHERE "status" = 'dispatching';

WITH ordered AS (
  SELECT
    v."id" AS variant_id,
    a."id" AS asset_id,
    row_number() OVER (
      PARTITION BY v."id" ORDER BY a."createdAt", a."id"
    ) AS rn
  FROM "Variant" v
  JOIN "Asset" a
    ON a."manuscriptId" = v."manuscriptId"
   AND a."kind" = 'manuscript_image'
  WHERE v."snapshotVersion" = 0
)
INSERT INTO "VariantAsset" ("variantId", "assetId", "position", "isCover")
SELECT variant_id, asset_id, rn - 1, rn = 1
FROM ordered
ON CONFLICT DO NOTHING;

UPDATE "Variant"
SET "snapshotVersion" = 2, "sealedAt" = clock_timestamp()
WHERE "snapshotVersion" = 0;

WITH paused AS (
  UPDATE "PublishTask" t
  SET "status" = 'paused', "lastError" = '迁移后缺少有效确认快照，需重新确认', "updatedAt" = clock_timestamp()
  WHERE t."status" = 'scheduled'
    AND NOT EXISTS (
      SELECT 1
      FROM "Approval" ap
      JOIN "Variant" v ON v."id" = ap."variantId"
      WHERE ap."variantId" = t."variantId"
        AND v."status" = 'approved'
        AND v."snapshotVersion" = 1
        AND v."sealedAt" IS NOT NULL
        AND ap."snapshotHash" = v."contentHash"
    )
  RETURNING t."workspaceId", t."id"
)
INSERT INTO "TaskEvent"
  ("workspaceId", "taskId", "kind", "fromStatus", "toStatus", "reason")
SELECT "workspaceId", "id", 'paused', 'scheduled', 'paused',
       '迁移后缺少有效确认快照，需重新确认'
FROM paused;

CREATE OR REPLACE FUNCTION "reject_task_event_mutation"()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'TaskEvent 只允许追加，禁止修改或删除' USING ERRCODE = 'MA002';
END $$;

CREATE TRIGGER "TaskEvent_append_only"
BEFORE UPDATE OR DELETE ON "TaskEvent"
FOR EACH ROW EXECUTE FUNCTION "reject_task_event_mutation"();

CREATE OR REPLACE FUNCTION "guard_variant_update"()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."workspaceId"    IS DISTINCT FROM OLD."workspaceId"
     OR NEW."manuscriptId"   IS DISTINCT FROM OLD."manuscriptId"
     OR NEW."platform"      IS DISTINCT FROM OLD."platform"
     OR NEW."version"       IS DISTINCT FROM OLD."version"
     OR NEW."title"         IS DISTINCT FROM OLD."title"
     OR NEW."body"          IS DISTINCT FROM OLD."body"
     OR NEW."tags"          IS DISTINCT FROM OLD."tags"
     OR NEW."platformFields" IS DISTINCT FROM OLD."platformFields"
     OR NEW."contentHash"   IS DISTINCT FROM OLD."contentHash"
     OR NEW."snapshotVersion" IS DISTINCT FROM OLD."snapshotVersion"
  THEN
    RAISE EXCEPTION '版本快照不可原地修改，请创建新版本' USING ERRCODE = 'MA002';
  END IF;

  IF OLD."sealedAt" IS NOT NULL AND NEW."sealedAt" IS DISTINCT FROM OLD."sealedAt" THEN
    RAISE EXCEPTION '版本封存后不可重新打开' USING ERRCODE = 'MA002';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'draft'    AND NEW."status" IN ('approved', 'superseded'))
    OR (OLD."status" = 'approved' AND NEW."status" = 'superseded')
  ) THEN
    RAISE EXCEPTION '非法版本状态迁移: % -> %', OLD."status", NEW."status" USING ERRCODE = 'MA002';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "Variant_immutable"
BEFORE UPDATE ON "Variant"
FOR EACH ROW EXECUTE FUNCTION "guard_variant_update"();

CREATE OR REPLACE FUNCTION "reject_variant_asset_mutation"()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'VariantAsset 是版本快照的一部分，禁止修改或删除' USING ERRCODE = 'MA002';
END $$;

CREATE TRIGGER "VariantAsset_immutable"
BEFORE UPDATE OR DELETE ON "VariantAsset"
FOR EACH ROW EXECUTE FUNCTION "reject_variant_asset_mutation"();

CREATE OR REPLACE FUNCTION "guard_variant_asset_scope"()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_workspace text;
  v_manuscript text;
  v_sealed_at timestamptz;
  a_workspace text;
  a_manuscript text;
BEGIN
  SELECT "workspaceId", "manuscriptId", "sealedAt"
  INTO v_workspace, v_manuscript, v_sealed_at
  FROM "Variant" WHERE "id" = NEW."variantId" FOR UPDATE;

  SELECT "workspaceId", "manuscriptId"
  INTO a_workspace, a_manuscript
  FROM "Asset" WHERE "id" = NEW."assetId";

  IF v_workspace IS NULL OR a_workspace IS DISTINCT FROM v_workspace THEN
    RAISE EXCEPTION '版本或素材不存在于当前工作室' USING ERRCODE = 'MA001';
  END IF;

  IF v_manuscript IS DISTINCT FROM a_manuscript THEN
    RAISE EXCEPTION '版本图片必须来自同一原稿' USING ERRCODE = 'MA003';
  END IF;

  IF v_sealed_at IS NOT NULL THEN
    RAISE EXCEPTION '版本封存后不可新增图片，请创建新版本' USING ERRCODE = 'MA002';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "VariantAsset_scope"
BEFORE INSERT ON "VariantAsset"
FOR EACH ROW EXECUTE FUNCTION "guard_variant_asset_scope"();

CREATE OR REPLACE FUNCTION "guard_asset_scope"()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_workspace text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
       OR NEW."manuscriptId" IS DISTINCT FROM OLD."manuscriptId"
       OR NEW."taskId" IS DISTINCT FROM OLD."taskId"
       OR NEW."kind" IS DISTINCT FROM OLD."kind"
       OR NEW."storageKey" IS DISTINCT FROM OLD."storageKey" THEN
      RAISE EXCEPTION '素材归属、用途与对象 key 不可改写' USING ERRCODE = 'MA002';
    END IF;
  END IF;

  IF NEW."manuscriptId" IS NOT NULL THEN
    SELECT "workspaceId" INTO owner_workspace
    FROM "Manuscript" WHERE "id" = NEW."manuscriptId";
  ELSE
    SELECT "workspaceId" INTO owner_workspace
    FROM "PublishTask" WHERE "id" = NEW."taskId";
  END IF;

  IF owner_workspace IS DISTINCT FROM NEW."workspaceId" THEN
    RAISE EXCEPTION '素材所属资源不存在于当前工作室' USING ERRCODE = 'MA001';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "Asset_scope"
BEFORE INSERT OR UPDATE ON "Asset"
FOR EACH ROW EXECUTE FUNCTION "guard_asset_scope"();

CREATE OR REPLACE FUNCTION "guard_task_scope"()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  variant_workspace text;
  variant_platform "Platform";
  account_workspace text;
  account_platform "Platform";
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."executionChannel" IS NOT NULL
       AND NEW."executionChannel" IS DISTINCT FROM OLD."executionChannel" THEN
      RAISE EXCEPTION '任务的实际执行通道已确定' USING ERRCODE = 'MA002';
    END IF;
  END IF;

  SELECT "workspaceId", "platform" INTO variant_workspace, variant_platform
  FROM "Variant" WHERE "id" = NEW."variantId";

  SELECT "workspaceId", "platform" INTO account_workspace, account_platform
  FROM "ChannelAccount" WHERE "id" = NEW."accountId";

  IF variant_workspace IS DISTINCT FROM NEW."workspaceId"
     OR account_workspace IS DISTINCT FROM NEW."workspaceId" THEN
    RAISE EXCEPTION '版本或账号不存在于任务所属工作室' USING ERRCODE = 'MA001';
  END IF;

  IF variant_platform IS DISTINCT FROM account_platform THEN
    RAISE EXCEPTION '任务的版本与账号平台不一致' USING ERRCODE = 'MA003';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "PublishTask_scope"
BEFORE INSERT OR UPDATE ON "PublishTask"
FOR EACH ROW EXECUTE FUNCTION "guard_task_scope"();

CREATE OR REPLACE FUNCTION "guard_child_workspace"()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_workspace text;
  execution_channel "ChannelKind";
  evidence_workspace text;
  evidence_task text;
  evidence_kind "AssetKind";
BEGIN
  IF TG_TABLE_NAME IN ('Approval', 'VariantRejection') THEN
    SELECT "workspaceId" INTO owner_workspace
    FROM "Variant" WHERE "id" = NEW."variantId";
  ELSIF TG_TABLE_NAME IN ('TaskEvent', 'PublishResult', 'NotificationDelivery') THEN
    SELECT "workspaceId", "executionChannel" INTO owner_workspace, execution_channel
    FROM "PublishTask" WHERE "id" = NEW."taskId";
  ELSE
    RAISE EXCEPTION 'guard_child_workspace 不支持表 %', TG_TABLE_NAME USING ERRCODE = 'XX000';
  END IF;

  IF owner_workspace IS DISTINCT FROM NEW."workspaceId" THEN
    RAISE EXCEPTION '所属资源不存在于当前工作室: %', TG_TABLE_NAME USING ERRCODE = 'MA001';
  END IF;

  IF TG_TABLE_NAME = 'PublishResult' THEN
    IF NEW."platformPublishedAt" IS NOT NULL AND execution_channel IS DISTINCT FROM 'official' THEN
      RAISE EXCEPTION '平台发表时间须由官方通道回读确认' USING ERRCODE = 'MA003';
    END IF;

    IF NEW."evidenceAssetId" IS NOT NULL THEN
      SELECT "workspaceId", "taskId", "kind"
      INTO evidence_workspace, evidence_task, evidence_kind
      FROM "Asset" WHERE "id" = NEW."evidenceAssetId";

      IF evidence_workspace IS DISTINCT FROM NEW."workspaceId" THEN
        RAISE EXCEPTION '截图不存在于当前工作室' USING ERRCODE = 'MA001';
      END IF;

      IF evidence_task IS DISTINCT FROM NEW."taskId" OR evidence_kind <> 'task_evidence' THEN
        RAISE EXCEPTION '回执截图须来自本任务' USING ERRCODE = 'MA003';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "Approval_workspace_scope"
BEFORE INSERT OR UPDATE ON "Approval"
FOR EACH ROW EXECUTE FUNCTION "guard_child_workspace"();

CREATE TRIGGER "VariantRejection_workspace_scope"
BEFORE INSERT OR UPDATE ON "VariantRejection"
FOR EACH ROW EXECUTE FUNCTION "guard_child_workspace"();

CREATE TRIGGER "TaskEvent_workspace_scope"
BEFORE INSERT ON "TaskEvent"
FOR EACH ROW EXECUTE FUNCTION "guard_child_workspace"();

CREATE TRIGGER "PublishResult_workspace_scope"
BEFORE INSERT OR UPDATE ON "PublishResult"
FOR EACH ROW EXECUTE FUNCTION "guard_child_workspace"();

CREATE TRIGGER "NotificationDelivery_workspace_scope"
BEFORE INSERT OR UPDATE ON "NotificationDelivery"
FOR EACH ROW EXECUTE FUNCTION "guard_child_workspace"();

CREATE OR REPLACE FUNCTION "guard_oauth_state_scope"()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  account_workspace text;
  account_platform  "Platform";
  is_member         boolean;
BEGIN
  SELECT "workspaceId", "platform"
  INTO account_workspace, account_platform
  FROM "ChannelAccount" WHERE "id" = NEW."accountId";

  SELECT EXISTS (
    SELECT 1 FROM "Membership"
    WHERE "workspaceId" = NEW."workspaceId" AND "userId" = NEW."userId"
  ) INTO is_member;

  IF account_workspace IS DISTINCT FROM NEW."workspaceId"
     OR account_platform IS DISTINCT FROM NEW."platform"
     OR NOT is_member THEN
    RAISE EXCEPTION 'OAuthState 的工作室、账号、操作人或平台不匹配' USING ERRCODE = 'MA001';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "OAuthState_scope"
BEFORE INSERT ON "OAuthState"
FOR EACH ROW EXECUTE FUNCTION "guard_oauth_state_scope"();

COMMIT;
