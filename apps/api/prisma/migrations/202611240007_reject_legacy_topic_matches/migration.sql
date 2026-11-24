ALTER TABLE "TopicWork" ADD COLUMN "legacyRuleRejected" BOOLEAN;
ALTER TABLE "TopicWork" ALTER COLUMN "legacyRuleRejected" SET DEFAULT false;

CREATE INDEX "TopicWork_pending_legacy_review_idx" ON "TopicWork"("workspaceId", "id")
WHERE "legacyRuleRejected" IS NULL;
