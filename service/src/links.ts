import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fits, isRecordRef, isRelation, RELATIONS, type RecordRef } from '@augur/records';
import type { Audit } from './audit.ts';
import { rightsOn, type HeldLibrary, type OnFloor } from './app.ts';
import { documentFinder, documentRights } from './documents.ts';
import type { CallerPrincipals } from './people.ts';
import { LinkedError, type FolioStore, type RecordLink } from './store.ts';

export interface LinkDeps {
  store: FolioStore;
  audit: Audit;
  onFloor(req: FastifyRequest, reply: FastifyReply): OnFloor | undefined;
  reach(caller: OnFloor, id: string): Promise<HeldLibrary | undefined>;
  principalsOf: CallerPrincipals;
  log: { error(obj: object, msg: string): void };
}

/** What Artifacts' own records are called in a link to them: `unit`, by `<library>/<record>`. */
export const UNIT = 'unit';
export const unitId = (library: string, record: string) => `${library}/${record}`;

const ID = { type: 'string', maxLength: 64 } as const;
const PARAMS = { type: 'object', properties: { id: ID }, required: ['id'] } as const;

/**
 * Relationships (docs/app-patterns.md, `@augur/records`): typed links from a
 * library, folder or document to another record, here (`unit`) or in another
 * app (an entity in Data Atlas, an intent in Mandate). Anyone who can see the
 * record sees its links, both ways; whoever may change it links and unlinks.
 * A linked record the caller can't open stays listed, and says so.
 */
