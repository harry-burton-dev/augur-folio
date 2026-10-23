import { defineMicroFrontend, type MountContext } from '@augur/mfe-sdk';
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
        floor-name=${ctx.workspace.name}
        .place=${placeFor(ctx.path)}
        @folio-place=${moved}
      ></folio-app>`,
      el,
    );
  },
  unmount(el: HTMLElement) {
    render(html``, el);
  },
});
