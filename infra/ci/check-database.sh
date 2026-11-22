#!/usr/bin/env bash
set -euo pipefail

pg_bin=${PG16_BIN:-/usr/lib/postgresql/16/bin}
cluster=$(mktemp -d "${RUNNER_TEMP:-/tmp}/matrixark-db.XXXXXX")
server_log="$cluster/server.log"
export PGHOST=127.0.0.1 PGPORT=55432 PGUSER=matrixark_ci
baseline=apps/api/prisma/migrations/0000_init/migration.sql

stop_database() {
  if [[ -f "$cluster/postmaster.pid" ]]; then
    "$pg_bin/pg_ctl" -D "$cluster" -m fast -w stop
  fi
}
trap stop_database EXIT

"$pg_bin/initdb" -D "$cluster" -U "$PGUSER" --auth=trust --encoding=UTF8 --no-locale
# All test clients use TCP loopback. Avoid the system Unix socket directory.
printf "\nunix_socket_directories = ''\n" >> "$cluster/postgresql.conf"
if ! "$pg_bin/pg_ctl" -D "$cluster" -l "$server_log" -o "-h $PGHOST -p $PGPORT" -w start; then
  if [[ -s "$server_log" ]]; then
    tail -n 80 "$server_log" >&2
  fi
  exit 1
fi
"$pg_bin/createdb" matrixark_test
"$pg_bin/createdb" matrixark_upgrade_test

export DATABASE_URL="postgresql://${PGUSER}@${PGHOST}:${PGPORT}/matrixark_test?schema=public"
node apps/api/scripts/prisma.mjs migrate deploy

"$pg_bin/psql" -X -v ON_ERROR_STOP=1 -d matrixark_upgrade_test -f "$baseline"
"$pg_bin/psql" -X -v ON_ERROR_STOP=1 -d matrixark_upgrade_test <<'SQL'
ALTER DATABASE matrixark_upgrade_test SET timezone TO 'Asia/Shanghai';
CREATE TYPE "AssetKind" AS ENUM ('manuscript_image', 'task_evidence');
INSERT INTO "User" (id, email, name, "passwordHash") VALUES ('legacy-user', 'legacy@example.test', 'Legacy', 'fixture');
INSERT INTO "Workspace" (id, name) VALUES ('legacy-ws', 'Legacy');
INSERT INTO "Manuscript" (id, "workspaceId", title, body, "createdById", "updatedAt")
  VALUES ('legacy-ms', 'legacy-ws', 'Legacy', 'Content', 'legacy-user', now());
INSERT INTO "Variant" (id, "workspaceId", "manuscriptId", platform, version, title, body, "contentHash", status, "createdById")
  VALUES ('legacy-version', 'legacy-ws', 'legacy-ms', 'bilibili', 1, 'Legacy', 'Content', repeat('a', 64), 'approved', 'legacy-user');
INSERT INTO "Approval" (id, "workspaceId", "variantId", "approvedById")
  VALUES ('legacy-approval', 'legacy-ws', 'legacy-version', 'legacy-user');
INSERT INTO "ChannelAccount" (id, "workspaceId", platform, "channelKind", "displayName")
  VALUES ('legacy-account', 'legacy-ws', 'bilibili', 'manual', 'Legacy');
INSERT INTO "PublishTask" (id, "workspaceId", "variantId", "accountId", "scheduledAt", "idempotencyKey", "createdById", "updatedAt")
  VALUES ('legacy-task', 'legacy-ws', 'legacy-version', 'legacy-account', '2026-01-01 08:00:00.123', 'legacy-key', 'legacy-user', now());
SQL

export DATABASE_URL="postgresql://${PGUSER}@${PGHOST}:${PGPORT}/matrixark_upgrade_test?schema=public"
node apps/api/scripts/prisma.mjs migrate resolve --applied 0000_init
node apps/api/scripts/prisma.mjs migrate deploy
node apps/api/scripts/prisma.mjs migrate deploy

for test_db in matrixark_test matrixark_upgrade_test; do
  "$pg_bin/psql" -X -v ON_ERROR_STOP=1 -d "$test_db" -f apps/api/prisma/app-privileges.sql
  "$pg_bin/psql" -X -v ON_ERROR_STOP=1 -d "$test_db" <<'SQL'
DO $$
BEGIN
  ASSERT current_setting('server_version_num')::int / 10000 = 16, 'Use PostgreSQL 16 for migration checks';
  ASSERT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('"PublishTask_one_dispatching_per_account"')
    AND indisunique AND indisvalid AND indpred IS NOT NULL), 'Missing account dispatch constraint';
  ASSERT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
    AND data_type = 'timestamp without time zone'), 'Found a time column without a time zone';
  ASSERT NOT has_table_privilege('matrixark_app', '"Workspace"', 'DELETE'), 'Workspace delete must be denied';
  ASSERT has_table_privilege('matrixark_app', '"TaskEvent"', 'INSERT')
    AND NOT has_table_privilege('matrixark_app', '"TaskEvent"', 'UPDATE'), 'Task events must be append only';
  ASSERT has_table_privilege('matrixark_app', '"PlatformAppSetting"', 'SELECT')
    AND has_table_privilege('matrixark_app', '"PlatformAppSetting"', 'INSERT')
    AND has_table_privilege('matrixark_app', '"PlatformAppSetting"', 'UPDATE')
    AND NOT has_table_privilege('matrixark_app', '"PlatformAppSetting"', 'DELETE'), 'Platform settings permissions are incorrect';
  IF current_database() = 'matrixark_upgrade_test' THEN
    ASSERT EXISTS (SELECT 1 FROM "PublishTask" t JOIN "TaskEvent" e ON e."taskId" = t.id
      WHERE t.id = 'legacy-task' AND t.status = 'paused' AND t."idempotencyKey" = 'legacy-key'
        AND t."scheduledAt" = '2026-01-01T08:00:00.123Z'::timestamptz AND e.kind = 'paused'), 'Legacy task was not preserved and paused';
    ASSERT EXISTS (SELECT 1 FROM "Approval" WHERE id = 'legacy-approval' AND "snapshotHash" IS NULL), 'Missing legacy approval';
    BEGIN
      UPDATE "Variant" SET title = 'Changed' WHERE id = 'legacy-version';
      RAISE EXCEPTION 'The immutable variant update was accepted';
    EXCEPTION WHEN SQLSTATE 'MA002' THEN
      NULL;
    END;
  END IF;
END $$;
SQL
done

pnpm db:generate
pnpm --filter '@matrixark/api...' build
STORAGE_LOCAL_DIR="$cluster/storage" PUBLIC_BASE_URL=http://127.0.0.1 SANDBOX_CHANNEL=false STORAGE_DRIVER=local \
  node --test --test-concurrency=1 apps/api/test/variant-snapshot.test.mjs apps/api/test/manual-handoff.test.mjs
