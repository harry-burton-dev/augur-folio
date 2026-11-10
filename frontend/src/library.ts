import { CONTAINER_LIFECYCLE, CONTENT_LIFECYCLE } from '@augur/records';
import type { RemoteNode } from '@augur/mfe-sdk/sdk3';
import type { ContentState, DocumentPage, DocumentView, FloorView, FolderAnswer, FolderView, LevelInfo, LibraryAnswer, PathStep, ReceivedAnswer, ReceivedFolderAnswer, ReceivedItem, Rights, SharedItem, Signpost, UnitLevel } from '../../service/src/api-types.js';
import { quill } from './screen.js';

/**
 * The library's screens (spec section 6): tiles for what holds things, rows for documents, a filter bar
 * over the rows, and a page head with the whole path. Each tile and row is marked for the shell's
 * radial menu (`thing`); the pane keeps one action, Add.
 */

export type Load<T> = { kind: 'asking' } | { kind: 'answered'; value: T } | { kind: 'failed'; why: string };

/** What a folder's rows are narrowed to: lifecycle states, and the order. */
export interface RowFilter {
  lifecycle: string[];
  sort: 'updated' | 'title' | 'newest';
}

export const DEFAULT_FILTER: RowFilter = { lifecycle: [], sort: 'updated' };

export const levelName = (levels: readonly LevelInfo[], id: UnitLevel, plural = false) => {
  const level = levels.find((l) => l.id === id);
  return (plural ? level?.plural : level?.name) ?? id;
};

/** The trail from the library down to a folder, for the page head. */
export const trailOf = (path: readonly PathStep[]) => [{ id: 'library', label: 'Library' }, ...path.map((s) => ({ id: s.id, label: s.name }))];

const tileKind = (f: FolderView) => (f.level === 'collection' ? 'collection' : f.level === 'series' || f.level === 'subseries' ? 'series' : 'folder');

const folderTile = (f: FolderView, levels: readonly LevelInfo[], open: (id: string) => void) =>
  quill('quill-kind-tile', {
    kind: tileKind(f),
    name: f.name,
    eyebrow: levelName(levels, f.level),
    ...(f.state !== 'open' ? { state: CONTAINER_LIFECYCLE.get(f.state).name } : {}),
    ...(f.description ? { note: f.description } : {}),
    thing: { kind: f.level === 'collection' ? 'collection' : 'folder', id: f.id, label: f.name },
    onOpen: () => open(f.id),
  });

/** The add tile: a new folder of the next level down, or why not. */
const addTile = (label: string, rights: Rights, press: () => void) => quill('quill-add-tile', { label, ...(rights.add ? {} : { reason: rights.why ?? 'You can’t add here.' }), onPress: press });

const asking = (heading: string) => quill('quill-state', { kind: 'loading', heading, size: 'region' });
const failed = (heading: string, why: string, retry: () => void) => quill('quill-state', { kind: 'error', heading, body: why, action: 'Try again', size: 'region', onAction: retry });

export interface LibraryOn {
  retry: () => void;
  open: (folder: string) => void;
  newFolder: () => void;
}

/** The library's top: its collections. */
export const libraryScreen = (load: Load<LibraryAnswer>, on: LibraryOn): RemoteNode => {
  if (load.kind === 'asking') return asking('Opening the library');
  if (load.kind === 'failed') return failed('The library couldn’t open', load.why, on.retry);
  const { collections, levels, rights } = load.value;
  const plural = levelName(levels, 'collection', true);
  return [
    quill('quill-page-head', { heading: 'Library', summary: collections.length ? `${collections.length} ${plural.toLowerCase()} on this floor.` : `This floor’s documents live in ${plural.toLowerCase()}.` }),
    collections.length || rights.manage
      ? quill('quill-tiles', { label: plural }, [...collections.map((c) => folderTile(c, levels, on.open)), addTile(`New ${levelName(levels, 'collection').toLowerCase()}`, { ...rights, add: rights.manage, why: `Only the floor’s leads make ${plural.toLowerCase()}.` }, on.newFolder)])
      : quill('quill-state', { kind: 'empty', heading: `There are no ${plural.toLowerCase()} here yet.`, body: 'The floor’s leads make them. Ask one of them to start the library.', size: 'region' }),
  ];
};

