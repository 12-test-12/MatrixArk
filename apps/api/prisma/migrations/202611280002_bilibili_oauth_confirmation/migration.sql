BEGIN;

ALTER TABLE "OAuthState"
  ADD COLUMN "pendingGrantCiphertext" text,
  ADD CONSTRAINT "OAuthState_pending_grant_check" CHECK (
    "pendingGrantCiphertext" IS NULL OR ("platform" = 'bilibili' AND "consumedAt" IS NOT NULL)
  );

COMMIT;
