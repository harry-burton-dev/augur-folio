import { createHash, randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Audit } from './audit.ts';
import { rightsOn, type HeldLibrary, type OnFloor } from './app.ts';
import type { CallerPrincipals } from './people.ts';
import type { ObjectStore } from './objects.ts';
import { furthest, levelFrom, objectKeyFor, reaches, SINCE, type DocumentSort, type FolioDocument, type FolioStore, type Level, type NewVersion, type Since } from './store.ts';
import { renditionRoutes } from './renditions.ts';
import { KINDS, VIEW_QUERY, timeOf } from './tags.ts';

/** What Folio takes, and the file endings each may have. PowerPoint waits for a later version. */
export const ACCEPTED: Record<string, readonly string[]> = {
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'text/html': ['.html', '.htm'],
  'text/markdown': ['.md', '.markdown'],
  'text/plain': ['.txt'],
};

/** The most one upload may be, as the manifest's `maxUpload` says. The gateway stops larger ones first. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

const ACCEPTED_WORDS = 'Folio takes PDF, Word (.docx), HTML, Markdown and plain text files.';

/** The media type a request says it carries, without parameters such as charset. */
const mediaTypeOf = (req: FastifyRequest) => (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
const endingOf = (filename: string) => (filename.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase();
/** A title from a file's name: "Travel policy v3.pdf" → "Travel policy v3". */
export const titleFrom = (filename: string) => filename.replace(/\.[^.]+$/, '').trim() || filename;

class TooLarge extends Error {}

/** Content-Disposition for a download, with the original name kept intact for any language. */
const attachment = (filename: string) =>
  `attachment; filename="${filename.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`;

export interface DocumentDeps {
  store: FolioStore;
  objects: ObjectStore;
  audit: Audit;
  onFloor(req: FastifyRequest, reply: FastifyReply): OnFloor | undefined;
  /** A library and how far the caller is let in, which may be not at all. */
  reach(caller: OnFloor, id: string): Promise<HeldLibrary | undefined>;
  libraryFor(caller: OnFloor, id: string, reply: FastifyReply): Promise<HeldLibrary | undefined>;
  principalsOf: CallerPrincipals;
  refused(err: unknown, reply: FastifyReply): unknown;
  log: { error(obj: object, msg: string): void };
  /** The most one upload may be; MAX_UPLOAD_BYTES unless a test says less. */
  maxUploadBytes?: number;
}

const FILE_QUERY = {
  type: 'object',
  required: ['filename'],
  properties: {
    filename: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^/\\\\]+$' },
    title: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
    folder: { type: 'string', maxLength: 64 },
  },
} as const;
/** An upload may come tagged: `tag` once for each. */
const UPLOAD_QUERY = { ...FILE_QUERY, properties: { ...FILE_QUERY.properties, tag: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 64 } } } } as const;

/** The document list's filters: the view query's, one value of each in the address, and paging. */
const LIST_QUERY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    folder: VIEW_QUERY.properties.folder,
    below: { type: 'boolean' },
    tag: VIEW_QUERY.properties.tags,
    type: VIEW_QUERY.properties.types,
    author: VIEW_QUERY.properties.authors,
    since: VIEW_QUERY.properties.since,
    from: VIEW_QUERY.properties.from,
    to: VIEW_QUERY.properties.to,
    sort: VIEW_QUERY.properties.sort,
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    offset: { type: 'integer', minimum: 0 },
  },
} as const;

type ListQuery = {
  folder?: string;
  below?: boolean;
  tag?: string[];
  type?: string[];
  author?: string[];
  since?: Since;
  from?: string;
  to?: string;
  sort?: DocumentSort;
  limit?: number;
  offset?: number;
};

const DAY = 24 * 60 * 60 * 1000;

/** A document as the caller reaches it: how far they're let in, through its library or into it alone. */
export type HeldDocument = FolioDocument & { level: Level; shelf: HeldLibrary };

/** Whoever may edit it, and whoever added it while they may still add to its library. */
export const mayChange = (caller: OnFloor, doc: FolioDocument & { level?: Level }, shelf: HeldLibrary) =>
  reaches(furthest(doc.level, shelf.level), 'edit') || (doc.createdBy === caller.id && rightsOn(caller, shelf).addDocuments);

/** What the caller may do with a document. */
export const documentRights = (caller: OnFloor, doc: HeldDocument) => ({ change: mayChange(caller, doc, doc.shelf), share: reaches(doc.level, 'manage') });

