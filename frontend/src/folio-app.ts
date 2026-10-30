import { LitElement, html, nothing } from 'lit';
import { ago, filterValue, type ButtonKind, type DialogSubmit, type PageAction, type FieldCheck, type FilterDef, type FilterValue, type ListItem, type SelectOption, type TagOption, type TreeItem, type UiTextField } from '@augur/ui-kit';
import './folio-reader.js';
import type { Propose } from './folio-reader.js';
import './folio-share.js';
import './folio-publish.js';
import './folio-series.js';
import './folio-audience.js';
import './folio-publish-up.js';
import './folio-links.js';
import { DEFAULT_LEVELS } from './folio-levels.js';
import type { OpenRef, PickRef } from './folio-links.js';
import { filterWords, floorWords } from './folio-publish-up.js';
import { CONTAINER_LIFECYCLE } from '@augur/records';
import type { Chosen } from './folio-audience.js';
import { whoWords, type Explainer } from './folio-share.js';
import {
  ACCEPT,
  KINDS,
  MAX_UPLOAD_MB,
  fileTypeOf,
  sizeWords,
  type DocumentSort,
  type DocumentState,
  type FolioApi,
  type FolioDocument,
  type Folder,
  type Library,
  type OpenDocument,
  type OpenLibrary,
  type Place,
  type PublishedPage,
  type Principal,
  type ReaderState,
  type SavedView,
  type Series,
  type SeriesView,
  type Cadence,
  type ContainerState,
  type ContentState,
  type FolderLevel,
  type LevelInfo,
  type Received,
  type RecordLink,
  type ReceivedPage,
  type RecordView,
  type StateMove,
  CONTAINER_STATES,
  stateName,
  type Shared,
  type Since,
  type Tag,
  type ViewQuery,
} from './api.js';

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

type Dialog =
  | 'new-library'
  | 'edit-library'
  | 'archive-library'
  | 'new-folder'
  | 'rename-folder'
  | 'remove-folder'
  | 'document'
  | 'edit-document'
  | 'delete-document'
  | 'tags'
  | 'rename-tag'
  | 'remove-tag'
  | 'save-view'
  | 'rename-view'
  | 'delete-view'
  | 'share'
  | 'publish'
  | 'new-series'
  | 'edit-series'
  | 'delete-series'
  | 'details'
  | 'publish-up'
  | 'levels';

/** How many documents come in one page of the list. */
const PAGE = 100;

export const SORTS: SelectOption[] = [
  { value: 'title', label: 'Title' },
  { value: 'newest', label: 'Newest first' },
  { value: 'updated', label: 'Recently changed' },
  { value: 'period', label: 'Series period' },
];

const CADENCE_OPTIONS: SelectOption[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'adhoc', label: 'Now and then', detail: 'No due dates' },
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

/** Tags as a picker offers them: the org's marked as such. */
export const tagOptions = (tags: readonly Tag[]): TagOption[] =>
  tags.map((t) => ({ value: t.id, label: t.name, ...(t.library ? {} : { detail: 'Org', icon: 'org' }) }));

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

const sameQuery = (a: ViewQuery, b: ViewQuery) => {
  const norm = (q: ViewQuery) => JSON.stringify(Object.entries(q).sort(([x], [y]) => x.localeCompare(y)));
  return norm(a) === norm(b);
};

/** Whether any filter is on: then the list looks in every folder below. */
export const filtering = (filters: FilterValue) => Object.values(filters).some((v) => v.length > 0);

export { DEFAULT_LEVELS };

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

/** Rows for documents carry this before their id, so they never meet a folder's. */
const DOC = 'doc:';

/** "Version 3 · PDF · 1.2 MB": what a document is, in a line. */
export const documentLine = (doc: Pick<FolioDocument, 'latest'>) =>
  [`Version ${doc.latest.number}`, fileTypeOf(doc.latest.filename)?.word, sizeWords(doc.latest.size)].filter(Boolean).join(' · ');

/** Saves a file the browser was handed, under its own name. */
const save = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** The folders inside `parent` (or at the top), as tree rows with theirs inside them. */
export const folderTree = (folders: readonly Folder[], parent?: string): TreeItem[] =>
  folders
    .filter((f) => f.parent === parent)
    .map((f) => {
      const children = folderTree(folders, f.id);
      return { id: f.id, label: f.name, icon: 'folder', ...(children.length ? { children } : {}) };
    });

/** From the top of the library down to `id`. */
export const folderTrail = (folders: readonly Folder[], id: string | undefined): Folder[] => {
  const trail: Folder[] = [];
  for (let at = folders.find((f) => f.id === id); at; at = folders.find((f) => f.id === at!.parent)) trail.unshift(at);
  return trail;
};

const nameCheck =
  (taken: readonly string[], what: string, slashes = true, most = 80) =>
  (value: string): FieldCheck | null => {
    const name = value.trim();
    if (!name) return { state: 'error', message: `Give the ${what} a name.` };
    if (name.length > most) return { state: 'error', message: `Keep it to ${most} characters.` };
    if (!slashes && /[/\\]/.test(name)) return { state: 'error', message: 'A folder’s name can’t have a slash in it.' };
    if (taken.some((t) => t.toLocaleLowerCase() === name.toLocaleLowerCase())) return { state: 'error', message: `There’s already a ${what} called ${name} here.` };
    return null;
  };

/**
 * Folio inside the shell's top bar: everything below it is Folio's own layout.
 * A side rail with the floor's libraries and the open library's folders, and a
 * main area with where you are, what you can do there, and what's inside.
 *
 * @fires folio-place - detail `{ library?, folder?, view?, document?, version? }`, when the person moves somewhere else in Folio
 */
export class FolioApp extends LitElement {
  static override properties = {
    api: { attribute: false },
    floorName: { type: String, attribute: 'floor-name' },
    floorKind: { type: String, attribute: 'floor-kind' },
    place: { attribute: false },
    propose: { attribute: false },
    pickRef: { attribute: false },
    openRef: { attribute: false },
    libraries: { state: true },
    canCreate: { state: true },
    open: { state: true },
    folder: { state: true },
    loading: { state: true },
    opening: { state: true },
    error: { state: true },
    dialog: { state: true },
    target: { state: true },
    documents: { state: true },
    uploading: { state: true },
    note: { state: true },
    doc: { state: true },
    filters: { state: true },
    sort: { state: true },
    total: { state: true },
    view: { state: true },
    uploadTags: { state: true },
    orgTags: { state: true },
    tagTarget: { state: true },
    more: { state: true },
    reading: { state: true },
    shared: { state: true },
    inbox: { state: true },
    run: { state: true },
    seriesEdit: { state: true },
    publisher: { type: Boolean },
    levels: { state: true },
    received: { state: true },
    arrived: { state: true },
    upTarget: { state: true },
    moves: { state: true },
  };

  declare api: FolioApi;
  declare floorName: string;
  declare floorKind: 'personal' | 'team' | 'org';
  /** Where to start, from the path the shell mounted Folio at. */
  declare place: Place;
  /** Offers words marked in the open document to Data Atlas (see folio-reader). */
  declare propose: ((doc: { id: string; title: string }, ...rest: Parameters<Propose>) => Promise<string>) | undefined;
  /** Asks the person for a thing in Data Atlas or an intent in Mandate, to link to. */
  declare pickRef: PickRef | undefined;
  /** Opens a thing in Data Atlas, or an intent in Mandate, that a record links to. */
  declare openRef: OpenRef | undefined;
  declare libraries: Library[];
  declare canCreate: boolean;
  declare open: OpenLibrary | undefined;
  declare folder: string | undefined;
  declare loading: boolean;
  declare opening: boolean;
  declare error: string;
  declare dialog: Dialog | undefined;
  /** The folder a folder dialog is about. */
  declare target: Folder | undefined;
  /** The documents where the person is: in the open folder, or at the top of the library. */
  declare documents: FolioDocument[];
  /** How many files are still going up. */
  declare uploading: number;
  /** What happened with the last files: "Added 2 documents.", or what was turned away. */
  declare note: string;
  /** The document open in its dialog, with its versions. */
  declare doc: OpenDocument | undefined;
  /** What the filter bar has on, by filter: tag, type, author, since. */
  declare filters: FilterValue;
  declare sort: DocumentSort;
  /** How many documents match, of which `documents` holds the first pages. */
  declare total: number;
  /** The saved view open, if one is. */
  declare view: string | undefined;
  /** Tags for the next files dropped. */
  declare uploadTags: string[];
  /** The org's tags and whether the person keeps them, once the tags dialog has asked. */
  declare orgTags: { tags: Tag[]; manage: boolean } | undefined;
  /** The tag a tag dialog is about. */
  declare tagTarget: Tag | undefined;
  /** The next page is on its way. */
  declare more: boolean;
  /** The document being read, on its own page, and which version (the newest when there's none). */
  declare reading: { library: string; document: string; version?: number } | undefined;
  /** Libraries and documents shared with the person from other floors. */
  declare shared: Shared;
  /** What's been published to the person, while they're looking at it (`/published`), or reading from it. */
  declare inbox: PublishedPage | undefined;
  /** The series open on its own page, and the library it's in. */
  declare run: { library: string; series: string } | undefined;
  /** The series its dialog changes, with its audience named. */
  declare seriesEdit: (Omit<SeriesView, 'audience'> & { audience: Principal[] }) | undefined;
  /** The person has the publisher role: the whole org is theirs to publish to. */
  declare publisher: boolean;
  /** The levels a library is built from, in the org's words. */
  declare levels: LevelInfo[];
  /** What's been published up to this floor, and signposts to what the person sees higher up. */
  declare received: Received;
  /** Something published up to this floor, open on its own page, at one of its folders. */
  declare arrived: ReceivedPage | undefined;
  /** What the publish-up dialog is about. */
  declare upTarget: { library: string; kind: RecordView['kind']; id: string; name: string } | undefined;
  /** The lifecycle moves the details dialog shows. */
  declare moves: StateMove[] | undefined;
  /** The floor the person stands on, as placements name floors (set by the entry). */
  floorKey = '';
  /** Set by the entry: asks another app to explain who can open something. */
  explain: Explainer | undefined;
  /** What the share dialog is about: a library, or one document of it. */
  shareTarget: { library: string; document?: string; folder?: string; name: string } | undefined;

