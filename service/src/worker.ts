import { appDatabaseFromEnv, appStorageFromEnv, loadConfig, readManifest } from '@augur/service-kit';
import { S3ObjectStore } from './objects.ts';
import { renditionWorker, type WorkerLog } from './renditions.ts';
import { Store } from './store.ts';

// The worker part (score/worker.score.yaml): makes each version's reader copy in the background. It has the
// app's database and bucket and nothing else: it never reaches AUGUR, so it has no gateway and no sign-in.
const manifest = readManifest(import.meta.url);

const line = (level: number) => (fields: Record<string, unknown>, msg: string) => console.log(JSON.stringify({ level, time: Date.now(), app: manifest.id, part: 'worker', ...fields, msg }));
const log: WorkerLog = { info: line(30), warn: line(40), error: line(50) };

loadConfig(manifest.id, [{ name: 'S3_SECRET_ACCESS_KEY', about: 'the app’s bucket key, from the bucket resource', secret: true }]);
const db = appDatabaseFromEnv(manifest.id);
const { bucket } = appStorageFromEnv(process.env);
if (!db || !bucket) {
  log.error({ database: Boolean(db), bucket: Boolean(bucket) }, 'the worker needs the app’s database and bucket; check score/worker.score.yaml');
  process.exit(1);
}

const stop = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => stop.abort());

const worker = renditionWorker({ store: new Store(db.pool), objects: new S3ObjectStore(bucket), log, scratchDir: process.env.SCRATCH_DIR });
log.info({ version: manifest.version }, 'making reader copies');
// A copy being made when the part stops is left to its lease: the next worker takes it over.
await worker.run(stop.signal);
await db.pool.end();
log.info({}, 'stopped');
