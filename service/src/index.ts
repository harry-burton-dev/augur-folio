import { appDatabaseFromEnv, appStorageFromEnv, loadConfig, peopleFor, readManifest, startAppService } from '@augur/service-kit';
import { buildApp, retentionDaysOf } from './app.ts';
import { memoryEvents, postgresEvents } from './events.ts';
import { MemoryObjectStore, S3ObjectStore } from './objects.ts';
import { inboxFor, platformEnv } from './platform.ts';
import { purgeDeleted } from './retention.ts';
import { Store } from './store.ts';

// The inbound part (score/web.score.yaml): builds the service, listens on PORT and stops cleanly on
// SIGTERM. It reaches AUGUR only through the gateway (GATEWAY_URL), signed in as the app with the client the
// gateway resource gives it, and checks callers with the gateway's keys (CALLER_KEYS_URL). On contract 3 the
// runner registers the app, not the part.
const manifest = readManifest(import.meta.url);
// Secrets arrive as files (`<NAME>_FILE`): read them into the settings the service kit's clients use.
loadConfig(manifest.id, [
  { name: 'SERVICE_CLIENT_SECRET', about: 'the app’s sign-in, from the gateway resource', secret: true },
  { name: 'S3_SECRET_ACCESS_KEY', about: 'the app’s bucket key, from the bucket resource', secret: true },
]);
const env = platformEnv(process.env);
const db = appDatabaseFromEnv(manifest.id);
if (!db) console.log(`No DATABASE_HOST, so ${manifest.name} keeps the events it is sent in memory and can’t keep documents (fine under pnpm dev:app).`);
const events = db ? postgresEvents(db.pool) : memoryEvents();
const store = db ? new Store(db.pool) : undefined;
const { bucket } = appStorageFromEnv(env);
const objects = bucket ? new S3ObjectStore(bucket) : new MemoryObjectStore();
if (!bucket) console.log(`No bucket, so ${manifest.name} keeps uploaded files in memory until it stops (fine under pnpm dev:app).`);
const people = peopleFor(manifest.id, { env });
const retentionDays = retentionDaysOf(manifest, env);

await startAppService({
  manifest,
  env,
  buildApp: async ({ jobs, audit, log }) => {
    const app = await buildApp({ manifest, jobs, events, store, objects, people, audit, inbox: inboxFor(manifest.id, (line) => log.info(line, 'inbox (no Inbox here)'), env), env });
    // Deleted documents' files leave the bucket once the retention setting's days have passed. Every hour,
    // from whichever instance gets there: the store takes each one once.
    if (store) {
      const sweep = () => purgeDeleted({ store, objects, days: retentionDays, log }).catch((err: Error) => log.error({ err: err.message }, 'could not clear deleted documents'));
      const timer = setInterval(sweep, 60 * 60 * 1000);
      timer.unref();
      app.addHook('onClose', async () => clearInterval(timer));
      void sweep();
    }
    return app;
  },
});
