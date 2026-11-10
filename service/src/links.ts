import { RELATIONS, type Level } from '@augur/records';
import { Problem, type AppAudit, type AppNotify, type OnFloor } from '@augur/service-kit';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { pathTo, reaches, type FloorAccess } from './access.ts';
import type { LinkEnd, LinkKind, LinksAnswer, LinkView } from './api-types.ts';
import { LinkedError, type DocumentRecord, type FolderRecord, type LinkRecord, type Store, type VersionRecord } from './store.ts';

/**
 * Links between documents (`@augur/records` relations) and following a series (the spec's D6).
 *
 * A document links to another document here: relates to, supersedes, responds to. Anyone who can open it
 * sees its links both ways; whoever may change it links and unlinks. A linked document the caller can't
 * open stays listed and says so. "About" and "Serves" point at things other apps keep, and stay listed,
 * unavailable, with why.
 *
 * Whoever can read a series may follow it, and is told each time one of its documents is Issued.
 */

/** What Artifacts' own documents are called in a link to them. */
export const DOCUMENT_KIND = 'document';
/** The links made between documents here. */
const OWN = new Set(['relates-to', 'supersedes', 'responds-to']);
const WHY_NOT: Record<string, string> = {
  about: 'Saying what a document is about, from the floor’s knowledge, comes in the next version of Artifacts.',
  serves: 'No app on this floor keeps intents yet, so “Serves” has nothing to link to. An admin can install one.',
};
const SERIES_LEVELS = new Set(['series', 'subseries']);

type Read = { document: DocumentRecord; access: FloorAccess; level: Level; reached?: unknown };

export interface LinkDeps {
  app: string;
  store: Store;
  notify: AppNotify;
  recorded: (entry: Parameters<AppAudit>[0]) => void;
  log: FastifyBaseLogger;
  callerOf: (req: FastifyRequest) => Promise<OnFloor>;
  readDocument: (caller: OnFloor, id: string) => Promise<Read>;
  readFolder: (caller: OnFloor, id: string) => Promise<{ folder: FolderRecord; access: FloorAccess; level: Level }>;
}

