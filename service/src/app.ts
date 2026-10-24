import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { callerCheckFromEnv, callerFromHeaders, health, packageVersion, signedCallers, type Caller, type CallerCheck, type CallerWorkspace } from '@augur/service-kit';
import { auditFromEnv, type Audit } from './audit.ts';
import { documentRoutes } from './documents.ts';
import { MemoryObjectStore, type ObjectStore } from './objects.ts';
import { BadParentError, MemoryFolioStore, NameTakenError, NotEmptyError, type FolioStore, type Library } from './store.ts';

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
}

/** What the caller may do with a library, so the app only offers what will work. */
export interface LibraryRights {
  /** Rename, describe and archive the library, and tidy anyone's folders: the floor's leads. */
  manage: boolean;
  /** Make folders: anyone on the floor. */
  addFolders: boolean;
  /** Upload documents: anyone on the floor. */
  addDocuments: boolean;
}

export type OnFloor = Caller & { workspace: CallerWorkspace };

const NAME = { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' } as const;
const FOLDER_NAME = { type: 'string', minLength: 1, maxLength: 80, pattern: '^(?=.*\\S)[^/\\\\]+$' } as const;
const DESCRIPTION = { type: 'string', maxLength: 500 } as const;
const ID_PARAMS = { type: 'object', properties: { id: { type: 'string', maxLength: 64 } }, required: ['id'] } as const;
const FOLDER_PARAMS = { type: 'object', properties: { id: { type: 'string', maxLength: 64 }, folder: { type: 'string', maxLength: 64 } }, required: ['id', 'folder'] } as const;

export const rightsOn = (caller: OnFloor): LibraryRights => ({ manage: caller.workspace.role === 'lead', addFolders: true, addDocuments: true });

export const buildApp = async ({ callers = callerCheckFromEnv('folio'), store = new MemoryFolioStore(), objects = new MemoryObjectStore(), audit, maxUploadBytes }: Options = {}) => {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
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

  /** The library, when it is on the caller's floor. One on another floor is as good as not there. */
  const libraryFor = async (caller: OnFloor, id: string, reply: FastifyReply): Promise<Library | undefined> => {
    const library = await store.library(id);
    if (!library || library.workspace !== caller.workspace.id) {
      reply.code(404).send({ error: 'not-found', message: 'There’s no such library on this floor.' });
      return undefined;
    }
    return library;
  };

  const leadsOnly = (caller: OnFloor, reply: FastifyReply) => {
    if (rightsOn(caller).manage) return true;
    reply.code(403).send({ error: 'forbidden', message: 'Only the floor’s leads can do that.' });
    return false;
  };

  /** Store refusals people can act on, as 409s with the store's own words. */
  const refused = (err: unknown, reply: FastifyReply) => {
    if (err instanceof NameTakenError || err instanceof NotEmptyError) return reply.code(409).send({ error: err instanceof NameTakenError ? 'name-taken' : 'not-empty', message: err.message });
    if (err instanceof BadParentError) return reply.code(400).send({ error: 'bad-parent', message: err.message });
    throw err;
  };

  await app.register(
    async (app) => {
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
          if (!caller || !leadsOnly(caller, reply)) return reply;
          try {
            const library = await store.createLibrary({ workspace: caller.workspace.id, name: req.body.name.trim(), description: req.body.description?.trim(), createdBy: caller.id });
            await recorded({ actor: caller.id, action: 'library.created', target: library.id, workspace: library.workspace, detail: { name: library.name } });
            return reply.code(201).send(library);
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
        return { ...library, folders: await store.folders(library.id), can: rightsOn(caller) };
      });

      app.patch<{ Params: { id: string }; Body: { name?: string; description?: string } }>(
        '/libraries/:id',
        { schema: { params: ID_PARAMS, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { name: NAME, description: DESCRIPTION } } } },
        async (req, reply) => {
          const caller = onFloor(req, reply);
          if (!caller) return reply;
          const library = await libraryFor(caller, req.params.id, reply);
          if (!library || !leadsOnly(caller, reply)) return reply;
          try {
            return await store.updateLibrary(library.id, { name: req.body.name?.trim(), description: req.body.description?.trim() });
          } catch (err) {
            return refused(err, reply);
          }
        },
      );

      app.post<{ Params: { id: string } }>('/libraries/:id/archive', { schema: { params: ID_PARAMS } }, async (req, reply) => {
        const caller = onFloor(req, reply);
        if (!caller) return reply;
        const library = await libraryFor(caller, req.params.id, reply);
        if (!library || !leadsOnly(caller, reply)) return reply;
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
          try {
            return reply.code(201).send(await store.createFolder({ library: library.id, parent: req.body.parent, name: req.body.name.trim(), createdBy: caller.id }));
          } catch (err) {
            return refused(err, reply);
          }
        },
      );

      /** A folder may be renamed or removed by whoever made it, or by a lead. */
      const folderFor = async (caller: OnFloor, library: Library, id: string, reply: FastifyReply) => {
        const folder = (await store.folders(library.id)).find((f) => f.id === id);
        if (!folder) {
          reply.code(404).send({ error: 'not-found', message: 'There’s no such folder in this library.' });
          return undefined;
        }
        if (folder.createdBy !== caller.id && !rightsOn(caller).manage) {
          reply.code(403).send({ error: 'forbidden', message: 'Only whoever made the folder, or the floor’s leads, can change it.' });
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

      await documentRoutes(app, { store, objects, audit: record, onFloor, libraryFor, refused, log: app.log, maxUploadBytes });
    },
    { prefix: `/${API_VERSION}` },
  );
  return app;
};
