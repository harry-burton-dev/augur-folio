import { readFileSync } from 'node:fs';
import { appCredentialsFromEnv, appStorageFromEnv, registerApp } from '@augur/service-kit';
import { buildApp } from './app.ts';
import { MemoryFolioStore, PgFolioStore } from './store.ts';

const port = Number(process.env.PORT ?? 8083);
// Folio keeps its libraries in its own schema (docs/app-storage.md). Without one it forgets them
// on restart, which is fine under pnpm dev:app and never in production.
const { databaseUrl } = appStorageFromEnv();
if (!databaseUrl && process.env.NODE_ENV === 'production') throw new Error('Folio needs DATABASE_URL: give it its storage (docs/app-storage.md).');
const store = databaseUrl ? await PgFolioStore.connect(databaseUrl) : new MemoryFolioStore();
const app = await buildApp({ store });
await app.listen({ port, host: '0.0.0.0' });

// Put Folio in the platform's catalogue, so the shell can offer it.
// It signs in as itself with SERVICE_CLIENT_SECRET (issued for it by an admin in Admin, Apps).
const { REGISTRY_URL, APP_MANIFEST } = process.env;
const credentials = appCredentialsFromEnv('folio');
if (REGISTRY_URL && credentials) {
  const manifest = JSON.parse(readFileSync(APP_MANIFEST ?? new URL('../../manifest.json', import.meta.url), 'utf8'));
  registerApp({ registryUrl: REGISTRY_URL, credentials, manifest })
    .then(() => app.log.info({ app: manifest.id, version: manifest.version }, 'registered with the platform'))
    .catch((err: Error) => app.log.error(err.message));
} else {
  app.log.info('REGISTRY_URL or the app’s sign-in (SERVICE_CLIENT_SECRET) is not set, so Folio is not in the catalogue (fine under pnpm dev:app).');
}