export const linkRoutes = async (app: FastifyInstance, { store, audit, onFloor, reach, principalsOf, log }: LinkDeps) => {
  const documentFor = documentFinder({ store, reach, principalsOf });
  const recorded = (entry: Parameters<Audit>[0]) =>
    audit(entry).catch((err: Error) => log.error({ err: err.message, action: entry.action, target: entry.target }, 'could not record in the audit log'));

  /** The record in the library and what the caller may do with it: undefined (and a 404 sent) when they can't see it. */
  const recordFor = async (caller: OnFloor, library: string, record: string, reply: FastifyReply) => {
    const held = await reach(caller, library);
    if (held?.level && record === library) return { kind: 'library' as const, name: held.name, change: rightsOn(caller, held).addFolders };
    const folder = held?.level && record !== library ? (await store.folders(library)).find((f) => f.id === record) : undefined;
    if (held && folder) return { kind: 'folder' as const, name: folder.name, change: rightsOn(caller, held).addFolders };
    if (record !== library) {
      const doc = await documentFor(caller, { id: library, doc: record }, reply, { audience: true });
      if (!doc) return undefined;
      return { kind: 'document' as const, name: doc.title, change: documentRights(caller, doc).change };
    }
    reply.code(404).send({ error: 'not-found', message: 'There’s no such thing, or it hasn’t been shared with you.' });
    return undefined;
  };

  /** What one of Artifacts' own records is called, for whoever asks: undefined when they can't open it. */
  const unitFor = async (caller: OnFloor, id: string) => {
    const [library, record] = id.split('/');
    if (!library || !record) return undefined;
    const quiet = { code: () => quiet, send: () => quiet } as unknown as FastifyReply;
    const found = await recordFor(caller, library, record, quiet);
    return found && { library, record, kind: found.kind, name: found.name };
  };

  /** A link as the caller sees it: the other end named, and whether they can open it. */
  const shown = async (caller: OnFloor, l: RecordLink, back = false) => {
    const def = RELATIONS.find((r) => r.id === l.relation);
    const words = back ? def?.inverse : def?.name;
    if (back) {
      const from = await unitFor(caller, unitId(l.library, l.from));
      return { id: l.id, relation: l.relation, words: words ?? l.relation, from: from ?? { unavailable: 'Something you can’t open links here.' }, by: l.by, at: l.at };
    }
    if (l.to.app !== 'folio') return { id: l.id, relation: l.relation, words: words ?? l.relation, to: l.to, by: l.by, at: l.at };
    const unit = await unitFor(caller, l.to.id);
    return {
      id: l.id,
      relation: l.relation,
      words: words ?? l.relation,
      to: { ...l.to, ...(unit ? { label: unit.name, library: unit.library, record: unit.record, unitKind: unit.kind } : { unavailable: `${l.to.label ?? 'It'} isn’t shared with you.` }) },
      by: l.by,
      at: l.at,
    };
  };

  app.get<{ Params: { id: string }; Querystring: { record: string } }>(
    '/libraries/:id/links',
    { schema: { params: PARAMS, querystring: { type: 'object', additionalProperties: false, required: ['record'], properties: { record: ID } } } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const record = await recordFor(caller, req.params.id, req.query.record, reply);
      if (!record) return reply;
      const { from, to } = await store.links(req.query.record, unitId(req.params.id, req.query.record));
      return {
        kinds: RELATIONS,
        links: await Promise.all(from.map((l) => shown(caller, l))),
        back: await Promise.all(to.map((l) => shown(caller, l, true))),
        can: { change: record.change },
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { record: string; relation: string; to: RecordRef } }>(
    '/libraries/:id/links',
    {
      schema: {
        params: PARAMS,
        body: { type: 'object', additionalProperties: false, required: ['record', 'relation', 'to'], properties: { record: ID, relation: { type: 'string', maxLength: 40 }, to: { type: 'object' } } },
      },
    },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const record = await recordFor(caller, req.params.id, req.body.record, reply);
      if (!record) return reply;
      if (!record.change) return reply.code(403).send({ error: 'forbidden', message: 'Only whoever may change it can link it to something.' });
      const { relation, to } = req.body;
      if (!isRelation(relation)) return reply.code(400).send({ error: 'bad-link', message: 'That isn’t a kind of link Artifacts knows.' });
      if (!isRecordRef(to)) return reply.code(400).send({ error: 'bad-link', message: 'Say what it links to: its app, its kind and its id.' });
      if (!fits(relation, to, 'folio'))
        return reply.code(400).send({
          error: 'bad-link',
          message: relation === 'about' ? '“About” links to a thing in Data Atlas.' : relation === 'serves' ? '“Serves” links to an intent in Mandate.' : 'This kind of link is to something else in Artifacts.',
        });
      let label = to.label;
      if (to.app === 'folio') {
        if (to.id === unitId(req.params.id, req.body.record)) return reply.code(400).send({ error: 'bad-link', message: 'Something can’t be linked to itself.' });
        const unit = to.kind === UNIT ? await unitFor(caller, to.id) : undefined;
        if (!unit) return reply.code(400).send({ error: 'bad-link', message: 'Link to something in Artifacts you can open.' });
        label = unit.name;
      }
      try {
        const made = await store.link({ library: req.params.id, from: req.body.record, relation, to: { app: to.app, kind: to.kind, id: to.id, ...(label ? { label } : {}) }, by: caller.id });
        await recorded({ actor: caller.id, action: 'record.linked', target: req.body.record, workspace: caller.workspace.id, detail: { library: req.params.id, relation, to: made.to } });
        return reply.code(201).send(await shown(caller, made));
      } catch (err) {
        if (err instanceof LinkedError) return reply.code(409).send({ error: 'already-linked', message: err.message });
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string; link: string }; Querystring: { record: string } }>(
    '/libraries/:id/links/:link',
    {
      schema: {
        params: { type: 'object', properties: { id: ID, link: ID }, required: ['id', 'link'] },
        querystring: { type: 'object', additionalProperties: false, required: ['record'], properties: { record: ID } },
      },
    },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const record = await recordFor(caller, req.params.id, req.query.record, reply);
      if (!record) return reply;
      if (!record.change) return reply.code(403).send({ error: 'forbidden', message: 'Only whoever may change it can unlink it.' });
      const gone = await store.unlink(req.query.record, req.params.link);
      if (!gone) return reply.code(404).send({ error: 'not-found', message: 'There’s no such link.' });
      await recorded({ actor: caller.id, action: 'record.unlinked', target: req.query.record, workspace: caller.workspace.id, detail: { library: req.params.id, relation: gone.relation, to: gone.to } });
      return reply.code(204).send();
    },
  );
};
