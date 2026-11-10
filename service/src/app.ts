import Fastify from 'fastify';
import { Problem, appServer, floorCaller, packageVersion, readManifest, serviceFastifyOptions, type AppAudit, type AppManifest, type AppNotify, type AppPeople, type CallerCheck, type Jobs } from '@augur/service-kit';
import { memoryEvents, partEvents, type EventsKept } from './events.ts';
import { libraryRoutes } from './library.ts';
import { MemoryObjectStore, type ObjectStore } from './objects.ts';
import { openApi } from './openapi.ts';
import { memoryInbox, type Inbox } from './platform.ts';
import type { Store } from './store.ts';

/** The major version of the API this service serves. Its routes go under /v1, as the platform's do. */
export const API_VERSION = 'v1';
const version = packageVersion(import.meta.url);

/** A setting's value as the runner hands it (`${resources.settings.<id>}`, in `variables`), else the manifest's default. */
export const setting = (manifest: AppManifest, id: string, value: string | undefined) => {
  const declared = (manifest.contributes as { settings?: { id: string; default?: unknown }[] } | undefined)?.settings?.find((s) => s.id === id);
  if (!declared) throw new Error(`The manifest declares no setting ${id}.`);
  return value || String(declared.default ?? '');
};

/** How long a deleted document is kept before its files and text go for good: a whole number of days. */
export const retentionDaysOf = (manifest: AppManifest, env: Record<string, string | undefined>) => {
  const days = Number(setting(manifest, 'retentionDays', env.RETENTION_DAYS));
  if (!Number.isInteger(days) || days < 1) throw new Error(`The setting “Keep deleted documents for” must be a whole number of days, 1 or more; it is ${env.RETENTION_DAYS}.`);
  return days;
};

export interface Options {
  manifest?: AppManifest;
  /**
   * Checks the caller the gateway signed for this app's part: on contract 3 the service kit's `appServer`
   * expects audience `app-<id>` (`callerAudienceOf`), a person's call as a delegated caller (the person, the
   * app and its scopes), an event as AUGUR's events service. On by default; under `pnpm dev:app` and in
   * tests `x-user-*` headers are believed.
   */
  callers?: CallerCheck;
  /** Where pushed events are kept; in memory without a database (index.ts gives it one). */
  events?: EventsKept;
  /** Background and scheduled jobs; startAppService passes them in. */
  jobs?: Jobs;
  /** The library's store, in the app's database. Without one (`pnpm dev:app` with no database) the library says it can't be reached. */
  store?: Store;
  /** Where uploaded files are kept: the app's bucket. In memory by default. */
  objects?: ObjectStore;
  /** Who someone stands for, and finding people and teams to share with. */
  people?: AppPeople;
  inbox?: Inbox;
  audit?: AppAudit;
  /** Tells people as the app (`notifications:send`); startAppService passes it in. */
  notify?: AppNotify;
  /** The most one upload may be, in bytes: the manifest's `maxUpload` unless a test says less. */
  maxUploadBytes?: number;
  env?: Record<string, string | undefined>;
}

/** The manifest's `maxUpload`, in bytes: the gateway lets nothing larger through. */
export const uploadLimitOf = (manifest: AppManifest) => Number((manifest as { maxUpload?: number }).maxUpload ?? 10) * 1024 * 1024;

export const buildApp = async ({
  manifest = readManifest(import.meta.url),
  callers,
  events = memoryEvents(),
  store,
  objects = new MemoryObjectStore(),
  people,
  inbox = memoryInbox(),
  audit = async () => undefined,
  notify = async () => undefined,
  maxUploadBytes = uploadLimitOf(manifest),
  env = process.env,
}: Options = {}) => {
  const app = Fastify(serviceFastifyOptions());
  // Only the gateway's signed word says who is calling; every error is a problem details body; /healthz
  // answers the release's version without a caller, which is how the runner knows this part is ready.
  await appServer(app, { manifest, version, api: API_VERSION, callers });
  // A setting the admin got wrong stops the part at start, saying which, rather than later.
  retentionDaysOf(manifest, env);

  app.get(`/${(manifest.api as { openapi: string }).openapi}`, async () => openApi(manifest, version, API_VERSION));
  await partEvents(app, { kept: events });

  await app.register(
    async (app) => {
      if (store) await libraryRoutes(app, { manifest, store, objects, ...(people ? { people } : {}), inbox, audit, notify, maxUploadBytes });
      else
        // Nothing to keep documents in: every route says so, rather than answering as if the floor were empty.
        app.all('/*', async (req) => {
          floorCaller(manifest)(req);
          throw new Problem(503, 'unavailable', `${manifest.name} can’t reach its database, so it can’t show or keep documents.`, { whoCanChange: 'An admin, who can see why in the app’s logs.' });
        });
    },
    { prefix: `/${API_VERSION}` },
  );
  return app;
};
