import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DirectorySearch } from '@augur/service-kit';
import { rightsOn, type HeldLibrary, type OnFloor } from './app.ts';
import type { Audit } from './audit.ts';
import { CADENCES, nextIssue, type Cadence } from './cadence.ts';
import type { Notify } from './notices.ts';
import { describePrincipals, type CallerPrincipals } from './people.ts';
import type { Publisher } from './publishing.ts';
import { MAX_PAGE, type FolioStore, type Series } from './store.ts';

export interface SeriesDeps {
  store: FolioStore;
  audit: Audit;
  onFloor(req: FastifyRequest, reply: FastifyReply): OnFloor | undefined;
  reach(caller: OnFloor, id: string): Promise<HeldLibrary | undefined>;
  libraryFor(caller: OnFloor, id: string, reply: FastifyReply): Promise<HeldLibrary | undefined>;
  principalsOf: CallerPrincipals;
  directory: DirectorySearch;
  publisher: Publisher;
  refused(err: unknown, reply: FastifyReply): unknown;
}

const ID = { type: 'string', maxLength: 64 } as const;
const NAME = { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' } as const;
const FIELDS = {
  name: NAME,
  description: { type: 'string', maxLength: 500 },
  cadence: { type: 'string', enum: CADENCES },
  audience: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 120 } },
  tags: { type: 'array', maxItems: 30, items: ID },
} as const;
const LIBRARY_PARAMS = { type: 'object', properties: { id: ID }, required: ['id'] } as const;
const SERIES_PARAMS = { type: 'object', properties: { id: ID, series: ID }, required: ['id', 'series'] } as const;
const ONE_PARAMS = { type: 'object', properties: { series: ID }, required: ['series'] } as const;

type SeriesChange = { name?: string; description?: string; cadence?: Cadence; audience?: string[]; tags?: string[] };

/** A series as the caller reaches it: through its library, or as the audience its issues go to. */
type HeldSeries = Series & { shelf: HeldLibrary; manage: boolean };

/**
 * Series: a named run of documents in a library, such as a weekly report, with
 * a cadence, and the audience and tags each issue starts with. Adding the next
 * issue is an upload to the library with `series` (documents.ts), which gives
 * it its number, period and title and publishes it. Whoever may read a series
 * (its library's readers, and its audience) may follow it to be told of each
 * issue; its owner is reminded when one is late (remindLate).
 */
