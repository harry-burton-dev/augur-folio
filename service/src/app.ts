import Fastify from 'fastify';
import { Problem, appServer, packageVersion, readManifest, serviceFastifyOptions, signedInCaller, type AppManifest, type CallerCheck, type Jobs } from '@augur/service-kit';
import { homeSchema, type Home } from './api-types.ts';
import { memoryEvents, partEvents, type EventsKept } from './events.ts';
import { openApi } from './openapi.ts';

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
  env?: Record<string, string | undefined>;
}

export const buildApp = async ({ manifest = readManifest(import.meta.url), callers, events = memoryEvents(), env = process.env }: Options = {}) => {
  const app = Fastify(serviceFastifyOptions());
  // Only the gateway's signed word says who is calling; every error is a problem details body; /healthz
  // answers the release's version without a caller, which is how the runner knows this part is ready.
  await appServer(app, { manifest, version, api: API_VERSION, callers });
  const caller = signedInCaller(manifest);
  // A setting the admin got wrong stops the part at start, saying which, rather than later.
  retentionDaysOf(manifest, env);

  app.get(`/${(manifest.api as { openapi: string }).openapi}`, async () => openApi(manifest, version, API_VERSION));
  await partEvents(app, { kept: events });

  await app.register(
    async (app) => {
      // Home for the person the shell called for, on the floor the gateway signed. Nobody reaches this
      // without signing in, and never without a floor. The store that fills it comes next; until then a
      // floor has no documents, so nothing needs anyone and nothing is new.
      app.get('/home', { schema: { response: { 200: homeSchema } } }, async (req): Promise<Home> => {
        const person = caller(req);
        if (!person.workspace) throw new Problem(400, 'no_floor', `${manifest.name} opens on a floor; this call named none.`);
        return { floor: { id: person.workspace.id, kind: person.workspace.kind }, needsYou: [], latest: [] };
      });
    },
    { prefix: `/${API_VERSION}` },
  );
  return app;
};
