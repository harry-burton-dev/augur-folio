import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DirectorySearch } from '@augur/service-kit';
import type { Audit } from './audit.ts';
import { rightsOn, type HeldLibrary, type OnFloor } from './app.ts';
import { documentFinder, documentRights, type HeldDocument } from './documents.ts';
import type { CallerPrincipals } from './people.ts';
import { LEVELS, PRINCIPAL, reaches, type FolioStore, type Grant, type Level } from './store.ts';

export interface AccessDeps {
  store: FolioStore;
  audit: Audit;
  onFloor(req: FastifyRequest, reply: FastifyReply): OnFloor | undefined;
  reach(caller: OnFloor, id: string): Promise<HeldLibrary | undefined>;
  libraryFor(caller: OnFloor, id: string, reply: FastifyReply): Promise<HeldLibrary | undefined>;
  principalsOf: CallerPrincipals;
  directory: DirectorySearch;
  log: { error(obj: object, msg: string): void };
}

/** A principal as people see it: what kind it is and who, by name, when the directory knows them. */
export interface Described {
  principal: string;
  kind: 'person' | 'team' | 'tree' | 'org';
  name?: string;
  email?: string;
  /** For a team: the teams it sits in, from the top down. */
  within?: string[];
}

const ID = { type: 'string', maxLength: 64 } as const;
const PRINCIPAL_PARAM = { type: 'string', maxLength: 120 } as const;
const LEVEL_BODY = { type: 'object', additionalProperties: false, required: ['level'], properties: { level: { type: 'string', enum: LEVELS } } } as const;

const kindOf = (principal: string) => (principal === 'org' ? 'org' : (principal.split(':')[0] as Described['kind']));
const idOf = (principal: string) => principal.slice(principal.indexOf(':') + 1);

/**
 * Who may see a library or a document, and letting people and teams in: a
 * grant on a library reaches all of it, one on a document just that. Anyone who
 * can see it can see who else can; whoever manages it can change that. Every
 * change is on the record, and each document's readers follow it at once.
 */