export const seriesRoutes = async (app: FastifyInstance, { store, onFloor, reach, libraryFor, principalsOf, directory, publisher, refused }: SeriesDeps) => {
  const describe = describePrincipals(directory);
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not-found', message: 'There’s no such series, or it hasn’t been shared with you.' });
  const managersOnly = (reply: FastifyReply) => reply.code(403).send({ error: 'forbidden', message: 'Only whoever manages this library can change its series.' });

  /** The series, when the caller may see it: its library lets them in, or they're in the audience its issues go to. */
  const seriesFor = async (caller: OnFloor, id: string, reply: FastifyReply): Promise<HeldSeries | undefined> => {
    const run = await store.series(id);
    const shelf = run && (await reach(caller, run.library));
    const principals = shelf ? await principalsOf(caller) : [];
    if (!run || !shelf || !(shelf.level || run.audience.some((a) => principals.includes(a)))) return void notFound(reply);
    return { ...run, shelf, manage: rightsOn(caller, shelf).manage };
  };

  /** A series as it's sent: when the next issue is due, and what the caller may do with it. */
  const view = async (caller: OnFloor, { shelf, manage, ...run }: HeldSeries) => ({
    ...run,
    libraryName: shelf.name,
    next: nextIssue(run.cadence, run.last),
    following: (await store.followers(run.id)).includes(caller.id),
    can: { manage, addIssue: Boolean(shelf.level) && rightsOn(caller, shelf).addDocuments, publish: manage },
  });

  /** The series' default audience, checked as a publication's would be when it's set. */
  const audienceRefused = async (caller: OnFloor, library: HeldLibrary, audience: string[] | undefined, reply: FastifyReply) => {
    if (!audience?.length) return false;
    const refusal = await publisher.audienceRefusal(caller, library, [...new Set(audience)]);
    if (refusal) reply.code(refusal.code).send({ error: refusal.error, message: refusal.message });
    return Boolean(refusal);
  };

  app.get<{ Params: { id: string } }>('/libraries/:id/series', { schema: { params: LIBRARY_PARAMS } }, async (req, reply) => {
    const caller = onFloor(req, reply);
    if (!caller) return reply;
    const library = await libraryFor(caller, req.params.id, reply);
    if (!library) return reply;
    const manage = rightsOn(caller, library).manage;
    return { series: await Promise.all((await store.seriesIn(library.id)).map((run) => view(caller, { ...run, shelf: library, manage }))), can: { create: manage } };
  });

  /**
   * A schedule for a series: a new series (in `parent`, or at the top of the
   * library), or one already in the library (`folder`) that has none yet.
   */
  app.post<{ Params: { id: string }; Body: SeriesChange & { name: string; cadence: Cadence; parent?: string; folder?: string } }>(
    '/libraries/:id/series',
    { schema: { params: LIBRARY_PARAMS, body: { type: 'object', additionalProperties: false, required: ['name', 'cadence'], properties: { ...FIELDS, parent: ID, folder: ID } } } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const library = await libraryFor(caller, req.params.id, reply);
      if (!library) return reply;
      if (!rightsOn(caller, library).manage) return managersOnly(reply);
      if (await audienceRefused(caller, library, req.body.audience, reply)) return reply;
      try {
        const run = await store.createSeries({ ...req.body, library: library.id, name: req.body.name.trim(), description: req.body.description?.trim(), createdBy: caller.id });
        await publisher.recorded({ actor: caller.id, action: 'series.created', target: run.id, workspace: library.workspace, detail: { library: library.id, name: run.name, cadence: run.cadence } });
        return reply.code(201).send(await view(caller, { ...run, shelf: library, manage: true }));
      } catch (err) {
        return refused(err, reply);
      }
    },
  );

  app.get<{ Params: { series: string } }>('/series/:series', { schema: { params: ONE_PARAMS } }, async (req, reply) => {
    const caller = onFloor(req, reply);
    if (!caller) return reply;
    const run = await seriesFor(caller, req.params.series, reply);
    if (!run) return reply;
    return { ...(await view(caller, run)), audience: await describe(run.audience) };
  });

  app.patch<{ Params: { id: string; series: string }; Body: SeriesChange }>(
    '/libraries/:id/series/:series',
    { schema: { params: SERIES_PARAMS, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: FIELDS } } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const run = await seriesFor(caller, req.params.series, reply);
      if (!run) return reply;
      if (run.library !== req.params.id) return notFound(reply);
      if (!run.manage) return managersOnly(reply);
      if (await audienceRefused(caller, run.shelf, req.body.audience, reply)) return reply;
      try {
        const changed = await store.updateSeries(run.id, { ...req.body, name: req.body.name?.trim(), description: req.body.description?.trim() });
        return { ...(await view(caller, { ...changed!, shelf: run.shelf, manage: true })), audience: await describe(changed!.audience) };
      } catch (err) {
        return refused(err, reply);
      }
    },
  );

  app.delete<{ Params: { id: string; series: string } }>('/libraries/:id/series/:series', { schema: { params: SERIES_PARAMS } }, async (req, reply) => {
    const caller = onFloor(req, reply);
    if (!caller) return reply;
    const run = await seriesFor(caller, req.params.series, reply);
    if (!run) return reply;
    if (run.library !== req.params.id) return notFound(reply);
    if (!run.manage) return managersOnly(reply);
    try {
      await store.deleteSeries(run.id);
      await publisher.recorded({ actor: caller.id, action: 'series.deleted', target: run.id, workspace: run.workspace, detail: { library: run.library, name: run.name } });
      return reply.code(204).send();
    } catch (err) {
      return refused(err, reply);
    }
  });

  /** The issues the caller may read, newest period first: as a library's reader, or the ones published to them. */
  app.get<{ Params: { series: string }; Querystring: { limit?: number; offset?: number } }>(
    '/series/:series/issues',
    {
      schema: {
        params: ONE_PARAMS,
        querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE }, offset: { type: 'integer', minimum: 0 } } },
      },
    },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const run = await seriesFor(caller, req.params.series, reply);
      if (!run) return reply;
      const readers = await principalsOf(caller);
      return store.documents(run.library, { series: run.id, below: true, readers, audience: true, sort: 'period', limit: req.query.limit ?? 50, offset: req.query.offset });
    },
  );

  app.put<{ Params: { series: string }; Body: { following: boolean } }>(
    '/series/:series/follow',
    { schema: { params: ONE_PARAMS, body: { type: 'object', additionalProperties: false, required: ['following'], properties: { following: { type: 'boolean' } } } } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const run = await seriesFor(caller, req.params.series, reply);
      if (!run) return reply;
      await store.follow(run.id, caller.id, req.body.following);
      return { following: req.body.following };
    },
  );
};

const DAY_WORDS = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

/**
 * Tells each series' owner, once, when its next issue is overdue. Run on a
 * timer by each instance; the store lets only one of them tell the owner.
 */
export const remindLate = async ({ store, notify, log, now = new Date() }: { store: FolioStore; notify: Notify; log: { error(obj: object, msg: string): void }; now?: Date }) => {
  for (const run of await store.timedSeries()) {
    const next = nextIssue(run.cadence, run.last, now);
    if (!next.overdue || !next.dueBy || !(await store.markReminded(run.id, next.periodStart))) continue;
    const due = DAY_WORDS.format(new Date(`${next.dueBy}T00:00:00Z`));
    await notify({
      recipients: [run.createdBy],
      workspace: run.workspace,
      title: `${run.name} is late`,
      detail: `The issue for ${next.period} was due by the end of ${due}.`,
      link: `/libraries/${run.library}/series/${run.id}`,
    }).catch((err: Error) => log.error({ err: err.message, series: run.id }, 'could not remind the owner of a late issue'));
  }
};