  constructor() {
    super();
    this.floorName = '';
    this.floorKind = 'team';
    this.place = { adding: false };
    this.libraries = [];
    this.canCreate = false;
    this.loading = true;
    this.opening = false;
    this.error = '';
    this.documents = [];
    this.uploading = 0;
    this.note = '';
    this.filters = {};
    this.sort = 'title';
    this.total = 0;
    this.uploadTags = [];
    this.more = false;
    this.shared = { libraries: [], documents: [] };
    this.publisher = false;
    this.levels = DEFAULT_LEVELS;
    this.received = { here: [], signposts: [] };
  }

  override createRenderRoot() {
    return this;
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has('api') && this.api) void this.load();
  }

  async load() {
    this.loading = true;
    this.error = '';
    try {
      const [{ libraries, can }, shared, levels, received] = await Promise.all([
        this.api.libraries(),
        // What's shared from elsewhere is a side rail's worth: Folio opens without it, and the same for the rest.
        this.api.shared().catch(() => ({ libraries: [], documents: [] }) as Shared),
        this.api.levels().then((l) => l.levels).catch(() => DEFAULT_LEVELS),
        this.api.received().catch(() => ({ here: [], signposts: [] }) as Received),
      ]);
      this.libraries = libraries;
      this.shared = shared;
      this.levels = levels;
      this.received = received;
      this.canCreate = can.create;
      // Another app opened a document by its id alone (document.open): find its library first.
      const asked = this.place.document && !this.place.library ? await this.api.locate(this.place.document).catch(() => undefined) : undefined;
      const start = this.open?.id ?? this.reading?.library ?? asked?.library ?? this.place.library ?? libraries[0]?.id;
      const reading = this.reading ?? (this.place.document ? { document: this.place.document, version: this.place.version } : undefined);
      if (this.place.adding && can.create) this.dialog = 'new-library';
      const run = this.run ?? (this.place.series && this.place.library ? { library: this.place.library, series: this.place.series } : undefined);
      if (run && !reading) {
        // Its library when the person can see it; a series published to them opens on its own.
        this.open = undefined;
        if ([...libraries, ...shared.libraries].some((l) => l.id === run.library)) await this.openLibrary(run.library, undefined, false);
        this.run = run;
      } else if (this.place.received && !reading) {
        this.open = undefined;
        if (typeof this.place.received === 'string') await this.openArrived(this.place.received, undefined, false);
      } else if (this.place.published && !reading) {
        this.open = undefined;
        await this.openInbox(false);
      } else if (start && [...libraries, ...shared.libraries].some((l) => l.id === start)) {
        await this.openLibrary(start, this.open ? this.folder : this.place.folder, false, this.open ? this.view : this.place.view);
        if (reading) await this.read(reading.document, reading.version, false);
      } else if (start && reading) {
        // A document shared alone: read it without its library.
        this.open = undefined;
        await this.read(reading.document, reading.version, false, start);
      } else this.open = undefined;
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.loading = false;
    }
  }

  /** Something published up to this floor, at one of its folders or its top. */
  private async openArrived(id: string, folder?: string, tell = true) {
    this.reading = undefined;
    this.doc = undefined;
    this.run = undefined;
    this.inbox = undefined;
    this.opening = true;
    try {
      this.arrived = await this.api.receivedPage(id, folder);
      if (tell) this.tell();
    } catch (err) {
      this.note = (err as Error).message;
    } finally {
      this.opening = false;
    }
  }

  /** What's been published to the person, newest first. */
  private async openInbox(tell = true) {
    this.arrived = undefined;
    this.reading = undefined;
    this.doc = undefined;
    this.run = undefined;
    try {
      this.inbox = await this.api.published();
      // Seen now: Home stops counting these as new.
      void this.api.looked().catch(() => undefined);
      if (tell) this.tell();
    } catch (err) {
      this.note = (err as Error).message;
    }
  }

  private async openLibrary(id: string, folder?: string, tell = true, view?: string) {
    this.opening = true;
    this.reading = undefined;
    this.inbox = undefined;
    this.arrived = undefined;
    this.run = undefined;
    try {
      const switching = this.open?.id !== id;
      this.open = await this.api.library(id);
      this.folder = folder && this.open.folders.some((f) => f.id === folder) ? folder : undefined;
      if (switching) {
        this.filters = {};
        this.sort = 'title';
        this.uploadTags = [];
      }
      this.view = undefined;
      const saved = view ? this.open.views.find((v) => v.id === view) : undefined;
      if (saved) this.applyView(saved);
      await this.loadDocuments();
      if (tell) this.tell();
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.opening = false;
    }
  }

  private async goToFolder(folder: string | undefined) {
    this.reading = undefined;
    this.run = undefined;
    this.folder = folder;
    this.view = undefined;
    this.note = '';
    this.tell();
    await this.loadDocuments();
  }

  /** Puts a saved view's folder, filters and sort in place, dropping any tag that's gone. */
  private applyView(view: SavedView) {
    const open = this.open!;
    this.reading = undefined;
    this.run = undefined;
    this.view = view.id;
    this.folder = view.query.folder && open.folders.some((f) => f.id === view.query.folder) ? view.query.folder : undefined;
    this.filters = filterValue(filtersFor(open), filtersFrom(view.query));
    this.sort = view.query.sort ?? 'title';
  }

  private async openView(id: string) {
    const view = this.open?.views.find((v) => v.id === id);
    if (!view) return;
    this.applyView(view);
    this.note = '';
    this.tell();
    await this.loadDocuments();
  }

  private async refilter(e: CustomEvent<{ value: FilterValue; sort: DocumentSort }>) {
    this.filters = e.detail.value;
    this.sort = e.detail.sort;
    await this.loadDocuments();
  }

  /** The documents where the person is, as the bar filters and sorts them; `more` adds the next page. */
  private async loadDocuments(more = false) {
    const open = this.open;
    if (!open) return;
    const { folder, filters, sort } = this;
    const offset = more ? this.documents.length : 0;
    this.more = more;
    try {
      const page = await this.api.documents(open.id, { ...queryFrom(filters, sort, folder), below: filtering(filters), limit: PAGE, offset });
      // Only if the person is still where they were when asked.
      if (this.open?.id !== open.id || this.folder !== folder || this.filters !== filters || this.sort !== sort) return;
      this.documents = more ? [...this.documents, ...page.documents] : page.documents;
      this.total = page.total;
    } catch (err) {
      this.note = (err as Error).message;
    } finally {
      this.more = false;
    }
  }

  /** The library again, for its tags, authors and views after a change. */
  private async refreshLibrary() {
    const open = this.open;
    if (!open) return;
    const fresh = await this.api.library(open.id);
    if (this.open?.id === open.id) this.open = fresh;
  }

  /** Uploads the files one after another into where the person is, and says how it went. */
  private async upload(files: File[]) {
    const open = this.open;
    if (!open) return;
    const folder = this.folder;
    this.uploading = files.length;
    this.note = '';
    const failed: string[] = [];
    let added = 0;
    for (const file of files) {
      try {
        await this.api.upload(open.id, file, folder, this.uploadTags);
        added++;
      } catch (err) {
        failed.push(`${file.name}: ${(err as Error).message}`);
      }
      this.uploading--;
    }
    this.note = [added ? `Added ${added} ${added === 1 ? 'document' : 'documents'}.` : '', ...failed.map((f) => `Couldn’t add ${f}`)].filter(Boolean).join(' ');
    // Someone new may have added something: the author filter should know them.
    if (added) await this.refreshLibrary().catch(() => undefined);
    await this.loadDocuments();
  }

  private rejected(files: File[]) {
    this.note = `Artifacts can’t take ${files.map((f) => f.name).join(', ')}: it takes PDF, Word (.docx), HTML, Markdown and plain text.`;
  }

  /** Opens a document on its own page to read, at a version or the newest. */
  private async read(id: string, version?: number, tell = true, library = this.open?.id) {
    if (!library) return;
    try {
      if (this.doc?.id !== id) this.doc = await this.api.document(library, id);
      this.reading = { library, document: id, ...(version ? { version } : {}) };
      if (tell) this.tell();
    } catch (err) {
      this.note = (err as Error).message;
    }
  }

  /** A series on its own page. */
  private openSeries(library: string, series: string) {
    this.reading = undefined;
    this.doc = undefined;
    this.inbox = undefined;
    this.view = undefined;
    this.note = '';
    this.run = { library, series };
    this.tell();
  }

  /** Leaves the document being read, back to where it is in its library. */
  private async stopReading() {
    this.reading = undefined;
    this.doc = undefined;
    if (this.run) return this.tell();
    if (this.inbox) return this.openInbox();
    if (this.arrived) return this.tell();
    if (!this.open) {
      // Read from "Shared with you", with no library to go back to: back to the floor's own.
      const first = this.libraries[0];
      if (first) await this.openLibrary(first.id);
      else this.tell();
      return;
    }
    this.tell();
    await this.loadDocuments();
  }

  /** A document dialog closed: the document page keeps its document, up to date; the list lets it go. */
  private async letGoOfDoc() {
    const doc = this.doc;
    if (!this.reading || !doc) {
      this.doc = undefined;
      return;
    }
    try {
      this.doc = await this.api.document(doc.library, doc.id);
    } catch (err) {
      this.note = (err as Error).message;
    }
  }

  /** How often an open document looks again while a reader copy is on its way. */
  static readerPollMs = 4000;
  private readerTimer?: ReturnType<typeof setTimeout>;

  override updated(changed: Map<string, unknown>) {
    if (changed.has('doc')) this.followReaders();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.readerTimer);
  }

  /** While the open document has a reader copy on its way, looks again now and then. */
  private followReaders() {
    clearTimeout(this.readerTimer);
    const doc = this.doc;
    if (!doc?.versions.some((v) => v.reader.state === 'queued' || v.reader.state === 'running')) return;
    this.readerTimer = setTimeout(async () => {
      if (this.doc?.id !== doc.id) return;
      try {
        const fresh = await this.api.document(doc.library, doc.id);
        if (this.doc?.id === doc.id) this.doc = fresh;
      } catch {
        // Quietly: the dialog still shows what it knew, and the next open looks again.
      }
    }, (this.constructor as typeof FolioApp).readerPollMs);
  }

  private async retryReader(version: number) {
    const doc = this.doc;
    if (!doc) return;
    try {
      await this.api.retryReader(doc.library, doc.id, version);
      this.doc = await this.api.document(doc.library, doc.id);
      this.note = `Making the reader copy of version ${version} again.`;
    } catch (err) {
      this.note = (err as Error).message;
    }
  }

  private async download(version: number) {
    const doc = this.doc;
    if (!doc) return;
    try {
      const v = doc.versions.find((x) => x.number === version)!;
      save(await this.api.original(doc.library, doc.id, version), v.filename);
    } catch (err) {
      this.note = (err as Error).message;
    }
  }

  private async newVersion(files: File[]) {
    const doc = this.doc;
    if (!doc || !files[0]) return;
    this.uploading = 1;
    try {
      await this.api.addVersion(doc.library, doc.id, files[0]);
      this.doc = await this.api.document(doc.library, doc.id);
      this.note = `Added version ${this.doc.latest.number} of ${this.doc.title}.`;
      await this.loadDocuments();
    } catch (err) {
      this.note = `Couldn’t add ${files[0].name}: ${(err as Error).message}`;
    } finally {
      this.uploading = 0;
    }
  }

  private submitEditDocument: DialogSubmit = async (values) => {
    const doc = this.doc!;
    const folder = values.folder || null;
    await this.api.updateDocument(doc.library, doc.id, { title: values.title.trim(), folder });
    await this.letGoOfDoc();
    await this.loadDocuments();
  };

  private submitDeleteDocument: DialogSubmit = async () => {
    const doc = this.doc!;
    await this.api.deleteDocument(doc.library, doc.id);
    this.doc = undefined;
    this.documents = this.documents.filter((d) => d.id !== doc.id);
    if (this.reading) await this.stopReading();
  };

  /** A new tag for the open library, from a picker's "Add …", or a word typed in the tags dialog. */
  private async addTag(name: string): Promise<Tag | undefined> {
    const open = this.open;
    if (!open) return undefined;
    try {
      const tag = await this.api.createTag(open.id, name);
      this.open = { ...open, tags: [...open.tags, tag].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })) };
      return tag;
    } catch (err) {
      this.note = (err as Error).message;
      return undefined;
    }
  }

  private async retag(tags: string[]) {
    const doc = this.doc;
    if (!doc) return;
    try {
      const tagged = await this.api.setTags(doc.library, doc.id, tags);
      this.doc = { ...doc, tags: tagged.tags };
      this.documents = this.documents.map((d) => (d.id === doc.id ? { ...d, tags: tagged.tags } : d));
    } catch (err) {
      this.note = (err as Error).message;
    }
  }

  private async openTags() {
    this.dialog = 'tags';
    try {
      const { tags, can } = await this.api.orgTags();
      this.orgTags = { tags, manage: can.manage };
    } catch {
      this.orgTags = undefined;
    }
  }

  /** Adds the word in one of the tags dialog's fields: for the library, or with `org` for the org. */
  private async addTagFrom(field: string, org = false) {
    const input = this.querySelector<UiTextField>(`ui-text-field[name="${field}"]`);
    const name = input?.value.trim();
    if (!input || !name) return;
    try {
      if (org) {
        await this.api.createTag(undefined, name);
        await this.openTags();
      } else if (!(await this.addTag(name))) {
        input.setState('error', this.note);
        this.note = '';
        return;
      }
      await this.refreshLibrary();
      input.value = '';
      input.setState('idle');
    } catch (err) {
      input.setState('error', (err as Error).message);
    }
  }

  private submitRenameTag: DialogSubmit = async (values) => {
    await this.api.renameTag(this.tagTarget!, values.name.trim());
    await this.refreshLibrary();
    if (!this.tagTarget!.library) await this.openTags();
  };

  private submitRemoveTag: DialogSubmit = async () => {
    const tag = this.tagTarget!;
    await this.api.deleteTag(tag);
    this.filters = filterValue(filtersFor({ tags: this.open!.tags.filter((t) => t.id !== tag.id), authors: this.open!.authors }), this.filters);
    this.uploadTags = this.uploadTags.filter((t) => t !== tag.id);
    await this.refreshLibrary();
    if (!tag.library) await this.openTags();
    await this.loadDocuments();
  };

  private onTagAction(e: CustomEvent<{ item: ListItem; action: { id: string } }>) {
    this.tagTarget = [...(this.open?.tags ?? []), ...(this.orgTags?.tags ?? [])].find((t) => t.id === e.detail.item.id);
    this.dialog = e.detail.action.id === 'rename' ? 'rename-tag' : 'remove-tag';
  }

  /** May the person rename or delete this view: whoever saved it, or a lead. */
  private mayChangeView(view: SavedView) {
    return Boolean(this.open?.can.manage || view.createdBy === this.userId);
  }

  private get currentView() {
    return this.open?.views.find((v) => v.id === this.view);
  }

  private submitSaveView: DialogSubmit = async (values) => {
    const open = this.open!;
    const view = await this.api.createView(open.id, values.name.trim(), queryFrom(this.filters, this.sort, this.folder));
    await this.refreshLibrary();
    this.view = view.id;
    this.tell();
  };

  private async saveViewChanges() {
    const open = this.open;
    const view = this.currentView;
    if (!open || !view) return;
    try {
      await this.api.updateView(open.id, view.id, { query: queryFrom(this.filters, this.sort, this.folder) });
      await this.refreshLibrary();
      this.note = `Saved the changes to ${view.name}.`;
    } catch (err) {
      this.note = (err as Error).message;
    }
  }

  private submitRenameView: DialogSubmit = async (values) => {
    await this.api.updateView(this.open!.id, this.view!, { name: values.name.trim() });
    await this.refreshLibrary();
  };

  private submitDeleteView: DialogSubmit = async () => {
    await this.api.deleteView(this.open!.id, this.view!);
    this.view = undefined;
    this.tell();
    await this.refreshLibrary();
  };

  /** Every folder in the open library, by where it is, for moving a document. */
  private folderOptions(): SelectOption[] {
    const open = this.open;
    if (!open) return [];
    return [
      { value: '', label: `${open.name} (the top)` },
      ...open.folders
        .map((f) => ({ value: f.id, label: folderTrail(open.folders, f.id).map((t) => t.name).join(' / ') }))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })),
    ];
  }

  /** Starts a new series in the open library. */
  private newSeries() {
    this.seriesEdit = undefined;
    this.dialog = 'new-series';
  }

  /** Opens a series' dialog, with its audience named. */
  private async editSeries(id: string, dialog: Dialog = 'edit-series') {
    try {
      this.seriesEdit = await this.api.series(id);
      this.dialog = dialog;
    } catch (err) {
      this.note = (err as Error).message;
    }
  }

  /** What a series dialog's fields say. */
  private seriesFields(values: Record<string, string>) {
    const list = (v: string | undefined) => (v ? v.split(',').filter(Boolean) : []);
    return { name: values.name.trim(), description: values.description?.trim() ?? '', cadence: values.cadence as Cadence, tags: list(values.tags), audience: list(values.audience) };
  }

  private submitNewSeries: DialogSubmit = async (values) => {
    const open = this.open!;
    const made = await this.api.createSeries(open.id, this.seriesFields(values));
    await this.refreshLibrary();
    this.openSeries(open.id, made.id);
  };

  private submitEditSeries: DialogSubmit = async (values) => {
    const run = this.seriesEdit!;
    await this.api.updateSeries(run.library, run.id, this.seriesFields(values));
    await this.refreshLibrary().catch(() => undefined);
    await this.querySelector('folio-series')?.load();
  };

  private submitDeleteSeries: DialogSubmit = async () => {
    const run = this.seriesEdit!;
    await this.api.deleteSeries(run.library, run.id);
    this.run = undefined;
    await this.refreshLibrary();
    this.tell();
    await this.loadDocuments();
  };

  /** Follows or stops following the series of the issue being read. */
  private async followFromReader(following: boolean) {
    const doc = this.doc;
    if (!doc?.run) return;
    try {
      await this.api.follow(doc.run.id, following);
      if (this.doc?.id === doc.id) this.doc = { ...doc, run: { ...doc.run, following } };
    } catch (err) {
      this.note = (err as Error).message;
    }
  }

  private tell() {
    const detail = this.reading
      ? { ...this.reading }
      : this.run
        ? { ...this.run }
      : this.inbox
        ? { published: true }
      : this.arrived
        ? { received: this.arrived.placement.id }
        : this.view
        ? { library: this.open?.id, view: this.view }
        : { library: this.open?.id, folder: this.folder };
    this.dispatchEvent(new CustomEvent('folio-place', { detail, bubbles: true }));
  }

  /** May the person rename or remove this folder: whoever made it, or a lead. */
  private mayChange(folder: Folder) {
    return Boolean(this.open?.can.manage || folder.createdBy === this.userId);
  }

  private openShare(target: { library: string; document?: string; folder?: string; name: string }) {
    this.shareTarget = target;
    this.dialog = 'share';
  }

  /** Set by the entry: who is signed in, so folders they made offer Rename and Remove. */
  userId = '';

  private submitNewLibrary: DialogSubmit = async (values) => {
    const made = await this.api.createLibrary(values.name.trim(), values.description?.trim() || undefined);
    this.libraries = [...this.libraries, made].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    await this.openLibrary(made.id);
  };

  private submitEditLibrary: DialogSubmit = async (values) => {
    const open = this.open!;
    const changed = await this.api.updateLibrary(open.id, { name: values.name.trim(), description: values.description?.trim() ?? '' });
    this.libraries = this.libraries.map((l) => (l.id === changed.id ? changed : l));
    this.open = { ...open, ...changed };
  };

  private submitArchive: DialogSubmit = async () => {
    await this.api.archiveLibrary(this.open!.id);
    this.libraries = this.libraries.filter((l) => l.id !== this.open!.id);
    this.open = undefined;
    this.folder = undefined;
    this.view = undefined;
    if (this.libraries[0]) await this.openLibrary(this.libraries[0].id);
    else this.tell();
  };

  private submitNewFolder: DialogSubmit = async (values) => {
    const open = this.open!;
    const made = await this.api.createFolder(open.id, values.name.trim(), this.folder, (values.level || undefined) as FolderLevel | undefined, values.description?.trim() || undefined);
    this.open = { ...open, folders: [...open.folders, made].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })) };
  };

  private submitRenameFolder: DialogSubmit = async (values) => {
    const open = this.open!;
    const renamed = await this.api.updateFolder(open.id, this.target!.id, { name: values.name.trim(), description: values.description?.trim() ?? '' });
    this.open = { ...open, folders: open.folders.map((f) => (f.id === renamed.id ? renamed : f)) };
  };

  private submitRemoveFolder: DialogSubmit = async () => {
    const open = this.open!;
    await this.api.deleteFolder(open.id, this.target!.id);
    this.open = { ...open, folders: open.folders.filter((f) => f.id !== this.target!.id) };
  };

  /** "Your libraries" on your own floor, "Libraries on Finance" on a team's. */
  private get shelfName() {
    return this.floorKind === 'personal' ? 'Your libraries' : this.floorName ? `Libraries on ${this.floorName}` : 'Libraries';
  }

  private rail() {
    const open = this.open;
    return html`<div slot="rail" class="folio-rail">
      <ui-tree
        label="Libraries"
        heading=${this.shelfName}
        .items=${this.libraries.map((l): TreeItem => ({ id: l.id, label: l.name, icon: 'library' }))}
        selected=${open?.id ?? ''}
        @ui-select=${(e: CustomEvent<{ item: TreeItem }>) => void this.openLibrary(e.detail.item.id)}
      ></ui-tree>
      <div class="folio-rail-act">
        ${this.canCreate ? html`<ui-button kind="ghost" size="sm" @click=${() => (this.dialog = 'new-library')}>New library</ui-button>` : nothing}
        <ui-button kind="ghost" size="sm" @click=${() => (this.dialog = 'levels')}>Level names</ui-button>
      </div>
      <ui-tree
        label="For you"
        .items=${[{ id: 'published', label: 'Published to you', icon: 'inbox' }] satisfies TreeItem[]}
        selected=${this.inbox && !this.reading ? 'published' : ''}
        @ui-select=${() => void this.openInbox()}
      ></ui-tree>
      ${this.received.here.length
        ? html`<ui-tree
            label="Published up to this floor"
            heading="From below"
            .items=${this.received.here.map((p): TreeItem => ({ id: p.id, label: p.record.name ?? 'Something', icon: p.record.kind === 'document' ? 'document' : p.record.kind === 'library' ? 'library' : 'folder' }))}
            selected=${this.arrived && !this.reading ? this.arrived.placement.id : ''}
            @ui-select=${(e: CustomEvent<{ item: TreeItem }>) => void this.openArrived(e.detail.item.id)}
          ></ui-tree>`
        : nothing}
      ${this.shared.libraries.length || this.shared.documents.length
        ? html`<ui-tree
            label="Shared with you from other floors"
            heading="Shared with you"
            .items=${[
              ...this.shared.libraries.map((l): TreeItem => ({ id: l.id, label: l.name, icon: 'library' })),
              ...this.shared.documents.map((d): TreeItem => ({ id: `${DOC}${d.library}/${d.id}`, label: d.title, icon: 'document' })),
            ]}
            selected=${this.reading && !open ? `${DOC}${this.reading.library}/${this.reading.document}` : this.shared.libraries.some((l) => l.id === open?.id) ? open!.id : ''}
            @ui-select=${(e: CustomEvent<{ item: TreeItem }>) => {
              const id = e.detail.item.id;
              if (!id.startsWith(DOC)) return void this.openLibrary(id);
              const [library, document] = id.slice(DOC.length).split('/');
              this.open = undefined;
              void this.read(document, undefined, true, library);
            }}
          ></ui-tree>`
        : nothing}
      ${open && open.folders.length
        ? html`<ui-tree
            label=${`Folders in ${open.name}`}
            heading="Folders"
            .items=${folderTree(open.folders)}
            selected=${this.view ? '' : (this.folder ?? '')}
            @ui-select=${(e: CustomEvent<{ item: TreeItem }>) => this.goToFolder(e.detail.item.id)}
          ></ui-tree>`
        : nothing}
      ${open && open.series.length
        ? html`<ui-tree
            label=${`Series in ${open.name}`}
            heading="Series"
            .items=${open.series.map((r): TreeItem => ({ id: r.id, label: r.name, icon: 'series' }))}
            selected=${this.run && !this.reading ? this.run.series : ''}
            @ui-select=${(e: CustomEvent<{ item: TreeItem }>) => this.openSeries(open.id, e.detail.item.id)}
          ></ui-tree>`
        : nothing}
      ${open && open.views.length
        ? html`<ui-tree
            label=${`Views saved in ${open.name}`}
            heading="Views"
            .items=${open.views.map((v): TreeItem => ({ id: v.id, label: v.name, icon: 'view' }))}
            selected=${this.view ?? ''}
            @ui-select=${(e: CustomEvent<{ item: TreeItem }>) => void this.openView(e.detail.item.id)}
          ></ui-tree>`
        : nothing}
    </div>`;
  }

  private main() {
    if (this.loading) return html`<ui-state kind="loading" heading="Opening your libraries…"></ui-state>`;
    if (this.error)
      return html`<ui-state kind="error" heading="Couldn’t open Artifacts" body=${this.error} action="Try again" @ui-action=${() => void this.load()}></ui-state>`;
    const open = this.open;
    if (this.reading) {
      const doc = this.doc;
      if (!doc || doc.id !== this.reading.document) return html`<ui-state kind="loading" heading="Opening the document"></ui-state>`;
      return html`<folio-reader
        .api=${this.api}
        .doc=${doc}
        .version=${this.reading.version}
        .tags=${open?.tags ?? []}
        .propose=${this.propose ? (...rest: Parameters<Propose>) => this.propose!({ id: doc.id, title: doc.title }, ...rest) : undefined}
        .pickRef=${this.pickRef}
        @folio-open-link=${(e: CustomEvent<{ link: RecordLink }>) => void this.openLink(e.detail.link)}
        library-name=${open ? [open.name, ...folderTrail(open.folders, doc.folder).map((f) => f.name)].join(' / ') : doc.libraryName}
        @folio-read=${(e: CustomEvent<{ version?: number }>) => void this.read(doc.id, e.detail.version, true, doc.library)}
        @folio-back=${() => void this.stopReading()}
        @folio-manage=${() => (this.dialog = 'document')}
        @folio-share=${() => this.openShare({ library: doc.library, document: doc.id, name: doc.title })}
        @folio-publish=${() => (this.dialog = 'publish')}
        @folio-move=${(e: CustomEvent<{ version: number; state: ContentState }>) => void this.moveVersion(e.detail.version, e.detail.state)}
        @folio-publish-up=${() => this.publishUp({ library: doc.library, kind: 'document', id: doc.id, name: doc.title })}
        @folio-issue=${(e: CustomEvent<{ library: string; document: string }>) => void this.read(e.detail.document, undefined, true, e.detail.library)}
        @folio-series=${(e: CustomEvent<{ series: string }>) => this.openSeries(doc.library, e.detail.series)}
        @folio-follow=${(e: CustomEvent<{ following: boolean }>) => void this.followFromReader(e.detail.following)}
        @folio-download=${(e: CustomEvent<{ version: number }>) => void this.download(e.detail.version)}
        @folio-retry=${(e: CustomEvent<{ version: number }>) => void this.retryReader(e.detail.version)}
      ></folio-reader>`;
    }
    if (this.run)
      return html`<div class="folio-main-inner">
        <folio-series .api=${this.api} series=${this.run.series}
          @folio-read=${(e: CustomEvent<{ library: string; document: string }>) => void this.read(e.detail.document, undefined, true, e.detail.library)}
          @folio-edit-series=${(e: CustomEvent<{ series: string }>) => void this.editSeries(e.detail.series)}
          @folio-delete-series=${(e: CustomEvent<{ series: string }>) => void this.editSeries(e.detail.series, 'delete-series')}
          @folio-issue-added=${() => void this.refreshLibrary().catch(() => undefined)}></folio-series>
      </div>`;
    if (this.inbox) return this.inboxPage(this.inbox);
    if (this.arrived) return this.arrivedPage(this.arrived);
    if (!open)
      return this.canCreate
        ? html`<ui-state kind="empty" heading="No libraries here yet" body="A library keeps documents together, with folders inside it." action="New library"
            @ui-action=${() => (this.dialog = 'new-library')}></ui-state>`
        : html`<ui-state kind="empty" heading="No libraries here yet" body="A lead on this floor can start one."></ui-state>`;
    const trail = folderTrail(open.folders, this.folder);
    const here = trail.at(-1);
    const view = this.currentView;
    const narrowed = filtering(this.filters);
    // Filtering looks in every folder below, so folders themselves leave the list.
    const folders = narrowed ? [] : open.folders.filter((f) => f.parent === this.folder);
    const inside: ListItem[] = [
      ...this.documents.map((d) => ({
        id: `${DOC}${d.id}`,
        title: d.title,
        icon: 'document',
        detail: this.rowDetail(d, narrowed),
        ...(d.state === 'published' ? { icon: 'publish' } : {}),
        meta: ago(d.updatedAt),
      })),
    ];
    const where = here?.name ?? open.name;
    const changedView = view && !sameQuery(view.query, queryFrom(this.filters, this.sort, this.folder));
    const tagOpts = tagOptions(open.tags);
    const actions = this.libraryActions(open, view, here);
    return html`<div class="folio-main-inner">
      <ui-page-head
        .trail=${here && !view ? [{ id: '', label: open.name }, ...trail.slice(0, -1).map((f) => ({ id: f.id, label: f.name }))] : []}
        eyebrow=${view ? `A view in ${open.name}` : here ? `${this.levelName(here.level)} in ${trail.at(-2)?.name ?? open.name}` : this.shelfName}
        heading=${view?.name ?? here?.name ?? open.name}
        summary=${view ? (here ? `In ${trail.map((f) => f.name).join(' / ')}` : '') : [here ? here.description : open.description, closedWords(stateOf(here, open))].filter(Boolean).join(' ')}
        .actions=${actions}
        @ui-trail=${(e: CustomEvent<{ step: { id: string } }>) => this.goToFolder(e.detail.step.id || undefined)}
        @ui-action=${(e: CustomEvent<{ action: { id: string } }>) => actions.find((a) => a.id === e.detail.action.id)?.run()}
      ></ui-page-head>
      <ui-filter-bar
        label=${`Filter what’s in ${where}`}
        .filters=${filtersFor(open)}
        .value=${this.filters}
        .sorts=${SORTS}
        sort=${this.sort}
        .count=${this.total}
        .noun=${['document', 'documents']}
        @ui-change=${this.refilter}
      >
        ${changedView && this.mayChangeView(view)
          ? html`<ui-button slot="actions" kind="secondary" size="sm" @click=${() => void this.saveViewChanges()}>Save changes</ui-button>`
          : nothing}
        ${(narrowed || this.sort !== 'title') && (!view || changedView)
          ? html`<ui-button slot="actions" kind="ghost" size="sm" @click=${() => (this.dialog = 'save-view')}>${view ? 'Save as new view' : 'Save view'}</ui-button>`
          : nothing}
      </ui-filter-bar>
      ${folders.length ? this.folderCards(folders) : nothing}
      <ui-surface>
        <ui-list
          label=${narrowed ? `Matching in ${where}` : `${this.levelName('file', true)} in ${where}`}
          density="compact"
          .noun=${['document', 'documents']}
          .items=${inside}
          empty=${narrowed ? `Nothing in ${where} matches these filters.` : folders.length ? `No ${this.levelName('file', true).toLowerCase()} here yet: open one of the places above, or add some.` : here ? `This ${this.levelName(here.level).toLowerCase()} is empty.` : 'This library is empty.'}
          @ui-open=${(e: CustomEvent<{ item: ListItem }>) => {
            const id = e.detail.item.id;
            void (id.startsWith(DOC) ? this.read(id.slice(DOC.length)) : this.goToFolder(id));
          }}
        ></ui-list>
      </ui-surface>
      ${this.documents.length < this.total
        ? html`<div class="folio-more"><ui-button kind="ghost" size="sm" ?busy=${this.more} busy-label="Loading…" @click=${() => void this.loadDocuments(true)}>
            Show ${Math.min(PAGE, this.total - this.documents.length)} more of ${this.total}
          </ui-button></div>`
        : nothing}
      ${open.can.addDocuments && !view
        ? html`<div class="folio-add">
            <ui-tag-picker
              label="Tags for what you add"
              optional
              placeholder="None"
              .options=${tagOpts}
              .values=${this.uploadTags}
              ?creatable=${open.can.addTags}
              @ui-change=${(e: CustomEvent<{ values: string[] }>) => (this.uploadTags = e.detail.values)}
              @ui-create=${async (e: CustomEvent<{ name: string }>) => {
                const tag = await this.addTag(e.detail.name);
                if (tag) this.uploadTags = [...this.uploadTags, tag.id];
              }}
            ></ui-tag-picker>
            <ui-drop-zone
              heading=${`Drop files to add them to ${where}`}
              hint=${`PDF, Word, HTML, Markdown or text, up to ${MAX_UPLOAD_MB} MB each`}
              action="Choose files"
              accept=${ACCEPT}
              multiple
              ?busy=${this.uploading > 0}
              @ui-files=${(e: CustomEvent<{ files: File[] }>) => void this.upload(e.detail.files)}
              @ui-reject=${(e: CustomEvent<{ files: File[] }>) => this.rejected(e.detail.files)}
            ></ui-drop-zone>
          </div>`
        : nothing}
      <ui-note live>${this.uploading ? `Adding ${this.uploading} ${this.uploading === 1 ? 'file' : 'files'}…` : this.note}</ui-note>
    </div>`;
  }

  /** "Version 3 · PDF · 1.2 MB · Policy, Travel", with the folder first when the list spans several. */
  private rowDetail(d: FolioDocument, spanning: boolean) {
    const open = this.open!;
    const names = d.tags.map((t) => open.tags.find((x) => x.id === t)?.name).filter(Boolean);
    const folder = spanning ? folderTrail(open.folders, d.folder).map((f) => f.name).join(' / ') : '';
    const run = d.issue && open.series.find((r) => r.id === d.issue!.series);
    const issue = d.issue && run ? `${run.name}, ${d.issue.period.startsWith('Issue') ? d.issue.period.toLowerCase() : d.issue.period}` : '';
    return [lifecycleWords(d), stateWords(d), issue, folder, documentLine(d), names.join(', ')].filter(Boolean).join(' · ');
  }

  /** What the org calls a level: "Series", or with `plural` "Files". */
  private levelName(id: LevelInfo['id'], plural = false) {
    // A folder from before levels is a subcollection.
    const level = this.levels.find((l) => l.id === id) ?? DEFAULT_LEVELS.find((l) => l.id === id) ?? DEFAULT_LEVELS[1];
    return plural ? level.plural : level.name;
  }

  /** The places inside where the person is, as cards: what each is, what it's for, and anything that changes what you'd do. */
  private folderCards(folders: readonly Folder[]) {
    const open = this.open!;
    return html`<ui-cards role="list" aria-label=${`Inside ${folderTrail(open.folders, this.folder).at(-1)?.name ?? open.name}`}>
      ${folders.map((f) => {
        const inside = open.folders.filter((c) => c.parent === f.id).length;
        return html`<ui-card role="listitem" heading=${f.name} icon=${f.level === 'series' || f.level === 'subseries' ? 'series' : 'folder'}
          .meta=${[this.levelName(f.level), inside ? `${inside} inside` : '', `Changed ${ago(f.updatedAt)}`].filter(Boolean)}
          note=${closedWords(stateOf(f)) || f.description}
          note-tone=${stateOf(f) !== 'open' ? 'warning' : 'ink'}
          @ui-open=${() => void this.goToFolder(f.id)}></ui-card>`;
      })}
    </ui-cards>`;
  }

  /** Something published up to this floor: what it lets through, from where, and what's inside it. */
  private arrivedPage(arrived: ReceivedPage) {
    const p = arrived.placement;
    const trail = folderTrail(arrived.folders, arrived.folder ?? undefined).filter((f) => f.id !== p.record.id);
    const folders = arrived.folders.filter((f) => (f.parent ?? null) === arrived.folder && f.id !== p.record.id);
    const rows: ListItem[] = arrived.documents.map((d) => ({
      id: `${DOC}${d.library}/${d.id}`,
      title: d.title,
      icon: 'document',
      detail: [`Version ${d.latest.number}`, stateName(d.latest.state), d.onlyVia ? `Shown here only: ${floorWords(d.onlyVia)} doesn’t show it` : ''].filter(Boolean).join(' · '),
      meta: ago(d.latest.createdAt),
    }));
    const below = [...new Set(Object.values(arrived.states).filter((f) => f && f.id !== p.to).map((f) => floorWords(f)))];
    return html`<div class="folio-main-inner">
      <ui-page-head
        .trail=${trail.length ? [{ id: '', label: p.record.name ?? '' }, ...trail.slice(0, -1).map((f) => ({ id: f.id, label: f.name }))] : []}
        eyebrow=${`From ${floorWords(p.fromFloor)}`}
        heading=${trail.at(-1)?.name ?? p.record.name ?? 'Published up to here'}
        summary=${[`Showing ${filterWords(p.filter).toLowerCase()}.`, p.note ? `“${p.note}”` : '', below.length ? `Some versions show here only because ${below.join(' and ')} shows them.` : '', p.landed ? '' : 'It sits under From below until a lead here gives it a place.'].filter(Boolean).join(' ')}
        @ui-trail=${(e: CustomEvent<{ step: { id: string } }>) => void this.openArrived(p.id, e.detail.step.id || undefined)}
      ></ui-page-head>
      ${folders.length
        ? html`<ui-cards role="list" aria-label="Inside it">
            ${folders.map((f) => html`<ui-card role="listitem" heading=${f.name} icon="folder" .meta=${[this.levelName(f.level)]} note=${f.description} note-tone="ink"
              @ui-open=${() => void this.openArrived(p.id, f.id)}></ui-card>`)}
          </ui-cards>`
        : nothing}
      <ui-surface>
        <ui-list label=${`In ${p.record.name ?? 'it'}`} density="compact" .noun=${['document', 'documents']} .items=${rows}
          empty="Nothing here is in a state it lets through yet. It shows as soon as something is."
          @ui-open=${(e: CustomEvent<{ item: ListItem }>) => {
            const [library, document] = e.detail.item.id.slice(DOC.length).split('/');
            void this.read(document, undefined, true, library);
          }}></ui-list>
      </ui-surface>
      ${this.received.signposts.length
        ? html`<p class="folio-note">${this.received.signposts.map((sp) => `${sp.record.name ?? 'Something'} went on up: you see it on ${floorWords(sp.to)}.`).join(' ')}</p>`
        : nothing}
      <ui-note live>${this.note}</ui-note>
    </div>`;
  }

  /** Opens the publish-up dialog for a library, one of its folders, or a document. */
  private publishUp(target: NonNullable<FolioApp['upTarget']>) {
    this.upTarget = target;
    this.dialog = 'publish-up';
  }

  /** Opens the other end of a link: a record here, or a thing or intent in the app that keeps it. */
  private async openLink(link: RecordLink) {
    const end = link.to ?? link.from;
    if (!end || 'unavailable' in end) return;
    if ('app' in end && end.app !== 'folio') {
      try {
        await this.openRef?.(end);
      } catch (err) {
        this.note = (err as Error).message;
      }
      return;
    }
    const at = 'app' in end ? { library: end.library, record: end.record, kind: end.unitKind } : { library: end.library, record: end.record, kind: end.kind };
    if (!at.library || !at.record) return;
    if (at.kind === 'document') await this.read(at.record, undefined, true, at.library);
    else await this.openLibrary(at.library, at.kind === 'folder' ? at.record : undefined);
  }

  /** A folder's own tags, which count for everything inside it when filtering: changed by whoever may change the folder. */
  private folderTags(open: OpenLibrary, folder: Folder) {
    const tags = folder.tags ?? [];
    if (!this.mayChange(folder))
      return tags.length
        ? html`<div class="folio-tags" aria-label="Tags">${tags.map((t) => {
            const tag = open.tags.find((x) => x.id === t);
            return tag ? html`<ui-tag quiet label=${tag.name} icon=${tag.library ? '' : 'org'}></ui-tag>` : nothing;
          })}</div>`
        : nothing;
    return html`<ui-tag-picker label="Tags" placeholder="Add a tag" hint="They count for everything inside it when you filter." .options=${tagOptions(open.tags)} .values=${tags}
      ?creatable=${open.can.addTags}
      @ui-change=${(e: CustomEvent<{ values: string[] }>) => void this.retagFolder(folder, e.detail.values)}
      @ui-create=${async (e: CustomEvent<{ name: string }>) => {
        const tag = await this.addTag(e.detail.name);
        if (tag) await this.retagFolder(folder, [...tags, tag.id]);
      }}></ui-tag-picker>`;
  }

  private async retagFolder(folder: Folder, tags: string[]) {
    const open = this.open;
    if (!open) return;
    try {
      const tagged = await this.api.setFolderTags(open.id, folder.id, tags);
      this.open = { ...open, folders: open.folders.map((f) => (f.id === folder.id ? { ...f, tags: tagged.tags ?? tags } : f)) };
    } catch (err) {
      this.note = (err as Error).message;
    }
  }

  /** Opens the details of the library or folder on screen, with its lifecycle moves. */
  private async openDetails() {
    const open = this.open;
    if (!open) return;
    this.moves = undefined;
    this.dialog = 'details';
    try {
      this.moves = (await this.api.moves(open.id, this.folder ? { folder: this.folder } : {})).moves;
    } catch {
      this.moves = [];
    }
  }

  /** Moves the library, or the folder on screen, to another state of its lifecycle. */
  private async moveContainer(state: ContainerState) {
    const open = this.open;
    if (!open) return;
    try {
      await this.api.setState(open.id, state, this.folder);
      if (state === 'archived' && !this.folder) {
        this.dialog = undefined;
        this.libraries = this.libraries.filter((l) => l.id !== open.id);
        this.open = undefined;
        if (this.libraries[0]) await this.openLibrary(this.libraries[0].id);
        else this.tell();
        return;
      }
      await this.refreshLibrary();
      await this.openDetails();
    } catch (err) {
      this.note = (err as Error).message;
    }
  }

  /** Moves a version of the document being read through its lifecycle. */
  private async moveVersion(version: number, state: ContentState) {
    const doc = this.doc;
    if (!doc) return;
    try {
      await this.api.setVersionState(doc.library, doc.id, version, state);
      this.doc = await this.api.document(doc.library, doc.id);
    } catch (err) {
      this.note = (err as Error).message;
    }
  }

  /** What's out to the person now, from any floor: each opens at the version that's out. */
  /** What can be done with the library, folder or view on screen: two show, the rest go in ⋯. */
  private libraryActions(open: OpenLibrary, view: SavedView | undefined, here: unknown) {
    const acts: (PageAction & { run: () => void })[] = [];
    const add = (id: string, label: string, kind: ButtonKind, run: () => void) => acts.push({ id, label, kind, run });
    if (view && this.mayChangeView(view)) {
      add('rename-view', 'Rename view', 'secondary', () => (this.dialog = 'rename-view'));
      add('delete-view', 'Delete view', 'ghost', () => (this.dialog = 'delete-view'));
      return acts;
    }
    const place = here as Folder | undefined;
    const next = levelsInside(this.levels, place?.level ?? 'collection');
    if (open.can.addFolders && !view && next.length && stateOf(place, open) === 'open') add('new-folder', `New ${next[0].name.toLowerCase()}`, 'secondary', () => (this.dialog = 'new-folder'));
    if (!view) add('details', 'Details', 'ghost', () => void this.openDetails());
    if (!view && open.can.manage) add('publish-up', 'Publish up', 'ghost', () => this.publishUp({ library: open.id, kind: place ? 'folder' : 'library', id: place?.id ?? open.id, name: place?.name ?? open.name }));
    if (place && !view && this.mayChange(place)) {
      add('rename-folder', 'Rename', 'ghost', () => {
        this.target = place;
        this.dialog = 'rename-folder';
      });
      add('remove-folder', 'Remove', 'ghost', () => {
        this.target = place;
        this.dialog = 'remove-folder';
      });
    }
    add('share', open.can.share ? 'Share' : 'Who can see it', 'ghost', () => this.openShare(place ? { library: open.id, folder: place.id, name: place.name } : { library: open.id, name: open.name }));
    add('tags', 'Tags', 'ghost', () => void this.openTags());
    if (open.can.manage && !here && !view) add('new-series', 'New series', 'ghost', () => this.newSeries());
    if (open.can.manage && !here) {
      add('rename', 'Rename', 'ghost', () => (this.dialog = 'edit-library'));
      add('archive', 'Archive', 'ghost', () => (this.dialog = 'archive-library'));
    }
    return acts;
  }

  private inboxPage(inbox: PublishedPage) {
    const rows: ListItem[] = inbox.documents.map((d) => ({
      id: `${DOC}${d.library}/${d.id}/${d.published.version}`,
      title: d.title,
      icon: 'publish',
      detail: [`In ${d.libraryName}`, `Version ${d.published.version}`, d.published.note].filter(Boolean).join(' · '),
      meta: ago(d.published.publishedAt),
    }));
    return html`<div class="folio-main-inner">
      <ui-page-head eyebrow="For you" heading="Published to you" summary="Put out to you, or to a team you’re on, from any floor. The newest first."></ui-page-head>
      <ui-surface>
        <ui-list label="Published to you" density="compact" .noun=${['document', 'documents']} .items=${rows}
          empty="Nothing has been published to you yet. When a team you’re on is sent something, it shows here."
          @ui-open=${(e: CustomEvent<{ item: ListItem }>) => {
            const [library, document, version] = e.detail.item.id.slice(DOC.length).split('/');
            const doc = inbox.documents.find((d) => d.id === document);
            // The version that's out is the newest they can read: open it as the newest.
            void this.read(document, doc && doc.latest.number !== Number(version) ? Number(version) : undefined, true, library);
          }}></ui-list>
      </ui-surface>
      <ui-note live>${this.note}</ui-note>
    </div>`;
  }

  private dialogs() {
    const open = this.open;
    const close = () => {
      this.dialog = undefined;
      this.target = undefined;
    };
    const siblings = (except?: string) => (open?.folders ?? []).filter((f) => f.parent === (this.target ? this.target.parent : this.folder) && f.id !== except).map((f) => f.name);
    switch (this.dialog) {
      case 'levels':
        return html`<ui-dialog open eyebrow="Artifacts" heading="Level names" cancel-label="Done" @ui-close=${close}>
          <folio-levels .api=${this.api} @folio-levels=${(e: CustomEvent<{ levels: LevelInfo[] }>) => (this.levels = e.detail.levels)}></folio-levels>
        </ui-dialog>`;
      case 'new-library':
        return html`<ui-dialog open eyebrow=${this.floorName || 'Artifacts'} heading="New library" summary=${this.floorKind === 'personal' ? 'Only you can see it.' : 'Everyone on this floor can see it and add folders; its leads look after it.'}
          action-label="Make it" busy-label="Making…" .submit=${this.submitNewLibrary} @ui-close=${close}>
          <ui-text-field slot="fields" name="name" label="Name" required maxlength="80" .validate=${nameCheck(this.libraries.map((l) => l.name), 'library')}></ui-text-field>
          <ui-text-field slot="fields" name="description" label="What it’s for" optional multiline maxlength="500"></ui-text-field>
        </ui-dialog>`;
      case 'edit-library':
        return open
          ? html`<ui-dialog open eyebrow="Library" heading=${`Rename ${open.name}`} action-label="Save" busy-label="Saving…" .submit=${this.submitEditLibrary} @ui-close=${close}>
              <ui-text-field slot="fields" name="name" label="Name" required maxlength="80" .value=${open.name}
                .validate=${nameCheck(this.libraries.filter((l) => l.id !== open.id).map((l) => l.name), 'library')}></ui-text-field>
              <ui-text-field slot="fields" name="description" label="What it’s for" optional multiline maxlength="500" .value=${open.description}></ui-text-field>
            </ui-dialog>`
          : nothing;
      case 'archive-library':
        return open
          ? html`<ui-dialog open danger eyebrow="Library" heading=${`Archive ${open.name}?`} action-label="Archive" busy-label="Archiving…" .submit=${this.submitArchive} @ui-close=${close}>
              <p>It leaves this floor’s list. Nothing in it is deleted.</p>
            </ui-dialog>`
          : nothing;
      case 'new-folder':
        return open
          ? (() => {
              const at = folderTrail(open.folders, this.folder).at(-1);
              const next = levelsInside(this.levels, at?.level ?? 'collection');
              const options: SelectOption[] = next.map((l) => ({ value: l.id, label: l.name, detail: `Holds ${l.holds.map((h) => this.levelName(h, true).toLowerCase()).join(' and ')}` }));
              return html`<ui-dialog open eyebrow=${at?.name ?? open.name} heading=${`New ${next[0]?.name.toLowerCase() ?? 'folder'}`}
                summary="Each level holds the ones below it, never the ones above: collection, subcollection, series, subseries, then files."
                action-label="Make it" busy-label="Making…" .submit=${this.submitNewFolder} @ui-close=${close}>
                ${next.length > 1 ? html`<ui-select slot="fields" name="level" label="What it is" .options=${options} .value=${next[0].id}></ui-select>` : nothing}
                <ui-text-field slot="fields" name="name" label="Name" required maxlength="80" .validate=${nameCheck(siblings(), 'folder', false)}></ui-text-field>
                <ui-text-field slot="fields" name="description" label="What it’s for" optional multiline maxlength="500"></ui-text-field>
              </ui-dialog>`;
            })()
          : nothing;
      case 'rename-folder':
        return this.target
          ? html`<ui-dialog open eyebrow=${this.levelName(this.target.level)} heading=${`Rename ${this.target.name}`} action-label="Save" busy-label="Saving…" .submit=${this.submitRenameFolder} @ui-close=${close}>
              <ui-text-field slot="fields" name="name" label="Name" required maxlength="80" .value=${this.target.name} .validate=${nameCheck(siblings(this.target.id), 'folder', false)}></ui-text-field>
              <ui-text-field slot="fields" name="description" label="What it’s for" optional multiline maxlength="500" .value=${this.target.description}></ui-text-field>
            </ui-dialog>`
          : nothing;
      case 'remove-folder':
        return this.target
          ? html`<ui-dialog open danger eyebrow="Folder" heading=${`Remove ${this.target.name}?`} action-label="Remove" busy-label="Removing…" .submit=${this.submitRemoveFolder} @ui-close=${close}>
              <p>Only an empty folder can be removed.</p>
            </ui-dialog>`
          : nothing;
      case 'document': {
        const doc = this.doc;
        if (!doc) return nothing;
        const versions: ListItem[] = doc.versions.map((v) => ({
          id: String(v.number),
          title: `Version ${v.number}`,
          icon: 'document',
          detail: `${v.filename} · ${sizeWords(v.size)} · ${readerWords(v.reader)}`,
          meta: ago(v.createdAt),
          actions: [{ id: 'download', label: 'Download' }, ...(v.reader.state === 'failed' && doc.can.change ? [{ id: 'retry', label: 'Try again' }] : [])],
        }));
        return html`<ui-dialog open size="read" light eyebrow=${folderTrail(open?.folders ?? [], doc.folder).at(-1)?.name ?? open?.name ?? 'Document'}
          heading=${doc.title} summary=${documentLine(doc)} cancel-label="Close" @ui-close=${() => {
            close();
            void this.letGoOfDoc();
          }}>
          ${doc.can.change
            ? html`<ui-tag-picker label="Tags" placeholder="Add a tag" .options=${tagOptions(open?.tags ?? [])} .values=${doc.tags} ?creatable=${Boolean(open?.can.addTags)}
                @ui-change=${(e: CustomEvent<{ values: string[] }>) => void this.retag(e.detail.values)}
                @ui-create=${async (e: CustomEvent<{ name: string }>) => {
                  const tag = await this.addTag(e.detail.name);
                  if (tag) await this.retag([...doc.tags, tag.id]);
                }}></ui-tag-picker>`
            : doc.tags.length
              ? html`<div class="folio-tags" aria-label="Tags">${doc.tags.map((t) => {
                  const tag = open?.tags.find((x) => x.id === t);
                  return tag ? html`<ui-tag quiet label=${tag.name} icon=${tag.library ? '' : 'org'}></ui-tag>` : nothing;
                })}</div>`
              : nothing}
          <ui-list label="Versions" density="compact" .noun=${['version', 'versions']} .items=${versions}
            @ui-action=${(e: CustomEvent<{ item: ListItem; action: { id: string } }>) =>
              void (e.detail.action.id === 'retry' ? this.retryReader(Number(e.detail.item.id)) : this.download(Number(e.detail.item.id)))}></ui-list>
          ${doc.versions
            .filter((v) => v.reader.state === 'failed')
            .map((v) => html`<p class="folio-note">Version ${v.number} has no reader copy. ${v.reader.error ?? 'Artifacts couldn’t make one.'}</p>`)}
          ${doc.can.change
            ? html`<ui-drop-zone compact heading="Drop the next version here: it becomes the newest" action="Choose a file" accept=${ACCEPT}
                  .multiple=${false} ?busy=${this.uploading > 0} @ui-files=${(e: CustomEvent<{ files: File[] }>) => void this.newVersion(e.detail.files)}
                  @ui-reject=${(e: CustomEvent<{ files: File[] }>) => this.rejected(e.detail.files)}></ui-drop-zone>
                <ui-note live>${this.uploading ? 'Adding the new version…' : this.note}</ui-note>
                <div class="folio-actions">
                  <ui-button kind="secondary" size="sm" @click=${() => (this.dialog = 'edit-document')}>Rename or move</ui-button>
                  <ui-button kind="ghost" size="sm" @click=${() => (this.dialog = 'delete-document')}>Delete</ui-button>
                </div>`
            : nothing}
        </ui-dialog>`;
      }
      case 'share': {
        const target = this.shareTarget;
        if (!target) return nothing;
        const folderNames = new Map(open?.id === target.library ? open.folders.map((f) => [f.id, f.name]) : []);
        return html`<ui-dialog open eyebrow=${target.document ? 'Document' : target.folder ? this.levelName(open?.folders.find((f) => f.id === target.folder)?.level ?? DEFAULT_LEVELS[1].id) : 'Library'} heading=${`Who can see ${target.name}`} cancel-label="Done"
          @ui-close=${() => {
            close();
            this.shareTarget = undefined;
          }}>
          <folio-share .api=${this.api} .explain=${this.explain} .folderNames=${folderNames} name=${target.name} me=${this.userId} library=${target.library}
            document=${target.document ?? nothing} folder=${target.folder ?? nothing}></folio-share>
        </ui-dialog>`;
      }
      case 'details': {
        if (!open) return nothing;
        const here = folderTrail(open.folders, this.folder).at(-1);
        const state = stateOf(here, open);
        const inside = open.folders.filter((f) => f.parent === here?.id).length;
        return html`<ui-dialog open eyebrow=${here ? this.levelName(here.level) : this.levelName('collection')} heading=${here?.name ?? open.name} cancel-label="Close"
          @ui-close=${() => {
            close();
            this.moves = undefined;
          }}>
          <ui-details .items=${[
            { label: 'What it is', value: here ? this.levelName(here.level) : this.levelName('collection') },
            { label: 'What it’s for', value: (here ? here.description : open.description) || undefined },
            { label: 'State', value: closedWords(state) || `Open: ${CONTAINER_LIFECYCLE.get('open').meaning}` },
            { label: 'Inside it', value: inside ? `${inside} ${inside === 1 ? 'place' : 'places'}` : undefined },
            { label: 'Made', value: ago(here?.createdAt ?? open.createdAt) },
            { label: 'Last changed', value: ago(here?.updatedAt ?? open.updatedAt) },
            { label: 'Kept on', value: this.floorName || undefined },
          ]} missing="Not given"></ui-details>
          ${here ? this.folderTags(open, here) : nothing}
          <ui-lifecycle label=${here?.name ?? open.name} .states=${CONTAINER_STATES} state=${state}
            .moves=${CONTAINER_LIFECYCLE.movesFrom(state, open.can.manage ? 'manage' : undefined)}
            why="Only whoever manages the library can close or archive it."
            @ui-move=${(e: CustomEvent<{ state: ContainerState }>) => void this.moveContainer(e.detail.state)}></ui-lifecycle>
          <section class="folio-details-links" aria-label="Links">
            <h3 class="label">Links</h3>
            <folio-links .api=${this.api} library=${open.id} .record=${{ kind: here ? 'folder' : 'library', id: here?.id ?? open.id, name: here?.name ?? open.name }}
              .pickRef=${this.pickRef}
              @folio-open-link=${(e: CustomEvent<{ link: RecordLink }>) => {
                close();
                void this.openLink(e.detail.link);
              }}></folio-links>
          </section>
          ${this.moves?.length
            ? html`<ui-list label="Its lifecycle so far" density="compact" .noun=${['move', 'moves']}
                .items=${this.moves.map((m): ListItem => ({ id: m.id, title: `${stateName(m.from)} to ${stateName(m.to)}`, detail: m.note ?? '', meta: ago(m.at) }))}></ui-list>`
            : nothing}
        </ui-dialog>`;
      }
      case 'publish-up': {
        const target = this.upTarget;
        if (!target) return nothing;
        return html`<ui-dialog open size="read" light eyebrow="Publish up" heading=${target.name}
          summary="Put it on a floor above, showing only versions in the states you choose. It stays a live window: what reaches those states shows there."
          cancel-label="Done" @ui-close=${() => {
            close();
            this.upTarget = undefined;
          }}>
          <folio-publish-up .api=${this.api} library=${target.library} here=${this.floorKey} .record=${{ kind: target.kind, id: target.id, name: target.name }}
            @folio-placed=${() => void this.api.received().then((r) => (this.received = r)).catch(() => undefined)}></folio-publish-up>
        </ui-dialog>`;
      }
      case 'publish': {
        const doc = this.doc;
        if (!doc) return nothing;
        return html`<ui-dialog open size="read" light eyebrow="Publish" heading=${doc.title} summary="Put a version out to teams or the whole org, or take it back."
          cancel-label="Done" @ui-close=${() => {
            close();
            void this.letGoOfDoc();
          }}>
          <folio-publish .api=${this.api} library=${doc.library} document=${doc.id} ?issue=${Boolean(doc.issue)} .versions=${doc.versions.map((v) => v.number)}
            @folio-published=${() => void this.loadDocuments()}></folio-publish>
        </ui-dialog>`;
      }
      case 'new-series':
      case 'edit-series': {
        if (!open && this.dialog === 'new-series') return nothing;
        const run = this.dialog === 'edit-series' ? this.seriesEdit : undefined;
        if (this.dialog === 'edit-series' && !run) return nothing;
        const taken = (open?.series ?? []).filter((r) => r.id !== run?.id).map((r) => r.name);
        const chosen: Chosen[] = run ? run.audience.map((p) => ({ principal: p.principal, name: whoWords(p) })) : [];
        return html`<ui-dialog open eyebrow=${run ? 'Series' : (open?.name ?? 'Series')} heading=${run ? `Change ${run.name}` : 'New series'}
          summary="A run of documents that comes out on a cadence, such as a weekly report. Each new issue takes its name, tags and audience from here."
          action-label=${run ? 'Save' : 'Make it'} busy-label=${run ? 'Saving…' : 'Making…'} .submit=${run ? this.submitEditSeries : this.submitNewSeries}
          @ui-close=${() => {
            this.dialog = undefined;
            this.seriesEdit = undefined;
          }}>
          <ui-text-field slot="fields" name="name" label="Name" required maxlength="80" .value=${run?.name ?? ''} .validate=${nameCheck(taken, 'series')}></ui-text-field>
          <ui-text-field slot="fields" name="description" label="What it’s for" optional multiline maxlength="500" .value=${run?.description ?? ''}></ui-text-field>
          <ui-select slot="fields" name="cadence" label="Comes out" .options=${CADENCE_OPTIONS} .value=${run?.cadence ?? 'weekly'}
            hint="Weekly, monthly and quarterly issues each have a period, and its owner is reminded when one is late."></ui-select>
          <ui-tag-picker slot="fields" name="tags" label="Tags each issue starts with" optional placeholder="None" .options=${tagOptions(open?.tags ?? [])} .values=${run?.tags ?? []}></ui-tag-picker>
          <folio-audience slot="fields" name="audience" label="Who each issue goes to" .api=${this.api} .chosen=${chosen} ?org=${this.publisher}
            empty="No one: issues stay drafts until someone publishes them."></folio-audience>
        </ui-dialog>`;
      }
      case 'delete-series':
        return this.seriesEdit
          ? html`<ui-dialog open danger eyebrow="Series" heading=${`Remove ${this.seriesEdit.name}?`} action-label="Remove" busy-label="Removing…" .submit=${this.submitDeleteSeries}
              @ui-close=${() => {
                this.dialog = undefined;
                this.seriesEdit = undefined;
              }}>
              <p>It has no issues, so nothing else changes. Anyone following it stops being told.</p>
            </ui-dialog>`
          : nothing;
      case 'edit-document':
        return this.doc
          ? html`<ui-dialog open eyebrow="Document" heading=${`Rename or move ${this.doc.title}`} action-label="Save" busy-label="Saving…" .submit=${this.submitEditDocument}
              @ui-close=${() => {
                close();
                void this.letGoOfDoc();
              }}>
              <ui-text-field slot="fields" name="title" label="Title" required maxlength="200" .value=${this.doc.title}></ui-text-field>
              <ui-select slot="fields" name="folder" label="Folder" .options=${this.folderOptions()} .value=${this.doc.folder ?? ''}></ui-select>
            </ui-dialog>`
          : nothing;
      case 'delete-document':
        return this.doc
          ? html`<ui-dialog open danger eyebrow="Document" heading=${`Delete ${this.doc.title}?`} action-label="Delete" busy-label="Deleting…" .submit=${this.submitDeleteDocument}
              @ui-close=${() => {
                close();
                void this.letGoOfDoc();
              }}>
              <p>It leaves this library, with all ${this.doc.versions.length} ${this.doc.versions.length === 1 ? 'version' : 'versions'}. The record of it stays in the audit log.</p>
            </ui-dialog>`
          : nothing;
      case 'tags': {
        if (!open) return nothing;
        const own = open.tags.filter((t) => t.library);
        const org = this.orgTags?.tags ?? open.tags.filter((t) => !t.library);
        const tagRows = (tags: Tag[], editable: boolean): ListItem[] =>
          tags.map((t) => ({ id: t.id, title: t.name, icon: t.library ? 'tag' : 'org', ...(editable ? { actions: [{ id: 'rename', label: 'Rename' }, { id: 'remove', label: 'Remove' }] } : {}) }));
        return html`<ui-dialog open size="read" light eyebrow=${open.name} heading="Tags"
          summary="Documents are found by their tags. The org’s tags are shared by every library; this library’s are its own."
          cancel-label="Done" @ui-close=${close}>
          <ui-list label=${`${open.name}’s tags`} density="compact" .noun=${['tag', 'tags']} .items=${tagRows(own, open.can.manage)}
            empty="This library has no tags of its own yet." @ui-action=${this.onTagAction}></ui-list>
          ${open.can.addTags
            ? html`<div class="folio-add-tag">
                <ui-text-field name="new-tag" label="New tag" maxlength="40" .validate=${nameCheck(open.tags.map((t) => t.name), 'tag', true, 40)}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    void this.addTagFrom('new-tag');
                  }}></ui-text-field>
                <ui-button kind="secondary" size="sm" @click=${() => void this.addTagFrom('new-tag')}>Add</ui-button>
              </div>`
            : nothing}
          ${open.can.manage
            ? html`<ui-toggle label="Anyone here can add tags" hint="Otherwise only the floor’s leads add them; everyone can still tag with the ones there are."
                ?checked=${open.freeTags}
                .change=${async (on: boolean) => {
                  await this.api.updateLibrary(open.id, { freeTags: on });
                  await this.refreshLibrary();
                }}></ui-toggle>`
            : nothing}
          <ui-list label="The org’s tags" density="compact" .noun=${['org tag', 'org tags']} .items=${tagRows(org, Boolean(this.orgTags?.manage))}
            empty=${this.orgTags?.manage ? 'The org has no tags yet.' : 'The org has no tags yet. Its leads add them, on the org’s floor.'} @ui-action=${this.onTagAction}></ui-list>
          ${this.orgTags?.manage
            ? html`<div class="folio-add-tag">
                <ui-text-field name="new-org-tag" label="New org tag" maxlength="40" .validate=${nameCheck(org.map((t) => t.name), 'tag', true, 40)}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    void this.addTagFrom('new-org-tag', true);
                  }}></ui-text-field>
                <ui-button kind="secondary" size="sm" @click=${() => void this.addTagFrom('new-org-tag', true)}>Add</ui-button>
              </div>`
            : nothing}
        </ui-dialog>`;
      }
      case 'rename-tag': {
        const tag = this.tagTarget;
        if (!tag) return nothing;
        const same = (tag.library ? open?.tags.filter((t) => t.library === tag.library || !t.library) : this.orgTags?.tags) ?? [];
        return html`<ui-dialog open eyebrow=${tag.library ? 'Tag' : 'Org tag'} heading=${`Rename ${tag.name}`} action-label="Save" busy-label="Saving…"
          summary=${tag.library ? 'Every document with it keeps it.' : 'Every document with it keeps it, in every library.'}
          .submit=${this.submitRenameTag} @ui-close=${() => (this.dialog = 'tags')}>
          <ui-text-field slot="fields" name="name" label="Name" required maxlength="40" .value=${tag.name}
            .validate=${nameCheck(same.filter((t) => t.id !== tag.id && (!tag.library || t.library)).map((t) => t.name), 'tag', true, 40)}></ui-text-field>
        </ui-dialog>`;
      }
      case 'remove-tag':
        return this.tagTarget
          ? html`<ui-dialog open danger eyebrow=${this.tagTarget.library ? 'Tag' : 'Org tag'} heading=${`Remove ${this.tagTarget.name}?`} action-label="Remove" busy-label="Removing…"
              .submit=${this.submitRemoveTag} @ui-close=${() => (this.dialog = 'tags')}>
              <p>It comes off every document that has it${this.tagTarget.library ? '' : ', in every library'}. The documents stay.</p>
            </ui-dialog>`
          : nothing;
      case 'save-view':
        return open
          ? html`<ui-dialog open eyebrow=${open.name} heading="Save this view" summary="It goes in the side rail, for everyone who can see this library."
              action-label="Save" busy-label="Saving…" .submit=${this.submitSaveView} @ui-close=${close}>
              <ui-text-field slot="fields" name="name" label="Name" required maxlength="60" .validate=${nameCheck(open.views.map((v) => v.name), 'view', true, 60)}></ui-text-field>
            </ui-dialog>`
          : nothing;
      case 'rename-view': {
        const view = this.currentView;
        return view && open
          ? html`<ui-dialog open eyebrow="View" heading=${`Rename ${view.name}`} action-label="Save" busy-label="Saving…" .submit=${this.submitRenameView} @ui-close=${close}>
              <ui-text-field slot="fields" name="name" label="Name" required maxlength="60" .value=${view.name}
                .validate=${nameCheck(open.views.filter((v) => v.id !== view.id).map((v) => v.name), 'view', true, 60)}></ui-text-field>
            </ui-dialog>`
          : nothing;
      }
      case 'delete-view': {
        const view = this.currentView;
        return view
          ? html`<ui-dialog open danger eyebrow="View" heading=${`Delete ${view.name}?`} action-label="Delete" busy-label="Deleting…" .submit=${this.submitDeleteView} @ui-close=${close}>
              <p>It leaves the side rail for everyone. No documents are touched.</p>
            </ui-dialog>`
          : nothing;
      }
      default:
        return nothing;
    }
  }

  override render() {
    return html`<style>
        folio-app { display: block; min-height: 100%; }
        folio-app .folio-rail { display: flex; flex-direction: column; gap: var(--space-5); }
        folio-app .folio-rail-act { display: flex; flex-wrap: wrap; gap: var(--space-2); padding: 0 var(--space-2); }
        folio-app .folio-main-inner { display: flex; flex-direction: column; gap: var(--space-5); }
        folio-app .folio-actions { display: flex; gap: var(--space-2); }
        folio-app .folio-note { margin: 0; min-height: 1.5em; font-size: var(--type-small); color: var(--ink-muted); }
        folio-app .folio-more { display: flex; justify-content: center; }
        folio-app .folio-add { display: flex; flex-direction: column; gap: var(--space-3); }
        folio-app .folio-add-tag { display: flex; align-items: flex-end; gap: var(--space-3); }
        folio-app .folio-add-tag ui-text-field { flex: 1; }
        folio-app .folio-tags { display: flex; flex-wrap: wrap; gap: var(--space-2); }
      </style>
      <ui-app-frame rail-label="Libraries and folders" measure=${this.reading ? 'full' : 'wide'} ?busy=${this.opening}>
        ${this.rail()}
        ${this.main()}
      </ui-app-frame>
      ${this.dialogs()}`;
  }
}

if (!customElements.get('folio-app')) customElements.define('folio-app', FolioApp);

declare global {
  interface HTMLElementTagNameMap {
    'folio-app': FolioApp;
  }
}
