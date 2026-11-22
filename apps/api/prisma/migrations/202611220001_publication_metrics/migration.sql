CREATE TYPE "MetricsSource" AS ENUM ('manual', 'platform');

CREATE TABLE "PublicationMetrics" (
  "taskId" TEXT NOT NULL,
  "views" INTEGER,
  "likes" INTEGER,
  "comments" INTEGER,
  "favorites" INTEGER,
  "shares" INTEGER,
  "source" "MetricsSource" NOT NULL,
  "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recordedById" TEXT NOT NULL,
  CONSTRAINT "PublicationMetrics_pkey" PRIMARY KEY ("taskId"),
  CONSTRAINT "PublicationMetrics_result_fkey" FOREIGN KEY ("taskId") REFERENCES "PublishResult"("taskId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "PublicationMetrics_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "PublicationMetrics_counts_check" CHECK (
    num_nonnulls("views", "likes", "comments", "favorites", "shares") > 0
    AND "views" >= 0 AND "likes" >= 0 AND "comments" >= 0 AND "favorites" >= 0 AND "shares" >= 0
  )
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'matrixark_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "PublicationMetrics" TO matrixark_app;
  END IF;
END
$$;
