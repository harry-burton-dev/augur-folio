import { CONTAINER_LIFECYCLE } from '@augur/records';
import type { FilterDef, FilterValue, SelectOption, TreeNode } from '@augur/app-kit';
import {
  KINDS,
  fileTypeOf,
  sizeWords,
  stateName,
  type ContainerState,
  type DocumentSort,
  type DocumentState,
  type FolioDocument,
  type Folder,
  type LevelInfo,
  type OpenLibrary,
  type ReaderState,
  type Series,
  type Since,
  type ViewQuery,
} from './api.js';
import { tagOptions } from './words.js';

/**
 * Where things are in Artifacts, in its own words and free of any kit's
 * parts: the filter bar's choices and a saved view's query, a place's levels
 * and lifecycle, and a document in a line.
 */

/** Where a version's reader copy is, in a few words. */
export const readerWords = (reader: ReaderState) => {
  switch (reader.state) {
    case 'ready':
      return reader.pages ? `Reader copy ready, ${reader.pages} ${reader.pages === 1 ? 'page' : 'pages'}` : 'Reader copy ready';
    case 'failed':
      return 'No reader copy';
    default:
      return 'Making the reader copy…';
  }
};

export const SORTS: SelectOption[] = [
  { value: 'title', label: 'Title' },
  { value: 'newest', label: 'Newest first' },
  { value: 'updated', label: 'Recently changed' },
  { value: 'period', label: 'Series period' },
];


const STATE_OPTIONS: SelectOption[] = [
  { value: 'draft', label: 'Drafts' },
  { value: 'published', label: 'Published' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

/** Where a document is in being published, as its row says it: nothing for a draft. */
export const stateWords = (doc: Pick<FolioDocument, 'state' | 'published'>) =>
  doc.state === 'published' && doc.published ? `Published, version ${doc.published.version}` : doc.state === 'withdrawn' ? 'Withdrawn' : '';

const SINCE_OPTIONS: SelectOption[] = [
  { value: 'week', label: 'Past week' },
  { value: 'month', label: 'Past month' },
  { value: 'quarter', label: 'Past three months' },
  { value: 'year', label: 'Past year' },
];

/** The filter bar's choices, from what the library has. */
export const filtersFor = (open: Pick<OpenLibrary, 'tags' | 'authors'> & { series?: Series[] }): FilterDef[] => [
  { id: 'tag', label: 'Tags', search: true, options: tagOptions(open.tags) },
  { id: 'type', label: 'Type', options: KINDS },
  { id: 'author', label: 'Added by', search: open.authors.length > 8, options: open.authors.map((a) => ({ value: a.id, label: a.name || 'Someone' })) },
  { id: 'since', label: 'Changed', single: true, options: SINCE_OPTIONS },
  { id: 'state', label: 'Published', options: STATE_OPTIONS },
  ...(open.series?.length ? [{ id: 'series', label: 'Series', single: true, options: open.series.map((r) => ({ value: r.id, label: r.name })) }] : []),
];

/** The bar's filters and sort as a saved view keeps them. */
export const queryFrom = (filters: FilterValue, sort: DocumentSort, folder?: string): ViewQuery => ({
  ...(folder ? { folder } : {}),
  ...(filters.tag?.length ? { tags: filters.tag } : {}),
  ...(filters.type?.length ? { types: filters.type } : {}),
  ...(filters.author?.length ? { authors: filters.author } : {}),
  ...(filters.since?.length ? { since: filters.since[0] as Since } : {}),
  ...(sort !== 'title' ? { sort } : {}),
  ...(filters.state?.length ? { states: filters.state as DocumentState[] } : {}),
  ...(filters.series?.length ? { series: filters.series[0] } : {}),
});

/** A saved view's filters, back in the bar's shape. */
export const filtersFrom = (q: ViewQuery): FilterValue =>
  Object.fromEntries(
    Object.entries({ tag: q.tags ?? [], type: q.types ?? [], author: q.authors ?? [], since: q.since ? [q.since] : [], state: q.states ?? [], series: q.series ? [q.series] : [] }).filter(
      ([, v]) => v.length,
    ),
  );

/** Whether any filter is on: then the list looks in every folder below. */
export const filtering = (filters: FilterValue) => Object.values(filters).some((v) => v.length > 0);

/** The folder levels a place may hold, by what it is: the library itself (a collection) or a folder's level. */
export const levelsInside = (levels: readonly LevelInfo[], at: LevelInfo['id']): LevelInfo[] => {
  const holds = levels.find((l) => l.id === at)?.holds ?? [];
  return levels.filter((l) => l.id !== 'file' && holds.includes(l.id));
};

/** Where a library or folder is in its lifecycle: open, when a server from before lifecycles doesn't say. */
export const stateOf = (x: { state?: ContainerState } | undefined, or?: { state?: ContainerState }): ContainerState => x?.state ?? or?.state ?? 'open';

/** "Closed: kept as it is, nothing new goes in.", or nothing while it's open. */
export const closedWords = (state: ContainerState) => (state === 'open' ? '' : `${stateName(state)}: ${CONTAINER_LIFECYCLE.get(state).meaning}`);

/** Where a document is in its lifecycle, as its row says it: the newest version's state. */
export const lifecycleWords = (doc: Pick<FolioDocument, 'latest'>) => (doc.latest.state ? stateName(doc.latest.state) : '');

/** "Version 3 · PDF · 1.2 MB": what a document is, in a line. */
export const documentLine = (doc: Pick<FolioDocument, 'latest'>) =>
  [`Version ${doc.latest.number}`, fileTypeOf(doc.latest.filename)?.word, sizeWords(doc.latest.size)].filter(Boolean).join(' · ');

/** The folders inside `parent` (or at the top), as tree rows with theirs inside them. */
export const folderTree = (folders: readonly Folder[], parent?: string): TreeNode[] =>
  folders
    .filter((f) => f.parent === parent)
    .map((f) => {
      const children = folderTree(folders, f.id);
      return { id: f.id, label: f.name, icon: 'folder' as const, ...(children.length ? { children } : {}) };
    });

/** From the top of the library down to `id`. */
export const folderTrail = (folders: readonly Folder[], id: string | undefined): Folder[] => {
  const trail: Folder[] = [];
  for (let at = folders.find((f) => f.id === id); at; at = folders.find((f) => f.id === at!.parent)) trail.unshift(at);
  return trail;
};
