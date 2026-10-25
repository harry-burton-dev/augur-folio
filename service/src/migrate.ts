import { PgFolioStore } from './store.ts';

// Brings Folio's schema up to date and stops: for the rendition worker's tests, which need the tables the service makes.
const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL to the Postgres to migrate.');
const store = await PgFolioStore.connect(url);
await store.close();
