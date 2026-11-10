import { appDatabaseFromEnv, readManifest, startAppService } from '@augur/service-kit';
import { buildApp } from './app.ts';
import { memoryEvents, postgresEvents } from './events.ts';

// The inbound part (score/web.score.yaml): builds the service, listens on PORT and stops cleanly on
// SIGTERM. It reaches AUGUR only through the gateway (GATEWAY_URL), and checks callers with the
// gateway's keys (CALLER_KEYS_URL). On contract 3 the runner registers the app, not the part.
const manifest = readManifest(import.meta.url);
const db = appDatabaseFromEnv(manifest.id);
if (!db) console.log(`No DATABASE_HOST, so ${manifest.name} keeps the events it is sent in memory (fine under pnpm dev:app).`);
const events = db ? postgresEvents(db.pool) : memoryEvents();
await startAppService({ manifest, buildApp: ({ jobs }) => buildApp({ manifest, jobs, events }) });