export type DocumentFor = (caller: OnFloor, params: { id: string; doc: string }, reply: FastifyReply) => Promise<HeldDocument | undefined>;

/**
 * The document, when the caller may read it: through its library (its floor,
 * or a grant on the library) or a grant on the document alone.
 */
export const documentFinder =
  ({ store, reach, principalsOf }: Pick<DocumentDeps, 'store' | 'reach' | 'principalsOf'>): DocumentFor =>
  async (caller, params, reply) => {
    const [doc, shelf] = await Promise.all([store.document(params.doc), reach(caller, params.id)]);
    const level = doc && shelf && doc.library === shelf.id ? furthest(shelf.level, levelFrom(await store.grants(shelf.id, doc.id), await principalsOf(caller))) : undefined;
    if (!doc || !shelf || !level) {
      reply.code(404).send({ error: 'not-found', message: 'There’s no such document, or it hasn’t been shared with you.' });
      return undefined;
    }
    return { ...doc, level, shelf };
  };

/** A document as it's sent: without the library it was reached through. */
export const sent = ({ shelf: _, ...doc }: HeldDocument) => doc;

const DOC_PARAMS = { type: 'object', properties: { id: { type: 'string', maxLength: 64 }, doc: { type: 'string', maxLength: 64 } }, required: ['id', 'doc'] } as const;
const VERSION_PARAMS = {
  type: 'object',
  properties: { id: { type: 'string', maxLength: 64 }, doc: { type: 'string', maxLength: 64 }, number: { type: 'integer', minimum: 1 } },
  required: ['id', 'doc', 'number'],
} as const;

/**
 * Documents: uploading them, new versions, and their original files. Uploads stream
 * straight into Folio's bucket, counted and hashed on the way; nothing is held in memory.
 */
