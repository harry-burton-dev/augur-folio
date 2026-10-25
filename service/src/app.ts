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
import { seriesRoutes } from './series.ts';
import { BadParentError, BadTagError, furthest, levelFrom, MemoryFolioStore, NameTakenError, NotEmptyError, reaches, type FolioStore, type Level, type Library } from './store.ts';
import { tagRoutes } from './tags.ts';

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
      reply.code(401).send({ error: 'unauthenticated', message: 'Sign in to use Folio.' });
      return undefined;
    }
    if (!caller.workspace) {
      reply.code(400).send({ error: 'floor-needed', message: 'Say which floor the libraries are on (X-Workspace-Id).' });
      return undefined;
    }
    return caller as OnFloor;
  };

  /** A library and how far the caller is let in, which may be not at all. */
  const reach = async (caller: OnFloor, id: string): Promise<HeldLibrary | undefined> => {
    const library = await store.library(id);
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
        return reply.code(503).send({ error: 'unavailable', message: 'Folio can’t check who you are right now. Try again in a moment.' });
      });

      app.get('/libraries', async (req, reply) => {
        const caller = onFloor(req, reply);
        if (!caller) return reply;
        return { libraries: await store.libraries(caller.workspace.id), can: { create: rightsOn(caller).manage } };
      });

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

      app.post<{ Params: { id: string } }>('/libraries/:id/archive', { schema: { params: ID_PARAMS } }, async (req, reply) => {
        const caller = onFloor(req, reply);
        if (!caller) return reply;
        const library = await libraryFor(caller, req.params.id, reply);
        if (!library || !managersOnly(caller, library, reply)) return reply;
        await store.archiveLibrary(library.id, caller.id);
        await recorded({ actor: caller.id, action: 'library.archived', target: library.id, workspace: library.workspace, detail: { name: library.name } });
        return reply.code(204).send();
      });

      app.post<{ Params: { id: string }; Body: { name: string; parent?: string } }>(
        '/libraries/:id/folders',
        { schema: { params: ID_PARAMS, body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: FOLDER_NAME, parent: { type: 'string', maxLength: 64 } } } } },
        async (req, reply) => {
          const caller = onFloor(req, reply);
          if (!caller) return reply;
          const library = await libraryFor(caller, req.params.id, reply);
          if (!library) return reply;
          if (!rightsOn(caller, library).addFolders) return reply.code(403).send({ error: 'forbidden', message: 'You can read this library, but not add to it.' });
          try {
            return reply.code(201).send(await store.createFolder({ library: library.id, parent: req.body.parent, name: req.body.name.trim(), createdBy: caller.id }));
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

      app.patch<{ Params: { id: string; folder: string }; Body: { name: string } }>(
        '/libraries/:id/folders/:folder',
        { schema: { params: FOLDER_PARAMS, body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: FOLDER_NAME } } } },
        async (req, reply) => {
          const caller = onFloor(req, reply);
          if (!caller) return reply;
          const library = await libraryFor(caller, req.params.id, reply);
          if (!library || !(await folderFor(caller, library, req.params.folder, reply))) return reply;
          try {
            return await store.renameFolder(library.id, req.params.folder, req.body.name.trim());
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
    },
    { prefix: `/${API_VERSION}` },
  );
  return app;
};
