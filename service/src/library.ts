import { createHash } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { floorCaller, Problem, standInPeople, type AppAudit, type AppManifest, type AppNotify, type AppPeople, type OnFloor } from '@augur/service-kit';
import { BadMoveError, PRINCIPAL } from '@augur/records';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  closedAbove,
  CONTAINER_LIFECYCLE,
  CONTENT_LIFECYCLE,
  documentLevel,
  floorLevel,
  folderLevel,
  holdsOf,
  levelInfo,
  libraryLevel,
  nextLevel,
  nextStates,
  pathTo,
  reaches,
  rightsFor,
  stepsOf,
  UNIT_LEVELS,
  type FloorAccess,
  type Level,
} from './access.ts';
import type {
  ContainerState,
  ContentState,
  DocumentAnswer,
  DocumentPage,
  DocumentView,
  FloorKind,
  FolderAnswer,
  FolderLevel,
  FolderView,
  GrantKind,
  GrantView,
  Home,
  HomeItem,
  LibraryAnswer,
  PeopleAnswer,
  ReaderAnswer,
  ReaderState,
  SharedItem,
  TagView,
  UnitLevel,
  VersionView,
} from './api-types.ts';
import { homeSchema } from './api-types.ts';
import type { ObjectStore } from './objects.ts';
import type { Inbox } from './platform.ts';
import { placing } from './placements.ts';
import { GoneError, NameTakenError, newId, NotEmptyError, objectKeyFor, searchWords, type DocumentRecord, type FolderRecord, type Store, type VersionRecord } from './store.ts';

export interface LibraryOptions {
  manifest: AppManifest;
  store: Store;
  objects: ObjectStore;
  people?: AppPeople;
  inbox: Inbox;
  audit: AppAudit;
  /** Tells people as the app: a floor that something was published up to it. */
  notify?: AppNotify;
  /** The most one upload may be, in bytes. */
  maxUploadBytes: number;
}

const NAME = { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' } as const;
const FOLDER_NAME = { type: 'string', minLength: 1, maxLength: 80, pattern: '^(?=.*\\S)[^/\\\\]+$' } as const;
const DESCRIPTION = { type: 'string', maxLength: 500 } as const;
const NOTE = { type: 'string', maxLength: 500 } as const;
const ID = { type: 'string', minLength: 1, maxLength: 64 } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: ID } } as const;
const LEVELS = ['read', 'edit', 'manage'] as const;
const FOLDER_LEVELS = ['collection', 'subcollection', 'series', 'subseries'] as const;

const notFound = (what: string) => new Problem(404, 'not_found', `There’s no such ${what}, or it hasn’t been shared with you.`);

/** A version for the screen: never its object key. */
const versionView = (v: VersionRecord, names: ReadonlyMap<string, string>): VersionView => ({
  number: v.number,
  filename: v.filename,
  mediaType: v.mediaType,
  size: v.size,
  state: v.state,
  createdBy: v.createdBy,
  ...(names.get(v.createdBy) ? { createdByName: names.get(v.createdBy) } : {}),
  createdAt: v.createdAt,
  ...(v.reader ? { reader: v.reader } : {}),
  thumbnail: v.thumbnail,
});

const documentView = (d: DocumentRecord, names: ReadonlyMap<string, string> = new Map()): DocumentView => ({
  id: d.id,
  folder: d.folder,
  title: d.title,
  tags: d.tags,
  createdBy: d.createdBy,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
  latest: versionView(d.latest, names),
  ...(d.issued ? { issued: versionView(d.issued, names) } : {}),
});

const folderView = ({ workspace: _, ...f }: FolderRecord): FolderView => f;

/** The file name a download is saved under, for Content-Disposition (RFC 6266), safe in a header. */
export const contentDisposition = (filename: string) => {
  const plain = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
};

/** Strips a path a browser may send with a name, and anything that can't be in one. */
export const cleanFilename = (name: string) => {
  const base = [...name.split(/[\\/]/).pop()!].filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f).join('').trim();
  return base.slice(0, 200) || 'file';
};

/** A title from a file's name: its extension gone, dashes and underscores as spaces. */
export const titleFromFilename = (name: string) => cleanFilename(name).replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/[_-]+/g, ' ').trim() || 'Untitled';

/** Counts and hashes the bytes going by, and stops past `max`. */
const measured = (max: number) => {
  const hash = createHash('sha256');
  let size = 0;
  const through = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      if (size > max) return done(new Problem(413, 'too_large', `That file is larger than this deployment takes (${Math.round(max / 1024 / 1024)} MB).`));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  return { through, done: () => ({ size, sha256: hash.digest('hex') }) };
};

