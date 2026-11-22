CREATE TABLE "PlatformAppSetting" (
  "workspaceId" TEXT NOT NULL,
  "platform" "Platform" NOT NULL,
  "appId" TEXT NOT NULL,
  "secretCiphertext" TEXT NOT NULL,
  "updatedById" TEXT NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformAppSetting_pkey" PRIMARY KEY ("workspaceId", "platform"),
  CONSTRAINT "PlatformAppSetting_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "PlatformAppSetting_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'matrixark_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "PlatformAppSetting" TO matrixark_app;
  END IF;
END
$$;
