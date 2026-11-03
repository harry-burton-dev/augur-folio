import { DOCUMENT_OPEN, DOCUMENT_PICK, ENTITY_PICK, ENTITY_PROPOSE, LIBRARY_OPEN, defineMicroFrontend, isDocumentRef, isIntentCancelled, isLibraryRef, isUnitRef, UNIT_OPEN, openDocument, openEntity, pickEntities, proposeEntity, type DocumentPick, type Intent, type MountContext } from '@augur/mfe-sdk';
import manifest from '../../manifest.json' with { type: 'json' };
import { FolioApi, pathFor, placeFor, type Brief, type Place } from './api.js';
import type { OpenRef, PickRef } from './links.js';
import type { ExplainPayload } from './access.js';
import type { MarkedPassage } from '@augur/app-kit';
import { mountArtifacts, mountGlance, mountPicker, unmountArtifacts } from './quill/mount.js';

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
      if ((err as Error).message.includes(`"${ENTITY_PROPOSE}"`)) throw new Error('Data Atlas isn’t open to you on this floor, so there’s nowhere to add it.', { cause: err });
      throw err;
    }
  };

/** Mandate's intents, by the intents it handles: opening one, and asking the person for one. */
const AIM_OPEN = 'aim.open';
const AIM_PICK = 'aim.pick';

/**
 * Asks the person for the far end of a link in the app that keeps it: a thing
 * in Data Atlas (`entity.pick`), or an intent in Mandate (`aim.pick`). Answers
 * nothing when they close it without picking.
 */
export const pickFrom =
  (ctx: Pick<MountContext, 'request'>): PickRef =>
  async (app) => {
    try {
      if (app === 'atlas') {
        const [entity] = await pickEntities(ctx, { purpose: 'Say what it’s about' });
        return { app: 'atlas', kind: 'entity', id: entity!.id, ...(entity!.label ? { label: entity!.label } : {}) };
      }
      const aim = await ctx.request<{ kind?: unknown; id?: unknown; title?: unknown }>({ type: AIM_PICK, payload: { purpose: 'Say what it serves' } });
      if (aim?.kind !== 'intent' || typeof aim.id !== 'string' || !aim.id) throw new Error('Mandate answered with something that isn’t an intent.');
      return { app: 'mandate', kind: 'intent', id: aim.id, ...(typeof aim.title === 'string' && aim.title ? { label: aim.title.slice(0, 300) } : {}) };
    } catch (err) {
      if (isIntentCancelled(err)) return undefined;
      const intent = app === 'atlas' ? ENTITY_PICK : AIM_PICK;
      if ((err as Error).message.includes(`"${intent}"`)) throw new Error(`${app === 'atlas' ? 'Data Atlas' : 'Mandate'} isn’t open to you on this floor, so there’s nothing to pick from.`, { cause: err });
      throw err;
    }
  };

/** Opens the far end of a link in the app that keeps it. Data Atlas opens an entity by its id alone. */
export const openFrom =
  (ctx: Pick<MountContext, 'raise'>): OpenRef =>
  (ref) =>
    ref.app === 'atlas'
      ? openEntity(ctx, { kind: 'entity', id: ref.id, type: 'entity', ...(ref.label ? { label: ref.label } : {}) })
      : ctx.raise({ type: AIM_OPEN, payload: { id: ref.id } });

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
 * `library.open` at one of Folio's libraries, `unit.open` at one of its units
 * (a library, a folder at any level, or a file), or `document.open` for one of
 * Folio's own documents opens it to read, at the version asked for. Its
 * library is found from the document.
 */
