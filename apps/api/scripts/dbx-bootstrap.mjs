import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const [database, output] = process.argv.slice(2);
if (!database || !output) {
  console.error('Usage: node apps/api/scripts/dbx-bootstrap.mjs <database> <output.sql>');
  process.exit(1);
}

const quote = (value) => `E'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
const directory = new URL('../prisma/migrations/', import.meta.url);
const migrations = readdirSync(directory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const apply = migrations.map((name) => {
  const file = readFileSync(new URL(`${name}/migration.sql`, directory));
  const checksum = quote(createHash('sha256').update(file).digest('hex'));
  const body = file.toString('utf8').match(/^BEGIN;\s*([\s\S]+?)\s*COMMIT;\s*$/)?.[1];
  if (!body || body.includes('$matrixark_bootstrap$')) {
    throw new Error(`Expected a transactional migration in ${name}`);
  }
  const migration = quote(name);
  return `
  IF EXISTS (
    SELECT 1 FROM "_prisma_migrations" WHERE migration_name = ${migration} AND rolled_back_at IS NULL
      AND (finished_at IS NULL OR checksum <> ${checksum})
  ) THEN
    RAISE EXCEPTION 'Resolve the incomplete or changed migration % before applying', ${migration};
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "_prisma_migrations" WHERE migration_name = ${migration} AND rolled_back_at IS NULL
  ) THEN
    migration_started := clock_timestamp();
${body}
    INSERT INTO "_prisma_migrations"
      (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
      VALUES (gen_random_uuid()::text, ${checksum}, ${migration}, migration_started, clock_timestamp(), 1);
  END IF;`;
});

if (!apply.length) throw new Error('No Prisma migrations found');

// DBX prepares one statement. Keep the DDL and its Prisma history in the same transaction.
const sql = `DO $matrixark_bootstrap$
DECLARE
  migration_started timestamptz;
BEGIN
  IF current_database() <> ${quote(database)} OR current_schema() <> 'public' THEN
    RAISE EXCEPTION 'Wrong database or schema: %.%', current_database(), current_schema();
  END IF;

  PERFORM pg_advisory_xact_lock(72707369);

  CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    id varchar(36) PRIMARY KEY NOT NULL,
    checksum varchar(64) NOT NULL,
    finished_at timestamptz,
    migration_name varchar(255) NOT NULL,
    logs text,
    rolled_back_at timestamptz,
    started_at timestamptz NOT NULL DEFAULT now(),
    applied_steps_count integer NOT NULL DEFAULT 0
  );

  IF EXISTS (
    SELECT 1 FROM "_prisma_migrations" WHERE rolled_back_at IS NULL
      AND migration_name NOT IN (${migrations.map(quote).join(', ')})
  ) THEN
    RAISE EXCEPTION 'This database has unrecognized migrations';
  END IF;
${apply.join('\n')}
END;
$matrixark_bootstrap$;
`;

writeFileSync(output, sql, { encoding: 'utf8', flag: 'wx' });
