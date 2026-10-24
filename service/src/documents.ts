import { createHash, randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Audit } from './audit.ts';
import type { OnFloor } from './app.ts';
import type { ObjectStore } from './objects.ts';
import { objectKeyFor, type FolioDocument, type FolioStore, type Library, type NewVersion } from './store.ts';

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
  libraryFor(caller: OnFloor, id: string, reply: FastifyReply): Promise<Library | undefined>;
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
export const documentRoutes = async (app: FastifyInstance, { store, objects, audit, onFloor, libraryFor, refused, log, maxUploadBytes = MAX_UPLOAD_BYTES }: DocumentDeps) => {
  // Every upload reaches its route as a stream, whatever it says it is; the route decides what it takes.
  app.removeContentTypeParser('text/plain');
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

  /** Whoever added a document, or a lead, may change it. */
  const mayChange = (caller: OnFloor, doc: FolioDocument) => doc.createdBy === caller.id || caller.workspace.role === 'lead';

  const documentFor = async (caller: OnFloor, params: { id: string; doc: string }, reply: FastifyReply) => {
    const library = await libraryFor(caller, params.id, reply);
    if (!library) return undefined;
    const doc = await store.document(params.doc);
    if (!doc || doc.library !== library.id) {
      reply.code(404).send({ error: 'not-found', message: 'There’s no such document in this library.' });
      return undefined;
    }
    return doc;
  };

  const forbidden = (reply: FastifyReply) => reply.code(403).send({ error: 'forbidden', message: 'Only whoever added the document, or the floor’s leads, can change it.' });

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

  app.get<{ Params: { id: string }; Querystring: { folder?: string } }>(
    '/libraries/:id/documents',
    { schema: { params: { type: 'object', properties: { id: { type: 'string', maxLength: 64 } }, required: ['id'] }, querystring: { type: 'object', properties: { folder: { type: 'string', maxLength: 64 } } } } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const library = await libraryFor(caller, req.params.id, reply);
      if (!library) return reply;
      const documents = await store.documents(library.id, req.query.folder || undefined);
      return { documents: documents.map((d) => ({ ...d, can: { change: mayChange(caller, d) } })) };
    },
  );

  app.post<{ Params: { id: string }; Querystring: { filename: string; title?: string; folder?: string } }>(
    '/libraries/:id/documents',
    { schema: { params: { type: 'object', properties: { id: { type: 'string', maxLength: 64 } }, required: ['id'] }, querystring: FILE_QUERY } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const library = await libraryFor(caller, req.params.id, reply);
      if (!library) return reply;
      const { filename, folder } = req.query;
      const mediaType = typeOf(req, filename, reply);
      if (!mediaType) return reply;
      if (folder && !(await store.folders(library.id)).some((f) => f.id === folder))
        return reply.code(400).send({ error: 'bad-parent', message: 'That folder isn’t in this library.' });
      const id = randomUUID();
      try {
        const first = await receive(req, id, filename, mediaType, caller.id);
        if (!first.size) {
          await objects.delete(first.objectKey);
          return reply.code(400).send({ error: 'empty', message: 'That file is empty.' });
        }
        const title = req.query.title?.trim() || titleFrom(filename);
        const doc = await store.createDocument({ id, library: library.id, folder: folder || undefined, title, createdBy: caller.id }, first).catch(async (err) => {
          await objects.delete(first.objectKey).catch(() => undefined);
          throw err;
        });
        await recorded({ actor: caller.id, action: 'document.uploaded', target: doc.id, workspace: library.workspace, detail: { library: library.id, title, version: 1, size: first.size, sha256: first.sha256 } });
        return reply.code(201).send({ ...doc, can: { change: true } });
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
    return { ...doc, versions: await store.versions(doc.id), can: { change: mayChange(caller, doc) } };
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
      if (!mayChange(caller, doc)) return forbidden(reply);
      try {
        const changed = await store.updateDocument(doc.id, { title: req.body.title?.trim(), folder: req.body.folder });
        return { ...changed, can: { change: true } };
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
    if (!mayChange(caller, doc)) return forbidden(reply);
    await store.deleteDocument(doc.id, caller.id);
    await recorded({ actor: caller.id, action: 'document.deleted', target: doc.id, workspace: doc.workspace, detail: { library: doc.library, title: doc.title } });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string; doc: string }; Querystring: { filename: string } }>(
    '/libraries/:id/documents/:doc/versions',
    { schema: { params: DOC_PARAMS, querystring: FILE_QUERY } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const doc = await documentFor(caller, req.params, reply);
      if (!doc) return reply;
      if (!mayChange(caller, doc)) return forbidden(reply);
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
};
