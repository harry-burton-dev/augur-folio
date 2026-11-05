import { place, placeRoutes, type AppProps, type AppSurfaceProps, type PickerProps } from '@augur/app-kit';
import { openDocument, type DocumentPick, type MountContext } from '@augur/mfe-sdk';
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { APP_NAME, FolioApi, pathFor, placeFor, type Brief, type Place } from './api.js';
import type { ExplainPayload } from './access.js';
import { ACCESS_EXPLAIN, FOLIO_OPEN, openFrom, pickFrom, proposeFrom } from './intents.js';
import { Artifacts } from './quill/artifacts.js';
import { Glance as GlanceCard } from './quill/glance.js';
import { Picker as PickerDialog } from './quill/picker.js';

/** Where the place on the address bar reaches Artifacts, which stays mounted while the person moves about in it. */
const Placed = createContext<(place: Place) => void>(() => undefined);

/**
 * A place's screen: it shows nothing itself, and tells Artifacts where the
 * address says it is. Artifacts keeps what it loaded as the person moves, so
 * it lives in the frame, not in a screen the router swaps out.
 */
const at = (name: keyof typeof shapes) =>
  function Here() {
    const shown = places[name];
    const path = (shown.to as (params: Record<string, string>) => string)(shown.useParams() as Record<string, string>);
    const report = useContext(Placed);
    useLayoutEffect(() => report(placeFor(path)), [report, path]);
    return null;
  };

/** An address inside Artifacts that is no place in it opens its front page. */
function Elsewhere() {
  const report = useContext(Placed);
  useLayoutEffect(() => report({ home: true, adding: false }), [report]);
  return null;
}

/** Every address Artifacts answers below its route, as `placeFor` and `pathFor` read and write them (api.ts). */
const shapes = {
  front: '/',
  libraries: '/libraries',
  newLibrary: '/libraries/new',
  library: '/libraries/:library',
  folder: '/libraries/:library/:folder',
  view: '/libraries/:library/views/:view',
  series: '/libraries/:library/series/:series',
  document: '/libraries/:library/documents/:document',
  version: '/libraries/:library/documents/:document/versions/:version',
  found: '/documents/:document',
  foundVersion: '/documents/:document/versions/:version',
  published: '/published',
  shared: '/shared',
  received: '/received',
  arrived: '/received/:placement',
} as const;

/** Artifacts' places on the address bar, below its route. */
export const places = placeRoutes(
  {
    front: place(shapes.front, at('front')),
    libraries: place(shapes.libraries, at('libraries')),
    newLibrary: place(shapes.newLibrary, at('newLibrary')),
    library: place(shapes.library, at('library')),
    folder: place(shapes.folder, at('folder')),
    view: place(shapes.view, at('view')),
    series: place(shapes.series, at('series')),
    document: place(shapes.document, at('document')),
    version: place(shapes.version, at('version')),
    found: place(shapes.found, at('found')),
    foundVersion: place(shapes.foundVersion, at('foundVersion')),
    published: place(shapes.published, at('published')),
    shared: place(shapes.shared, at('shared')),
    received: place(shapes.received, at('received')),
    arrived: place(shapes.arrived, at('arrived')),
  },
  { NotFound: Elsewhere },
);

/** Which of Artifacts' places shows `place`, with its parameters. */
export const routeOf = (where: Omit<Place, 'adding'>): { name: keyof typeof shapes; params: Record<string, string> } => {
  const { library, folder, view, series, document, version, published, received, shared, home } = where;
  if (home && !document) return { name: 'front', params: {} };
  if (published && !document) return { name: 'published', params: {} };
  if (shared && !document) return { name: 'shared', params: {} };
  if (received && !document) return received === true ? { name: 'received', params: {} } : { name: 'arrived', params: { placement: received } };
  if (document && !library) return version ? { name: 'foundVersion', params: { document, version: String(version) } } : { name: 'found', params: { document } };
  if (!library) return { name: 'libraries', params: {} };
  if (document) return version ? { name: 'version', params: { library, document, version: String(version) } } : { name: 'document', params: { library, document } };
  if (series) return { name: 'series', params: { library, series } };
  if (view) return { name: 'view', params: { library, view } };
  if (folder) return { name: 'folder', params: { library, folder } };
  return { name: 'library', params: { library } };
};

