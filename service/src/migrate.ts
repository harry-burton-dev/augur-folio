import { appDatabaseFromEnv, readManifest, runMigrations } from '@augur/service-kit';
import { MIGRATIONS } from './migrations.ts';

// The `migrate` part (score/migrate.score.yaml, a job): brings the app's schema up to date and exits.
// The runner runs it once per install, before the switch; exiting non-zero stops the install with
// these lines, and the old version keeps serving.
const manifest = readManifest(import.meta.url);
const db = appDatabaseFromEnv(manifest.id);
if (!db) {
  console.error(`${manifest.name}’s migrations need its database: DATABASE_HOST is not set.`);
  process.exit(1);
}
try {
  await runMigrations(db.pool, { schema: db.schema, migrations: MIGRATIONS });
  console.log(`${manifest.name}’s schema ${db.schema} is up to date (${MIGRATIONS.length} migrations).`);
} finally {
  await db.pool.end();
}
