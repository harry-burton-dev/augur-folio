// Folio's tests run on real Postgres (PER-271): the store they use is the one Folio runs on, so a query that
// only an in-memory copy got right can't pass here. CI starts a Postgres for the check job; locally, point
// DATABASE_URL at a database of their own (README, "Working on it"): each file drops the folio schema.
import pg from 'pg';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { PgFolioStore } from './store.ts';

/** Where the tests' Postgres is. Without it, the tests that need one are skipped, saying so. */
export const DATABASE_URL = process.env.DATABASE_URL;

/**
 * Folio's store on a fresh `folio` schema for this file, emptied before each test. Call it at the top of a test
 * file; read `db.store` inside tests, after `beforeAll` has made it.
 */
export const folioDb = () => {
  const db = {} as {
    pool: pg.Pool;
    store: PgFolioStore;
    /** Empties the store, for a test that needs a fresh one part way through. */
    reset: () => Promise<void>;
  };
  if (!DATABASE_URL) return db;

  const reset = async () => {
    const { rows } = await db.pool.query<{ name: string }>(`select tablename as name from pg_tables where schemaname = 'folio' and tablename <> 'migrations'`);
    if (rows.length) await db.pool.query(`truncate ${rows.map((r) => `folio.${r.name}`).join(', ')}`);
  };
  beforeAll(async () => {
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    await pool.query('drop schema if exists folio cascade');
    Object.assign(db, { pool, reset, store: await PgFolioStore.connect(DATABASE_URL) });
  });
  beforeEach(reset);
  afterAll(async () => {
    await db.store?.close();
    await db.pool?.end();
  });
  return db;
};