export const libraryRoutes = async (app: FastifyInstance, { manifest, store, objects, people = standInPeople, inbox, audit, notify = async () => undefined, maxUploadBytes }: LibraryOptions) => {
  const floorOf = floorCaller(manifest);
  const recorded = (entry: Parameters<AppAudit>[0]) => audit(entry).catch((err: Error) => app.log.error({ err: err.message, action: entry.action }, 'could not record in the audit log'));

  /** The caller, kept by name so every list can show them. */
  const callerOf = async (req: FastifyRequest) => {
    const caller = floorOf(req);
    await store.seen(caller);
    return caller;
  };

  const principalsOf = async (caller: OnFloor) => {
    try {
      return await people.principals(caller.id, caller.workspace);
    } catch (err) {
      // Without identity the caller still stands for themselves and their floor; a team's grants wait.
      app.log.warn({ err: (err as Error).message }, 'could not ask who the caller stands for');
      return standInPeople.principals(caller.id, caller.workspace);
    }
  };

  /** Everything access on one floor is decided from. */
  const accessOn = async (caller: OnFloor, workspace: string, principals?: readonly string[]): Promise<FloorAccess> => {
    const [folders, grants, p] = await Promise.all([store.folders(workspace), store.grants(workspace), principals ?? principalsOf(caller)]);
    return { workspace, folders: new Map(folders.map((f) => [f.id, f])), grants, principals: p, ...(workspace === caller.workspace.id ? { standing: floorLevel(caller) } : {}) };
  };

  /** A folder the caller may read, and their access on its floor. */
  const readFolder = async (caller: OnFloor, id: string) => {
    const folder = await store.folder(id);
    if (!folder) throw notFound('folder');
    const access = await accessOn(caller, folder.workspace);
    const level = folderLevel(access, folder.id);
    if (!level) throw notFound('folder');
    return { folder, access, level };
  };

  const place = placing({ store, people, notify, recorded, log: app.log, callerOf, principalsOf, accessOn });
  await place.routes(app);

  /** A document the caller may read: on its floor, by a grant, or, one version only, through publishing up. */
  const readDocument = async (caller: OnFloor, id: string) => {
    const document = await store.document(id);
    if (!document) throw notFound('document');
    const access = await accessOn(caller, document.workspace);
    const level = documentLevel(access, document);
    if (level) return { document, access, level };
    const reached = await place.reachedVersion(caller, access, document);
    if (!reached) throw notFound('document');
    return { document, access, level: 'read' as Level, reached };
  };

  /** A version of a document, when the caller may open that one. */
  const versionIn = async (read: Awaited<ReturnType<typeof readDocument>>, number: number) => {
    if (read.reached && read.reached.version !== number) throw notFound('version');
    const version = await store.version(read.document.id, number);
    if (!version) throw notFound('version');
    return version;
  };

  const need = (level: Level | undefined, want: Level, what: string) => {
    if (!reaches(level, want)) throw new Problem(403, 'forbidden', `Only someone who can ${want === 'manage' ? 'manage' : 'change'} this can ${what}.`, { whoCanChange: 'The floor’s leads, or whoever shared it with you.' });
  };

  const notClosed = (access: FloorAccess, folder: string) => {
    const closed = closedAbove(access, folder);
    if (closed) throw new Problem(409, 'closed', `“${closed.name}” is ${closed.state}, so nothing new goes in.`, { whoCanChange: 'Whoever manages it can open it again.' });
  };

  const refused = (err: unknown): never => {
    if (err instanceof NameTakenError) throw new Problem(409, 'name_taken', err.message);
    if (err instanceof NotEmptyError) throw new Problem(409, 'not_empty', err.message);
    if (err instanceof GoneError) throw new Problem(409, 'conflict', err.message);
    if (err instanceof BadMoveError) throw new Problem(409, 'bad_move', err.message);
    throw err;
  };

  // The library

  app.get('/library', async (req): Promise<LibraryAnswer> => {
    const caller = await callerOf(req);
    const floor = await store.floor(caller.workspace.id, caller.workspace.kind);
    const access = await accessOn(caller, floor.workspace);
    const level = libraryLevel(access) ?? 'read';
    const names = await store.levelNames();
    const collections = [...access.folders.values()].filter((f) => !f.parent && f.state !== 'archived' && folderLevel(access, f.id));
    return {
      floor: { id: floor.workspace, kind: floor.kind },
      freeTags: floor.freeTags,
      rights: { ...rightsFor(level, { freeTags: floor.freeTags }), add: reaches(level, 'manage'), ...(reaches(level, 'manage') ? {} : { why: 'Only the floor’s leads make collections.' }) },
      levels: levelInfo(names),
      collections: collections.map(folderView),
    };
  });

  app.patch<{ Body: { freeTags: boolean } }>(
    '/library',
    { schema: { body: { type: 'object', required: ['freeTags'], additionalProperties: false, properties: { freeTags: { type: 'boolean' } } } } },
    async (req) => {
      const caller = await callerOf(req);
      await store.floor(caller.workspace.id, caller.workspace.kind);
      need(libraryLevel(await accessOn(caller, caller.workspace.id)), 'manage', 'change how tags are made here');
      await store.setFreeTags(caller.workspace.id, req.body.freeTags);
      return { freeTags: req.body.freeTags };
    },
  );

  // Folders

  app.post<{ Body: { parent?: string; level?: FolderLevel; name: string; description?: string } }>(
    '/folders',
    {
      schema: {
        body: { type: 'object', required: ['name'], additionalProperties: false, properties: { parent: ID, level: { type: 'string', enum: FOLDER_LEVELS }, name: FOLDER_NAME, description: DESCRIPTION } },
      },
    },
    async (req, reply) => {
      const caller = await callerOf(req);
      const { parent, name, description } = req.body;
      let workspace = caller.workspace.id;
      let level: FolderLevel | undefined = req.body.level;
      if (parent) {
        const held = await readFolder(caller, parent);
        need(held.level, 'edit', 'add a folder here');
        notClosed(held.access, parent);
        level ??= nextLevel(held.folder.level);
        const refusal = level && UNIT_LEVELS.refusal(held.folder.level, level);
        if (!level || refusal) throw new Problem(400, 'bad_level', refusal ?? `A ${held.folder.level} holds only files.`);
        workspace = held.folder.workspace;
      } else {
        await store.floor(caller.workspace.id, caller.workspace.kind);
        need(libraryLevel(await accessOn(caller, workspace)), 'manage', 'make a collection');
        if (level && level !== 'collection') throw new Problem(400, 'bad_level', 'The top of the library holds only collections.');
        level = 'collection';
      }
      const folder = await store.createFolder({ workspace, parent, level, name, description, createdBy: caller.id }).catch(refused);
      return reply.code(201).send(folderView(folder));
    },
  );

  app.get<{ Params: { id: string } }>('/folders/:id', { schema: { params: idParams } }, async (req): Promise<FolderAnswer> => {
    const caller = await callerOf(req);
    const { folder, access, level } = await readFolder(caller, req.params.id);
    const floor = await store.floorRow(folder.workspace);
    const closed = closedAbove(access, folder.id);
    const placed = await place.signpostFor(caller, access, { id: folder.id, ...(folder.parent ? { folder: folder.parent } : {}) });
    return {
      folder: folderView(folder),
      path: stepsOf(pathTo(access.folders, folder.id)),
      folders: [...access.folders.values()].filter((f) => f.parent === folder.id && f.state !== 'archived').map(folderView),
      rights: rightsFor(level, { freeTags: floor?.freeTags, ...(closed ? { closed } : {}) }),
      holds: holdsOf(folder.level),
      received: folder.workspace === caller.workspace.id ? await place.receivedIn(caller, folder.id) : [],
      ...(placed ? { placed } : {}),
    };
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; description?: string } }>(
    '/folders/:id',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { name: FOLDER_NAME, description: DESCRIPTION } } } },
    async (req) => {
      const caller = await callerOf(req);
      const { folder, level } = await readFolder(caller, req.params.id);
      need(level, 'manage', 'rename it');
      return folderView((await store.updateFolder(folder.id, req.body).catch(refused))!);
    },
  );

  app.post<{ Params: { id: string }; Body: { to: ContainerState; note?: string } }>(
    '/folders/:id/state',
    { schema: { params: idParams, body: { type: 'object', required: ['to'], additionalProperties: false, properties: { to: { type: 'string', enum: ['open', 'closed', 'archived'] }, note: NOTE } } } },
    async (req) => {
      const caller = await callerOf(req);
      const { folder, level } = await readFolder(caller, req.params.id);
      try {
        CONTAINER_LIFECYCLE.check(folder.state, req.body.to, level);
      } catch (err) {
        refused(err);
      }
      const moved = await store.setFolderState(folder, req.body.to, caller.id, req.body.note);
      void recorded({ actor: caller.id, action: `folder.${req.body.to}`, target: folder.id, workspace: folder.workspace, detail: { from: folder.state, name: folder.name } });
      return folderView(moved!);
    },
  );

  app.delete<{ Params: { id: string } }>('/folders/:id', { schema: { params: idParams } }, async (req, reply) => {
    const caller = await callerOf(req);
    const { folder, level } = await readFolder(caller, req.params.id);
    need(level, 'manage', 'delete it');
    await store.deleteFolder(folder.id).catch(refused);
    void recorded({ actor: caller.id, action: 'folder.deleted', target: folder.id, workspace: folder.workspace, detail: { name: folder.name } });
    return reply.code(204).send();
  });

  app.put<{ Params: { id: string }; Body: { tags: string[] } }>(
    '/folders/:id/tags',
    { schema: { params: idParams, body: { type: 'object', required: ['tags'], additionalProperties: false, properties: { tags: { type: 'array', maxItems: 20, items: NAME } } } } },
    async (req) => {
      const caller = await callerOf(req);
      const { folder, level } = await readFolder(caller, req.params.id);
      need(level, 'manage', 'tag it');
      return folderView((await store.setFolderTags(folder, req.body.tags).catch(refused))!);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { tags?: string; lifecycle?: string; sort?: 'title' | 'updated' | 'newest'; limit?: number; offset?: number } }>(
    '/folders/:id/documents',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tags: { type: 'string', maxLength: 500 },
            lifecycle: { type: 'string', maxLength: 100 },
            sort: { type: 'string', enum: ['title', 'updated', 'newest'] },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            offset: { type: 'integer', minimum: 0, maximum: 100000 },
          },
        },
      },
    },
    async (req): Promise<DocumentPage> => {
      const caller = await callerOf(req);
      const { folder, access } = await readFolder(caller, req.params.id);
      const lifecycle = req.query.lifecycle ? CONTENT_LIFECYCLE.tidy(req.query.lifecycle.split(',')) : undefined;
      const tags = req.query.tags?.split(',').map((t) => t.trim()).filter(Boolean);
      const page = await store.documents([folder.id], { ...(tags ? { tags } : {}), ...(lifecycle ? { lifecycle } : {}), sort: req.query.sort, limit: req.query.limit, offset: req.query.offset });
      // Someone let into one document but not the folder reads only that one; a folder they read shows all.
      const documents = page.documents.filter((d) => documentLevel(access, d));
      const names = await store.names(documents.map((d) => d.latest.createdBy));
      // One place: a document whose place for the caller is a floor above shows a signpost to it here.
      const reaching = await place.covering([...new Set(documents.flatMap((d) => place.shownThrough(access, d)))], access.principals);
      const placed = await Promise.all(
        documents.map((d) => {
          const through = new Set(place.shownThrough(access, d));
          const steps = reaching.filter((p) => through.has(p.record.id));
          return steps.length ? place.signpostFor(caller, access, d, steps) : undefined;
        }),
      );
      return { documents: documents.map((d, i) => ({ ...documentView(d, names), ...(placed[i] ? { placed: placed[i] } : {}) })), total: page.total };
    },
  );

  // Documents and versions: a file arrives as the request's body, its name in the query.

  const takeFile = async (req: FastifyRequest, documentId: string, versionId: string, filename: string, createdBy: string) => {
    const objectKey = objectKeyFor(documentId, versionId);
    const mediaType = (req.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase() || 'application/octet-stream';
    const { through, done } = measured(maxUploadBytes);
    // The bucket client reads the counted stream; a body that runs past the limit fails it, and nothing is kept.
    const counted = (req.body as Readable).pipe(through);
    (req.body as Readable).on('error', (err) => through.destroy(err));
    try {
      await objects.put(objectKey, counted, mediaType);
    } catch (err) {
      await objects.delete(objectKey).catch(() => undefined);
      throw err instanceof Problem ? err : through.errored instanceof Problem ? through.errored : err;
    }
    const { size, sha256 } = done();
    if (size === 0) {
      await objects.delete(objectKey).catch(() => undefined);
      throw new Problem(400, 'empty_file', 'That file is empty.');
    }
    return { id: versionId, filename: cleanFilename(filename), mediaType, size, sha256, objectKey, createdBy };
  };

  await app.register(async (files) => {
    // Every type comes as a stream, so a 200 MB file is never held in memory.
    files.removeAllContentTypeParsers();
    files.addContentTypeParser('*', { bodyLimit: maxUploadBytes }, (_req, payload, done) => done(null, payload));

    files.post<{ Params: { id: string }; Querystring: { filename: string; title?: string } }>(
      '/folders/:id/documents',
      {
        bodyLimit: maxUploadBytes,
        schema: { params: idParams, querystring: { type: 'object', required: ['filename'], additionalProperties: false, properties: { filename: { type: 'string', minLength: 1, maxLength: 255 }, title: NAME } } },
      },
      async (req, reply) => {
        const caller = await callerOf(req);
        const { folder, access, level } = await readFolder(caller, req.params.id);
        need(level, 'edit', 'add documents here');
        notClosed(access, folder.id);
        const documentId = newId('d');
        const first = await takeFile(req, documentId, newId('v'), req.query.filename, caller.id);
        const document = await store.createDocument({ workspace: folder.workspace, folder: folder.id, title: req.query.title ?? titleFromFilename(req.query.filename), createdBy: caller.id }, first, documentId);
        void recorded({ actor: caller.id, action: 'document.added', target: document.id, workspace: folder.workspace, detail: { title: document.title, size: first.size } });
        return reply.code(201).send(documentView(document, new Map([[caller.id, caller.name]])));
      },
    );

    files.post<{ Params: { id: string }; Querystring: { filename: string } }>(
      '/documents/:id/versions',
      {
        bodyLimit: maxUploadBytes,
        schema: { params: idParams, querystring: { type: 'object', required: ['filename'], additionalProperties: false, properties: { filename: { type: 'string', minLength: 1, maxLength: 255 } } } },
      },
      async (req, reply) => {
        const caller = await callerOf(req);
        const { document, access, level } = await readDocument(caller, req.params.id);
        need(level, 'edit', 'add a version');
        notClosed(access, document.folder);
        const version = await takeFile(req, document.id, newId('v'), req.query.filename, caller.id);
        const next = await store.addVersion(document, version);
        void recorded({ actor: caller.id, action: 'document.version-added', target: document.id, workspace: document.workspace, detail: { version: next.latest.number } });
        return reply.code(201).send(documentView(next, new Map([[caller.id, caller.name]])));
      },
    );
  });

  app.get<{ Params: { id: string } }>('/documents/:id', { schema: { params: idParams } }, async (req): Promise<DocumentAnswer> => {
    const caller = await callerOf(req);
    const { document, access, level, reached } = await readDocument(caller, req.params.id);
    const [all, allMoves] = await Promise.all([store.versions(document.id), store.moves(document.id)]);
    // Through publishing up, the one version the caller's floors let through, and nothing about the others.
    const versions = reached ? all.filter((v) => v.number === reached.version) : all;
    const moves = reached ? allMoves.filter((m) => m.version === reached.version) : allMoves;
    const names = await store.names([...versions.map((v) => v.createdBy), ...moves.map((m) => m.by)]);
    const floor = await store.floorRow(document.workspace);
    const closed = closedAbove(access, document.folder);
    const shown = reached ? { ...document, latest: versions[0]!, issued: versions[0]!.state === 'issued' ? versions[0] : undefined } : document;
    const placed = reached ? undefined : await place.signpostFor(caller, access, document);
    return {
      floor: { id: document.workspace, kind: floor?.kind ?? 'team' },
      document: { ...documentView(shown, names), ...(placed ? { placed } : {}) },
      path: stepsOf(pathTo(access.folders, document.folder)),
      versions: versions.map((v) => versionView(v, names)),
      moves: moves.map(({ record: _, ...m }) => ({ ...m, ...(names.get(m.by) ? { byName: names.get(m.by) } : {}) })),
      rights: reached
        ? { ...rightsFor('read'), why: `It was published up to ${reached.floor.kind === 'org' ? 'the org’s floor' : reached.floor.name}, which shows the version its floor lets through. Its own floor changes it.` }
        : rightsFor(level, { freeTags: floor?.freeTags, ...(closed ? { closed } : {}) }),
      next: reached ? [] : nextStates(document.latest.state, level),
      ...(reached ? { reached } : {}),
    };
  });

  app.patch<{ Params: { id: string }; Body: { title?: string; folder?: string } }>(
    '/documents/:id',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { title: NAME, folder: ID } } } },
    async (req) => {
      const caller = await callerOf(req);
      const { document, access, level } = await readDocument(caller, req.params.id);
      need(level, 'edit', 'change it');
      if (req.body.folder && req.body.folder !== document.folder) {
        // Moving it needs leave to take it out and to put it in, on the same floor: publishing up is how it goes to another.
        need(folderLevel(access, document.folder), 'edit', 'move it out of this folder');
        const to = access.folders.get(req.body.folder);
        if (!to) throw new Problem(400, 'bad_folder', 'It can only move to a folder on its own floor. Publishing up is how it reaches another.');
        need(folderLevel(access, to.id), 'edit', 'move it there');
        notClosed(access, to.id);
      }
      const changed = await store.updateDocument(document.id, req.body);
      return documentView(changed!);
    },
  );

  app.delete<{ Params: { id: string } }>('/documents/:id', { schema: { params: idParams } }, async (req, reply) => {
    const caller = await callerOf(req);
    const { document, level } = await readDocument(caller, req.params.id);
    need(level, 'manage', 'delete it');
    await store.deleteDocument(document.id, caller.id);
    // A version waiting for review waits no more.
    for (const v of await store.versions(document.id)) if (v.state === 'in-review') await closeReview(document, v, 'withdrawn', 'The document was deleted.');
    void recorded({ actor: caller.id, action: 'document.deleted', target: document.id, workspace: document.workspace, detail: { title: document.title } });
    return reply.code(204).send();
  });

  app.put<{ Params: { id: string }; Body: { tags: string[] } }>(
    '/documents/:id/tags',
    { schema: { params: idParams, body: { type: 'object', required: ['tags'], additionalProperties: false, properties: { tags: { type: 'array', maxItems: 20, items: NAME } } } } },
    async (req) => {
      const caller = await callerOf(req);
      const { document, level } = await readDocument(caller, req.params.id);
      need(level, 'edit', 'tag it');
      return documentView((await store.setDocumentTags(document, req.body.tags).catch(refused))!);
    },
  );

  const versionParams = { type: 'object', required: ['id', 'number'], properties: { id: ID, number: { type: 'integer', minimum: 1 } } } as const;

  app.get<{ Params: { id: string; number: number } }>('/documents/:id/versions/:number/file', { schema: { params: versionParams } }, async (req, reply) => {
    const caller = await callerOf(req);
    const version = await versionIn(await readDocument(caller, req.params.id), req.params.number);
    const body = await objects.get(version.objectKey);
    if (!body) throw new Problem(404, 'file_missing', 'The file for this version can’t be found in storage.', { whoCanChange: 'An admin, who can check the app’s bucket.' });
    return reply.type(version.mediaType).header('content-length', version.size).header('content-disposition', contentDisposition(version.filename)).header('cache-control', 'private, no-store').send(body);
  });

  // Reader copies: made by the worker part (renditions.ts); read here as Markdown with their pictures.

  const readVersion = async (req: FastifyRequest<{ Params: { id: string; number: number } }>) => {
    const caller = await callerOf(req);
    const read = await readDocument(caller, req.params.id);
    const version = await versionIn(read, req.params.number);
    return { document: read.document, version, level: read.level, rendition: await store.rendition(version.id) };
  };

  const READER_WHY: Partial<Record<ReaderState, string>> = {
    queued: 'Its copy to read here is waiting to be made. It usually takes a minute.',
    working: 'Its copy to read here is being made.',
  };

  app.get<{ Params: { id: string; number: number } }>('/documents/:id/versions/:number/reader', { schema: { params: versionParams } }, async (req, reply): Promise<ReaderAnswer> => {
    const { level, rendition } = await readVersion(req);
    reply.header('cache-control', 'private, no-store');
    if (!rendition) return { state: 'none', why: 'This version was added before Artifacts made copies to read. Download the original to open it.', retry: false };
    const retry = rendition.state === 'failed' && reaches(level, 'edit');
    if (rendition.state !== 'ready' || !rendition.readerKey) return { state: rendition.state, why: rendition.why ?? READER_WHY[rendition.state] ?? 'There’s no copy to read here.', retry };
    const body = await objects.get(rendition.readerKey);
    if (!body) throw new Problem(404, 'file_missing', 'The copy to read can’t be found in storage.', { whoCanChange: 'An admin, who can check the app’s bucket.' });
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array));
    return { state: 'ready', markdown: Buffer.concat(chunks).toString('utf8'), ...(rendition.pages ? { pages: rendition.pages } : {}), retry: false };
  });

  app.post<{ Params: { id: string; number: number } }>('/documents/:id/versions/:number/reader', { schema: { params: versionParams } }, async (req, reply) => {
    const { document, version, level, rendition } = await readVersion(req);
    need(level, 'edit', 'ask for its copy to read again');
    if (rendition?.state !== 'failed' || !(await store.retryRendition(version.id))) throw new Problem(409, 'not_failed', 'Only a copy that couldn’t be made can be asked for again.');
    void recorded({ actor: floorOf(req).id, action: 'document.reader-retried', target: document.id, workspace: document.workspace, detail: { version: version.number } });
    return reply.code(202).send({ state: 'queued' });
  });

  const sendStored = async (reply: FastifyReply, key: string | undefined, contentType: string) => {
    const body = key ? await objects.get(key) : undefined;
    if (!body) throw notFound('picture');
    // A version never changes, so neither do its pictures: the browser may keep them, for this person only.
    return reply.type(contentType).header('cache-control', 'private, max-age=86400, immutable').header('x-content-type-options', 'nosniff').send(body);
  };

  const PICTURE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

  app.get<{ Params: { id: string; number: number; name: string } }>(
    '/documents/:id/versions/:number/pictures/:name',
    { schema: { params: { type: 'object', required: ['id', 'number', 'name'], properties: { ...versionParams.properties, name: { type: 'string', pattern: '^[A-Za-z0-9-]{1,40}\\.(png|jpg|gif|webp)$' } } } } },
    async (req, reply) => {
      const { rendition } = await readVersion(req);
      const key = rendition?.pictureKeys.find((k) => k.endsWith(`/pictures/${req.params.name}`));
      return sendStored(reply, key, PICTURE_TYPES[req.params.name.split('.').pop()!]!);
    },
  );

  app.get<{ Params: { id: string; number: number } }>('/documents/:id/versions/:number/thumbnail', { schema: { params: versionParams } }, async (req, reply) => {
    const { rendition } = await readVersion(req);
    return sendStored(reply, rendition?.thumbnailKey, 'image/png');
  });

  // Review: a version In review waits in the Inbox of whoever manages the floor (the spec's D10).

  const reviewKey = (v: VersionRecord) => `review/${v.id}`;

  const openReview = async (document: DocumentRecord, version: VersionRecord, by: OnFloor) => {
    const floorKind = document.workspace === by.workspace.id ? by.workspace.kind : 'team';
    // On someone's own floor nobody else reviews: they are its lead.
    if (floorKind === 'personal') return;
    await inbox
      .put(reviewKey(version), document.workspace, {
        kind: 'review',
        owner: { kind: 'team', id: document.workspace, role: 'lead' },
        title: `Review “${document.title}”`,
        detail: `Version ${version.number}, sent for review by ${by.name}.`,
        subject: { kind: 'document', app: manifest.id, id: document.id, label: document.title },
        path: `/documents/${document.id}`,
        from: by.id,
        reopen: true,
      })
      .catch((err: Error) => app.log.error({ err: err.message, document: document.id }, 'could not put the review in the Inbox'));
  };

  const closeReview = (document: DocumentRecord, version: VersionRecord, state: 'done' | 'withdrawn', note: string) =>
    inbox.change(reviewKey(version), document.workspace, { state, note }).catch((err: Error) => app.log.warn({ err: err.message, document: document.id }, 'could not close the review in the Inbox'));

  app.post<{ Params: { id: string; number: number }; Body: { to: ContentState; note?: string } }>(
    '/documents/:id/versions/:number/state',
    {
      schema: {
        params: versionParams,
        body: { type: 'object', required: ['to'], additionalProperties: false, properties: { to: { type: 'string', enum: ['in-progress', 'in-review', 'complete', 'issued', 'retired'] }, note: NOTE } },
      },
    },
    async (req) => {
      const caller = await callerOf(req);
      const { document, level } = await readDocument(caller, req.params.id);
      const version = await store.version(document.id, req.params.number);
      if (!version) throw notFound('version');
      try {
        CONTENT_LIFECYCLE.check(version.state, req.body.to, level);
      } catch (err) {
        refused(err);
      }
      const moved = await store.moveVersion(document, version, req.body.to, caller.id, req.body.note).catch(refused);
      if (req.body.to === 'in-review') await openReview(moved, version, caller);
      else if (version.state === 'in-review') await closeReview(moved, version, req.body.to === 'in-progress' ? 'withdrawn' : 'done', `Moved to ${CONTENT_LIFECYCLE.get(req.body.to).name} by ${caller.name}.`);
      if (req.body.to === 'issued' || req.body.to === 'retired')
        void recorded({ actor: caller.id, action: `document.${req.body.to}`, target: document.id, workspace: document.workspace, detail: { version: version.number, from: version.state } });
      return documentView(moved, await store.names([moved.latest.createdBy]));
    },
  );

  // Tags

  app.get('/tags', async (req): Promise<{ tags: TagView[] }> => {
    const caller = await callerOf(req);
    return { tags: (await store.tags(caller.workspace.id)).map((t) => ({ id: t.id, name: t.name, org: !t.workspace })) };
  });

  app.post<{ Body: { name: string; org?: boolean } }>(
    '/tags',
    { schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { ...NAME, maxLength: 40 }, org: { type: 'boolean' } } } } },
    async (req, reply) => {
      const caller = await callerOf(req);
      if (req.body.org) {
        if (!(caller.workspace.kind === 'org' && caller.workspace.role === 'lead')) throw new Problem(403, 'forbidden', 'Only the organisation’s leads make its tags.', { whoCanChange: 'The organisation’s leads.' });
      } else {
        const floor = await store.floor(caller.workspace.id, caller.workspace.kind);
        const level = libraryLevel(await accessOn(caller, floor.workspace));
        if (!(reaches(level, 'manage') || (floor.freeTags && reaches(level, 'edit')))) throw new Problem(403, 'forbidden', 'Only the floor’s leads make its tags here.', { whoCanChange: 'The floor’s leads, who can let anyone who tags make tags too.' });
      }
      const tag = await store.createTag({ ...(req.body.org ? {} : { workspace: caller.workspace.id }), name: req.body.name, createdBy: caller.id }).catch(refused);
      return reply.code(201).send({ id: tag.id, name: tag.name, org: !tag.workspace } satisfies TagView);
    },
  );

  // Levels: what the org calls them

  app.put<{ Params: { level: UnitLevel }; Body: { name: string; plural: string } | { reset: true } }>(
    '/levels/:level',
    {
      schema: {
        params: { type: 'object', required: ['level'], properties: { level: { type: 'string', enum: ['collection', 'subcollection', 'series', 'subseries', 'file'] } } },
        body: {
          oneOf: [
            { type: 'object', required: ['name', 'plural'], additionalProperties: false, properties: { name: { ...NAME, maxLength: 30 }, plural: { ...NAME, maxLength: 30 } } },
            { type: 'object', required: ['reset'], additionalProperties: false, properties: { reset: { const: true } } },
          ],
        },
      },
    },
    async (req) => {
      const caller = await callerOf(req);
      if (!(caller.workspace.kind === 'org' && caller.workspace.role === 'lead')) throw new Problem(403, 'forbidden', 'Only the organisation’s leads name the levels.', { whoCanChange: 'The organisation’s leads.' });
      await store.setLevelName(req.params.level, 'reset' in req.body ? null : req.body, caller.id);
      return { levels: levelInfo(await store.levelNames()) };
    },
  );

  // Sharing

  const recordOf = async (caller: OnFloor, kind: GrantKind, id: string) => {
    if (kind === 'library') {
      if (id !== caller.workspace.id) throw notFound('library');
      await store.floor(id, caller.workspace.kind);
      const access = await accessOn(caller, id);
      return { workspace: id, level: libraryLevel(access), title: 'the library' };
    }
    if (kind === 'folder') {
      const { folder, level } = await readFolder(caller, id);
      return { workspace: folder.workspace, level, title: folder.name };
    }
    const { document, level } = await readDocument(caller, id);
    return { workspace: document.workspace, level, title: document.title };
  };

  const grantQuery = { type: 'object', required: ['kind', 'record'], additionalProperties: false, properties: { kind: { type: 'string', enum: ['library', 'folder', 'document'] }, record: ID } } as const;

  app.get<{ Querystring: { kind: GrantKind; record: string } }>('/grants', { schema: { querystring: grantQuery } }, async (req): Promise<{ grants: GrantView[] }> => {
    const caller = await callerOf(req);
    const held = await recordOf(caller, req.query.kind, req.query.record);
    need(held.level, 'manage', 'see who it’s shared with');
    const grants = (await store.grants(held.workspace)).filter((g) => g.record === req.query.record);
    const ids = grants.map((g) => g.principal.split(':')[1] ?? '').filter(Boolean);
    const found = ids.length ? await people.directory({ ids }).catch(() => ({ people: [], teams: [] })) : { people: [], teams: [] };
    const named = new Map<string, string>([...found.people.map((p) => [`person:${p.id}`, p.name] as const), ...found.teams.flatMap((t) => [[`team:${t.id}`, t.name] as const, [`tree:${t.id}`, t.name] as const])]);
    return { grants: grants.map((g) => ({ kind: g.kind, record: g.record, principal: g.principal, ...(named.get(g.principal) ? { name: named.get(g.principal) } : g.principal === 'org' ? { name: 'Everyone' } : {}), level: g.level, createdBy: g.createdBy, createdAt: g.createdAt })) };
  });

  app.put<{ Body: { kind: GrantKind; record: string; principal: string; level: Level } }>(
    '/grants',
    {
      schema: {
        body: {
          type: 'object',
          required: ['kind', 'record', 'principal', 'level'],
          additionalProperties: false,
          properties: { kind: { type: 'string', enum: ['library', 'folder', 'document'] }, record: ID, principal: { type: 'string', maxLength: 110 }, level: { type: 'string', enum: LEVELS } },
        },
      },
    },
    async (req) => {
      const caller = await callerOf(req);
      if (!PRINCIPAL.test(req.body.principal)) throw new Problem(400, 'bad_principal', 'Share with a person, a team or everyone.');
      const held = await recordOf(caller, req.body.kind, req.body.record);
      need(held.level, 'manage', 'share it');
      await store.grant({ workspace: held.workspace, kind: req.body.kind, record: req.body.record, principal: req.body.principal, level: req.body.level, createdBy: caller.id });
      void recorded({ actor: caller.id, action: 'grant.given', target: req.body.record, workspace: held.workspace, detail: { principal: req.body.principal, level: req.body.level } });
      return { shared: true };
    },
  );

  app.delete<{ Querystring: { kind: GrantKind; record: string; principal: string } }>(
    '/grants',
    { schema: { querystring: { ...grantQuery, required: ['kind', 'record', 'principal'], properties: { ...grantQuery.properties, principal: { type: 'string', maxLength: 110 } } } } },
    async (req, reply) => {
      const caller = await callerOf(req);
      const held = await recordOf(caller, req.query.kind, req.query.record);
      need(held.level, 'manage', 'stop sharing it');
      if (!(await store.revoke(req.query.record, req.query.principal))) throw new Problem(404, 'not_found', 'It wasn’t shared with them.');
      void recorded({ actor: caller.id, action: 'grant.taken-back', target: req.query.record, workspace: held.workspace, detail: { principal: req.query.principal } });
      return reply.code(204).send();
    },
  );

  /** What other floors have shared with the caller, newest first. */
  app.get('/shared', async (req): Promise<{ items: SharedItem[] }> => {
    const caller = await callerOf(req);
    const principals = await principalsOf(caller);
    const grants = (await store.grantsTo(principals.filter((p) => p !== 'org'))).filter((g) => g.workspace !== caller.workspace.id);
    const items: SharedItem[] = [];
    const seen = new Set<string>();
    for (const g of grants) {
      if (seen.has(g.record)) continue;
      seen.add(g.record);
      if (g.kind === 'folder') {
        const folder = await store.folder(g.record);
        if (folder && folder.state !== 'archived') items.push({ kind: 'folder', id: folder.id, title: folder.name, floor: folder.workspace, level: g.level, path: `/folders/${folder.id}` });
      } else if (g.kind === 'document') {
        const document = await store.document(g.record);
        if (document) items.push({ kind: 'document', id: document.id, title: document.title, floor: document.workspace, level: g.level, path: `/documents/${document.id}` });
      } else items.push({ kind: 'library', id: g.record, title: 'Library', floor: g.workspace, level: g.level, path: '/library' });
      if (items.length >= 100) break;
    }
    return { items };
  });

  /** People and teams to share with, for the people picker. */
  app.get<{ Querystring: { q: string } }>(
    '/people',
    { schema: { querystring: { type: 'object', required: ['q'], additionalProperties: false, properties: { q: { type: 'string', minLength: 1, maxLength: 100 } } } } },
    async (req): Promise<PeopleAnswer> => {
      floorOf(req);
      try {
        const found = await people.directory({ q: req.query.q, limit: 20 });
        return {
          query: req.query.q,
          items: [
            ...found.people.map((p) => ({ kind: 'person' as const, id: p.id, name: p.name, ...(p.email ? { detail: p.email } : {}) })),
            ...found.teams.map((t) => ({ kind: 'team' as const, id: t.id, name: t.name, ...(t.within.length ? { detail: t.within.join(' › ') } : {}) })),
          ],
        };
      } catch {
        return { query: req.query.q, items: [], error: 'People can’t be looked up right now. Try again in a moment.' };
      }
    },
  );

  // Find and Home

  app.get<{ Querystring: { q: string } }>(
    '/search',
    { schema: { querystring: { type: 'object', required: ['q'], properties: { q: { type: 'string', maxLength: 200 } } } } },
    async (req) => {
      const caller = await callerOf(req);
      const words = searchWords(req.query.q);
      if (!words.length) return { results: [] };
      const access = await accessOn(caller, caller.workspace.id);
      const found = (await store.search(caller.workspace.id, words, 30)).filter((d) => documentLevel(access, d)).slice(0, 10);
      return {
        results: found.map((d) => {
          const where = pathTo(access.folders, d.folder).map((f) => f.name).join(' › ');
          const state = CONTENT_LIFECYCLE.get(d.latest.state).name;
          return { id: d.id, title: d.title, detail: [where, state].filter(Boolean).join(' · '), path: `/documents/${d.id}` };
        }),
      };
    },
  );

  app.get('/home', { schema: { response: { 200: homeSchema } } }, async (req): Promise<Home> => {
    const caller = await callerOf(req);
    const floor = await store.floor(caller.workspace.id, caller.workspace.kind);
    const access = await accessOn(caller, floor.workspace);
    const since = await store.looked(caller.id, floor.workspace);
    const needsYou: HomeItem[] = [];
    if (reaches(libraryLevel(access), 'manage') && floor.kind !== 'personal')
      for (const r of await store.inReview(floor.workspace)) needsYou.push({ id: `${r.document}/${r.number}`, title: r.title, detail: `Version ${r.number} is waiting for review.`, path: `/documents/${r.document}` });
    for (const p of await place.waiting(caller)) {
      const what = p.record.kind === 'document' ? (await store.document(p.record.id))?.title : (await store.folder(p.record.id))?.name;
      if (what) needsYou.push({ id: `placement/${p.id}`, title: what, detail: 'Published up to this floor: give it a place in the library.', path: '/below' });
    }
    const latest = (await store.changedSince(floor.workspace, since, 30))
      .filter((d) => documentLevel(access, d))
      .slice(0, 10)
      .map((d) => ({ id: d.id, title: d.title, detail: `${CONTENT_LIFECYCLE.get(d.latest.state).name} · version ${d.latest.number}`, path: `/documents/${d.id}` }));
    return { floor: { id: floor.workspace, kind: floor.kind as FloorKind }, needsYou, latest, ...(since ? { since } : {}) };
  });

  /** The person has seen what's new: Home counts from now. */
  app.post('/home/looked', async (req, reply) => {
    const caller = await callerOf(req);
    await store.floor(caller.workspace.id, caller.workspace.kind);
    await store.setLooked(caller.id, caller.workspace.id);
    return reply.code(204).send();
  });
};

