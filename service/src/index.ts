import { existsSync, readFileSync } from 'node:fs';
import { appCredentialsFromEnv, appSettings, appStorageFromEnv, outboxRelay, registerApp } from '@augur/service-kit';
import { buildApp } from './app.ts';
import { auditFromEnv } from './audit.ts';
import { notifyFromEnv } from './notices.ts';
import { clearDeleted, DEFAULT_RETENTION_DAYS, RETENTION_SETTING } from './retention.ts';
import { remindLate } from './series.ts';
import { devRenderer } from './renditions.ts';
import { MemoryObjectStore, S3ObjectStore } from './objects.ts';
import { MemoryFolioStore, PgFolioStore } from './store.ts';

const port = Number(process.env.PORT ?? 8083);
// Folio keeps its libraries in its own schema and its files in its own bucket (docs/app-storage.md).
// Without them it forgets everything on restart, which is fine under pnpm dev:app and never in production.
const { databaseUrl, bucket } = appStorageFromEnv();
if ((!databaseUrl || !bucket) && process.env.NODE_ENV === 'production') throw new Error('Folio needs DATABASE_URL and its bucket (S3_*): give it its storage (docs/app-storage.md).');
const store = databaseUrl ? await PgFolioStore.connect(databaseUrl) : new MemoryFolioStore();
const objects = bucket ? new S3ObjectStore(bucket) : new MemoryObjectStore();
// With Postgres the rendition worker (apps/folio/worker) makes reader copies; without it, a stand-in does.
if (store instanceof MemoryFolioStore) store.onQueued = devRenderer(store, objects);
const notify = notifyFromEnv((notice) => app.log.info({ notice }, 'notification (no notifications here)'));
const app = await buildApp({ store, objects, notify });
await app.listen({ port, host: '0.0.0.0' });

// Remind each series' owner when an issue is late. Every instance checks; the store lets one tell them.
const remind = () => remindLate({ store, notify, log: app.log }).catch((err: Error) => app.log.error({ err: err.message }, 'could not check for late issues'));
setInterval(remind, 15 * 60 * 1000).unref();
void remind();

// Put Folio in the platform's catalogue on every start, so the shell can offer it, with no admin step.
// It signs in as itself with SERVICE_CLIENT_SECRET: in a deployment, FOLIO_CLIENT_SECRET, which identity
// makes its sign-in from. The build puts the manifest beside the code; from source it's in apps/folio.
const { REGISTRY_URL, APP_MANIFEST } = process.env;
const credentials = appCredentialsFromEnv('folio');
if (REGISTRY_URL && credentials) {
  const built = new URL('./manifest.json', import.meta.url);
  const manifest = JSON.parse(readFileSync(APP_MANIFEST ?? (existsSync(built) ? built : new URL('../../manifest.json', import.meta.url)), 'utf8'));
  registerApp({ registryUrl: REGISTRY_URL, credentials, manifest })
    .then(() => app.log.info({ app: manifest.id, version: manifest.version }, 'registered with the platform'))
    .catch((err: Error) => app.log.error(err.message));
} else {
  app.log.info('REGISTRY_URL or the app’s sign-in (SERVICE_CLIENT_SECRET) is not set, so Folio is not in the catalogue (fine under pnpm dev:app).');
}

// Clear away deleted documents once they're past the retention period an admin set in Admin, Apps
// (Folio's retentionDays setting). When the registry can't say what it is, nothing is cleared that
// round: an admin may have asked for longer than the default.
const retentionDays = async () => {
  if (!REGISTRY_URL || !credentials) return DEFAULT_RETENTION_DAYS;
  const settings = await appSettings({ registryUrl: REGISTRY_URL, credentials, app: 'folio' });
  return settings[RETENTION_SETTING] ?? DEFAULT_RETENTION_DAYS;
};
const audit = auditFromEnv((entry) => app.log.info({ audit: entry }, 'audit (no audit log here)'));
const clear = () =>
  retentionDays()
    .then((days) => clearDeleted({ store, objects, days, audit, log: app.log }))
    .then((cleared) => cleared && app.log.info({ cleared }, 'cleared deleted documents past their retention'))
    .catch((err: Error) => app.log.error({ err: err.message }, 'could not clear deleted documents'));
setInterval(clear, 60 * 60 * 1000).unref();
void clear();

// Tell other apps what happened (folio.document.*), from the outbox, once each change has committed.
const { EVENTS_URL } = process.env;
if (databaseUrl && EVENTS_URL && credentials) {
  outboxRelay({ pool: PgFolioStore.outboxPool(databaseUrl), eventsUrl: EVENTS_URL, credentials, onError: (err) => app.log.error({ err: (err as Error).message }, 'could not send events') }).start();
} else if (databaseUrl) {
  app.log.info('EVENTS_URL or the app’s sign-in is not set, so Folio’s events wait in its outbox.');
}
