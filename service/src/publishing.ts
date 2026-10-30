import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AudienceLookup, DirectorySearch } from '@augur/service-kit';
import type { Audit } from './audit.ts';
import type { HeldLibrary, OnFloor } from './app.ts';
import { documentFinder, documentRights, type HeldDocument } from './documents.ts';
import type { Notify } from './notices.ts';
import { describePrincipals, idOf, type CallerPrincipals } from './people.ts';
import { AUDIENCE, MAX_PAGE, reaches, type FolioStore, type Publication } from './store.ts';

/** The role that lets someone publish beyond their own team: to the whole org, or to any team. */
export const PUBLISHER_ROLE = 'publisher';

/** The most teams one version goes to at once. */
const MAX_AUDIENCE = 20;

export interface PublishingDeps {
  store: FolioStore;
  audit: Audit;
  onFloor(req: FastifyRequest, reply: FastifyReply): OnFloor | undefined;
  reach(caller: OnFloor, id: string): Promise<HeldLibrary | undefined>;
  principalsOf: CallerPrincipals;
  directory: DirectorySearch;
  /** Who an audience reaches, to tell them. */
  audience: AudienceLookup;
  notify: Notify;
  log: { error(obj: object, msg: string): void };
}

const ID = { type: 'string', maxLength: 64 } as const;
const DOC = { type: 'object', properties: { id: ID, doc: ID }, required: ['id', 'doc'] } as const;
const NOTE = { type: 'string', maxLength: 500 } as const;

/** The team a library's floor is, when it's a team's: `tree:<team>`. */
const floorTeam = (library: HeldLibrary) => (library.floor.startsWith('tree:') ? idOf(library.floor) : undefined);

/** What publishes, for the routes here and for a series' next issue. */
export type Publisher = ReturnType<typeof publisherFor>;

/**
 * Whoever manages a document publishes it, within its floor: a team's leads
 * to their team and the teams below it, the org's to any team. The org itself,
 * and teams beyond the floor, need the publisher role.
 */
export const publisherFor = ({ store, audit, directory, audience, notify, log }: Pick<PublishingDeps, 'store' | 'audit' | 'directory' | 'audience' | 'notify' | 'log'>) => {
  const recorded = (entry: Parameters<Audit>[0]) =>
    audit(entry).catch((err: Error) => log.error({ err: err.message, action: entry.action, target: entry.target }, 'could not record in the audit log'));

  /**
   * Why the caller may not publish to each of `wanted` from this library, if they
   * may not: each must be a team the directory knows, within their reach.
   */
  const audienceRefusal = async (caller: OnFloor, library: HeldLibrary, wanted: string[]): Promise<{ code: number; error: string; message: string } | undefined> => {
    const bad = wanted.find((p) => !AUDIENCE.test(p));
    if (bad) return { code: 400, error: 'bad-audience', message: 'Publish to teams, a team and the teams below it, or the whole org. To let one person in, share it with them.' };
    const publisher = caller.roles.includes(PUBLISHER_ROLE);
    const home = floorTeam(library);
    const teams = wanted.filter((p) => p !== 'org');
    // The floor's own team needs no looking up: under `pnpm dev:app` there's no directory of teams.
    const ids = [...new Set(teams.map(idOf).filter((id) => id !== home))];
    const found = new Map((ids.length ? (await directory({ ids })).teams : []).map((t) => [t.id, t]));
    if (ids.some((id) => !found.has(id))) return { code: 400, error: 'unknown-team', message: 'There’s no such team.' };
    if (publisher) return undefined;
    const within = (id: string) => library.floor === 'org' || (home !== undefined && (id === home || Boolean(found.get(id)?.path?.includes(home))));
    if (wanted.includes('org') || teams.some((p) => !within(idOf(p)))) {
      const beyond = wanted.includes('org') ? 'the whole org' : 'other teams';
      const message =
        library.floor === 'org' || home
          ? `You can publish this to ${home ? 'this team and the teams below it' : 'any team'}. Publishing to ${beyond} needs the publisher role, which an admin can give you.`
          : 'Publishing from your own floor needs the publisher role, which an admin can give you. To show someone a document here, share it with them.';
      return { code: 403, error: 'publisher-only', message };
    }
    return undefined;
  };

  /**
   * Tells the audience, leaving out whoever published it; for a series' issue,
   * only those of them who follow it. A failure doesn't undo the publication.
   */
  const tell = async (caller: OnFloor, doc: HeldDocument, publication: Publication) => {
    try {
      const followers = doc.issue && new Set(await store.followers(doc.issue.series));
      const recipients = (await audience(publication.audience)).filter((id) => id !== caller.id && (!followers || followers.has(id)));
      if (!recipients.length) return;
      await notify({
        recipients,
        workspace: doc.shelf.workspace,
        title: doc.issue ? `${doc.title} is out` : `New in ${doc.shelf.name}: ${doc.title}${publication.version > 1 ? ` v${publication.version}` : ''}`,
        detail: publication.note ?? `${caller.name} published it.`,
        link: `/libraries/${doc.library}/documents/${doc.id}`,
        actions: [{ label: 'Read', intent: { type: 'document.open', payload: { app: 'folio', id: doc.id, version: String(publication.version), title: doc.title } } }],
      });
    } catch (err) {
      log.error({ err: (err as Error).message, document: doc.id }, 'could not tell the audience');
    }
  };

  /** Publishes a version the caller may publish to an audience they've been cleared for, records it, and tells them. */
  const publish = async (caller: OnFloor, doc: HeldDocument, { version, audience: wanted, note }: { version: number; audience: string[]; note?: string }) => {
    const publication = await store.publish({ document: doc.id, version, audience: wanted, note, by: caller.id });
    if (!publication) return undefined;
    // What's out to an audience is put out as final.
    await store.setVersionState(doc.id, publication.version, 'issued', caller.id);
    await recorded({
      actor: caller.id,
      action: 'document.published',
      target: doc.id,
      workspace: doc.workspace,
      detail: { library: doc.library, title: doc.title, version: publication.version, audience: publication.audience, ...(note ? { note } : {}) },
    });
    await tell(caller, doc, publication);
    return publication;
  };

  return { audienceRefusal, publish, recorded };
};

