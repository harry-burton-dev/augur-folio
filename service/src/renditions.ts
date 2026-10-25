import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { OnFloor } from './app.ts';
import { mayChange, mayRead, type DocumentFor } from './documents.ts';
import type { ObjectStore } from './objects.ts';
import { renditionPrefix, type FolioStore, type StoredVersion } from './store.ts';

export interface RenditionDeps {
  store: FolioStore;
  objects: ObjectStore;
  documentFor: DocumentFor;
  onFloor(req: FastifyRequest, reply: FastifyReply): OnFloor | undefined;
}

const ID = { type: 'string', maxLength: 64 } as const;
const VERSION_PARAMS = { type: 'object', properties: { id: ID, doc: ID, number: { type: 'integer', minimum: 1 } }, required: ['id', 'doc', 'number'] } as const;
const IMAGE_PARAMS = { ...VERSION_PARAMS, properties: { ...VERSION_PARAMS.properties, name: { type: 'string', pattern: '^[0-9]{1,5}\\.png$' } }, required: [...VERSION_PARAMS.required, 'name'] } as const;

type VersionParams = { id: string; doc: string; number: number };

/** Made from someone's file, so never run as a page: no scripts, no requests, no guessing its type. */
const contained = (reply: FastifyReply, contentType: string) =>
  reply
    .header('content-type', contentType)
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "sandbox; default-src 'none'")
    .header('cache-control', 'private, no-store');

/**
 * A version's renditions, as the rendition worker (apps/folio/worker) leaves them:
 * its reader copy in Markdown and the pictures that shows, a thumbnail of its first
 * page, and its words as plain text. Anyone who may see the document may read them;
 * whoever may change it may ask for a failed one again.
 */
export const renditionRoutes = async (app: FastifyInstance, { store, objects, documentFor, onFloor }: RenditionDeps) => {
  const noVersion = (reply: FastifyReply) => reply.code(404).send({ error: 'not-found', message: 'There’s no such version of this document.' });

  /** The version and its rendition, or a refusal already sent. */
  const renditionFor = async (params: VersionParams, reply: FastifyReply) => {
    const caller = onFloor(reply.request, reply);
    if (!caller) return undefined;
    // Its audience reads the version that's out, as everyone else does.
    const doc = await documentFor(caller, params, reply, { audience: true });
    if (!doc) return undefined;
    const version = mayRead(doc, params.number) ? await store.version(doc.id, params.number) : undefined;
    const rendition = version && (await store.rendition(version.id));
    if (!version || !rendition) return void noVersion(reply);
    return { caller, doc, version, rendition };
  };

  /** The rendition when it's ready, or a 409 that says how it's coming along. */
  const readyFor = async (params: VersionParams, reply: FastifyReply) => {
    const found = await renditionFor(params, reply);
    if (!found) return undefined;
    if (found.rendition.state !== 'ready') {
      const message = found.rendition.state === 'failed' ? 'Folio couldn’t make a reader copy of this version.' : 'The reader copy of this version is still being made.';
      return void reply.code(409).send({ error: 'not-ready', message, reader: found.version.reader });
    }
    return found;
  };

  const sendObject = async (reply: FastifyReply, key: string | undefined, contentType: string) => {
    const file = key && (await objects.get(key));
    if (!file) return reply.code(404).send({ error: 'not-found', message: 'That isn’t there.' });
    return contained(reply, contentType).send(file);
  };

  app.get<{ Params: VersionParams }>('/libraries/:id/documents/:doc/versions/:number/reader', { schema: { params: VERSION_PARAMS } }, async (req, reply) => {
    const found = await readyFor(req.params, reply);
    if (!found) return reply;
    return sendObject(reply, found.rendition.readerKey, 'text/markdown; charset=utf-8');
  });

  app.get<{ Params: VersionParams & { name: string } }>(
    '/libraries/:id/documents/:doc/versions/:number/reader/images/:name',
    { schema: { params: IMAGE_PARAMS } },
    async (req, reply) => {
      const found = await readyFor(req.params, reply);
      if (!found) return reply;
      if (!found.rendition.images.includes(req.params.name)) return reply.code(404).send({ error: 'not-found', message: 'The reader copy has no such picture.' });
      return sendObject(reply, `${renditionPrefix(found.version.id)}images/${req.params.name}`, 'image/png');
    },
  );

  app.get<{ Params: VersionParams }>('/libraries/:id/documents/:doc/versions/:number/thumbnail', { schema: { params: VERSION_PARAMS } }, async (req, reply) => {
    const found = await readyFor(req.params, reply);
    if (!found) return reply;
    if (!found.rendition.thumbnailKey) return reply.code(404).send({ error: 'not-found', message: 'This version has no thumbnail.' });
    return sendObject(reply, found.rendition.thumbnailKey, 'image/png');
  });

  app.get<{ Params: VersionParams }>('/libraries/:id/documents/:doc/versions/:number/text', { schema: { params: VERSION_PARAMS } }, async (req, reply) => {
    const found = await readyFor(req.params, reply);
    if (!found) return reply;
    return contained(reply, 'text/plain; charset=utf-8').send(found.rendition.text ?? '');
  });

  app.post<{ Params: VersionParams }>('/libraries/:id/documents/:doc/versions/:number/reader/retry', { schema: { params: VERSION_PARAMS } }, async (req, reply) => {
    const found = await renditionFor(req.params, reply);
    if (!found) return reply;
    if (!mayChange(found.caller, found.doc, found.doc.shelf)) return reply.code(403).send({ error: 'forbidden', message: 'Only whoever added the document, or whoever may edit it, can ask for its reader copy again.' });
    if (!(await store.retryRendition(found.version.id))) return reply.code(409).send({ error: 'not-failed', message: 'Only a reader copy that failed can be asked for again.', reader: found.version.reader });
    return reply.code(202).send((await store.version(found.doc.id, found.version.number))!.reader);
  });
};

/**
 * Stands in for the rendition worker under `pnpm dev:app`, where there's no
 * Postgres for it to watch: Markdown and plain text are their own reader copies,
 * and everything else fails with a word on why.
 */
export const devRenderer = (store: FolioStore, objects: ObjectStore) => async (version: StoredVersion) => {
  if (version.mediaType !== 'text/markdown' && version.mediaType !== 'text/plain') {
    await store.finishRendition(version.id, { state: 'failed', error: 'Reader copies of PDF, Word and HTML files are made by the rendition worker, which isn’t running here.' });
    return;
  }
  const file = await objects.get(version.objectKey);
  const chunks: Buffer[] = [];
  for await (const chunk of file ?? []) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  const readerKey = `${renditionPrefix(version.id)}reader.md`;
  await objects.put(readerKey, Readable.from([version.mediaType === 'text/plain' ? text.replace(/[\\`*_#[\]<>|-]/g, '\\$&') : text]), 'text/markdown');
  await store.finishRendition(version.id, { state: 'ready', engine: 'dev', engineVersion: '0', readerKey, images: [], text });
};