export const documentRoutes = async (app: FastifyInstance, { store, objects, audit, onFloor, reach, libraryFor, principalsOf, refused, log, maxUploadBytes = MAX_UPLOAD_BYTES }: DocumentDeps) => {
  // Every upload reaches its route as a stream, whatever it says it is; the route decides what it takes.
  app.removeContentTypeParser('text/plain');
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

  const documentFor = documentFinder({ store, reach, principalsOf });

  const forbidden = (reply: FastifyReply) => reply.code(403).send({ error: 'forbidden', message: 'Only whoever added the document, or whoever may edit it, can change it.' });

  /** The file's type, or a refusal already sent when Folio doesn't take it. */
  const typeOf = (req: FastifyRequest, filename: string, reply: FastifyReply) => {
    const type = mediaTypeOf(req);
    if (!ACCEPTED[type]?.includes(endingOf(filename))) {
      reply.code(415).send({ error: 'unsupported-type', message: ACCEPTED_WORDS });
      return undefined;
    }
    return type;
  };

  /**
   * Streams the request body into the bucket for a new version of `document`. Throws TooLarge
   * past the limit; anything that fails leaves no file behind.
   */
  const receive = async (req: FastifyRequest, document: string, filename: string, mediaType: string, createdBy: string): Promise<NewVersion> => {
    const id = randomUUID();
    const objectKey = objectKeyFor(document, id);
    const hash = createHash('sha256');
    let size = 0;
    const counted = new Transform({
      transform(chunk: Buffer, _encoding, next) {
        size += chunk.length;
        if (size > maxUploadBytes) return next(new TooLarge());
        hash.update(chunk);
        next(null, chunk);
      },
    });
    const body = req.body as Readable;
    body.on('error', (err) => counted.destroy(err));
    try {
      await objects.put(objectKey, body.pipe(counted), mediaType);
    } catch (err) {
      await objects.delete(objectKey).catch(() => undefined);
      throw counted.errored ?? err;
    }
    return { id, filename, mediaType, size, sha256: hash.digest('hex'), objectKey, createdBy };
  };

  /** Sends what went wrong with an upload, or rethrows what isn't the person's to fix. */
  const uploadFailed = (err: unknown, reply: FastifyReply) => {
    if (err instanceof TooLarge) return reply.code(413).send({ error: 'too-large', message: `A file can be ${Math.round(maxUploadBytes / 1024 / 1024)} MB at most.` });
    return refused(err, reply);
  };

  const recorded = (entry: Parameters<Audit>[0]) =>
    audit(entry).catch((err: Error) => log.error({ err: err.message, action: entry.action, target: entry.target }, 'could not record in the audit log'));

  /**
   * The documents in a folder (or at the top), or with `below` everything inside it,
   * narrowed by tags (all of them), kinds, authors and when they last changed.
   */
  app.get<{ Params: { id: string }; Querystring: ListQuery }>(
    '/libraries/:id/documents',
    { schema: { params: { type: 'object', properties: { id: { type: 'string', maxLength: 64 } }, required: ['id'] }, querystring: LIST_QUERY } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const library = await libraryFor(caller, req.params.id, reply);
      if (!library) return reply;
      const readers = await principalsOf(caller);
      const q = req.query;
      const [from, to] = [timeOf(q.from), timeOf(q.to)];
      if (from === null || to === null) return reply.code(400).send({ error: 'bad-time', message: 'Give “from” and “to” as dates or times.' });
      const since = q.since && new Date(Date.now() - SINCE[q.since] * DAY).toISOString();
      const { documents, total } = await store.documents(library.id, {
        folder: q.folder || undefined,
        below: q.below,
        tags: q.tag,
        mediaTypes: q.type?.map((t) => KINDS[t]),
        authors: q.author,
        from: since && (!from || since > from) ? since : from,
        to,
        sort: q.sort,
        limit: q.limit,
        offset: q.offset,
        readers,
      });
      // As the library lets them in; a grant on one document can let them further, as that document says.
      return { documents: documents.map((d) => ({ ...d, can: { change: mayChange(caller, d, library), share: reaches(library.level, 'manage') } })), total };
    },
  );

  app.post<{ Params: { id: string }; Querystring: { filename: string; title?: string; folder?: string; tag?: string[] } }>(
    '/libraries/:id/documents',
    { schema: { params: { type: 'object', properties: { id: { type: 'string', maxLength: 64 } }, required: ['id'] }, querystring: UPLOAD_QUERY } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const library = await libraryFor(caller, req.params.id, reply);
      if (!library) return reply;
      if (!rightsOn(caller, library).addDocuments) return reply.code(403).send({ error: 'forbidden', message: 'You can read this library, but not add to it.' });
      const { filename, folder } = req.query;
      const mediaType = typeOf(req, filename, reply);
      if (!mediaType) return reply;
      if (folder && !(await store.folders(library.id)).some((f) => f.id === folder))
        return reply.code(400).send({ error: 'bad-parent', message: 'That folder isn’t in this library.' });
      // Checked before the file goes up, so a wrong tag costs no upload.
      const tags = [...new Set(req.query.tag ?? [])];
      const known = new Set((await store.tags(library.id)).map((t) => t.id));
      if (tags.some((t) => !known.has(t))) return reply.code(400).send({ error: 'bad-tag', message: 'That tag isn’t the org’s or this library’s.' });
      const id = randomUUID();
      try {
        const first = await receive(req, id, filename, mediaType, caller.id);
        if (!first.size) {
          await objects.delete(first.objectKey);
          return reply.code(400).send({ error: 'empty', message: 'That file is empty.' });
        }
        const title = req.query.title?.trim() || titleFrom(filename);
        await store.notePerson({ id: caller.id, name: caller.name });
        const doc = await store.createDocument({ id, library: library.id, folder: folder || undefined, title, createdBy: caller.id, tags }, first).catch(async (err) => {
          await objects.delete(first.objectKey).catch(() => undefined);
          throw err;
        });
        await recorded({ actor: caller.id, action: 'document.uploaded', target: doc.id, workspace: library.workspace, detail: { library: library.id, title, version: 1, size: first.size, sha256: first.sha256 } });
        return reply.code(201).send({ ...doc, can: { change: true, share: rightsOn(caller, library).share } });
      } catch (err) {
        return uploadFailed(err, reply);
      }
    },
  );

  app.get<{ Params: { id: string; doc: string } }>('/libraries/:id/documents/:doc', { schema: { params: DOC_PARAMS } }, async (req, reply) => {
    const caller = onFloor(req, reply);
    if (!caller) return reply;
    const doc = await documentFor(caller, req.params, reply);
    if (!doc) return reply;
    return { ...sent(doc), libraryName: doc.shelf.name, versions: await store.versions(doc.id), can: documentRights(caller, doc) };
  });

  app.patch<{ Params: { id: string; doc: string }; Body: { title?: string; folder?: string | null } }>(
    '/libraries/:id/documents/:doc',
    {
      schema: {
        params: DOC_PARAMS,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { title: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' }, folder: { type: ['string', 'null'], maxLength: 64 } },
        },
      },
    },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const doc = await documentFor(caller, req.params, reply);
      if (!doc) return reply;
      if (!mayChange(caller, doc, doc.shelf)) return forbidden(reply);
      try {
        const changed = await store.updateDocument(doc.id, { title: req.body.title?.trim(), folder: req.body.folder });
        return { ...changed, can: documentRights(caller, doc) };
      } catch (err) {
        return refused(err, reply);
      }
    },
  );

  app.delete<{ Params: { id: string; doc: string } }>('/libraries/:id/documents/:doc', { schema: { params: DOC_PARAMS } }, async (req, reply) => {
    const caller = onFloor(req, reply);
    if (!caller) return reply;
    const doc = await documentFor(caller, req.params, reply);
    if (!doc) return reply;
    if (!mayChange(caller, doc, doc.shelf)) return forbidden(reply);
    await store.deleteDocument(doc.id, caller.id);
    await recorded({ actor: caller.id, action: 'document.deleted', target: doc.id, workspace: doc.workspace, detail: { library: doc.library, title: doc.title } });
    return reply.code(204).send();
  });

  app.put<{ Params: { id: string; doc: string }; Body: { tags: string[] } }>(
    '/libraries/:id/documents/:doc/tags',
    {
      schema: {
        params: DOC_PARAMS,
        body: { type: 'object', additionalProperties: false, required: ['tags'], properties: { tags: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 64 } } } },
      },
    },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const doc = await documentFor(caller, req.params, reply);
      if (!doc) return reply;
      if (!mayChange(caller, doc, doc.shelf)) return forbidden(reply);
      try {
        const tagged = await store.setDocumentTags(doc.id, req.body.tags);
        return { ...tagged, can: documentRights(caller, doc) };
      } catch (err) {
        return refused(err, reply);
      }
    },
  );

  app.post<{ Params: { id: string; doc: string }; Querystring: { filename: string } }>(
    '/libraries/:id/documents/:doc/versions',
    { schema: { params: DOC_PARAMS, querystring: FILE_QUERY } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const doc = await documentFor(caller, req.params, reply);
      if (!doc) return reply;
      if (!mayChange(caller, doc, doc.shelf)) return forbidden(reply);
      const mediaType = typeOf(req, req.query.filename, reply);
      if (!mediaType) return reply;
      try {
        const received = await receive(req, doc.id, req.query.filename, mediaType, caller.id);
        if (!received.size) {
          await objects.delete(received.objectKey);
          return reply.code(400).send({ error: 'empty', message: 'That file is empty.' });
        }
        const version = await store.addVersion(doc.id, received);
        if (!version) {
          await objects.delete(received.objectKey);
          return reply.code(404).send({ error: 'not-found', message: 'There’s no such document in this library.' });
        }
        await recorded({ actor: caller.id, action: 'document.version-added', target: doc.id, workspace: doc.workspace, detail: { library: doc.library, version: version.number, size: version.size, sha256: version.sha256 } });
        return reply.code(201).send(version);
      } catch (err) {
        return uploadFailed(err, reply);
      }
    },
  );

  app.get<{ Params: { id: string; doc: string; number: number } }>(
    '/libraries/:id/documents/:doc/versions/:number/original',
    { schema: { params: VERSION_PARAMS } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const doc = await documentFor(caller, req.params, reply);
      if (!doc) return reply;
      const version = await store.version(doc.id, req.params.number);
      const file = version && (await objects.get(version.objectKey));
      if (!version || !file) return reply.code(404).send({ error: 'not-found', message: 'There’s no such version of this document.' });
      // A download of an original is always on the record: none is given without one.
      try {
        await audit({ actor: caller.id, action: 'document.downloaded', target: doc.id, workspace: doc.workspace, detail: { library: doc.library, version: version.number } });
      } catch (err) {
        file.destroy();
        log.error({ err: (err as Error).message, target: doc.id }, 'could not record a download in the audit log');
        return reply.code(503).send({ error: 'audit-unavailable', message: 'Downloads are paused until the audit log is back. Try again in a moment.' });
      }
      return reply
        .header('content-type', version.mediaType)
        .header('content-length', String(version.size))
        .header('content-disposition', attachment(version.filename))
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "sandbox; default-src 'none'")
        .header('cache-control', 'private, no-store')
        .send(file);
    },
  );

  await renditionRoutes(app, { store, objects, documentFor, onFloor });
};