const LIFECYCLE_FILTER = {
  id: 'lifecycle',
  label: 'Lifecycle',
  options: CONTENT_LIFECYCLE.states.map((s) => ({ value: s.id, label: s.name, detail: s.meaning })),
};
const SORTS = [
  { value: 'updated', label: 'Last changed' },
  { value: 'title', label: 'Title' },
  { value: 'newest', label: 'Newest' },
];

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** A floor in a sentence: "Operations", or "the org’s floor". */
export const floorName = (f: FloorView) => (f.kind === 'org' ? 'the org’s floor' : f.name);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const statesLine = (states: readonly ContentState[]) => states.map((st) => CONTENT_LIFECYCLE.get(st).name).join(', ');

/** Where someone's one place for a thing is, said on the floor below. */
export const signpostLine = (p: Signpost) => `Its place is on ${floorName(p.to)}${p.landed ? `, in ${p.landed}` : ''}`;

/** A document as a row: its title, then its state, version and when it last changed. */
export const documentRow = (d: DocumentView, { needs = false }: { needs?: boolean } = {}) => ({
  id: d.id,
  title: d.title,
  detail: [CONTENT_LIFECYCLE.get(d.latest.state).name, `version ${d.latest.number}`, `changed ${when(d.updatedAt)}`].join(' · '),
  icon: 'document',
  ...(d.placed ? { meta: signpostLine(d.placed) } : {}),
  ...(needs && d.latest.state === 'in-review' ? { status: 'needs' as const } : {}),
  thing: { kind: 'document', id: d.id, label: d.title },
});

/** Something published up to this floor, as a row: what it is, where it came from and what it shows. */
export const receivedRow = (i: ReceivedItem, { actions = true }: { actions?: boolean } = {}) => {
  const { placement: p } = i;
  const isDocument = p.record.kind === 'document';
  return {
    id: p.id,
    title: p.record.name,
    detail: [`From ${p.from.kind === 'org' ? 'the org' : p.from.name}`, isDocument && i.version ? `${CONTENT_LIFECYCLE.get(i.version.state).name}, version ${i.version.number}` : `Shows ${statesLine(i.states).toLowerCase()}`, p.landed ? `in ${p.landed.name}` : undefined]
      .filter(Boolean)
      .join(' · '),
    icon: isDocument ? 'document' : 'folder',
    ...(isDocument ? { thing: { kind: 'document', id: p.record.id, label: p.record.name } } : {}),
    ...(actions && p.can.land ? { actions: [{ id: 'land', label: p.landed ? 'Move it' : 'Give it a place' }] } : {}),
  };
};


export interface FolderData {
  folder: FolderAnswer;
  page: DocumentPage;
  levels: LevelInfo[];
}

export interface FolderOn extends LibraryOn {
  trail: (id: string) => void;
  filter: (filter: RowFilter) => void;
  openDocument: (id: string) => void;
  add: () => void;
  /** Opens something published up to this floor. */
  openReceived: (item: ReceivedItem) => void;
  land: (item: ReceivedItem) => void;
}

/** The signpost a floor below shows where someone's place for a thing is higher up. */
export const signpostNotice = (p: Signpost, what: string) =>
  quill('quill-notice', { tone: 'info', label: 'One place', heading: `${capital(signpostLine(p))}.` }, [`People there read ${what} there. It is still kept, and changed, here.`]);

const receivedList = (items: readonly ReceivedItem[], on: { open: (item: ReceivedItem) => void; land: (item: ReceivedItem) => void }, label: string, empty?: string) =>
  quill('quill-list', {
    label,
    noun: ['thing', 'things'],
    items: items.map((i) => receivedRow(i)),
    ...(empty ? { empty } : {}),
    onOpen: (id: string) => {
      const item = items.find((i) => i.placement.id === id);
      if (item) on.open(item);
    },
    onAction: ({ item }: { item: string; action: string }) => {
      const found = items.find((i) => i.placement.id === item);
      if (found) on.land(found);
    },
  });

