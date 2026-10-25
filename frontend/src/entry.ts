import { DOCUMENT_OPEN, DOCUMENT_PICK, LIBRARY_OPEN, defineMicroFrontend, isDocumentRef, isLibraryRef, openDocument, type DocumentPick, type Intent, type MountContext } from '@augur/mfe-sdk';
import { html, render } from 'lit';
import '@augur/ui-kit';
import { FolioApi, pathFor, placeFor, type Brief, type Place } from './api.js';
import './folio-app.js';
import './folio-glance.js';
import './folio-picker.js';
import type { Picked } from './folio-picker.js';

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
        ?publisher=${ctx.user.roles.includes('publisher')}
        floor-name=${ctx.workspace.name}
        floor-kind=${ctx.workspace.kind}
        .place=${placeForIntent(ctx.intent) ?? placeFor(ctx.path)}
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
