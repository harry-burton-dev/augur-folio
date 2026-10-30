import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import {
  callerCheckFromEnv,
  callerFromHeaders,
  health,
  packageVersion,
  PeopleUnavailable,
  signedCallers,
  type AudienceLookup,
  type Caller,
  type CallerCheck,
  type CallerWorkspace,
  type DirectorySearch,
} from '@augur/service-kit';
import { auditFromEnv, type Audit } from './audit.ts';
import { documentRoutes } from './documents.ts';
import { MemoryObjectStore, type ObjectStore } from './objects.ts';
import { accessRoutes } from './access.ts';
import { notifyFromEnv, type Notify } from './notices.ts';
import { floorPrincipalOf, peopleFromEnv, type CallerPrincipals } from './people.ts';
import { publisherFor, publishingRoutes } from './publishing.ts';
import { homeRoutes } from './home.ts';
import { seriesRoutes } from './series.ts';
import { BadMoveError, BadLevelError, checkLevelName, CONTAINER_LIFECYCLE, type ContainerState } from '@augur/records';
import { BadParentError, BadTagError, checkPlace, ClosedError, furthest, levelFrom, MemoryFolioStore, NameTakenError, NotEmptyError, reaches, type FolioStore, type Level, type Library } from './store.ts';
import { placementRoutes } from './placements.ts';
import { tagRoutes } from './tags.ts';
import { FOLDER_LEVELS, UNIT_LEVELS, type FolderLevel, type UnitLevel } from './units.ts';

/** The major version of the API this service serves. Its routes go under /v1, as the platform's do. */
export const API_VERSION = 'v1';
const version = packageVersion(import.meta.url);

export interface Options {
  /** Checks the caller the gateway signed for Folio. In production it is on by default; in dev `x-user-*` headers are believed. */
  callers?: CallerCheck;
  store?: FolioStore;
  /** Where uploaded files go: Folio's bucket. */
  objects?: ObjectStore;
  /** The platform's audit log. */
  audit?: Audit;
  /** The most one upload may be, in bytes. */
  maxUploadBytes?: number;
  /** Who a caller stands for. From identity by default; without it, their floor (peopleFromEnv). */
  principals?: CallerPrincipals;
  /** People and teams to share with. */
  directory?: DirectorySearch;
  /** Who an audience reaches, to tell them something's published to them. */
  audience?: AudienceLookup;
  /** Tells people through the shell's stream. */
  notify?: Notify;
}

/** What the caller may do with a library, so the app only offers what will work. */
export interface LibraryRights {
  /** Rename, describe and archive the library, and tidy anyone's folders: the floor's leads. */
  manage: boolean;
  /** Make folders: anyone on the floor. */
  addFolders: boolean;
  /** Upload documents: anyone on the floor. */
  addDocuments: boolean;
  /** Make new tags for the library: its leads, or anyone when it takes free tags. */
  addTags: boolean;
  /** Let people and teams in, or take them out: whoever manages it. */
  share: boolean;
}

/**
 * A library as the caller reaches it. `level` is how far they're let in: the
 * floor's leads manage it and anyone who can stand on the floor reads it, and
 * grants add to that. `onFloor` is whether they're standing on its floor now,
 * where anyone may add folders and documents.
 */
export type HeldLibrary = Library & { level?: Level; onFloor: boolean };

export type OnFloor = Caller & { workspace: CallerWorkspace };