/** A folder: what it holds as tiles, then its documents as rows under the filter bar. */
export const folderScreen = (load: Load<FolderData>, filter: RowFilter, on: FolderOn): RemoteNode => {
  if (load.kind === 'asking') return asking('Opening the folder');
  if (load.kind === 'failed') return failed('The folder couldn’t open', load.why, on.retry);
  const { folder: answer, page, levels } = load.value;
  const { folder, path, folders, rights, holds } = answer;
  const next = holds.find((l) => l !== 'file');
  const narrowed = filter.lifecycle.length > 0;
  return [
    quill('quill-page-head', {
      trail: trailOf(path.slice(0, -1)),
      eyebrow: [levelName(levels, folder.level), folder.state !== 'open' ? CONTAINER_LIFECYCLE.get(folder.state).name : undefined].filter(Boolean).join(' · '),
      heading: folder.name,
      ...(folder.description ? { summary: folder.description } : {}),
      onTrail: on.trail,
    }),
    answer.placed ? signpostNotice(answer.placed, 'it') : null,
    folders.length || next
      ? quill('quill-tiles', { label: 'In it' }, [...folders.map((f) => folderTile(f, levels, on.open)), ...(next ? [addTile(`New ${levelName(levels, next).toLowerCase()}`, rights, on.newFolder)] : [])])
      : null,
    quill('quill-section', { label: 'Documents', count: page.total }, [
      page.total || narrowed
        ? quill('quill-filter-bar', {
            label: 'Narrow the documents',
            filters: [LIFECYCLE_FILTER],
            value: { lifecycle: filter.lifecycle },
            sorts: SORTS,
            sort: filter.sort,
            count: page.total,
            noun: ['document', 'documents'],
            onChange: ({ value, sort }: { value: Record<string, string[]>; sort?: string }) =>
              on.filter({ lifecycle: value.lifecycle ?? [], sort: (SORTS.some((s) => s.value === sort) ? sort : filter.sort) as RowFilter['sort'] }),
          })
        : null,
      quill('quill-list', {
        label: 'Documents',
        noun: ['document', 'documents'],
        items: page.documents.map((d) => documentRow(d, { needs: rights.manage })),
        empty: narrowed ? 'No documents here are in those states.' : rights.add ? 'Nothing here yet. Add a document, or drop files on this page.' : (rights.why ?? 'Nothing here yet.'),
        onOpen: on.openDocument,
      }),
    ]),
    answer.received.length
      ? quill('quill-section', { label: 'Published up to here', count: answer.received.length }, [receivedList(answer.received, { open: on.openReceived, land: on.land }, 'Published up to here')])
      : null,
  ];
};

/** What other floors let the person open. */
export const sharedScreen = (load: Load<SharedItem[]>, on: { retry: () => void; open: (item: SharedItem) => void }): RemoteNode => {
  if (load.kind === 'asking') return asking('Finding what’s shared with you');
  if (load.kind === 'failed') return failed('Shared with you couldn’t open', load.why, on.retry);
  const items = load.value;
  return [
    quill('quill-page-head', { heading: 'Shared with you', summary: 'What other floors let you open. You read what you’re let into, and change it only where they let you.' }),
    quill('quill-list', {
      label: 'Shared with you',
      noun: ['thing', 'things'],
      items: items.map((i) => ({ id: `${i.kind}:${i.id}`, title: i.title, detail: `${i.kind === 'document' ? 'Document' : i.kind === 'folder' ? 'Folder' : 'Library'} · you can ${i.level}`, icon: i.kind === 'document' ? 'document' : 'folder', ...(i.kind === 'document' ? { thing: { kind: 'document', id: i.id, label: i.title } } : {}) })),
      empty: 'Nothing has been shared with you from another floor.',
      onOpen: (id: string) => {
        const item = items.find((i) => `${i.kind}:${i.id}` === id);
        if (item) on.open(item);
      },
    }),
  ];
};

