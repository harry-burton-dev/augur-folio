import { appCredentialsFromEnv, appSettings, appStorageFromEnv, commonSettings, loadConfigOrExit, outboxRelay, startAppService } from '@augur/service-kit';
import { buildApp } from './app.ts';
import { auditFromEnv } from './audit.ts';
import { notifyFromEnv } from './notices.ts';
import { clearDeleted, DEFAULT_RETENTION_DAYS, RETENTION_SETTING } from './retention.ts';
import { remindLate } from './series.ts';
import { movePublications } from './moving.ts';
import { peopleFromEnv } from './people.ts';
import { devRenderer } from './renditions.ts';
import { MemoryObjectStore, S3ObjectStore } from './objects.ts';
import { MemoryFolioStore, PgFolioStore } from './store.ts';
import { manifest } from './manifest.ts';
import { renditionQueue } from './rendition-queue.ts';

// Every setting Folio reads, checked before it starts (in production, a missing one stops it).
loadConfigOrExit(manifest.id, [
  commonSettings.database,
  commonSettings.registry,
  commonSettings.events,
  commonSettings.issuer,
  commonSettings.issuerInside,
  commonSettings.clientSecret,
  commonSettings.gateway,
  { name: 'S3_ENDPOINT', about: 'the object store Folio keeps files in.', required: true },
  { name: 'S3_BUCKET', about: 'Folio’s bucket.', required: true },
  { name: 'S3_SECRET_ACCESS_KEY', about: 'the secret of Folio’s bucket key.', required: true, secret: true },
]);

// Folio keeps its libraries in its own schema and its files in its own bucket (docs/app-storage.md).
// Without them it forgets everything on restart, which is fine under pnpm dev:app and never in production.
const { databaseUrl, bucket } = appStorageFromEnv();
if ((!databaseUrl || !bucket) && process.env.NODE_ENV === 'production') throw new Error('Folio needs DATABASE_URL and its bucket (S3_*): give it its storage (docs/app-storage.md).');
const store = databaseUrl ? await PgFolioStore.connect(databaseUrl) : new MemoryFolioStore();
const objects = bucket ? new S3ObjectStore(bucket) : new MemoryObjectStore();
// With Postgres the rendition worker (worker/) makes reader copies; without it, a stand-in does.
if (store instanceof MemoryFolioStore) store.onQueued = devRenderer(store, objects);
const { directory } = peopleFromEnv(store);
const { REGISTRY_URL } = process.env;
const credentials = appCredentialsFromEnv(manifest.id);

// Builds Folio, listens, runs its jobs, gives the registry its frontend and puts it in the catalogue.
const app = await startAppService({
  manifest,
  port: Number(process.env.PORT ?? 8083),
  buildApp: ({ notify, audit }) => buildApp({ manifest, store, objects, notify, audit }),
  jobs: (jobs, app) => {
    const notify = notifyFromEnv((notice) => app.log.info({ notice }, 'notification (no notifications here)'));
    const audit = auditFromEnv((entry) => app.log.info({ audit: entry }, 'audit (no audit log here)'));

    // Remind each series' owner when an issue is late. Once per quarter hour, on one instance.
    jobs.schedule('remind-late', '*/15 * * * *', async () => {
      await remindLate({ store, notify, log: app.log });
    });

    // Move what was published the old way onto publishing up the floors. Until it's moved, it still reads
    // as before; when the directory can't be reached, it's tried again next round.
    jobs.schedule('move-publications', '*/15 * * * *', async () => {
      const moved = await movePublications({ store, directory, audit, log: app.log });
      if (moved) app.log.info({ moved }, 'moved publications onto publishing up');
    });

    // Clear away deleted documents once they're past the retention period an admin set in Admin, Apps
    // (Folio's retentionDays setting). When the registry can't say what it is, nothing is cleared that
    // round: an admin may have asked for longer than the default.
    const retentionDays = async () => {
      if (!REGISTRY_URL || !credentials) return DEFAULT_RETENTION_DAYS;
      const settings = await appSettings({ registryUrl: REGISTRY_URL, credentials, app: manifest.id });
      return settings[RETENTION_SETTING] ?? DEFAULT_RETENTION_DAYS;
    };
    jobs.schedule('clear-deleted', '0 * * * *', async () => {
      const cleared = await clearDeleted({ store, objects, days: await retentionDays(), audit, log: app.log });
      if (cleared) app.log.info({ cleared }, 'cleared deleted documents past their retention');
    });

    // Reader copies: the worker (worker/) makes them, from the renditions the store queues. Each is
    // handed to the worker as soon as the store says so, and every minute anything missed.
    if (databaseUrl) {
      const renditions = renditionQueue(store, jobs, app.log);
      jobs.schedule('queue-renditions', '* * * * *', async () => {
        await renditions.sweep();
      });
      const stop = renditions.listen(databaseUrl);
      app.addHook('onClose', stop);
    }
  },
});

// Tell other apps what happened (folio.document.*), from the outbox, once each change has committed.
const { EVENTS_URL } = process.env;
if (databaseUrl && EVENTS_URL && credentials) {
  outboxRelay({ pool: PgFolioStore.outboxPool(databaseUrl), eventsUrl: EVENTS_URL, credentials, onError: (err) => app.log.error({ err: (err as Error).message }, 'could not send events') }).start();
} else if (databaseUrl) {
  app.log.info('EVENTS_URL or the app’s sign-in is not set, so Folio’s events wait in its outbox.');
}