type Go = (params?: Record<string, string>) => void;

/** Goes to a place in Artifacts through the router, so the address follows and Back comes back here. */
const useFollow = () => {
  // Every place's `useGo`, called in the same order on every render.
  const gos = Object.fromEntries((Object.keys(shapes) as (keyof typeof shapes)[]).map((name) => [name, places[name].useGo() as Go])) as Record<keyof typeof shapes, Go>;
  const latest = useRef(gos);
  useLayoutEffect(() => {
    latest.current = gos;
  });
  return useCallback((to: Omit<Place, 'adding'>) => {
    const { name, params } = routeOf(to);
    latest.current[name](params);
  }, []);
};

/** One FolioApi for a mount: it calls through the shell's `ctx.fetch`, on the floor the app is on. */
const useApi = (ctx: MountContext) => useMemo(() => new FolioApi(ctx), [ctx]);

/** Artifacts: libraries of documents on each floor, in the frame that stays while the person moves about. */
export function App({ ctx, children }: AppProps<MountContext>) {
  const api = useApi(ctx);
  const [shown, setShown] = useState<Place>();
  const report = useCallback((to: Place) => setShown((was) => (was && pathFor(was) === pathFor(to) && was.adding === to.adding ? was : to)), []);
  const follow = useFollow();
  const explain = useCallback((payload: ExplainPayload) => ctx.request({ type: ACCESS_EXPLAIN, payload }), [ctx]);
  const helpers = useMemo(() => ({ propose: proposeFrom(ctx), pickRef: pickFrom(ctx), openRef: openFrom(ctx) }), [ctx]);
  return (
    <Placed.Provider value={report}>
      {children}
      {shown && (
        <div className="folio-host">
          <Artifacts
            api={api}
            userId={ctx.user.id}
            floorKey={ctx.workspace.kind === 'org' ? 'org' : ctx.workspace.id}
            floorName={ctx.workspace.name}
            floorKind={ctx.workspace.kind}
            // The org's name, from the floors the shell gives: where it says whose library something shared is.
            orgName={ctx.workspace.path.find((f) => f.kind === 'org')?.name}
            app={{ name: APP_NAME, icon: 'library' }}
            place={shown}
            onPlace={follow}
            {...helpers}
            explain={explain}
            publisher={ctx.user.roles.includes('publisher')}
          />
        </div>
      )}
    </Placed.Provider>
  );
}

/** Another app asked for a document: Artifacts opens over it as a picker, and answers with the one chosen. */
export function Picker({ ctx, intent, respond, cancel }: PickerProps<MountContext>) {
  const api = useApi(ctx);
  const pick = (intent.payload ?? {}) as DocumentPick;
  return (
    <PickerDialog
      api={api}
      purpose={typeof pick.purpose === 'string' ? pick.purpose : ''}
      accept={Array.isArray(pick.accept) ? pick.accept.filter((a): a is string => typeof a === 'string') : []}
      onPicked={respond}
      onCancel={cancel}
    />
  );
}

/** The card on Home: what's new to the person, and the floor's drafts for its leads. */
export function Glance({ ctx }: AppSurfaceProps<MountContext>) {
  const api = useApi(ctx);
  return (
    <GlanceCard
      api={api}
      onOpenDocument={(document: Brief) => void openDocument(ctx, { app: 'folio', id: document.id, title: document.title })}
      onOpenPublished={() => void ctx.raise({ type: FOLIO_OPEN, payload: { path: '/published' } })}
    />
  );
}
