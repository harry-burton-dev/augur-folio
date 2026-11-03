import {
  AddTile,
  AppFrame,
  Button,
  Dialog,
  FilterBar,
  filterValue,
  FrontPage,
  frontSections,
  Icon,
  KindTile,
  Palette,
  PathTree,
  RailLink,
  TextField,
  Tiles,
  type Depth,
  type FilterDef,
  type FilterValue,
  type FrontPageConfig,
  type PaletteItem,
  type PathNode,
  type ReelItem,
  type RingAction,
  type RingShape,
  type RingSubject,
} from '@augur/app-kit';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { stateName, type ContentState, type Folder, type FolioApi, type FolioDocument, type HomeGlance, type Library, type LevelInfo, type OpenDocument, type OpenLibrary, type Place, type DocumentSort, type Received, type SavedView, type ViewQuery, type RecordLink, type SeriesView, type Shared, type Tag } from '../api.js';
import { SORTS, filtering, filtersFor, filtersFrom, folderTrail, levelsInside, queryFrom } from '../folio-app.js';
import { DEFAULT_LEVELS } from '../words.js';
import { Levels } from './levels.js';
import type { OpenRef, PickRef } from '../folio-links.js';
import type { ExplainPayload } from '../folio-share.js';
import { ARTIFACTS_FRONT } from './front.js';
import { Publish } from './publish.js';
import { PublishUp } from './publish-up.js';
import { Share } from './share.js';
import { PlaceDetails } from './details.js';
import { TagsDialog } from './tags.js';
import { SaveView, ViewsMenu } from './views.js';
import { Arrived } from './arrived.js';
import { DocumentDialog } from './document.js';
import { ReadingContents, ReadingMain, ReadingSide, useReading, type Propose } from './reading.js';
import { agoWords } from '../folio-publish.js';
import { SeriesDialog, SeriesPage, type LoadedSeries } from './series.js';

/** What the new layout needs from the shell: the same as the classic one. */
export interface ArtifactsProps {
  api: FolioApi;
  userId: string;
  /** `org`, or the floor's id: where publishing up starts from. */
  floorKey: string;
  floorName: string;
  floorKind: 'personal' | 'team' | 'org';
  /** The app's name and icon, from its manifest. */
  app: { name: string; icon: 'library' };
  place: Place;
  /** Where the person went, so the address bar follows. */
  onPlace: (place: Omit<Place, 'adding'>) => void;
  /**
   * Go to the classic layout at this place: for this visit only when the new
   * layout hasn't got that part yet, or as the device's choice when the person
   * picked the classic layout itself (`chosen`).
   */
  onClassic: (place: Omit<Place, 'adding'>, chosen?: boolean) => void;
  /** Offers words marked in a document to Data Atlas. */
  propose?: Propose;
  pickRef?: PickRef;
  openRef?: OpenRef;
  explain?: (payload: ExplainPayload) => Promise<unknown>;
  /** The person has the publisher role: the whole org may get what they put out. */
  publisher?: boolean;
  /** The front page, by default Artifacts' own (`ARTIFACTS_FRONT`). */
  front?: FrontPageConfig;
  /** How the app goes out of focus behind a dialog, the ring or the palette. */
  depth?: Depth;
  ringShape?: RingShape;
}

type Screen = 'home' | 'collections' | 'library' | 'document' | 'series' | 'shared' | 'published' | 'received' | 'arrived';

/** Which screen a place opens. */
export const screenFor = (place: Place): Screen => {
  if (place.document) return 'document';
  if (place.series) return 'series';
  if (place.adding) return 'collections';
  if (place.library) return 'library';
  if (place.shared) return 'shared';
  if (place.published) return 'published';
  if (typeof place.received === 'string') return 'arrived';
  if (place.received) return 'received';
  if (place.collections) return 'collections';
  return 'home';
};


