ALTER TABLE "PublishTask" ADD COLUMN "metricsSyncAttemptedAt" TIMESTAMPTZ(3);
ALTER TABLE "PublicationMetrics" ALTER COLUMN "recordedById" DROP NOT NULL;
ALTER TABLE "PublicationMetricSnapshot" ALTER COLUMN "recordedById" DROP NOT NULL;
ALTER TABLE "PublicationMetrics" ADD CONSTRAINT "PublicationMetrics_manual_actor_check"
  CHECK ("source" <> 'manual' OR "recordedById" IS NOT NULL);
ALTER TABLE "PublicationMetricSnapshot" ADD CONSTRAINT "PublicationMetricSnapshot_manual_actor_check"
  CHECK ("source" <> 'manual' OR "recordedById" IS NOT NULL);
