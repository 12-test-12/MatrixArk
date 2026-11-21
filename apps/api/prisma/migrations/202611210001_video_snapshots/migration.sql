ALTER TYPE "AssetKind" ADD VALUE 'manuscript_video';

ALTER TABLE "Asset"
  DROP CONSTRAINT "Asset_kind_owner_check",
  DROP CONSTRAINT "Asset_mime_check",
  DROP CONSTRAINT "Asset_size_check",
  ADD CONSTRAINT "Asset_kind_owner_check" CHECK (
    ("kind"::text IN ('manuscript_image', 'manuscript_video') AND "manuscriptId" IS NOT NULL)
    OR ("kind" = 'task_evidence' AND "taskId" IS NOT NULL)
  ),
  ADD CONSTRAINT "Asset_mime_check" CHECK (
    CASE WHEN "kind"::text = 'manuscript_video' THEN "mimeType" = 'video/mp4'
      ELSE "mimeType" IN ('image/jpeg', 'image/png', 'image/webp') END
  ) NOT VALID,
  ADD CONSTRAINT "Asset_size_check" CHECK (
    "size" > 0 AND "size" <= CASE WHEN "kind"::text = 'manuscript_video' THEN 104857600 ELSE 20971520 END
  ) NOT VALID,
  ADD CONSTRAINT "Asset_video_checksum_check" CHECK ("kind"::text <> 'manuscript_video' OR "checksum" IS NOT NULL);

ALTER TABLE "Manuscript" ADD COLUMN "videoAssetId" text REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "Variant" ADD COLUMN "videoAssetId" text REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE FUNCTION "guard_video_reference"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text;
BEGIN
  IF TG_TABLE_NAME = 'Variant' AND TG_OP = 'UPDATE' THEN
    IF NEW."videoAssetId" IS DISTINCT FROM OLD."videoAssetId" THEN
      RAISE EXCEPTION '版本的视频快照不可原地修改' USING ERRCODE = 'MA002';
    END IF;
  END IF;
  IF NEW."videoAssetId" IS NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'Variant' THEN owner_id := NEW."manuscriptId";
  ELSE owner_id := NEW.id;
  END IF;
  IF NOT EXISTS (
    SELECT FROM "Asset" WHERE id = NEW."videoAssetId" AND "workspaceId" = NEW."workspaceId"
      AND "manuscriptId" = owner_id AND "kind"::text = 'manuscript_video'
  ) THEN
    RAISE EXCEPTION '视频必须属于当前工作室和原稿' USING ERRCODE = 'MA003';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "Manuscript_video_scope" BEFORE INSERT OR UPDATE OF "videoAssetId", "workspaceId" ON "Manuscript"
FOR EACH ROW EXECUTE FUNCTION "guard_video_reference"();
CREATE TRIGGER "Variant_video_scope" BEFORE INSERT OR UPDATE OF "videoAssetId" ON "Variant"
FOR EACH ROW EXECUTE FUNCTION "guard_video_reference"();

CREATE FUNCTION "guard_video_asset_fields"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."size", NEW."mimeType", NEW."checksum") IS DISTINCT FROM (OLD."size", OLD."mimeType", OLD."checksum") THEN
    RAISE EXCEPTION '视频文件元数据不可原地修改' USING ERRCODE = 'MA002';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Asset_video_immutable" BEFORE UPDATE ON "Asset"
FOR EACH ROW WHEN (OLD."kind"::text = 'manuscript_video') EXECUTE FUNCTION "guard_video_asset_fields"();

CREATE FUNCTION "guard_variant_image_kind"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT FROM "Asset" WHERE id = NEW."assetId" AND "kind"::text = 'manuscript_video') THEN
    RAISE EXCEPTION '版本图片位置不可引用视频' USING ERRCODE = 'MA003';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "VariantAsset_image_kind" BEFORE INSERT ON "VariantAsset"
FOR EACH ROW EXECUTE FUNCTION "guard_variant_image_kind"();
