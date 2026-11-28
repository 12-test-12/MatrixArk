ALTER TABLE "PublishTask" ADD COLUMN "selectedMode" TEXT;
ALTER TABLE "PublishTask" ADD CONSTRAINT "PublishTask_selected_mode_check" CHECK (
  "selectedMode" IS NULL OR "selectedMode" IN ('official_api', 'local_browser', 'manual_handoff', 'sandbox')
);
ALTER TABLE "PublishTask" ADD CONSTRAINT "PublishTask_mode_channel_check" CHECK (
  "selectedMode" IS NULL OR "executionChannel" IS NULL OR
  "executionChannel"::text = CASE "selectedMode"
    WHEN 'official_api' THEN 'official'
    WHEN 'sandbox' THEN 'sandbox'
    ELSE 'manual' END
);
CREATE FUNCTION "guard_task_selected_mode"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."selectedMode" IS DISTINCT FROM OLD."selectedMode" THEN
    RAISE EXCEPTION '任务发布方式已确定，请核对原任务，不能切换方式重复投稿' USING ERRCODE = 'MA002';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PublishTask_selected_mode" BEFORE UPDATE ON "PublishTask"
FOR EACH ROW EXECUTE FUNCTION "guard_task_selected_mode"();
