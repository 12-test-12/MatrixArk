-- Run in the MatrixArk database as its owner after applying the migrations.
DO $matrixark_privileges$
BEGIN
  IF current_schema() <> 'public' OR to_regclass('public._prisma_migrations') IS NULL THEN
    RAISE EXCEPTION 'Connect to the MatrixArk public schema first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public."_prisma_migrations"
    WHERE migration_name = '202611200001_database_design_v13'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Apply the MatrixArk database migrations first';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'matrixark_app') THEN
    CREATE ROLE matrixark_app NOLOGIN;
  END IF;

  GRANT USAGE ON SCHEMA public TO matrixark_app;
  GRANT SELECT, INSERT, UPDATE ON TABLE public."User", public."Workspace", public."Manuscript",
    public."Asset", public."Variant", public."Approval", public."ChannelAccount", public."PublishTask",
    public."PublishResult", public."NotificationSetting", public."NotificationDelivery", public."PlatformAppSetting",
    public."PublicationMetrics" TO matrixark_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."Session", public."Membership", public."OAuthState"
    TO matrixark_app;
  GRANT SELECT, INSERT ON TABLE public."TaskEvent", public."VariantAsset", public."VariantRejection",
    public."PublicationMetricSnapshot"
    TO matrixark_app;
  GRANT USAGE ON SEQUENCE public."TaskEvent_id_seq" TO matrixark_app;
  REVOKE DELETE, TRUNCATE ON TABLE public."Workspace" FROM PUBLIC, matrixark_app;
  REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public."TaskEvent" FROM PUBLIC, matrixark_app;
END;
$matrixark_privileges$;