const NAME = { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' } as const;
const FOLDER_NAME = { type: 'string', minLength: 1, maxLength: 80, pattern: '^(?=.*\\S)[^/\\\\]+$' } as const;
const DESCRIPTION = { type: 'string', maxLength: 500 } as const;
const ID_PARAMS = { type: 'object', properties: { id: { type: 'string', maxLength: 64 } }, required: ['id'] } as const;
const FOLDER_PARAMS = { type: 'object', properties: { id: { type: 'string', maxLength: 64 }, folder: { type: 'string', maxLength: 64 } }, required: ['id', 'folder'] } as const;

/** What the caller may do in a library; with none, on the floor they're standing on (making a library). */
export const rightsOn = (caller: OnFloor, library?: Pick<HeldLibrary, 'freeTags' | 'level' | 'onFloor'>): LibraryRights => {
  const manage = library ? reaches(library.level, 'manage') : caller.workspace.role === 'lead';
  const add = library ? library.onFloor || reaches(library.level, 'edit') : true;
  return { manage, addFolders: add, addDocuments: add, addTags: manage || (add && Boolean(library?.freeTags)), share: manage };
};

export const buildApp = async ({ callers = callerCheckFromEnv('folio'), store = new MemoryFolioStore(), objects = new MemoryObjectStore(), audit, maxUploadBytes, notify, ...people }: Options = {}) => {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  const fromEnv = peopleFromEnv(store);
  const principalsOf = people.principals ?? fromEnv.principals;
  const directory = people.directory ?? fromEnv.directory;
  const audience = people.audience ?? fromEnv.audience;
  const tell = notify ?? notifyFromEnv((notice) => app.log.info({ notice }, 'notification (no notifications here)'));
  const record = audit ?? auditFromEnv((entry) => app.log.info({ audit: entry }, 'audit (no audit log here)'));
  const recorded = (entry: Parameters<Audit>[0]) =>
    record(entry).catch((err: Error) => app.log.error({ err: err.message, action: entry.action, target: entry.target }, 'could not record in the audit log'));
  // Only the gateway's signed word says who is calling: headers anyone could send are dropped.
  app.addHook('onRequest', signedCallers(callers));
  app.get('/healthz', async () => health('folio', version, API_VERSION));

  /** The caller and the floor they're on, or a refusal already sent. Folio's libraries all live on a floor. */
  const onFloor = (req: FastifyRequest, reply: FastifyReply): OnFloor | undefined => {
    const caller = callerFromHeaders(req.headers);
    if (!caller) {
      reply.code(401).send({ error: 'unauthenticated', message: 'Sign in to use Artifacts.' });
      return undefined;
    }
    if (!caller.workspace) {
      reply.code(400).send({ error: 'floor-needed', message: 'Say which floor the libraries are on (X-Workspace-Id).' });
      return undefined;
    }
    return caller as OnFloor;
  };

  /** A library and how far the caller is let in, which may be not at all. Archived ones only when asked. */
  const reach = async (caller: OnFloor, id: string, { archived = false } = {}): Promise<HeldLibrary | undefined> => {
    const library = await store.library(id, { archived });
    if (!library) return undefined;
    const principals = await principalsOf(caller);
    const onFloor = library.workspace === caller.workspace.id;
    const floor: Level | undefined = onFloor ? (caller.workspace.role === 'lead' ? 'manage' : 'read') : principals.includes(library.floor) ? 'read' : undefined;
    return { ...library, onFloor, level: furthest(floor, levelFrom(await store.grants(library.id), principals)) };
  };

  /** The library, when the caller may see it. One they may not is as good as not there. */
  const libraryFor = async (caller: OnFloor, id: string, reply: FastifyReply): Promise<HeldLibrary | undefined> => {
    const library = await reach(caller, id);
    if (!library?.level) {
      reply.code(404).send({ error: 'not-found', message: 'There’s no such library, or it hasn’t been shared with you.' });
      return undefined;
    }
    return library;
  };

  const managersOnly = (caller: OnFloor, library: HeldLibrary, reply: FastifyReply) => {
    if (rightsOn(caller, library).manage) return true;
    reply.code(403).send({ error: 'forbidden', message: 'Only whoever manages this library can do that.' });
    return false;
  };

  /** Store refusals people can act on, as 409s with the store's own words. */
  const refused = (err: unknown, reply: FastifyReply) => {
    if (err instanceof NameTakenError || err instanceof NotEmptyError) return reply.code(409).send({ error: err instanceof NameTakenError ? 'name-taken' : 'not-empty', message: err.message });
    if (err instanceof ClosedError) return reply.code(409).send({ error: 'closed', message: err.message });
    if (err instanceof BadMoveError) return reply.code(409).send({ error: 'bad-move', message: err.message });
    if (err instanceof BadLevelError) return reply.code(400).send({ error: 'bad-level', message: err.message });
    if (err instanceof BadParentError) return reply.code(400).send({ error: 'bad-parent', message: err.message });
    if (err instanceof BadTagError) return reply.code(400).send({ error: 'bad-tag', message: err.message });
    throw err;
  };

  await app.register(
    async (app) => {
      // Identity out of reach: who the caller stands for can't be worked out, so nothing is let through.
      app.setErrorHandler((err, req, reply) => {
        if (!(err instanceof PeopleUnavailable)) return reply.send(err);
        req.log.error({ err: err.message }, 'could not ask identity who the caller is');
        return reply.code(503).send({ error: 'unavailable', message: 'Artifacts can’t check who you are right now. Try again in a moment.' });
      });

      /** The levels the library is built from, called what the org calls them. */
      const namedLevels = async () => UNIT_LEVELS.named(await store.levelNames());

      app.get<{ Querystring: { archived?: boolean } }>(
        '/libraries',
        { schema: { querystring: { type: 'object', additionalProperties: false, properties: { archived: { type: 'boolean' } } } } },
        async (req, reply) => {
          const caller = onFloor(req, reply);
          if (!caller) return reply;
          // Archived ones are for whoever can bring them back: the floor's leads.
          const archived = Boolean(req.query.archived) && rightsOn(caller).manage;
          return { libraries: await store.libraries(caller.workspace.id, { archived }), can: { create: rightsOn(caller).manage } };
        },
      );

      app.get('/levels', async (req, reply) => {
        const caller = onFloor(req, reply);
        if (!caller) return reply;
        const levels = await namedLevels();
        return { levels: levels.all.map(({ id, name, plural, holds }) => ({ id, name, plural, holds })), top: levels.top, can: { rename: caller.workspace.kind === 'org' && caller.workspace.role === 'lead' } };
      });

      const LEVEL_PARAMS = { type: 'object', properties: { level: { type: 'string', enum: UNIT_LEVELS.all.map((l) => l.id) } }, required: ['level'] } as const;
      const LEVEL_NAME = { type: 'string', minLength: 1, maxLength: 30, pattern: '\\S' } as const;

      /** Renames a level for the whole org, or gives it its own name back: the org's leads, on the org's floor. */
      const nameLevel = async (req: FastifyRequest<{ Params: { level: UnitLevel }; Body?: { name: string; plural: string } }>, reply: FastifyReply) => {
        const caller = onFloor(req, reply);
        if (!caller) return reply;
        if (caller.workspace.kind !== 'org' || caller.workspace.role !== 'lead') return reply.code(403).send({ error: 'forbidden', message: 'Only the org’s leads can rename the levels, from the org’s floor.' });
        try {
          const name = req.body ? checkLevelName(req.body) : null;
          await store.setLevelName(req.params.level, name, caller.id);
          await recorded({ actor: caller.id, action: 'level.renamed', target: req.params.level, workspace: caller.workspace.id, detail: { level: req.params.level, ...(name ?? { reset: true }) } });
          return reply.code(200).send({ levels: (await namedLevels()).all.map(({ id, name, plural, holds }) => ({ id, name, plural, holds })) });
        } catch (err) {
          return refused(err, reply);
        }
      };
      app.put<{ Params: { level: UnitLevel }; Body: { name: string; plural: string } }>(
        '/levels/:level',
        { schema: { params: LEVEL_PARAMS, body: { type: 'object', additionalProperties: false, required: ['name', 'plural'], properties: { name: LEVEL_NAME, plural: LEVEL_NAME } } } },
        nameLevel,
      );
      app.delete<{ Params: { level: UnitLevel } }>('/levels/:level', { schema: { params: LEVEL_PARAMS } }, nameLevel);

      app.post<{ Body: { name: string; description?: string } }>(
        '/libraries',
        { schema: { body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: NAME, description: DESCRIPTION } } } },
        async (req, reply) => {
          const caller = onFloor(req, reply);
          if (!caller) return reply;
          if (!rightsOn(caller).manage) return reply.code(403).send({ error: 'forbidden', message: 'Only the floor’s leads can do that.' });
          try {
            const library = await store.createLibrary({ workspace: caller.workspace.id, floor: floorPrincipalOf(caller), name: req.body.name.trim(), description: req.body.description?.trim(), createdBy: caller.id });
            await recorded({ actor: caller.id, action: 'library.created', target: library.id, workspace: library.workspace, detail: { name: library.name } });
            return reply.code(201).send({ ...library, can: rightsOn(caller, { ...library, level: 'manage', onFloor: true }) });
          } catch (err) {
            return refused(err, reply);
          }
        },
      );

      app.get<{ Params: { id: string } }>('/libraries/:id', { schema: { params: ID_PARAMS } }, async (req, reply) => {
        const caller = onFloor(req, reply);
        if (!caller) return reply;
        const library = await libraryFor(caller, req.params.id, reply);
        if (!library) return reply;
        const [folders, tags, authors, views, series] = await Promise.all([
          store.folders(library.id),
          store.tags(library.id),
          store.authors(library.id),
          store.views(library.id),
          store.seriesIn(library.id),
        ]);
        return { ...library, folders, tags, authors, views, series, can: rightsOn(caller, library) };
      });

      app.patch<{ Params: { id: string }; Body: { name?: string; description?: string; freeTags?: boolean } }>(
        '/libraries/:id',
        {
          schema: {
            params: ID_PARAMS,
            body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { name: NAME, description: DESCRIPTION, freeTags: { type: 'boolean' } } },
          },
        },
        async (req, reply) => {
          const caller = onFloor(req, reply);
          if (!caller) return reply;
          const library = await libraryFor(caller, req.params.id, reply);
          if (!library || !managersOnly(caller, library, reply)) return reply;
          try {
            return await store.updateLibrary(library.id, { name: req.body.name?.trim(), description: req.body.description?.trim(), freeTags: req.body.freeTags });
          } catch (err) {
            return refused(err, reply);
          }
        },
      );

      const STATE_BODY = {
        type: 'object',
        additionalProperties: false,
        required: ['state'],
        properties: { state: { type: 'string', enum: CONTAINER_LIFECYCLE.states.map((s) => s.id) }, note: { type: 'string', maxLength: 500 } },
      } as const;

      /** Moves a library through its lifecycle: open, closed, archived. An archived one can be found again to bring it back. */
      app.put<{ Params: { id: string }; Body: { state: ContainerState; note?: string } }>('/libraries/:id/state', { schema: { params: ID_PARAMS, body: STATE_BODY } }, async (req, reply) => {
        const caller = onFloor(req, reply);
        if (!caller) return reply;
        const library = await reach(caller, req.params.id, { archived: true });
        if (!library?.level) return reply.code(404).send({ error: 'not-found', message: 'There’s no such library, or it hasn’t been shared with you.' });
        try {
          CONTAINER_LIFECYCLE.check(library.state, req.body.state, rightsOn(caller, library).manage ? 'manage' : library.level);
          const moved = await store.setLibraryState(library.id, req.body.state, caller.id, req.body.note?.trim() || undefined);
          if (!moved) return reply.code(409).send({ error: 'bad-move', message: 'It changed in the meantime. Look again.' });
          await recorded({ actor: caller.id, action: `library.${req.body.state === 'open' ? 'opened' : req.body.state}`, target: library.id, workspace: library.workspace, detail: { name: library.name, from: library.state } });
          return { ...moved, can: rightsOn(caller, { ...moved, level: library.level, onFloor: library.onFloor }) };
        } catch (err) {
          return refused(err, reply);
        }
      });

      /** Every lifecycle move of the library, or of one of its folders. */
      app.get<{ Params: { id: string }; Querystring: { folder?: string } }>(
        '/libraries/:id/moves',
        { schema: { params: ID_PARAMS, querystring: { type: 'object', additionalProperties: false, properties: { folder: { type: 'string', maxLength: 64 } } } } },
        async (req, reply) => {
          const caller = onFloor(req, reply);
          if (!caller) return reply;
          const library = await libraryFor(caller, req.params.id, reply);
          if (!library) return reply;
          if (req.query.folder && !(await store.folders(library.id)).some((f) => f.id === req.query.folder)) return reply.code(404).send({ error: 'not-found', message: 'There’s no such folder in this library.' });
          return { moves: await store.stateMoves(req.query.folder ?? library.id) };
        },
      );

      app.post<{ Params: { id: string } }>('/libraries/:id/archive', { schema: { params: ID_PARAMS } }, async (req, reply) => {
        const caller = onFloor(req, reply);
        if (!caller) return reply;
        const library = await libraryFor(caller, req.params.id, reply);
        if (!library || !managersOnly(caller, library, reply)) return reply;
        await store.archiveLibrary(library.id, caller.id);
        await recorded({ actor: caller.id, action: 'library.archived', target: library.id, workspace: library.workspace, detail: { name: library.name } });
        return reply.code(204).send();
      });

      app.post<{ Params: { id: string }; Body: { name: string; parent?: string; level?: FolderLevel; description?: string } }>(
        '/libraries/:id/folders',
        {
          schema: {
            params: ID_PARAMS,
            body: {
              type: 'object',
              additionalProperties: false,
              required: ['name'],
              properties: { name: FOLDER_NAME, parent: { type: 'string', maxLength: 64 }, level: { type: 'string', enum: FOLDER_LEVELS }, description: DESCRIPTION },
            },
          },
        },
        async (req, reply) => {
          const caller = onFloor(req, reply);
          if (!caller) return reply;
          const library = await libraryFor(caller, req.params.id, reply);
          if (!library) return reply;
          if (!rightsOn(caller, library).addFolders) return reply.code(403).send({ error: 'forbidden', message: 'You can read this library, but not add to it.' });
          try {
            // Refused in the org's own words for the levels before the store checks again.
            const level = checkPlace(await store.folders(library.id), req.body.parent, req.body.level, await namedLevels());
            return reply.code(201).send(
              await store.createFolder({ library: library.id, parent: req.body.parent, level, name: req.body.name.trim(), description: req.body.description?.trim(), createdBy: caller.id }),
            );
          } catch (err) {
            return refused(err, reply);
          }
        },
      );

      /** A folder may be renamed or removed by whoever made it (while they may still add to the library), or by its managers. */
      const folderFor = async (caller: OnFloor, library: HeldLibrary, id: string, reply: FastifyReply) => {
        const folder = (await store.folders(library.id)).find((f) => f.id === id);
        if (!folder) {
          reply.code(404).send({ error: 'not-found', message: 'There’s no such folder in this library.' });
          return undefined;
        }
        const rights = rightsOn(caller, library);
        if (!rights.manage && !(folder.createdBy === caller.id && rights.addFolders)) {
          reply.code(403).send({ error: 'forbidden', message: 'Only whoever made the folder, or whoever manages the library, can change it.' });
          return undefined;
        }
        return folder;
      };

      app.patch<{ Params: { id: string; folder: string }; Body: { name?: string; description?: string } }>(
        '/libraries/:id/folders/:folder',
        { schema: { params: FOLDER_PARAMS, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { name: FOLDER_NAME, description: DESCRIPTION } } } },
        async (req, reply) => {
          const caller = onFloor(req, reply);
          if (!caller) return reply;
          const library = await libraryFor(caller, req.params.id, reply);
          if (!library || !(await folderFor(caller, library, req.params.folder, reply))) return reply;
          try {
            return await store.updateFolder(library.id, req.params.folder, { name: req.body.name?.trim(), description: req.body.description?.trim() });
          } catch (err) {
            return refused(err, reply);
          }
        },
      );

      /** Moves a subcollection, series or subseries through its lifecycle: whoever manages the library. */
      app.put<{ Params: { id: string; folder: string }; Body: { state: ContainerState; note?: string } }>(
        '/libraries/:id/folders/:folder/state',
        { schema: { params: FOLDER_PARAMS, body: STATE_BODY } },
        async (req, reply) => {
          const caller = onFloor(req, reply);
          if (!caller) return reply;
          const library = await libraryFor(caller, req.params.id, reply);
          if (!library) return reply;
          const folder = (await store.folders(library.id)).find((f) => f.id === req.params.folder);
          if (!folder) return reply.code(404).send({ error: 'not-found', message: 'There’s no such folder in this library.' });
          try {
            CONTAINER_LIFECYCLE.check(folder.state, req.body.state, rightsOn(caller, library).manage ? 'manage' : library.level);
            const moved = await store.setFolderState(library.id, folder.id, req.body.state, caller.id, req.body.note?.trim() || undefined);
            if (!moved) return reply.code(409).send({ error: 'bad-move', message: 'It changed in the meantime. Look again.' });
            await recorded({ actor: caller.id, action: `folder.${req.body.state === 'open' ? 'opened' : req.body.state}`, target: folder.id, workspace: library.workspace, detail: { library: library.id, name: folder.name, level: folder.level, from: folder.state } });
            return moved;
          } catch (err) {
            return refused(err, reply);
          }
        },
      );

      app.delete<{ Params: { id: string; folder: string } }>('/libraries/:id/folders/:folder', { schema: { params: FOLDER_PARAMS } }, async (req, reply) => {
        const caller = onFloor(req, reply);
        if (!caller) return reply;
        const library = await libraryFor(caller, req.params.id, reply);
        if (!library || !(await folderFor(caller, library, req.params.folder, reply))) return reply;
        try {
          await store.deleteFolder(library.id, req.params.folder);
          return reply.code(204).send();
        } catch (err) {
          return refused(err, reply);
        }
      });

      const publisher = publisherFor({ store, audit: record, directory, audience, notify: tell, log: app.log });
      await documentRoutes(app, { store, objects, audit: record, onFloor, reach, libraryFor, principalsOf, refused, log: app.log, publisher, maxUploadBytes });
      await accessRoutes(app, { store, audit: record, onFloor, reach, libraryFor, principalsOf, directory, log: app.log });
      await tagRoutes(app, { store, onFloor, libraryFor, refused, rightsOn });
      await publishingRoutes(app, { store, audit: record, onFloor, reach, principalsOf, directory, audience, notify: tell, log: app.log, publisher });
      await seriesRoutes(app, { store, audit: record, onFloor, reach, libraryFor, principalsOf, directory, publisher, refused });
      await homeRoutes(app, { store, onFloor, principalsOf });
      await placementRoutes(app, { store, audit: record, onFloor, reach, principalsOf, directory, audience, notify: tell, log: app.log });
    },
    { prefix: `/${API_VERSION}` },
  );
  return app;
};