export const placeForIntent = (intent: Intent | undefined): Place | undefined => {
  if (intent?.type === FOLIO_OPEN) {
    const path = (intent.payload as { path?: unknown } | undefined)?.path;
    return typeof path === 'string' ? placeFor(path) : undefined;
  }
  if (intent?.type === LIBRARY_OPEN) return isLibraryRef(intent.payload) && intent.payload.app === 'folio' ? { library: intent.payload.id, adding: false } : undefined;
  if (intent?.type === UNIT_OPEN) {
    if (!isUnitRef(intent.payload) || intent.payload.app !== 'folio') return undefined;
    const [library, unit] = intent.payload.id.split('/');
    if (!unit || unit === library) return { library, adding: false };
    return intent.payload.level === 'file' ? { library, document: unit, adding: false } : { library, folder: unit, adding: false };
  }
  if (intent?.type !== DOCUMENT_OPEN || !isDocumentRef(intent.payload) || intent.payload.app !== 'folio') return undefined;
  const version = /^[1-9]\d*$/.test(intent.payload.version ?? '') ? Number(intent.payload.version) : undefined;
  return { document: intent.payload.id, ...(version ? { version } : {}), adding: false };
};

/** What Artifacts is called, as its manifest names it (apps/folio/manifest.json). */
export const APP_NAME = manifest.name;

/** Asks whichever app explains access (Explorer) to say who can open a library or document, over Artifacts. */
export const ACCESS_EXPLAIN = 'access.explain';

/** Where each mount's layout lives inside the element the shell gave it. */
const hosts = new WeakMap<HTMLElement, HTMLElement>();

/** Folio: libraries of documents on each floor. What the shell mounts at /folio. */
export default defineMicroFrontend({
  mount(el: HTMLElement, ctx: MountContext) {
    // Another app asked for a document: Folio opens over it as a picker, and answers with the one chosen.
    if (ctx.intent?.type === DOCUMENT_PICK && ctx.reply) {
      const reply = ctx.reply;
      const pick = (ctx.intent.payload ?? {}) as DocumentPick;
      const host = document.createElement('div');
      el.replaceChildren(host);
      hosts.set(el, host);
      mountPicker(host, {
        api: new FolioApi((path, init) => ctx.fetch(path, init)),
        purpose: typeof pick.purpose === 'string' ? pick.purpose : '',
        accept: Array.isArray(pick.accept) ? pick.accept.filter((a): a is string => typeof a === 'string') : [],
        onPicked: (document) => reply.respond(document),
        onCancel: () => reply.cancel(),
      });
      return;
    }
    let mountedAt = ctx.path;
    const api = new FolioApi((path, init) => ctx.fetch(path, init));
    const floorKey = ctx.workspace.kind === 'org' ? 'org' : ctx.workspace.id;
    const explain = (payload: ExplainPayload) => ctx.request({ type: ACCESS_EXPLAIN, payload });
    const follow = (place: Omit<Place, 'adding'>) => {
      const to = addressFor(window.location.pathname, mountedAt, place);
      if (!to || to === window.location.pathname) return;
      window.history.pushState(window.history.state, '', to);
      mountedAt = pathFor(place);
    };
    const host = document.createElement('div');
    host.className = 'folio-host';
    el.replaceChildren(host);
    hosts.set(el, host);
    mountArtifacts(host, {
      api,
      userId: ctx.user.id,
      floorKey,
      floorName: ctx.workspace.name,
      floorKind: ctx.workspace.kind,
      app: { name: APP_NAME, icon: 'library' },
      place: placeForIntent(ctx.intent) ?? placeFor(ctx.path),
      onPlace: follow,
      propose: proposeFrom(ctx),
      pickRef: pickFrom(ctx),
      openRef: openFrom(ctx),
      explain,
      publisher: ctx.user.roles.includes('publisher'),
    });
  },
  unmount(el: HTMLElement) {
    const host = hosts.get(el);
    if (host) unmountArtifacts(host);
    hosts.delete(el);
    el.replaceChildren();
  },
  surfaces: {
    /** The card on Home: what's new to the person, and the floor's drafts for its leads. */
    './Glance': {
      mount(el: HTMLElement, ctx: MountContext) {
        mountGlance(el, {
          api: new FolioApi((path, init) => ctx.fetch(path, init)),
          onOpenDocument: (document: Brief) => void openDocument(ctx, { app: 'folio', id: document.id, title: document.title }),
          onOpenPublished: () => void ctx.raise({ type: FOLIO_OPEN, payload: { path: '/published' } }),
        });
      },
      unmount(el: HTMLElement) {
        unmountArtifacts(el);
      },
    },
  },
});