const save = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** "Today", "Tue", "12 Nov", from an ISO date or day. */
export const whenWords = (iso: string | undefined, now = new Date()) => {
  if (!iso) return undefined;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  const days = Math.round((Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (Math.abs(days) < 7) return at.toLocaleDateString(undefined, { weekday: 'short' });
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

/** A small page for a reel card: decorative. */
const page = (mark: 'rename' | 'check' | 'info' | 'clock') => (
  <>
    <Icon name="document" size={36} />
    <Icon name={mark} size={18} />
  </>
);

/** A series as the front page needs it: its next issue. */
type Upcoming = Omit<SeriesView, 'audience'>;

/** How many series' next issues the front page asks for, so it stays one quick look. */
const UPCOMING_MOST = 8;

type Ask =
  | { kind: 'name'; heading: string; eyebrow?: string; summary?: string; label: string; value?: string; action: string; run: (name: string) => Promise<unknown> }
  | { kind: 'confirm'; heading: string; summary: string; action: string; run: () => Promise<unknown> }
  | { kind: 'share'; library: string; document?: string; folder?: string; name: string; eyebrow: string }
  | { kind: 'publish-up'; library: string; record: { kind: 'library' | 'folder' | 'document'; id: string; name: string } }
  | { kind: 'publish'; doc: OpenDocument }
  | { kind: 'series'; library: OpenLibrary; series?: LoadedSeries }
  | { kind: 'levels' }
  | { kind: 'document'; doc: OpenDocument }
  | { kind: 'details'; library: OpenLibrary; folder?: Folder }
  | { kind: 'tags'; library: OpenLibrary }
  | { kind: 'save-view'; library: OpenLibrary };

/**
 * Artifacts on Quill (PDR-010): the front page from config, the rail with the
 * lit path, tiles you walk into, every object's actions in its radial menu,
 * find on `/`, and depth instead of scrims. Reading, sharing and publishing
 * are React too; only tags, saved views and what came from below still open
 * the classic layout.
 */
export function Artifacts(props: ArtifactsProps) {
  const { api, userId, floorKey, floorName, floorKind, app, onPlace, onClassic, front = ARTIFACTS_FRONT, depth, ringShape } = props;
  const [place, setPlace] = useState<Place>(props.place);
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [canCreate, setCanCreate] = useState(false);
  const [levels, setLevels] = useState<LevelInfo[]>(DEFAULT_LEVELS);
  const [open, setOpen] = useState<OpenLibrary>();
  const [docs, setDocs] = useState<FolioDocument[]>([]);
  const [doc, setDoc] = useState<OpenDocument>();
  const [glance, setGlance] = useState<HomeGlance>();
  const [received, setReceived] = useState<Received>();
  const [shared, setShared] = useState<Shared>();
  const [published, setPublished] = useState<(FolioDocument & { libraryName: string })[]>();
  const [upcoming, setUpcoming] = useState<Upcoming[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<Ask>();
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<PaletteItem[]>([]);
  const file = useRef<HTMLInputElement>(null);
  const issueFor = useRef<{ library: string; series: string }>(undefined);
  /** Counts the series' changes, so its page reads it again after its dialog saves. */
  const [seriesShown, setSeriesShown] = useState(0);
  /** How the documents where you are are narrowed and sorted, as the filter bar and saved views keep them. */
  const [filters, setFilters] = useState<FilterValue>({});
  const [sort, setSort] = useState<DocumentSort>('title');
  const [total, setTotal] = useState(0);

  const screen = screenFor(place);
  const reading = useReading(api, screen === 'document' && doc?.id === place.document ? doc : undefined, place.version);
  const shelfName = floorKind === 'personal' ? 'Your collections' : floorName ? `Collections on ${floorName}` : 'Collections';
  const levelName = useCallback((id: LevelInfo['id']) => levels.find((l) => l.id === id)?.name ?? id, [levels]);
  const fail = (err: unknown) => setNote(err instanceof Error ? err.message : String(err));

  const go = useCallback(
    (to: Omit<Place, 'adding'>) => {
      setNote('');
      setPlace({ ...to, adding: false });
      onPlace(to);
    },
    [onPlace],
  );
  const home = () => go({ home: true });

  // What every screen needs: the floor's collections and its level names.
  const loadLibraries = useCallback(() => api.libraries().then((l) => {
    setLibraries(l.libraries);
    setCanCreate(l.can.create);
  }), [api]);
  useEffect(() => {
    loadLibraries().catch(fail);
    api.levels().then((l) => setLevels(l.levels), () => setLevels(DEFAULT_LEVELS));
  }, [api, loadLibraries]);

  // A saved view puts its folder, filters and sort in place; leaving the collection clears them.
  const viewing = open?.id === place.library ? open?.views.find((v) => v.id === place.view) : undefined;
  const folderHere = viewing ? viewing.query.folder : place.folder;
  useEffect(() => {
    if (!viewing || !open) return;
    setFilters(filterValue(filtersFor(open) as FilterDef[], filtersFrom(viewing.query)));
    setSort(viewing.query.sort ?? 'title');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewing?.id, open?.id]);
  useEffect(() => {
    setFilters({});
    setSort('title');
  }, [place.library]);

  // The open collection and the documents where you are in it.
  const loadPlace = useCallback(async () => {
    const id = place.library;
    if (!id || screen !== 'library') return;
    setBusy(true);
    try {
      const lib = open?.id === id ? open : await api.library(id);
      setOpen(lib);
      const view = place.view ? lib.views.find((v) => v.id === place.view) : undefined;
      const folder = view ? view.query.folder : place.folder;
      const narrowed = filtering(filters);
      const list = await api.documents(id, { ...queryFrom(filters, sort, folder), below: narrowed, limit: 200 });
      setDocs(narrowed ? list.documents : list.documents.filter((d) => (d.folder ?? undefined) === (folder ?? undefined)));
      setTotal(narrowed ? list.total : list.documents.filter((d) => (d.folder ?? undefined) === (folder ?? undefined)).length);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
    // `open` is a cache: reading it mustn't reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, place.library, place.folder, place.view, screen, filters, sort]);
  useEffect(() => void loadPlace(), [loadPlace]);
  const refresh = async () => {
    if (!place.library) return loadLibraries();
    setOpen(await api.library(place.library));
    await loadPlace();
  };

  // A document to read: its library comes from the document when the place doesn't say.
  useEffect(() => {
    if (screen !== 'document' || !place.document) return;
    let gone = false;
    (async () => {
      const library = place.library ?? (await api.locate(place.document!)).library;
      const [d, lib] = await Promise.all([api.document(library, place.document!), open?.id === library ? open : api.library(library).catch(() => undefined)]);
      if (gone) return;
      setDoc(d);
      if (lib) setOpen(lib);
    })().catch(fail);
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, screen, place.document, place.library]);

  // The front page: what needs you, what's new, what's coming.
  useEffect(() => {
    if (screen !== 'home') return;
    api.home().then(setGlance, fail);
    api.received().then(setReceived, () => setReceived(undefined));
  }, [api, screen]);
  useEffect(() => {
    if (screen !== 'home' || !libraries.length) return;
    let gone = false;
    (async () => {
      const opened = await Promise.all(libraries.slice(0, UPCOMING_MOST).map((l) => api.library(l.id).catch(() => undefined)));
      const ids = opened.flatMap((l) => l?.series.map((s) => s.id) ?? []).slice(0, UPCOMING_MOST);
      const views = await Promise.all(ids.map((id) => api.series(id).catch(() => undefined)));
      if (!gone) setUpcoming(views.flatMap((v) => (v && v.cadence !== 'adhoc' ? [v] : [])));
    })().catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [api, screen, libraries]);
  useEffect(() => {
    if (screen === 'shared') api.shared().then(setShared, fail);
    if (screen === 'published') {
      api.published().then((p) => setPublished(p.documents), fail);
      void api.looked().catch(() => undefined);
    }
    if (screen === 'received' || screen === 'arrived') api.received().then(setReceived, fail);
  }, [api, screen]);

  // Find, from anywhere: `/` opens the palette.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setFinding(true);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    const term = query.trim();
    const mine: PaletteItem[] = libraries
      .filter((l) => !term || l.name.toLowerCase().includes(term.toLowerCase()))
      .slice(0, 5)
      .map((l, i) => ({ id: `library:${l.id}`, label: l.name, icon: 'library', detail: shelfName, meta: levelName('collection'), group: i === 0 ? 'Collections' : undefined }));
    if (term.length < 2) return setFound(mine);
    const t = setTimeout(() => {
      api.find(term).then(
        (r) => setFound([...mine, ...r.documents.slice(0, 20).map((d, i): PaletteItem => ({ id: `document:${d.library}:${d.id}`, label: d.title, icon: 'document', detail: d.libraryName, meta: d.latest.state ? stateName(d.latest.state) : undefined, group: i === 0 ? 'Documents' : undefined }))]),
        () => setFound(mine),
      );
    }, 200);
    return () => clearTimeout(t);
  }, [api, query, libraries, shelfName, levelName]);
  const pick = (item: PaletteItem) => {
    setFinding(false);
    setQuery('');
    const [kind, a, b] = item.id.split(':');
    if (kind === 'library') go({ library: a });
    else go({ library: a, document: b });
  };

  // Adding files where you are, or an issue to a series.
  const addFiles = () => file.current?.click();
  const uploaded = async (files: FileList | null) => {
    if (!files?.length || !place.library) return;
    const series = issueFor.current;
    issueFor.current = undefined;
    setBusy(true);
    try {
      for (const f of files) {
        if (series) await api.addIssue(series.library, series.series, f);
        else await api.upload(place.library, f, place.folder);
      }
      setNote(`${files.length === 1 ? files[0]!.name : `${files.length} files`} added.`);
      await refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };

  // ---- Every object's actions, for its radial menu. ----
  const run = (actions: (RingAction & { run?: () => void })[], label: string): RingSubject => ({
    label,
    actions: actions.map(({ run: _run, ...a }) => a),
    onAction: (id) => actions.find((a) => a.id === id)?.run?.(),
  });
  const only = (may: boolean | undefined, reason: string) => (may ? {} : { disabled: true, reason });

  const newFolder = (lib: OpenLibrary | undefined, parent?: Folder) => {
    const next = lib ? levelsInside(levels, parent?.level ?? 'collection')[0] : undefined;
    const label = next ? `New ${next.name.toLowerCase()}` : 'New folder';
    const why = !lib ? 'Open it first.' : !lib.can.addFolders ? 'Only its leads can add here.' : !next ? `A ${levelName(parent?.level ?? 'collection').toLowerCase()} holds no more levels.` : undefined;
    return {
      id: 'new-folder',
      label,
      icon: 'folder-plus' as const,
      ...(why ? { disabled: true, reason: why } : {}),
      run: () =>
        setAsk({ kind: 'name', heading: label, eyebrow: parent?.name ?? lib!.name, label: 'Name', action: 'Make it', run: (name) => api.createFolder(lib!.id, name, parent?.id, next!.id as Folder['level']).then(refresh) }),
    };
  };

  const libraryRing = (l: Library): RingSubject => {
    const lib = open?.id === l.id ? open : undefined;
    return run(
      [
        { id: 'open', label: 'Open', icon: 'arrow', run: () => go({ library: l.id }) },
        newFolder(lib),
        { id: 'share', label: 'Share', icon: 'people', run: () => setAsk({ kind: 'share', library: l.id, name: l.name, eyebrow: levelName('collection') }) },
        { id: 'publish-up', label: 'Publish up', icon: 'publish', ...(lib ? only(lib.can.manage, 'Only whoever manages it can publish it up.') : {}), run: () => setAsk({ kind: 'publish-up', library: l.id, record: { kind: 'library', id: l.id, name: l.name } }) },
        {
          id: 'rename',
          label: 'Rename',
          icon: 'rename',
          ...(lib ? only(lib.can.manage, 'Only whoever manages it can rename it.') : {}),
          run: () => setAsk({ kind: 'name', heading: `Rename ${l.name}`, label: 'Name', value: l.name, action: 'Rename', run: (name) => api.updateLibrary(l.id, { name }).then(loadLibraries).then(refresh) }),
        },
        {
          id: 'archive',
          label: 'Archive',
          icon: 'archive',
          danger: true,
          ...(lib ? only(lib.can.manage, 'Only whoever manages it can archive it.') : {}),
          run: () => setAsk({ kind: 'confirm', heading: `Archive ${l.name}?`, summary: 'It’s kept as it is, read only, and nothing new goes in.', action: 'Archive', run: () => api.archiveLibrary(l.id).then(loadLibraries) }),
        },
      ],
      l.name,
    );
  };

  const folderRing = (lib: OpenLibrary, f: Folder): RingSubject => {
    const mayChange = lib.can.manage || f.createdBy === userId;
    return run(
      [
        { id: 'open', label: 'Open', icon: 'arrow', run: () => go({ library: lib.id, folder: f.id }) },
        newFolder(lib, f),
        { id: 'share', label: lib.can.share ? 'Share' : 'Who can see it', icon: 'people', run: () => setAsk({ kind: 'share', library: lib.id, folder: f.id, name: f.name, eyebrow: levelName(f.level) }) },
        { id: 'publish-up', label: 'Publish up', icon: 'publish', ...only(lib.can.manage, 'Only whoever manages the collection can publish it up.'), run: () => setAsk({ kind: 'publish-up', library: lib.id, record: { kind: 'folder', id: f.id, name: f.name } }) },
        { id: 'details', label: 'Details', icon: 'info', run: () => setAsk({ kind: 'details', library: lib, folder: f }) },
        {
          id: 'rename',
          label: 'Rename',
          icon: 'rename',
          ...only(mayChange, 'Only whoever made it, or the collection’s leads, can rename it.'),
          run: () => setAsk({ kind: 'name', heading: `Rename ${f.name}`, label: 'Name', value: f.name, action: 'Rename', run: (name) => api.renameFolder(lib.id, f.id, name).then(refresh) }),
        },
        {
          id: 'delete',
          label: 'Remove',
          icon: 'delete',
          danger: true,
          ...only(mayChange, 'Only whoever made it, or the collection’s leads, can remove it.'),
          run: () =>
            setAsk({
              kind: 'confirm',
              heading: `Remove ${f.name}?`,
              summary: 'Only an empty one can go. Its documents stay wherever you moved them.',
              action: 'Remove',
              run: () => api.deleteFolder(lib.id, f.id).then(() => (place.folder === f.id ? go({ library: lib.id, ...(f.parent ? { folder: f.parent } : {}) }) : undefined)).then(refresh),
            }),
        },
      ],
      f.name,
    );
  };

  const documentRing = (d: FolioDocument, lib?: OpenLibrary): RingSubject =>
    run(
      [
        { id: 'open', label: 'Open', icon: 'arrow', run: () => go({ library: d.library, document: d.id }) },
        { id: 'download', label: 'Download', icon: 'download', run: () => void api.original(d.library, d.id, d.latest.number).then((b) => save(b, d.latest.filename), fail) },
        { id: 'share', label: d.can.share ? 'Share' : 'Who can see it', icon: 'people', run: () => setAsk({ kind: 'share', library: d.library, document: d.id, name: d.title, eyebrow: 'Document' }) },
        {
          id: 'publish',
          label: 'Publish',
          icon: 'publish',
          ...only(d.can.publish, 'Only its collection’s leads can put it out.'),
          run: () => void api.document(d.library, d.id).then((full) => setAsk({ kind: 'publish', doc: full }), fail),
        },
        { id: 'publish-up', label: 'Publish up', icon: 'inbox', ...only(lib?.can.manage, 'Only whoever manages the collection can publish it up.'), run: () => setAsk({ kind: 'publish-up', library: d.library, record: { kind: 'document', id: d.id, name: d.title } }) },
        {
          id: 'rename',
          label: 'Rename',
          icon: 'rename',
          ...only(d.can.change, 'You can read it, not change it.'),
          run: () => setAsk({ kind: 'name', heading: `Rename ${d.title}`, label: 'Title', value: d.title, action: 'Rename', run: (title) => api.updateDocument(d.library, d.id, { title }).then(refresh) }),
        },
        {
          id: 'delete',
          label: 'Delete',
          icon: 'delete',
          danger: true,
          ...only(d.can.change, 'You can read it, not change it.'),
          run: () => setAsk({ kind: 'confirm', heading: `Delete ${d.title}?`, summary: 'Every version goes, for everyone it was shared or published to.', action: 'Delete', run: () => api.deleteDocument(d.library, d.id).then(refresh) }),
        },
      ],
      d.title,
    );

  /** What can be done where you are: right-click the space between the tiles. */
  const placeRing = (lib: OpenLibrary, here: Folder | undefined): RingSubject =>
    run(
      [
        { id: 'add', label: 'Add files', icon: 'upload', ...only(lib.can.addDocuments, 'Only people who can edit it can add here.'), run: addFiles },
        newFolder(lib, here),
        ...(here ? [] : [{ id: 'new-series', label: 'New series', icon: 'series' as const, ...only(lib.can.manage, 'Only whoever manages the collection can start a series.'), run: () => setAsk({ kind: 'series', library: lib }) }]),
        { id: 'share', label: 'Share', icon: 'people', run: () => setAsk({ kind: 'share', library: lib.id, ...(here ? { folder: here.id } : {}), name: here?.name ?? lib.name, eyebrow: levelName(here?.level ?? 'collection') }) },
        { id: 'details', label: 'Details', icon: 'info', run: () => setAsk({ kind: 'details', library: lib, ...(here ? { folder: here } : {}) }) },
        { id: 'tags', label: 'Tags', icon: 'tag', run: () => setAsk({ kind: 'tags', library: lib }) },
        { id: 'save-view', label: 'Save this view', icon: 'view', ...only(filtering(filters) || sort !== 'title', 'Filter or sort what’s here first.'), run: () => setAsk({ kind: 'save-view', library: lib }) },
      ],
      here?.name ?? lib.name,
    );

  const shelfRing = (): RingSubject =>
    run(
      [
        {
          id: 'new',
          label: `New ${levelName('collection').toLowerCase()}`,
          icon: 'plus',
          ...only(canCreate, 'Only this floor’s leads can make one.'),
          run: () =>
            setAsk({
              kind: 'name',
              heading: `New ${levelName('collection').toLowerCase()}`,
              eyebrow: floorName,
              summary: floorKind === 'personal' ? 'Only you can see it.' : 'Everyone on this floor can see it and add folders; its leads look after it.',
              label: 'Name',
              action: 'Make it',
              run: (name) => api.createLibrary(name).then((l) => (loadLibraries(), go({ library: l.id }))),
            }),
        },
        { id: 'levels', label: 'Level names', icon: 'structure', run: () => setAsk({ kind: 'levels' }) },
      ],
      shelfName,
    );

  // `/libraries/new`: the shelf, with a new collection being named, for whoever may make one.
  const asked = useRef(false);
  useEffect(() => {
    if (!place.adding || asked.current || !canCreate) return;
    asked.current = true;
    shelfRing().onAction('new');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place.adding, canCreate]);

  // ---- The rail: where you can go, and the path you took, lit. ----
  const trail = open && place.library === open.id ? folderTrail(open.folders, place.folder) : [];
  const branch = (lib: OpenLibrary, parent?: string): PathNode[] =>
    lib.folders
      .filter((f) => f.parent === parent)
      .map((f) => ({ id: f.id, label: f.name, icon: 'folder', children: branch(lib, f.id) }));
  const nodes: PathNode[] = libraries.map((l) => ({ id: l.id, label: l.name, icon: 'library', children: open?.id === l.id ? branch(open, undefined) : [] }));
  const path = place.library ? [place.library, ...trail.map((f) => f.id)] : [];
  const byId = (id: string) => open?.folders.find((f) => f.id === id);

  const rail = (
    <>
      <RailLink icon="folder" label={shelfName} count={libraries.length} current={screen === 'collections' || screen === 'library'} onPress={() => go({ collections: true })} />
      {path.length ? (
        <PathTree
          label={shelfName}
          nodes={nodes}
          path={path}
          onOpen={(n) => (libraries.some((l) => l.id === n.id) ? go({ library: n.id }) : go({ library: place.library!, folder: n.id }))}
          ringFor={(n) => {
            const l = libraries.find((x) => x.id === n.id);
            if (l) return libraryRing(l);
            const f = byId(n.id);
            return f && open ? folderRing(open, f) : undefined;
          }}
        />
      ) : null}
      <RailLink icon="people" label="Shared libraries" current={screen === 'shared'} onPress={() => go({ shared: true })} />
      <RailLink icon="inbox" label="Published to you" current={screen === 'published'} count={glance?.published.new || undefined} onPress={() => go({ published: true })} />
      <RailLink icon="publish" label="From below" current={screen === 'received' || screen === 'arrived'} onPress={() => go({ received: true })} />
      <RailLink icon="history" label="Classic layout" onPress={() => onClassic(place, true)} />
    </>
  );

  // ---- Screens. ----
  const frontPage = () => {
    const actions: ReelItem[] = [
      ...(glance?.drafts?.documents ?? []).map((b) => ({
        id: `draft:${b.id}`,
        title: `Publish ${b.title}`,
        when: whenWords(b.at),
        from: b.libraryName,
        art: page('rename'),
        onOpen: () => go({ library: b.library, document: b.id }),
      })),
      ...upcoming
        .filter((s) => s.next.overdue && s.can.addIssue)
        .map((s) => ({ id: `late:${s.id}`, title: `Add ${s.next.period} to ${s.name}`, when: 'Late', urgent: true, from: s.libraryName, art: page('clock'), onOpen: () => go({ library: s.library, series: s.id }) })),
    ];
    const fresh: ReelItem[] = (glance?.published.documents ?? []).map((b) => ({
      id: `new:${b.id}`,
      title: b.title,
      when: whenWords(b.at),
      from: b.libraryName,
      art: page('info'),
      onOpen: () => go({ library: b.library, document: b.id }),
      ring: () => run([{ id: 'open', label: 'Open', icon: 'arrow', run: () => go({ library: b.library, document: b.id }) }, { id: 'all', label: 'Everything published to you', icon: 'inbox', run: () => go({ published: true }) }], b.title),
    }));
    const soon: ReelItem[] = upcoming
      .filter((s) => !s.next.overdue)
      .sort((a, b) => (a.next.dueAt ?? a.next.periodStart).localeCompare(b.next.dueAt ?? b.next.periodStart))
      .map((s) => ({ id: `soon:${s.id}`, title: `${s.name}: ${s.next.period}`, when: whenWords(s.next.dueBy ?? s.next.dueAt), from: s.libraryName, art: page('check'), onOpen: () => go({ library: s.library, series: s.id }) }));
    const sections = frontSections(front, { actions: { items: actions }, new: { items: fresh }, upcoming: { items: soon } });
    const needs = actions.length;
    return (
      <FrontPage
        eyebrow={floorName}
        heading={app.name}
        look={front.look ?? 'title'}
        ambience={front.ambience}
        summary={needs ? `${needs} ${needs === 1 ? 'thing needs' : 'things need'} you.` : undefined}
        search={
          <Button kind="secondary" onPress={() => setFinding(true)}>
            Find a document or {levelName('collection').toLowerCase()} ( / )
          </Button>
        }
        sections={sections}
      />
    );
  };

  const collectionsPage = () => (
    <>
      <h1 className="text-title-s">{shelfName}</h1>
      <Tiles label={shelfName} ring={shelfRing}>
        {libraries.map((l) => (
          <KindTile key={l.id} kind="collection" eyebrow={levelName('collection')} name={l.name} note={l.state && l.state !== 'open' ? stateName(l.state) : undefined} onOpen={() => go({ library: l.id })} ring={() => libraryRing(l)} />
        ))}
        <AddTile label={`New ${levelName('collection').toLowerCase()}`} reason={canCreate ? undefined : 'Only this floor’s leads can make one.'} onPress={() => shelfRing().onAction('new')} />
      </Tiles>
    </>
  );

  const libraryPage = () => {
    if (!open || open.id !== place.library) return null;
    const here = folderHere ? byId(folderHere) : undefined;
    // Filtering looks in every folder below, so folders and series leave the tiles.
    const narrowed = filtering(filters);
    const children = narrowed ? [] : open.folders.filter((f) => f.parent === (here?.id ?? undefined));
    const series = here || narrowed ? [] : open.series;
    const up = viewing
      ? { label: open.name, to: { library: open.id } }
      : here
        ? here.parent
          ? { label: byId(here.parent)?.name ?? open.name, to: { library: open.id, folder: here.parent } }
          : { label: open.name, to: { library: open.id } }
        : { label: shelfName, to: { collections: true } };
    const where = here?.name ?? open.name;
    return (
      <>
        <Button kind="ghost" onPress={() => go(up.to)}>
          {up.label}
        </Button>
        <h1 className="text-title-s">{viewing?.name ?? where}</h1>
        <FilterBar
          label={`Filter what’s in ${where}`}
          filters={filtersFor(open) as FilterDef[]}
          value={filters}
          sorts={SORTS}
          sort={sort}
          count={total}
          noun={['document', 'documents']}
          busy={busy}
          onChange={(value, next) => {
            setFilters(value);
            setSort(next as DocumentSort);
          }}
          actions={
            <ViewsMenu
              api={api}
              library={open}
              userId={userId}
              current={viewing}
              query={queryFrom(filters, sort, folderHere)}
              changed={filtering(filters) || sort !== 'title'}
              onOpen={(view) => go({ library: open.id, view: view.id })}
              onSaved={(view) => void refresh().then(() => go({ library: open.id, view: view.id }))}
              onRenamed={() => void refresh()}
              onDeleted={() => void refresh().then(() => go({ library: open.id }))}
            />
          }
        />
        {narrowed && !docs.length ? <p className="quill-empty">Nothing in {where} matches these filters.</p> : null}
        <input ref={file} type="file" multiple hidden onChange={(e) => void uploaded(e.target.files)} />
        <Tiles label={`In ${here?.name ?? open.name}`} ring={() => placeRing(open, here)}>
          {children.map((f) => (
            <KindTile key={f.id} kind="folder" eyebrow={levelName(f.level)} name={f.name} note={f.state !== 'open' ? stateName(f.state) : undefined} onOpen={() => go({ library: open.id, folder: f.id })} ring={() => folderRing(open, f)} />
          ))}
          {series.map((s) => (
            <KindTile
              key={s.id}
              kind="series"
              eyebrow="Series"
              name={s.name}
              count={String(s.issues).padStart(2, '0')}
              note={s.last?.period}
              onOpen={() => go({ library: open.id, series: s.id })}
              ring={() =>
                run(
                  [
                    { id: 'open', label: 'Open', icon: 'arrow', run: () => go({ library: open.id, series: s.id }) },
                    {
                      id: 'issue',
                      label: 'Add an issue',
                      icon: 'upload',
                      ...only(open.can.addDocuments, 'Only people who can edit the collection can add one.'),
                      run: () => {
                        issueFor.current = { library: open.id, series: s.id };
                        addFiles();
                      },
                    },
                  ],
                  s.name,
                )
              }
            />
          ))}
          {docs.map((d) => (
            <KindTile
              key={d.id}
              kind="document"
              eyebrow="Document"
              name={d.title}
              count={`v${d.latest.number}`}
              state={d.latest.state ? stateName(d.latest.state) : undefined}
              needs={d.latest.state === 'in-review' && d.can.change}
              needsLabel="In review, and yours to move on"
              onOpen={() => go({ library: open.id, document: d.id })}
              ring={() => documentRing(d, open)}
            />
          ))}
          <AddTile label="Add here" reason={open.can.addDocuments || open.can.addFolders ? undefined : 'You can read here, not add.'} onPress={() => (open.can.addDocuments ? addFiles() : placeRing(open, here).onAction('new-folder'))} />
        </Tiles>
      </>
    );
  };

  /** The other end of a link: in another app, or one of Artifacts' own records. */
  const openLink = (link: RecordLink) => {
    const end = link.to ?? link.from;
    if (!end || 'unavailable' in end) return;
    if ('app' in end && end.app !== 'folio') {
      void props.openRef?.(end).catch(fail);
      return;
    }
    const at = 'app' in end ? { library: end.library, record: end.record, kind: end.unitKind } : { library: end.library, record: end.record, kind: end.kind };
    if (!at.library || !at.record) return;
    setAsk(undefined);
    if (at.kind === 'document') go({ library: at.library, document: at.record });
    else go({ library: at.library, ...(at.kind === 'folder' ? { folder: at.record } : {}) });
  };
  const rereadDoc = (d: OpenDocument) => api.document(d.library, d.id).then(setDoc, fail);
  const download = (d: OpenDocument, version: number) => {
    const v = d.versions.find((x) => x.number === version);
    if (v) void api.original(d.library, d.id, v.number).then((b) => save(b, v.filename), fail);
  };
  const retry = (d: OpenDocument, version: number) => void api.retryReader(d.library, d.id, version).then(() => rereadDoc(d));
  const readingLib = doc && open?.id === doc.library ? open : undefined;
  const readerBack = doc ? (readingLib ? [readingLib.name, ...folderTrail(readingLib.folders, doc.folder).map((f) => f.name)].join(' / ') : doc.libraryName) : '';

  const readerPage = () => {
    if (!doc || doc.id !== place.document) return null;
    return (
      <ReadingMain
        reading={reading}
        backLabel={readerBack}
        actions={{
          onBack: () => go(doc.folder ? { library: doc.library, folder: doc.folder } : { library: doc.library }),
          onRead: (version) => go({ library: doc.library, document: doc.id, ...(version ? { version } : {}) }),
          onIssue: (library, document) => go({ library, document }),
          onRetry: (version) => retry(doc, version),
        }}
      />
    );
  };

  const readerSide = () =>
    doc && doc.id === place.document ? (
      <ReadingSide
        reading={reading}
        api={api}
        tags={readingLib?.tags ?? []}
        propose={props.propose}
        pickRef={props.pickRef}
        agoWords={agoWords}
        onRead={(version) => go({ library: doc.library, document: doc.id, ...(version ? { version } : {}) })}
        onDownload={(version) => download(doc, version)}
        onManage={() => setAsk({ kind: 'document', doc })}
        onShare={() => setAsk({ kind: 'share', library: doc.library, document: doc.id, name: doc.title, eyebrow: 'Document' })}
        onPublish={() => setAsk({ kind: 'publish', doc })}
        onPublishUp={() => setAsk({ kind: 'publish-up', library: doc.library, record: { kind: 'document', id: doc.id, name: doc.title } })}
        onMove={(version, state: ContentState) => api.setVersionState(doc.library, doc.id, version, state).then(() => rereadDoc(doc), fail)}
        onSeries={(series) => go({ library: doc.library, series })}
        onFollow={(following) => (doc.run ? api.follow(doc.run.id, following).then(() => rereadDoc(doc)) : Promise.resolve())}
        onOpenLink={openLink}
      />
    ) : null;

  const seriesPage = () => {
    if (!place.series) return null;
    const lib = open?.id === place.library ? open : undefined;
    const libraryOf = async (id: string) => (open?.id === id ? open : api.library(id));
    return (
      <>
        {place.library ? (
          <Button kind="ghost" onPress={() => go({ library: place.library! })}>
            {lib?.name ?? levelName('collection')}
          </Button>
        ) : null}
        <SeriesPage
          key={`${place.series}:${seriesShown}`}
          api={api}
          series={place.series}
          onRead={(library, document) => go({ library, document })}
          onEdit={(run) => void libraryOf(run.library).then((l) => setAsk({ kind: 'series', library: l, series: run }), fail)}
          onDelete={(run) =>
            setAsk({
              kind: 'confirm',
              heading: `Remove ${run.name}?`,
              summary: 'It has no issues, so nothing else changes. Anyone following it stops being told.',
              action: 'Remove',
              run: () => api.deleteSeries(run.library, run.id).then(() => go({ library: run.library })).then(refresh),
            })
          }
          onAdded={() => void refresh().catch(() => undefined)}
        />
      </>
    );
  };

  const sharedPage = () => (
    <>
      <h1 className="text-title-s">Shared libraries</h1>
      {shared && !shared.libraries.length && !shared.documents.length ? <p className="quill-empty">Nothing has been shared with you from other floors.</p> : null}
      <Tiles label="Shared with you">
        {(shared?.libraries ?? []).map((l) => (
          <KindTile key={l.id} kind="library" eyebrow={levelName('collection')} name={l.name} note={l.level === 'read' ? 'You can read it' : l.level === 'edit' ? 'You can add to it' : 'You manage it'} onOpen={() => go({ library: l.id })} ring={() => libraryRing(l)} />
        ))}
        {(shared?.documents ?? []).map((d) => (
          <KindTile key={d.id} kind="document" eyebrow="Document" name={d.title} owner={d.libraryName} count={`v${d.latest.number}`} onOpen={() => go({ library: d.library, document: d.id })} ring={() => documentRing(d)} />
        ))}
      </Tiles>
    </>
  );

  const publishedPage = () => (
    <>
      <h1 className="text-title-s">Published to you</h1>
      {published && !published.length ? <p className="quill-empty">Nothing has been put out to you yet.</p> : null}
      <Tiles label="Published to you">
        {(published ?? []).map((d) => (
          <KindTile key={d.id} kind="document" eyebrow="Document" name={d.title} owner={d.libraryName} count={`v${d.published?.version ?? d.latest.number}`} onOpen={() => go({ library: d.library, document: d.id })} ring={() => documentRing(d)} />
        ))}
      </Tiles>
    </>
  );

  const receivedPage = () => (
    <>
      <h1 className="text-title-s">From below</h1>
      <p className="text-meta text-ink-muted">What floors below have published up to this one. Each sits here until a lead gives it a place.</p>
      {received && !received.here.length && !received.signposts.length ? <p className="quill-empty">Nothing has been published up to this floor.</p> : null}
      <Tiles label="From below">
        {(received?.here ?? []).map((p) => (
          <KindTile
            key={p.id}
            kind={p.record.kind === 'document' ? 'document' : p.record.kind === 'library' ? 'library' : 'folder'}
            eyebrow={p.record.level ? levelName(p.record.level) : p.record.kind === 'document' ? 'Document' : levelName('collection')}
            name={p.record.name ?? p.record.id}
            owner={p.fromFloor?.name}
            onOpen={() => go({ received: p.id })}
          />
        ))}
      </Tiles>
    </>
  );

  const arrivedPage = () =>
    typeof place.received === 'string' ? (
      <Arrived key={place.received} api={api} placement={place.received} levelName={levelName} signposts={received?.signposts ?? []} onBack={() => go({ received: true })} onRead={(library, document) => go({ library, document })} onFail={fail} />
    ) : null;

  const main: Record<Screen, () => ReactNode> = {
    home: frontPage,
    collections: collectionsPage,
    library: libraryPage,
    document: readerPage,
    series: seriesPage,
    shared: sharedPage,
    published: publishedPage,
    received: receivedPage,
    arrived: arrivedPage,
  };

  return (
    <>
      <AppFrame
        app={app}
        onFront={home}
        rail={rail}
        railLabel={app.name}
        {...(screen === 'document' ? { drawer: readerSide(), drawerLabel: 'About this document', aside: <ReadingContents reading={reading} /> } : {})}
        busy={busy} screen={`${screen}:${place.library ?? ''}:${place.folder ?? ''}:${place.document ?? ''}`} measure={screen === 'document' ? 'read' : 'wide'} depth={depth} ringShape={ringShape}>
        {note ? (
          <p className="text-meta text-ink-muted" role="status">
            {note}
          </p>
        ) : null}
        {main[screen]()}
        <Palette open={finding} onClose={() => (setFinding(false), setQuery(''))} placeholder={`Find a document or ${levelName('collection').toLowerCase()}`} query={query} onQuery={setQuery} items={found} onPick={pick} />
        <Asking
          ask={ask}
          close={() => setAsk(undefined)}
          api={api}
          userId={userId}
          floorKey={floorKey}
          explain={props.explain}
          publisher={props.publisher}
          open={open}
          after={() => void refresh().catch(fail)}
          onLevels={setLevels}
          onDocument={setDoc}
          onTags={(tags) => setOpen((was) => (was ? { ...was, tags } : was))}
          onDeleted={(d) => {
            setAsk(undefined);
            setDoc(undefined);
            go(d.folder ? { library: d.library, folder: d.folder } : { library: d.library });
          }}
          onDownload={download}
          onRetry={retry}
          floorName={floorName}
          pickRef={props.pickRef}
          levelName={levelName}
          onChanged={refresh}
          onArchived={(id) => {
            setAsk(undefined);
            setOpen(undefined);
            void loadLibraries();
            if (place.library === id) go({ collections: true });
          }}
          onOpenLink={openLink}
          query={queryFrom(filters, sort, folderHere)}
          onViewSaved={(view) => void refresh().then(() => go({ library: view.library, view: view.id }))}
          onSeries={(saved) => {
            setSeriesShown((n) => n + 1);
            go({ library: saved.library, series: saved.id });
            void refresh().catch(() => undefined);
          }}
        />
      </AppFrame>
    </>
  );
}

/** The dialog an action asked for: a name, a confirmation, sharing, publishing, or changing a document. */
function Asking({
  ask,
  close,
  api,
  userId,
  floorKey,
  explain,
  publisher,
  open,
  after,
  onSeries,
  onLevels,
  onDocument,
  onTags,
  onDeleted,
  onDownload,
  onRetry,
  floorName,
  pickRef,
  levelName,
  onChanged,
  onArchived,
  onOpenLink,
  query,
  onViewSaved,
}: {
  ask: Ask | undefined;
  close: () => void;
  api: FolioApi;
  userId: string;
  floorKey: string;
  explain?: ArtifactsProps['explain'];
  publisher?: boolean;
  open?: OpenLibrary;
  after: () => void;
  onSeries: (saved: SeriesView) => void;
  onLevels: (levels: LevelInfo[]) => void;
  onDocument: (doc: OpenDocument) => void;
  onTags: (tags: Tag[]) => void;
  onDeleted: (doc: OpenDocument) => void;
  onDownload: (doc: OpenDocument, version: number) => void;
  onRetry: (doc: OpenDocument, version: number) => void;
  floorName: string;
  pickRef?: PickRef;
  levelName: (id: LevelInfo['id']) => string;
  onChanged: () => Promise<unknown>;
  onArchived: (library: string) => void;
  onOpenLink: (link: RecordLink) => void;
  query: ViewQuery;
  onViewSaved: (view: SavedView) => void;
}) {
  if (!ask) return null;
  switch (ask.kind) {
    case 'name':
      return (
        <Dialog open onClose={close} eyebrow={ask.eyebrow} heading={ask.heading} summary={ask.summary} actionLabel={ask.action} onSubmit={(v) => ask.run(v.name!.trim()).then(() => undefined)} fields={<TextField name="name" label={ask.label} required defaultValue={ask.value} autoFocus />} />
      );
    case 'confirm':
      return <Dialog open onClose={close} heading={ask.heading} summary={ask.summary} actionLabel={ask.action} danger onSubmit={() => ask.run().then(() => undefined)} />;
    case 'share': {
      const folderNames = new Map(open?.id === ask.library ? open.folders.map((f) => [f.id, f.name]) : []);
      return (
        <Dialog open light onClose={() => (close(), after())} eyebrow={ask.eyebrow} heading={`Who can see ${ask.name}`} cancelLabel="Done">
          <Share api={api} explain={explain} folderNames={folderNames} name={ask.name} me={userId} library={ask.library} document={ask.document} folder={ask.folder} />
        </Dialog>
      );
    }
    case 'publish-up':
      return (
        <Dialog open light size="read" onClose={close} eyebrow="Publish up" heading={ask.record.name} summary="Put it on a floor above, showing only versions in the states you choose. It stays a live window: what reaches those states shows there." cancelLabel="Done">
          <PublishUp api={api} library={ask.library} here={floorKey} record={ask.record} />
        </Dialog>
      );
    case 'levels':
      return (
        <Dialog open light onClose={close} eyebrow="Collections" heading="Level names" cancelLabel="Done">
          <Levels api={api} onLevels={onLevels} />
        </Dialog>
      );
    case 'document':
      return (
        <DocumentDialog
          api={api}
          doc={ask.doc}
          library={open?.id === ask.doc.library ? open : undefined}
          onClose={() => (close(), after())}
          onChanged={onDocument}
          onTags={onTags}
          onDeleted={() => onDeleted(ask.doc)}
          onDownload={(v) => onDownload(ask.doc, v)}
          onRetry={(v) => onRetry(ask.doc, v)}
        />
      );
    case 'details': {
      const library = open?.id === ask.library.id ? open : ask.library;
      const folder = ask.folder ? (library.folders.find((f) => f.id === ask.folder!.id) ?? ask.folder) : undefined;
      return (
        <PlaceDetails
          api={api}
          userId={userId}
          library={library}
          folder={folder}
          levelName={levelName(folder?.level ?? 'collection')}
          floorName={floorName}
          pickRef={pickRef}
          onClose={close}
          onChanged={onChanged}
          onArchived={() => onArchived(library.id)}
          onTags={onTags}
          onOpenLink={onOpenLink}
        />
      );
    }
    case 'save-view':
      return <SaveView api={api} library={ask.library} query={query} onClose={close} onSaved={onViewSaved} />;
    case 'tags':
      return <TagsDialog api={api} library={open?.id === ask.library.id ? open : ask.library} onClose={close} onChanged={onChanged} />;
    case 'series':
      return <SeriesDialog api={api} library={ask.library} series={ask.series} org={publisher} onClose={close} onSaved={onSeries} />;
    case 'publish':
      return (
        <Dialog open light size="read" onClose={() => (close(), after())} eyebrow="Publish" heading={ask.doc.title} summary="Put a version out to teams or the whole org, or take it back." cancelLabel="Done">
          <Publish api={api} library={ask.doc.library} document={ask.doc.id} issue={Boolean(ask.doc.issue)} versions={ask.doc.versions.map((v) => v.number)} />
        </Dialog>
      );
  }
}
