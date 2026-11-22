CREATE TABLE "PublicationMetricSnapshot" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "taskId" TEXT NOT NULL,
  "views" INTEGER,
  "likes" INTEGER,
  "comments" INTEGER,
  "favorites" INTEGER,
  "shares" INTEGER,
  "source" "MetricsSource" NOT NULL,
  "recordedAt" TIMESTAMPTZ(3) NOT NULL,
  "recordedById" TEXT NOT NULL,
  CONSTRAINT "PublicationMetricSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PublicationMetricSnapshot_result_fkey" FOREIGN KEY ("taskId") REFERENCES "PublishResult"("taskId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "PublicationMetricSnapshot_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "PublicationMetricSnapshot_counts_check" CHECK (
    num_nonnulls("views", "likes", "comments", "favorites", "shares") > 0
    AND "views" >= 0 AND "likes" >= 0 AND "comments" >= 0 AND "favorites" >= 0 AND "shares" >= 0
  )
);
CREATE INDEX "PublicationMetricSnapshot_task_time_idx" ON "PublicationMetricSnapshot" ("taskId", "recordedAt" DESC, "id" DESC);

INSERT INTO "PublicationMetricSnapshot"
  ("taskId", "views", "likes", "comments", "favorites", "shares", "source", "recordedAt", "recordedById")
SELECT "taskId", "views", "likes", "comments", "favorites", "shares", "source", "recordedAt", "recordedById"
FROM "PublicationMetrics";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'matrixark_app') THEN
    GRANT SELECT, INSERT ON TABLE "PublicationMetricSnapshot" TO matrixark_app;
  END IF;
END
$$;