/** What floors below published up here: waiting for a place, given one, and signposts to where it went on up. */
export const belowScreen = (load: Load<ReceivedAnswer>, on: { retry: () => void; open: (item: ReceivedItem) => void; land: (item: ReceivedItem) => void; signpost: (placement: string, kind: string, id: string) => void }): RemoteNode => {
  if (load.kind === 'asking') return asking('Finding what was published up here');
  if (load.kind === 'failed') return failed('From below couldn’t open', load.why, on.retry);
  const { here, signposts, places } = load.value;
  const waiting = here.filter((i) => !i.placement.landed);
  const placed = here.filter((i) => i.placement.landed);
  const head = quill('quill-page-head', { heading: 'From below', summary: 'What the floors below this one publish up to it, read only. Its own floor keeps it and changes it.' });
  if (!here.length && !signposts.length)
    return [head, quill('quill-state', { kind: 'empty', heading: 'Nothing has been published up to this floor yet.', body: 'When a floor below publishes something up to this one, it shows here.', size: 'region' })];
  const leads = places.length > 0 || here.some((i) => i.placement.can.land);
  return [
    head,
    quill('quill-section', { label: 'Waiting for a place', count: waiting.length }, [
      receivedList(waiting, on, 'Waiting for a place', leads ? 'Everything here has a place in the library.' : 'Nothing is waiting. The floor’s leads give each thing its place in the library.'),
    ]),
    placed.length ? quill('quill-section', { label: 'Given a place', count: placed.length }, [receivedList(placed, on, 'Given a place')]) : null,
    signposts.length
      ? quill('quill-section', { label: 'Gone on up', count: signposts.length }, [
          quill('quill-list', {
            label: 'Gone on up',
            noun: ['thing', 'things'],
            density: 'compact',
            items: signposts.map((p) => ({ id: p.placement, title: p.record.name, detail: signpostLine(p), icon: 'arrow' })),
            onOpen: (id: string) => {
              const p = signposts.find((x) => x.placement === id);
              if (p) on.signpost(p.placement, p.record.kind, p.record.id);
            },
          }),
        ])
      : null,
  ];
};

/** Inside a folder published up here, at the states it shows. */
export const receivedFolderScreen = (
  load: Load<ReceivedFolderAnswer>,
  levels: readonly LevelInfo[],
  on: { retry: () => void; trail: (id: string) => void; open: (folder: string) => void; openDocument: (id: string) => void },
): RemoteNode => {
  if (load.kind === 'asking') return asking('Opening the folder');
  if (load.kind === 'failed') return failed('The folder couldn’t open', load.why, on.retry);
  const { placement, folder, path, folders, documents, states } = load.value;
  return [
    quill('quill-page-head', {
      trail: [{ id: 'below', label: 'From below' }, ...path.slice(0, -1).map((s) => ({ id: s.id, label: s.name }))],
      eyebrow: `${levelName(levels, folder.level)} · from ${placement.from.kind === 'org' ? 'the org' : placement.from.name}`,
      heading: folder.name,
      summary: `Published up here, showing ${statesLine(states).toLowerCase()}. Its own floor keeps it and changes it.`,
      onTrail: on.trail,
    }),
    folders.length ? quill('quill-tiles', { label: 'In it' }, folders.map((f) => quill('quill-kind-tile', { kind: tileKind(f), name: f.name, eyebrow: levelName(levels, f.level), onOpen: () => on.open(f.id) }))) : null,
    quill('quill-section', { label: 'Documents', count: documents.length }, [
      quill('quill-list', {
        label: 'Documents',
        noun: ['document', 'documents'],
        items: documents.map((d) => ({ ...documentRow(d), detail: [CONTENT_LIFECYCLE.get(d.version.state).name, `version ${d.version.number}`].join(' · ') })),
        empty: 'Nothing in here is in a state this floor is shown.',
        onOpen: on.openDocument,
      }),
    ]),
  ];
};
