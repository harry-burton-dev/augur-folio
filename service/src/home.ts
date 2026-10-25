import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { OnFloor } from './app.ts';
import type { CallerPrincipals } from './people.ts';
import type { FolioDocument, FolioStore } from './store.ts';

export interface HomeDeps {
  store: FolioStore;
  onFloor(req: FastifyRequest, reply: FastifyReply): OnFloor | undefined;
  principalsOf: CallerPrincipals;
}

/** What Find takes from an app (the SDK's `SearchAnswer`, SDK 1.3). */
interface SearchAnswer {
  results: { id: string; title: string; detail?: string; path?: string; workspace?: string }[];
}

/** How many documents Home's card names in each list. */
const ON_CARD = 3;
/** How many results Find shows from one app. */
const FOUND = 10;

/** A document as Home's card names it. */
const brief = (d: FolioDocument & { libraryName: string }) => ({ id: d.id, library: d.library, title: d.title, libraryName: d.libraryName, at: d.published?.publishedAt ?? d.updatedAt });

/**
 * Folio in the shell: Find over the documents someone may read (by title, tags
 * and text), and Home's card, which says what's been published to them since
 * they last looked and, for the floor's leads, the drafts waiting to publish.
 */
export const homeRoutes = async (app: FastifyInstance, { store, onFloor, principalsOf }: HomeDeps) => {
  app.get<{ Querystring: { q?: string } }>(
    '/search',
    { schema: { querystring: { type: 'object', properties: { q: { type: 'string', maxLength: 200 } } } } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const principals = await principalsOf(caller);
      const hits = await store.search(principals, req.query.q ?? '', FOUND);
      return {
        results: hits.map(({ document: d, libraryName, audienceOnly }) => ({
          id: d.id,
          title: d.title,
          detail: [audienceOnly ? `Published to you from ${libraryName}` : `In ${libraryName}`, d.issue && !d.issue.period.startsWith('Issue') ? d.issue.period : '', d.state === 'published' && !audienceOnly ? 'Published' : '']
            .filter(Boolean)
            .join(' · '),
          path: `/libraries/${encodeURIComponent(d.library)}/documents/${encodeURIComponent(d.id)}`,
          // On a team's floor the person is on, it opens there; anything else opens from where they are.
          ...(!audienceOnly && d.workspace !== caller.workspace.id && principals.includes(`team:${d.workspace}`) ? { workspace: d.workspace } : {}),
        })),
      } satisfies SearchAnswer;
    },
  );

  /** What Home's card shows: what's new to the caller, and the floor's drafts for its leads. */
  app.get('/home', async (req, reply) => {
    const caller = onFloor(req, reply);
    if (!caller) return reply;
    const since = await store.lookedAt(caller.id);
    const fresh = await store.publishedTo(await principalsOf(caller), { limit: ON_CARD, since });
    const drafts = caller.workspace.role === 'lead' ? await store.draftsOn(caller.workspace.id, { limit: ON_CARD }) : undefined;
    return {
      published: { new: fresh.total, ...(since ? { since } : {}), documents: fresh.documents.map(brief) },
      ...(drafts ? { drafts: { total: drafts.total, documents: drafts.documents.map(brief) } } : {}),
    };
  });

  /** The caller has looked at what's published to them: Home stops counting it as new. */
  app.put('/published/looked', async (req, reply) => {
    const caller = onFloor(req, reply);
    if (!caller) return reply;
    await store.markLooked(caller.id);
    return reply.code(204).send();
  });
};