/**
 * Publishing: putting one version of a document out to an audience (teams, a
 * team and the teams below it, or the whole org), who may then read that
 * version from wherever they are and are told it's there, and taking it back.
 */
export const publishingRoutes = async (app: FastifyInstance, deps: PublishingDeps & { publisher: Publisher }) => {
  const { store, onFloor, reach, principalsOf, directory, publisher } = deps;
  const { audienceRefusal, recorded } = publisher;
  const documentFor = documentFinder({ store, reach, principalsOf });
  const describe = describePrincipals(directory);

  /** A publication with its audience named. */
  const named = async (publication: Publication) => ({ ...publication, audience: await describe(publication.audience) });

  const managers = (reply: FastifyReply, what: string) => reply.code(403).send({ error: 'forbidden', message: `Only whoever manages this document can ${what} it.` });

  app.post<{ Params: { id: string; doc: string }; Body: { version: number; audience: string[]; note?: string } }>(
    '/libraries/:id/documents/:doc/publish',
    {
      schema: {
        params: DOC,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['version', 'audience'],
          properties: { version: { type: 'integer', minimum: 1 }, audience: { type: 'array', minItems: 1, maxItems: MAX_AUDIENCE, items: { type: 'string', maxLength: 120 } }, note: NOTE },
        },
      },
    },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const doc = await documentFor(caller, req.params, reply);
      if (!doc) return reply;
      if (!reaches(doc.level, 'manage')) return managers(reply, 'publish');
      const wanted = [...new Set(req.body.audience)];
      const refusal = await audienceRefusal(caller, doc.shelf, wanted);
      if (refusal) return reply.code(refusal.code).send({ error: refusal.error, message: refusal.message });
      const publication = await publisher.publish(caller, doc, { version: req.body.version, audience: wanted, note: req.body.note?.trim() || undefined });
      if (!publication) return reply.code(404).send({ error: 'not-found', message: 'There’s no such version of this document.' });
      return reply.code(201).send(await named(publication));
    },
  );

  app.post<{ Params: { id: string; doc: string }; Body: { reason?: string } }>(
    '/libraries/:id/documents/:doc/withdraw',
    { schema: { params: DOC, body: { type: 'object', additionalProperties: false, properties: { reason: NOTE } } } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const doc = await documentFor(caller, req.params, reply);
      if (!doc) return reply;
      if (!reaches(doc.level, 'manage')) return managers(reply, 'withdraw');
      const reason = req.body?.reason?.trim() || undefined;
      const publication = await store.withdraw({ document: doc.id, by: caller.id, reason });
      if (!publication) return reply.code(409).send({ error: 'not-published', message: 'It isn’t published, so there’s nothing to withdraw.' });
      await recorded({
        actor: caller.id,
        action: 'document.withdrawn',
        target: doc.id,
        workspace: doc.workspace,
        detail: { library: doc.library, title: doc.title, version: publication.version, ...(reason ? { reason } : {}) },
      });
      return named(publication);
    },
  );

  /** Every time it was published, newest first, with who it went to by name. Not for its audience: they see only what's out. */
  app.get<{ Params: { id: string; doc: string } }>('/libraries/:id/documents/:doc/publications', { schema: { params: DOC } }, async (req, reply) => {
    const caller = onFloor(req, reply);
    if (!caller) return reply;
    const doc = await documentFor(caller, req.params, reply);
    if (!doc) return reply;
    return {
      publications: await Promise.all((await store.publications(doc.id)).map(named)),
      can: { publish: documentRights(caller, doc).publish, publishToOrg: caller.roles.includes(PUBLISHER_ROLE) },
    };
  });

  /** What is out now to the caller, from any floor, newest first. */
  app.get<{ Querystring: { limit?: number; offset?: number } }>(
    '/published',
    {
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE }, offset: { type: 'integer', minimum: 0 } } },
      },
    },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      return store.publishedTo(await principalsOf(caller), { limit: req.query.limit ?? 50, offset: req.query.offset });
    },
  );

  /** Where a document is, for opening it from another app (`document.open` gives only its id). */
  app.get<{ Params: { doc: string } }>('/documents/:doc', { schema: { params: { type: 'object', properties: { doc: ID }, required: ['doc'] } } }, async (req, reply) => {
    const caller = onFloor(req, reply);
    if (!caller) return reply;
    const found = await store.document(req.params.doc);
    const doc = found && (await documentFor(caller, { id: found.library, doc: found.id }, reply, { audience: true }));
    if (!found) return reply.code(404).send({ error: 'not-found', message: 'There’s no such document, or it hasn’t been shared with you.' });
    if (!doc) return reply;
    return { id: doc.id, library: doc.library, title: doc.title, ...(doc.only ? { only: doc.only } : {}) };
  });
};
