import { DOCUMENT_OPEN, defineMicroFrontend, isDocumentRef, type Intent, type MountContext } from '@augur/mfe-sdk';
import { html, render } from 'lit';
import '@augur/ui-kit';
import { FolioApi, pathFor, placeFor, type Place } from './api.js';
import './folio-app.js';

/**
 * Where Folio is in the address bar, so a place in it can be shared, and Back
 * goes to the last one: the shell mounts Folio again with that path.
 */
export const addressFor = (pathname: string, mountedAt: string, place: Omit<Place, 'adding'>) => {
  const inner = mountedAt === '/' ? '' : mountedAt;
  if (!pathname.endsWith(inner)) return undefined;
  return `${pathname.slice(0, pathname.length - inner.length)}${pathFor(place)}`;
};

/**
 * Where an intent asks Folio to start: `document.open` for one of Folio's own
 * documents opens it to read, at the version asked for. Its library is found
 * from the document.
 */
export const placeForIntent = (intent: Intent | undefined): Place | undefined => {
  if (intent?.type !== DOCUMENT_OPEN || !isDocumentRef(intent.payload) || intent.payload.app !== 'folio') return undefined;
  const version = /^[1-9]\d*$/.test(intent.payload.version ?? '') ? Number(intent.payload.version) : undefined;
  return { document: intent.payload.id, ...(version ? { version } : {}), adding: false };
};

/** Folio: libraries of documents on each floor. What the shell mounts at /folio. */
export default defineMicroFrontend({
  mount(el: HTMLElement, ctx: MountContext) {
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
});
