import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { LibraryRights, OnFloor } from './app.ts';
import { DOCUMENT_SORTS, SINCE, type FolioStore, type Library, type SavedView, type Tag } from './store.ts';

/** File kinds as people filter by them, and the media type each is kept as. */
export const KINDS: Record<string, string> = {
  pdf: 'application/pdf',
  word: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  html: 'text/html',
  markdown: 'text/markdown',
  text: 'text/plain',
};

const ID = { type: 'string', maxLength: 64 } as const;
export const TAG_NAME = { type: 'string', minLength: 1, maxLength: 40, pattern: '\\S' } as const;
const VIEW_NAME = { type: 'string', minLength: 1, maxLength: 60, pattern: '\\S' } as const;

/** A set of filters, as a saved view keeps it and as the document list takes it. */
export const VIEW_QUERY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    folder: ID,
    tags: { type: 'array', maxItems: 20, items: ID },
    types: { type: 'array', maxItems: 5, items: { type: 'string', enum: Object.keys(KINDS) } },
    authors: { type: 'array', maxItems: 50, items: ID },
    since: { type: 'string', enum: Object.keys(SINCE) },
    from: { type: 'string', maxLength: 40 },
    to: { type: 'string', maxLength: 40 },
    sort: { type: 'string', enum: DOCUMENT_SORTS },
  },
} as const;

export interface TagDeps {
  store: FolioStore;
  onFloor(req: FastifyRequest, reply: FastifyReply): OnFloor | undefined;
  libraryFor(caller: OnFloor, id: string, reply: FastifyReply): Promise<Library | undefined>;
  refused(err: unknown, reply: FastifyReply): unknown;
  rightsOn(caller: OnFloor, library?: Library): LibraryRights;
}

/** The org's tags are kept by the leads on the org's own floor. */
const keepsOrgTags = (caller: OnFloor) => caller.workspace.kind === 'org' && caller.workspace.role === 'lead';

/** A time a person gave, in ISO: undefined when they gave none, null when it isn't a time. */
export const timeOf = (value: string | undefined) => {
  if (!value) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
};

/**
 * Tags, the org's and each library's, and the views saved in a library. Tagging
 * documents is with the documents (documents.ts).
 */