export const linking = ({ app: own, store, notify, recorded, log, callerOf, readDocument, readFolder }: LinkDeps) => {
  const readable = async (caller: OnFloor, id: string) => {
    try {
      return await readDocument(caller, id);
    } catch {
      return undefined;
    }
  };

  /** Whether the caller may change a document's links: whoever may change it, on its own floor's terms. */
  const mayChange = (read: Read) => !read.reached && reaches(read.level, 'edit');

  const end = async (caller: OnFloor, to: LinkRecord['to']): Promise<LinkEnd> => {
    if (to.app !== own || to.kind !== DOCUMENT_KIND) return { ...to, label: to.label ?? to.id };
    const read = await readable(caller, to.id);
    return read ? { ...to, label: read.document.title } : { ...to, label: to.label ?? 'A document', unavailable: `${to.label ?? 'It'} isn’t shared with you.` };
  };

  const view = async (caller: OnFloor, l: LinkRecord, back: boolean, names: ReadonlyMap<string, string>): Promise<LinkView> => {
    const def = RELATIONS.find((r) => r.id === l.relation);
    return {
      id: l.id,
      relation: l.relation,
      words: (back ? def?.inverse : def?.name) ?? l.relation,
      ...(back ? { from: await end(caller, { app: own, kind: DOCUMENT_KIND, id: l.from }) } : { to: await end(caller, l.to) }),
      by: l.by,
      ...(names.get(l.by) ? { byName: names.get(l.by) } : {}),
      at: l.at,
    };
  };

  const kinds = (): LinkKind[] => RELATIONS.map((r) => ({ ...r, available: OWN.has(r.id), ...(WHY_NOT[r.id] ? { why: WHY_NOT[r.id] } : {}) }));

  /** The nearest series a document is in, when it is in one. */
  const seriesOf = (access: FloorAccess, document: DocumentRecord) => pathTo(access.folders, document.folder).reverse().find((f) => SERIES_LEVELS.has(f.level));

  /** Tells a series' followers that one of its documents was Issued, leaving out whoever issued it. A failure doesn't undo it. */
  const issued = async (by: OnFloor, access: FloorAccess, document: DocumentRecord, version: VersionRecord) => {
    const series = seriesOf(access, document);
    if (!series) return;
    try {
      const recipients = (await store.followers(series.id)).filter((id) => id !== by.id);
      if (!recipients.length) return;
      await notify({
        recipients,
        workspace: document.workspace,
        kind: 'issue',
        title: `A new issue of ${series.name}: ${document.title}`,
        detail: `Version ${version.number} was Issued by ${by.name}.`,
        link: `/documents/${document.id}`,
      });
    } catch (err) {
      log.error({ err: (err as Error).message, series: series.id }, 'could not tell the series’ followers');
    }
  };

  /** What a series folder says about following it, for its folder answer. */
  const followOf = async (caller: OnFloor, folder: FolderRecord) => {
    if (!SERIES_LEVELS.has(folder.level)) return undefined;
    const followers = await store.followers(folder.id);
    return { following: followers.includes(caller.id), followers: followers.length };
  };

  const routes = async (app: FastifyInstance) => {
    const ID = { type: 'string', minLength: 1, maxLength: 64 } as const;
    const idParams = { type: 'object', required: ['id'], properties: { id: ID } } as const;

    app.get<{ Params: { id: string } }>('/documents/:id/links', { schema: { params: idParams } }, async (req): Promise<LinksAnswer> => {
      const caller = await callerOf(req);
      const read = await readDocument(caller, req.params.id);
      const { from, to } = await store.links(read.document.id, own);
      const names = await store.names([...from, ...to].map((l) => l.by));
      const change = mayChange(read);
      return {
        kinds: kinds(),
        links: await Promise.all(from.map((l) => view(caller, l, false, names))),
        back: await Promise.all(to.map((l) => view(caller, l, true, names))),
        can: { change, ...(change ? {} : { why: 'Only someone who can change it, on its own floor, links it to other documents.' }) },
      };
    });

    app.post<{ Params: { id: string }; Body: { relation: string; to: { app?: string; kind?: string; id: string } } }>(
      '/documents/:id/links',
      {
        schema: {
          params: idParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['relation', 'to'],
            properties: {
              relation: { type: 'string', maxLength: 40 },
              to: { type: 'object', additionalProperties: false, required: ['id'], properties: { app: { type: 'string', maxLength: 40 }, kind: { type: 'string', maxLength: 30 }, id: ID } },
            },
          },
        },
      },
      async (req, reply) => {
        const caller = await callerOf(req);
        const read = await readDocument(caller, req.params.id);
        if (!mayChange(read)) throw new Problem(403, 'forbidden', 'Only someone who can change it links it to other documents.', { whoCanChange: 'The floor’s leads, or whoever shared it with you.' });
        const { relation, to } = req.body;
        if (WHY_NOT[relation]) throw new Problem(409, 'unavailable', WHY_NOT[relation]!);
        if (!OWN.has(relation)) throw new Problem(400, 'bad_link', 'That isn’t a kind of link Artifacts knows.');
        if ((to.app && to.app !== own) || (to.kind && to.kind !== DOCUMENT_KIND)) throw new Problem(400, 'bad_link', 'This kind of link is to another document in Artifacts.');
        if (to.id === read.document.id) throw new Problem(400, 'bad_link', 'A document can’t be linked to itself.');
        const target = await readable(caller, to.id);
        if (!target) throw new Problem(400, 'bad_link', 'Link to a document you can open.');
        const made = await store
          .link({ workspace: read.document.workspace, from: read.document.id, relation, to: { app: own, kind: DOCUMENT_KIND, id: to.id, label: target.document.title }, by: caller.id })
          .catch((err: unknown) => {
            if (err instanceof LinkedError) throw new Problem(409, 'already_linked', err.message);
            throw err;
          });
        recorded({ actor: caller.id, action: 'document.linked', target: read.document.id, workspace: read.document.workspace, detail: { relation, to: to.id } });
        return reply.code(201).send(await view(caller, made, false, await store.names([caller.id])));
      },
    );

    app.delete<{ Params: { id: string; link: string } }>(
      '/documents/:id/links/:link',
      { schema: { params: { type: 'object', required: ['id', 'link'], properties: { id: ID, link: ID } } } },
      async (req, reply) => {
        const caller = await callerOf(req);
        const read = await readDocument(caller, req.params.id);
        if (!mayChange(read)) throw new Problem(403, 'forbidden', 'Only someone who can change it unlinks it.', { whoCanChange: 'The floor’s leads, or whoever shared it with you.' });
        if (!(await store.unlink(read.document.id, req.params.link))) throw new Problem(404, 'not_found', 'It isn’t linked that way.');
        recorded({ actor: caller.id, action: 'document.unlinked', target: read.document.id, workspace: read.document.workspace, detail: { link: req.params.link } });
        return reply.code(204).send();
      },
    );

    app.put<{ Params: { id: string }; Body: { on: boolean } }>(
      '/folders/:id/follow',
      { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['on'], properties: { on: { type: 'boolean' } } } } },
      async (req) => {
        const caller = await callerOf(req);
        const { folder } = await readFolder(caller, req.params.id);
        if (!SERIES_LEVELS.has(folder.level)) throw new Problem(400, 'not_series', 'Only a series can be followed. Its new issues are what followers are told of.');
        await store.follow(folder.id, caller.id, req.body.on);
        return followOf(caller, folder);
      },
    );
  };

  return { routes, issued, followOf };
};