export const accessRoutes = async (app: FastifyInstance, { store, audit, onFloor, reach, libraryFor, principalsOf, directory, log }: AccessDeps) => {
  const documentFor = documentFinder({ store, reach, principalsOf });

  /** Names the principals, as far as the directory knows them. */
  const describe = async (principals: readonly string[]): Promise<Described[]> => {
    const ids = [...new Set(principals.filter((p) => p !== 'org').map(idOf))];
    const found = ids.length ? await directory({ ids }) : { people: [], teams: [] };
    const people = new Map(found.people.map((p) => [p.id, p]));
    const teams = new Map(found.teams.map((t) => [t.id, t]));
    return principals.map((principal) => {
      const kind = kindOf(principal);
      if (kind === 'org') return { principal, kind };
      if (kind === 'person') {
        const person = people.get(idOf(principal));
        return { principal, kind, ...(person ? { name: person.name, ...(person.email ? { email: person.email } : {}) } : {}) };
      }
      const team = teams.get(idOf(principal));
      return { principal, kind, ...(team ? { name: team.name, within: team.within } : {}) };
    });
  };

  const withNames = async (grants: Grant[]) => {
    const described = await describe(grants.map((g) => g.principal));
    return grants.map((g, i) => ({ ...described[i], level: g.level, createdBy: g.createdBy, createdAt: g.createdAt }));
  };

  /** The library's floor first, then whoever has been let in. */
  const libraryAccess = async (library: HeldLibrary) => {
    const [[floor], grants] = await Promise.all([describe([library.floor]), store.grants(library.id)]);
    return { floor, grants: await withNames(grants) };
  };

  const documentAccess = async (caller: OnFloor, doc: HeldDocument) => {
    const [library, grants] = await Promise.all([libraryAccess(doc.shelf), store.grants(doc.library, doc.id)]);
    return { ...library, library: library.grants, grants: await withNames(grants), can: { share: documentRights(caller, doc).share } };
  };

  const recorded = (entry: Parameters<Audit>[0]) =>
    audit(entry).catch((err: Error) => log.error({ err: err.message, action: entry.action, target: entry.target }, 'could not record in the audit log'));

  /**
   * Checks a principal can be let in: well formed, not the floor (already in),
   * and someone or some team the directory knows. Sends the refusal otherwise.
   */
  const checkPrincipal = async (principal: string, floor: string, reply: FastifyReply) => {
    if (!PRINCIPAL.test(principal)) return void reply.code(400).send({ error: 'bad-principal', message: 'Share with a person, a team, a team and the teams below it, or the whole org.' });
    if (principal === floor) return void reply.code(400).send({ error: 'already-in', message: 'Everyone there can already see it.' });
    if (principal !== 'org') {
      const [found] = await describe([principal]);
      if (!found.name) return void reply.code(400).send({ error: 'unknown-principal', message: 'There’s no such person or team.' });
    }
    return true;
  };

  /** Lets a principal in, changes how far, or takes them out; on the record either way. */
  const change = async (caller: OnFloor, target: { library: HeldLibrary; document?: HeldDocument }, principal: string, level: Level | null) => {
    const { library, document } = target;
    const was = (await store.grants(library.id, document?.id)).find((g) => g.principal === principal)?.level;
    if (was === (level ?? undefined)) return;
    await store.setGrant({ library: library.id, document: document?.id, principal, level, by: caller.id });
    const action = !level ? 'access.removed' : was ? 'access.changed' : 'access.granted';
    await recorded({
      actor: caller.id,
      action,
      target: document?.id ?? library.id,
      workspace: library.workspace,
      detail: { library: library.id, ...(document ? { document: document.id, title: document.title } : { name: library.name }), principal, ...(level ? { level } : {}), ...(was ? { was } : {}) },
    });
  };

  const managers = (reply: FastifyReply, what: string) => reply.code(403).send({ error: 'forbidden', message: `Only whoever manages this ${what} can share it.` });

  // ---- people and teams to share with ----

  app.get<{ Querystring: { q?: string } }>(
    '/people',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { q: { type: 'string', maxLength: 100 } } } } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const q = req.query.q?.trim();
      if (!q) return { people: [], teams: [] };
      const found = await directory({ q, limit: 8 });
      return { people: found.people.filter((p) => p.id !== caller.id), teams: found.teams };
    },
  );

  /** What has been shared with the caller from libraries on other floors. */
  app.get('/shared', async (req, reply) => {
    const caller = onFloor(req, reply);
    if (!caller) return reply;
    const { libraries, documents } = await store.shared(await principalsOf(caller), caller.workspace.id);
    const names = new Map((await Promise.all([...new Set(documents.map((d) => d.library))].map((id) => store.library(id)))).flatMap((l) => (l ? [[l.id, l.name]] : [])));
    return {
      libraries: libraries.map((l) => ({ ...l, can: rightsOn(caller, { ...l, onFloor: false }) })),
      documents: documents.map((d) => ({ ...d, libraryName: names.get(d.library) ?? '' })),
    };
  });

  // ---- a library ----

  app.get<{ Params: { id: string } }>('/libraries/:id/access', { schema: { params: { type: 'object', properties: { id: ID }, required: ['id'] } } }, async (req, reply) => {
    const caller = onFloor(req, reply);
    if (!caller) return reply;
    const library = await libraryFor(caller, req.params.id, reply);
    if (!library) return reply;
    return { ...(await libraryAccess(library)), can: { share: rightsOn(caller, library).share } };
  });

  const LIBRARY_PRINCIPAL = { type: 'object', properties: { id: ID, principal: PRINCIPAL_PARAM }, required: ['id', 'principal'] } as const;

  const shareLibrary = async (req: FastifyRequest<{ Params: { id: string; principal: string } }>, reply: FastifyReply, level: Level | null) => {
    const caller = onFloor(req, reply);
    if (!caller) return reply;
    const library = await libraryFor(caller, req.params.id, reply);
    if (!library) return reply;
    if (!rightsOn(caller, library).share) return managers(reply, 'library');
    if (level && !(await checkPrincipal(req.params.principal, library.floor, reply))) return reply;
    await change(caller, { library }, req.params.principal, level);
    return { ...(await libraryAccess(library)), can: { share: true } };
  };

  app.put<{ Params: { id: string; principal: string }; Body: { level: Level } }>('/libraries/:id/access/:principal', { schema: { params: LIBRARY_PRINCIPAL, body: LEVEL_BODY } }, (req, reply) =>
    shareLibrary(req, reply, req.body.level),
  );
  app.delete<{ Params: { id: string; principal: string } }>('/libraries/:id/access/:principal', { schema: { params: LIBRARY_PRINCIPAL } }, (req, reply) => shareLibrary(req, reply, null));

  // ---- one document ----

  const DOC = { type: 'object', properties: { id: ID, doc: ID }, required: ['id', 'doc'] } as const;
  const DOC_PRINCIPAL = { type: 'object', properties: { id: ID, doc: ID, principal: PRINCIPAL_PARAM }, required: ['id', 'doc', 'principal'] } as const;

  app.get<{ Params: { id: string; doc: string } }>('/libraries/:id/documents/:doc/access', { schema: { params: DOC } }, async (req, reply) => {
    const caller = onFloor(req, reply);
    if (!caller) return reply;
    const doc = await documentFor(caller, req.params, reply);
    if (!doc) return reply;
    return documentAccess(caller, doc);
  });

  const shareDocument = async (req: FastifyRequest<{ Params: { id: string; doc: string; principal: string } }>, reply: FastifyReply, level: Level | null) => {
    const caller = onFloor(req, reply);
    if (!caller) return reply;
    const doc = await documentFor(caller, req.params, reply);
    if (!doc) return reply;
    if (!reaches(doc.level, 'manage')) return managers(reply, 'document');
    if (level && !(await checkPrincipal(req.params.principal, doc.shelf.floor, reply))) return reply;
    await change(caller, { library: doc.shelf, document: doc }, req.params.principal, level);
    return documentAccess(caller, doc);
  };

  app.put<{ Params: { id: string; doc: string; principal: string }; Body: { level: Level } }>(
    '/libraries/:id/documents/:doc/access/:principal',
    { schema: { params: DOC_PRINCIPAL, body: LEVEL_BODY } },
    (req, reply) => shareDocument(req, reply, req.body.level),
  );
  app.delete<{ Params: { id: string; doc: string; principal: string } }>('/libraries/:id/documents/:doc/access/:principal', { schema: { params: DOC_PRINCIPAL } }, (req, reply) =>
    shareDocument(req, reply, null),
  );
};