export const tagRoutes = async (app: FastifyInstance, { store, onFloor, libraryFor, refused, rightsOn }: TagDeps) => {
  const notFound = (reply: FastifyReply, what: string) => reply.code(404).send({ error: 'not-found', message: `There’s no such ${what} here.` });
  const forbidden = (reply: FastifyReply, message: string) => reply.code(403).send({ error: 'forbidden', message });

  app.get('/tags', async (req, reply) => {
    const caller = onFloor(req, reply);
    if (!caller) return reply;
    return { tags: await store.orgTags(), can: { manage: keepsOrgTags(caller) } };
  });

  app.post<{ Body: { name: string } }>(
    '/tags',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: TAG_NAME } } } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      if (!keepsOrgTags(caller)) return forbidden(reply, 'Only the org’s leads, on the org’s floor, can keep its tags.');
      try {
        return reply.code(201).send(await store.createTag({ workspace: caller.workspace.id, name: req.body.name.trim(), createdBy: caller.id }));
      } catch (err) {
        return refused(err, reply);
      }
    },
  );

  /** One of the org's tags, for its leads. */
  const orgTagFor = async (caller: OnFloor, id: string, reply: FastifyReply): Promise<Tag | undefined> => {
    const tag = await store.tag(id);
    if (!tag || tag.library) return void notFound(reply, 'org tag');
    if (!keepsOrgTags(caller)) return void forbidden(reply, 'Only the org’s leads, on the org’s floor, can keep its tags.');
    return tag;
  };

  const TAG_PARAMS = { type: 'object', properties: { tag: ID }, required: ['tag'] } as const;

  app.patch<{ Params: { tag: string }; Body: { name: string } }>(
    '/tags/:tag',
    { schema: { params: TAG_PARAMS, body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: TAG_NAME } } } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller || !(await orgTagFor(caller, req.params.tag, reply))) return reply;
      try {
        return await store.renameTag(req.params.tag, req.body.name.trim());
      } catch (err) {
        return refused(err, reply);
      }
    },
  );

  app.delete<{ Params: { tag: string } }>('/tags/:tag', { schema: { params: TAG_PARAMS } }, async (req, reply) => {
    const caller = onFloor(req, reply);
    if (!caller || !(await orgTagFor(caller, req.params.tag, reply))) return reply;
    await store.deleteTag(req.params.tag);
    return reply.code(204).send();
  });

  const LIBRARY_PARAMS = { type: 'object', properties: { id: ID }, required: ['id'] } as const;
  const LIBRARY_TAG_PARAMS = { type: 'object', properties: { id: ID, tag: ID }, required: ['id', 'tag'] } as const;
  const VIEW_PARAMS = { type: 'object', properties: { id: ID, view: ID }, required: ['id', 'view'] } as const;

  app.post<{ Params: { id: string }; Body: { name: string } }>(
    '/libraries/:id/tags',
    { schema: { params: LIBRARY_PARAMS, body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: TAG_NAME } } } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const library = await libraryFor(caller, req.params.id, reply);
      if (!library) return reply;
      if (!rightsOn(caller, library).addTags) return forbidden(reply, 'Only the floor’s leads can add tags to this library.');
      try {
        return reply.code(201).send(await store.createTag({ workspace: library.workspace, library: library.id, name: req.body.name.trim(), createdBy: caller.id }));
      } catch (err) {
        return refused(err, reply);
      }
    },
  );

  /** One of the library's own tags, for its leads. */
  const libraryTagFor = async (caller: OnFloor, params: { id: string; tag: string }, reply: FastifyReply) => {
    const library = await libraryFor(caller, params.id, reply);
    if (!library) return undefined;
    const tag = await store.tag(params.tag);
    if (!tag || tag.library !== library.id) return void notFound(reply, 'tag in this library');
    if (!rightsOn(caller, library).manage) return void forbidden(reply, 'Only the floor’s leads can change this library’s tags.');
    return tag;
  };

  app.patch<{ Params: { id: string; tag: string }; Body: { name: string } }>(
    '/libraries/:id/tags/:tag',
    { schema: { params: LIBRARY_TAG_PARAMS, body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: TAG_NAME } } } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller || !(await libraryTagFor(caller, req.params, reply))) return reply;
      try {
        return await store.renameTag(req.params.tag, req.body.name.trim());
      } catch (err) {
        return refused(err, reply);
      }
    },
  );

  app.delete<{ Params: { id: string; tag: string } }>('/libraries/:id/tags/:tag', { schema: { params: LIBRARY_TAG_PARAMS } }, async (req, reply) => {
    const caller = onFloor(req, reply);
    if (!caller || !(await libraryTagFor(caller, req.params, reply))) return reply;
    await store.deleteTag(req.params.tag);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string }; Body: { name: string; query: SavedView['query'] } }>(
    '/libraries/:id/views',
    { schema: { params: LIBRARY_PARAMS, body: { type: 'object', additionalProperties: false, required: ['name', 'query'], properties: { name: VIEW_NAME, query: VIEW_QUERY } } } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const library = await libraryFor(caller, req.params.id, reply);
      if (!library) return reply;
      try {
        return reply.code(201).send(await store.createView({ library: library.id, name: req.body.name.trim(), query: req.body.query, createdBy: caller.id }));
      } catch (err) {
        return refused(err, reply);
      }
    },
  );

  /** A view in the library, for whoever saved it or a lead. */
  const viewFor = async (caller: OnFloor, params: { id: string; view: string }, reply: FastifyReply) => {
    const library = await libraryFor(caller, params.id, reply);
    if (!library) return undefined;
    const view = await store.view(params.view);
    if (!view || view.library !== library.id) return void notFound(reply, 'view in this library');
    if (view.createdBy !== caller.id && !rightsOn(caller, library).manage) return void forbidden(reply, 'Only whoever saved the view, or the floor’s leads, can change it.');
    return view;
  };

  app.patch<{ Params: { id: string; view: string }; Body: { name?: string; query?: SavedView['query'] } }>(
    '/libraries/:id/views/:view',
    { schema: { params: VIEW_PARAMS, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { name: VIEW_NAME, query: VIEW_QUERY } } } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller || !(await viewFor(caller, req.params, reply))) return reply;
      try {
        return await store.updateView(req.params.view, { name: req.body.name?.trim(), query: req.body.query });
      } catch (err) {
        return refused(err, reply);
      }
    },
  );

  app.delete<{ Params: { id: string; view: string } }>('/libraries/:id/views/:view', { schema: { params: VIEW_PARAMS } }, async (req, reply) => {
    const caller = onFloor(req, reply);
    if (!caller || !(await viewFor(caller, req.params, reply))) return reply;
    await store.deleteView(req.params.view);
    return reply.code(204).send();
  });
};
