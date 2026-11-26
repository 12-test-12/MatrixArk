BEGIN;

ALTER TABLE "OAuthState"
  ALTER COLUMN "accountId" DROP NOT NULL,
  ADD COLUMN "appId" text,
  ADD CONSTRAINT "OAuthState_account_binding_check"
    CHECK ("accountId" IS NOT NULL OR ("platform" = 'bilibili' AND nullif("appId", '') IS NOT NULL));

CREATE OR REPLACE FUNCTION "guard_oauth_state_scope"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Membership"
    WHERE "workspaceId" = NEW."workspaceId" AND "userId" = NEW."userId"
  ) OR (
    NEW."accountId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "ChannelAccount"
      WHERE "id" = NEW."accountId" AND "workspaceId" = NEW."workspaceId" AND "platform" = NEW."platform"
    )
  ) THEN
    RAISE EXCEPTION 'OAuthState 的工作室、账号、操作人或平台不匹配' USING ERRCODE = 'MA001';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
