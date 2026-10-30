import { DOCUMENT_OPEN, DOCUMENT_PICK, ENTITY_PROPOSE, LIBRARY_OPEN, defineMicroFrontend, isDocumentRef, isIntentCancelled, isLibraryRef, openDocument, proposeEntity, type DocumentPick, type Intent, type MountContext } from '@augur/mfe-sdk';
import { html, render } from 'lit';
import '@augur/ui-kit';
import { FolioApi, pathFor, placeFor, type Brief, type Place } from './api.js';
import './folio-app.js';
import './folio-glance.js';
import './folio-picker.js';
import type { Picked } from './folio-picker.js';
import type { ExplainPayload } from './folio-share.js';
import type { MarkedPassage } from '@augur/ui-kit';

/**
 * Offers words marked in a document to whichever app keeps entities (Data
 * Atlas), and says in a sentence what became of them.
 */
export const proposeFrom =
  (ctx: Pick<MountContext, 'request'>) =>
  async (doc: { id: string; title: string }, passage: MarkedPassage, version: number): Promise<string> => {
    try {
      const receipt = await proposeEntity(ctx, {
        source: { app: 'folio', id: doc.id, version: String(version), title: doc.title },
        ...(passage.anchor ? { anchor: passage.anchor } : {}),
        text: passage.text,
        ...(passage.context ? { context: passage.context } : {}),
      });
      return `Sent to ${receipt.queue}. Its leads decide what it names.`;
    } catch (err) {
      if (isIntentCancelled(err)) return 'Not sent.';
      if ((err as Error).message.includes(`"${ENTITY_PROPOSE}"`)) throw new Error('Data Atlas isn’t open to you on this floor, so there’s nowhere to add it.');
      throw err;
    }
  };

/**
 * Where Folio is in the address bar, so a place in it can be shared, and Back
 * goes to the last one: the shell mounts Folio again with that path.
 */
export const addressFor = (pathname: string, mountedAt: string, place: Omit<Place, 'adding'>) => {
  const inner = mountedAt === '/' ? '' : mountedAt;
  if (!pathname.endsWith(inner)) return undefined;
  return `${pathname.slice(0, pathname.length - inner.length)}${pathFor(place)}`;
};

/** Opens Folio at a place in it, `{ path }` as its address has it: how its card on Home goes in. */
export const FOLIO_OPEN = 'folio.open';

/**
 * Where an intent asks Folio to start: `folio.open` at the path it names,
 * `library.open` at one of Folio's libraries, or `document.open` for one of
 * Folio's own documents opens it to read, at the version asked for. Its
 * library is found from the document.
 */
export const placeForIntent = (intent: Intent | undefined): Place | undefined => {
  if (intent?.type === FOLIO_OPEN) {
    const path = (intent.payload as { path?: unknown } | undefined)?.path;
    return typeof path === 'string' ? placeFor(path) : undefined;
  }
  if (intent?.type === LIBRARY_OPEN) return isLibraryRef(intent.payload) && intent.payload.app === 'folio' ? { library: intent.payload.id, adding: false } : undefined;
  if (intent?.type !== DOCUMENT_OPEN || !isDocumentRef(intent.payload) || intent.payload.app !== 'folio') return undefined;
  const version = /^[1-9]\d*$/.test(intent.payload.version ?? '') ? Number(intent.payload.version) : undefined;
  return { document: intent.payload.id, ...(version ? { version } : {}), adding: false };
};

/** Asks whichever app explains access (Auspex) to say who can open a library or document, over Artifacts. */
export const ACCESS_EXPLAIN = 'access.explain';

/** Folio: libraries of documents on each floor. What the shell mounts at /folio. */
export default defineMicroFrontend({
  mount(el: HTMLElement, ctx: MountContext) {
    // Another app asked for a document: Folio opens over it as a picker, and answers with the one chosen.
    if (ctx.intent?.type === DOCUMENT_PICK && ctx.reply) {
      const reply = ctx.reply;
      const pick = (ctx.intent.payload ?? {}) as DocumentPick;
      render(
        html`<folio-picker
          .api=${new FolioApi((path, init) => ctx.fetch(path, init))}
          purpose=${typeof pick.purpose === 'string' ? pick.purpose : ''}
          .accept=${Array.isArray(pick.accept) ? pick.accept.filter((a) => typeof a === 'string') : []}
          @folio-picked=${(e: CustomEvent<{ document: Picked }>) => reply.respond(e.detail.document)}
          @folio-cancel=${() => reply.cancel()}
        ></folio-picker>`,
        el,
      );
      return;
    }
    let mountedAt = ctx.path;
    const moved = (e: CustomEvent<Omit<Place, 'adding'>>) => {
      const to = addressFor(window.location.pathname, mountedAt, e.detail);
      if (!to || to === window.location.pathname) return;
      window.history.pushState(window.history.state, '', to);
      mountedAt = pathFor(e.detail);
    };
    render(
      html`<folio-app
        .api=${new FolioApi((path, init) => ctx.fetch(path, init))}
        .userId=${ctx.user.id}
        .floorKey=${ctx.workspace.kind === 'org' ? 'org' : ctx.workspace.id}
        .propose=${proposeFrom(ctx)}
        ?publisher=${ctx.user.roles.includes('publisher')}
        floor-name=${ctx.workspace.name}
        floor-kind=${ctx.workspace.kind}
        .place=${placeForIntent(ctx.intent) ?? placeFor(ctx.path)}
        .explain=${(payload: ExplainPayload) => ctx.request({ type: ACCESS_EXPLAIN, payload })}
        @folio-place=${moved}
      ></folio-app>`,
      el,
    );
  },
  unmount(el: HTMLElement) {
    render(html``, el);
  },
  surfaces: {
    /** The card on Home: what's new to the person, and the floor's drafts for its leads. */
    './Glance': {
      mount(el: HTMLElement, ctx: MountContext) {
        render(
          html`<folio-glance
            .api=${new FolioApi((path, init) => ctx.fetch(path, init))}
            @folio-open-document=${(e: CustomEvent<{ document: Brief }>) => void openDocument(ctx, { app: 'folio', id: e.detail.document.id, title: e.detail.document.title })}
            @folio-open-published=${() => void ctx.raise({ type: FOLIO_OPEN, payload: { path: '/published' } })}
          ></folio-glance>`,
          el,
        );
      },
      unmount(el: HTMLElement) {
        render(html``, el);
      },
    },
  },
});
