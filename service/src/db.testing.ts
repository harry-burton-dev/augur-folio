// The store's tests run on real Postgres, so a query only an in-memory copy got right can't pass. CI starts
// one for the check job; locally, point DATABASE_URL at a database of your own (README, "Working on it").
// Each file starts from a fresh schema of its own; without DATABASE_URL the tests that need it are skipped.
import pg from 'pg';
import { runMigrations } from '@augur/service-kit';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { MIGRATIONS } from './migrations.ts';
import { Store } from './store.ts';

export const DATABASE_URL = process.env.DATABASE_URL;

/** A store on a fresh schema for this file, emptied before each test. Read `db.store` inside tests. */
export const testDatabase = (schema: string) => {
  const db = {} as { pool: pg.Pool; store: Store };
  if (!DATABASE_URL) return db;
  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
    // As the app's login does: its own schema first on the search path, so unqualified tables land there.
    db.pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}` });
    await runMigrations(db.pool, { schema, migrations: MIGRATIONS });
    db.store = new Store(db.pool);
  });
  beforeEach(async () => {
    const { rows } = await db.pool.query<{ name: string }>(`select tablename as name from pg_tables where schemaname = $1 and tablename <> 'migrations'`, [schema]);
    if (rows.length) await db.pool.query(`truncate ${rows.map((r) => `${schema}.${r.name}`).join(', ')} cascade`);
  });
  afterAll(async () => {
    await db.pool?.end();
  });
  return db;
};
