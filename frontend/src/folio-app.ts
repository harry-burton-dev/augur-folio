import { LitElement, html, nothing } from 'lit';
import { ago, filterValue, type DialogSubmit, type FieldCheck, type FilterDef, type FilterValue, type ListItem, type SelectOption, type TagOption, type TreeItem, type UiTextField } from '@augur/ui-kit';
import './folio-reader.js';
import type { Propose } from './folio-reader.js';
import './folio-share.js';
import './folio-publish.js';
import './folio-series.js';
import './folio-audience.js';
import type { Chosen } from './folio-audience.js';
import { whoWords } from './folio-share.js';
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
  | 'delete-series';

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
  };

  declare api: FolioApi;
  declare floorName: string;
  declare floorKind: 'personal' | 'team' | 'org';
  /** Where to start, from the path the shell mounted Folio at. */
  declare place: Place;
  /** Offers words marked in the open document to Data Atlas (see folio-reader). */
  declare propose: ((doc: { id: string; title: string }, ...rest: Parameters<Propose>) => Promise<string>) | undefined;
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
  /** What the share dialog is about: a library, or one document of it. */
  shareTarget: { library: string; document?: string; name: string } | undefined;

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
      const [{ libraries, can }, shared] = await Promise.all([
        this.api.libraries(),
        // What's shared from elsewhere is a side rail's worth: Folio opens without it.
        this.api.shared().catch(() => ({ libraries: [], documents: [] }) as Shared),
      ]);
      this.libraries = libraries;
      this.shared = shared;
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

  /** What's been published to the person, newest first. */
  private async openInbox(tell = true) {
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
        : this.view
        ? { library: this.open?.id, view: this.view }
        : { library: this.open?.id, folder: this.folder };
    this.dispatchEvent(new CustomEvent('folio-place', { detail, bubbles: true }));
  }

  /** May the person rename or remove this folder: whoever made it, or a lead. */
  private mayChange(folder: Folder) {
    return Boolean(this.open?.can.manage || folder.createdBy === this.userId);
  }

  private openShare(target: { library: string; document?: string; name: string }) {
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
    const made = await this.api.createFolder(open.id, values.name.trim(), this.folder);
    this.open = { ...open, folders: [...open.folders, made].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })) };
  };

  private submitRenameFolder: DialogSubmit = async (values) => {
    const open = this.open!;
    const renamed = await this.api.renameFolder(open.id, this.target!.id, values.name.trim());
    this.open = { ...open, folders: open.folders.map((f) => (f.id === renamed.id ? renamed : f)) };
  };

  private submitRemoveFolder: DialogSubmit = async () => {
    const open = this.open!;
    await this.api.deleteFolder(open.id, this.target!.id);
    this.open = { ...open, folders: open.folders.filter((f) => f.id !== this.target!.id) };
  };

  private onFolderAction(e: CustomEvent<{ item: ListItem; action: { id: string } }>) {
    this.target = this.open?.folders.find((f) => f.id === e.detail.item.id);
    this.dialog = e.detail.action.id === 'rename' ? 'rename-folder' : 'remove-folder';
  }

  /** "Your libraries" on your own floor, "Libraries on Finance" on a team's. */
  private get shelfName() {
    return this.floorKind === 'personal' ? 'Your libraries' : this.floorName ? `Libraries on ${this.floorName}` : 'Libraries';
  }

  private rail() {
    const open = this.open;
    return html`<nav class="folio-rail" aria-label="Libraries and folders">
      <ui-tree
        label="Libraries"
        heading=${this.shelfName}
        .items=${this.libraries.map((l): TreeItem => ({ id: l.id, label: l.name, icon: 'library' }))}
        selected=${open?.id ?? ''}
        @ui-select=${(e: CustomEvent<{ item: TreeItem }>) => void this.openLibrary(e.detail.item.id)}
      ></ui-tree>
      ${this.canCreate ? html`<div class="folio-rail-act"><ui-button kind="ghost" size="sm" @click=${() => (this.dialog = 'new-library')}>New library</ui-button></div>` : nothing}
      <ui-tree
        label="For you"
        .items=${[{ id: 'published', label: 'Published to you', icon: 'inbox' }] satisfies TreeItem[]}
        selected=${this.inbox && !this.reading ? 'published' : ''}
        @ui-select=${() => void this.openInbox()}
      ></ui-tree>
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
    </nav>`;
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
        library-name=${open ? [open.name, ...folderTrail(open.folders, doc.folder).map((f) => f.name)].join(' / ') : doc.libraryName}
        @folio-read=${(e: CustomEvent<{ version?: number }>) => void this.read(doc.id, e.detail.version, true, doc.library)}
        @folio-back=${() => void this.stopReading()}
        @folio-manage=${() => (this.dialog = 'document')}
        @folio-share=${() => this.openShare({ library: doc.library, document: doc.id, name: doc.title })}
        @folio-publish=${() => (this.dialog = 'publish')}
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
    const both = folders.length > 0 && this.documents.length > 0;
    const inside: ListItem[] = [
      ...folders.map((f) => ({
        id: f.id,
        title: f.name,
        icon: 'folder',
        meta: String(open.folders.filter((c) => c.parent === f.id).length || ''),
        ...(both ? { group: 'Folders' } : {}),
        ...(this.mayChange(f) ? { actions: [{ id: 'rename', label: 'Rename' }, { id: 'remove', label: 'Remove' }] } : {}),
      })),
      ...this.documents.map((d) => ({
        id: `${DOC}${d.id}`,
        title: d.title,
        icon: 'document',
        detail: this.rowDetail(d, narrowed),
        ...(d.state === 'published' ? { icon: 'publish' } : {}),
        meta: ago(d.updatedAt),
        ...(both ? { group: 'Documents' } : {}),
      })),
    ];
    const where = here?.name ?? open.name;
    const changedView = view && !sameQuery(view.query, queryFrom(this.filters, this.sort, this.folder));
    const tagOpts = tagOptions(open.tags);
    return html`<div class="folio-main-inner" aria-busy=${this.opening ? 'true' : 'false'}>
      ${here && !view
        ? html`<ol class="folio-trail" aria-label="Where you are">
            <li><button class="folio-crumb" @click=${() => this.goToFolder(undefined)}>${open.name}</button></li>
            ${trail.map(
              (f, i) => html`<li><span aria-hidden="true">/</span><button class="folio-crumb" aria-current=${i === trail.length - 1 ? 'page' : nothing} @click=${() => this.goToFolder(f.id)}>${f.name}</button></li>`,
            )}
          </ol>`
        : nothing}
      <div class="folio-head">
        ${view
          ? html`<ui-heading eyebrow=${`A view in ${open.name}`} heading=${view.name} summary=${here ? `In ${trail.map((f) => f.name).join(' / ')}` : ''}></ui-heading>`
          : html`<ui-heading eyebrow=${here ? (trail.at(-2)?.name ?? open.name) : this.shelfName} heading=${here?.name ?? open.name} summary=${here ? '' : open.description}></ui-heading>`}
        <div class="folio-actions">
          ${view && this.mayChangeView(view)
            ? html`<ui-button kind="ghost" size="sm" @click=${() => (this.dialog = 'rename-view')}>Rename view</ui-button>
                <ui-button kind="ghost" size="sm" @click=${() => (this.dialog = 'delete-view')}>Delete view</ui-button>`
            : html`${open.can.addFolders && !view ? html`<ui-button kind="secondary" size="sm" @click=${() => (this.dialog = 'new-folder')}>New folder</ui-button>` : nothing}
                ${open.can.manage && !here && !view ? html`<ui-button kind="ghost" size="sm" @click=${() => this.newSeries()}>New series</ui-button>` : nothing}
                <ui-button kind="ghost" size="sm" @click=${() => void this.openTags()}>Tags</ui-button>
                ${!here ? html`<ui-button kind="ghost" size="sm" @click=${() => this.openShare({ library: open.id, name: open.name })}>${open.can.share ? 'Share' : 'Who can see it'}</ui-button>` : nothing}
                ${open.can.manage && !here
                  ? html`<ui-button kind="ghost" size="sm" @click=${() => (this.dialog = 'edit-library')}>Rename</ui-button>
                      <ui-button kind="ghost" size="sm" @click=${() => (this.dialog = 'archive-library')}>Archive</ui-button>`
                  : nothing}`}
        </div>
      </div>
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
      <ui-surface>
        <ui-list
          label=${narrowed ? `Matching in ${where}` : `In ${where}`}
          density="compact"
          .noun=${folders.length && !this.documents.length ? ['folder', 'folders'] : this.documents.length && !folders.length ? ['document', 'documents'] : ['item', 'items']}
          .items=${inside}
          empty=${narrowed ? `Nothing in ${where} matches these filters.` : here ? 'This folder is empty.' : 'This library is empty.'}
          @ui-open=${(e: CustomEvent<{ item: ListItem }>) => {
            const id = e.detail.item.id;
            void (id.startsWith(DOC) ? this.read(id.slice(DOC.length)) : this.goToFolder(id));
          }}
          @ui-action=${this.onFolderAction}
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
      <p class="folio-note" role="status">${this.uploading ? `Adding ${this.uploading} ${this.uploading === 1 ? 'file' : 'files'}…` : this.note}</p>
    </div>`;
  }

  /** "Version 3 · PDF · 1.2 MB · Policy, Travel", with the folder first when the list spans several. */
  private rowDetail(d: FolioDocument, spanning: boolean) {
    const open = this.open!;
    const names = d.tags.map((t) => open.tags.find((x) => x.id === t)?.name).filter(Boolean);
    const folder = spanning ? folderTrail(open.folders, d.folder).map((f) => f.name).join(' / ') : '';
    const run = d.issue && open.series.find((r) => r.id === d.issue!.series);
    const issue = d.issue && run ? `${run.name}, ${d.issue.period.startsWith('Issue') ? d.issue.period.toLowerCase() : d.issue.period}` : '';
    return [stateWords(d), issue, folder, documentLine(d), names.join(', ')].filter(Boolean).join(' · ');
  }

  /** What's out to the person now, from any floor: each opens at the version that's out. */
  private inboxPage(inbox: PublishedPage) {
    const rows: ListItem[] = inbox.documents.map((d) => ({
      id: `${DOC}${d.library}/${d.id}/${d.published.version}`,
      title: d.title,
      icon: 'publish',
      detail: [`In ${d.libraryName}`, `Version ${d.published.version}`, d.published.note].filter(Boolean).join(' · '),
      meta: ago(d.published.publishedAt),
    }));
    return html`<div class="folio-main-inner">
      <div class="folio-head">
        <ui-heading eyebrow="For you" heading="Published to you" summary="Put out to you, or to a team you’re on, from any floor. The newest first."></ui-heading>
      </div>
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
      <p class="folio-note" role="status">${this.note}</p>
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
          ? html`<ui-dialog open eyebrow=${folderTrail(open.folders, this.folder).at(-1)?.name ?? open.name} heading="New folder" action-label="Make it" busy-label="Making…"
              .submit=${this.submitNewFolder} @ui-close=${close}>
              <ui-text-field slot="fields" name="name" label="Name" required maxlength="80" .validate=${nameCheck(siblings(), 'folder', false)}></ui-text-field>
            </ui-dialog>`
          : nothing;
      case 'rename-folder':
        return this.target
          ? html`<ui-dialog open eyebrow="Folder" heading=${`Rename ${this.target.name}`} action-label="Save" busy-label="Saving…" .submit=${this.submitRenameFolder} @ui-close=${close}>
              <ui-text-field slot="fields" name="name" label="Name" required maxlength="80" .value=${this.target.name} .validate=${nameCheck(siblings(this.target.id), 'folder', false)}></ui-text-field>
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
                <p class="folio-note" role="status">${this.uploading ? 'Adding the new version…' : this.note}</p>
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
        return html`<ui-dialog open eyebrow=${target.document ? 'Document' : 'Library'} heading=${`Who can see ${target.name}`} cancel-label="Done"
          @ui-close=${() => {
            close();
            this.shareTarget = undefined;
          }}>
          <folio-share .api=${this.api} me=${this.userId} library=${target.library} document=${target.document ?? nothing}></folio-share>
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
          <folio-publish .api=${this.api} library=${doc.library} document=${doc.id} .versions=${doc.versions.map((v) => v.number)}
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
        /* Folio's own ground: the shell's water stays outside the app. */
        folio-app { display: grid; grid-template-columns: minmax(220px, 280px) 1fr; min-height: 100%; background: var(--slate); }
        folio-app .folio-rail { display: flex; flex-direction: column; gap: var(--space-5); padding: var(--space-6) var(--space-3); border-right: 1px solid var(--hairline); overflow-y: auto; }
        folio-app .folio-rail-act { padding: 0 var(--space-2); }
        folio-app .folio-main { min-width: 0; padding: var(--space-6) var(--edge); }
        folio-app .folio-main-inner { max-width: var(--measure-wide); display: flex; flex-direction: column; gap: var(--space-5); }
        folio-app .folio-main-inner[aria-busy='true'] { opacity: 0.6; }
        folio-app .folio-trail { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: 0; padding: 0; list-style: none; font-size: var(--type-small); color: var(--ink-muted); }
        folio-app .folio-trail li { display: flex; gap: var(--space-2); }
        folio-app .folio-crumb { all: unset; cursor: pointer; border-radius: var(--radius-key); }
        folio-app .folio-crumb:hover { color: var(--ink); text-decoration: underline; }
        folio-app .folio-crumb:focus-visible { outline: 1.5px solid var(--focus); outline-offset: 2px; }
        folio-app .folio-crumb[aria-current] { color: var(--ink); }
        folio-app .folio-head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
        folio-app .folio-actions { display: flex; gap: var(--space-2); }
        folio-app .folio-note { margin: 0; min-height: 1.5em; font-size: var(--type-small); color: var(--ink-muted); }
        folio-app .folio-more { display: flex; justify-content: center; }
        folio-app .folio-add { display: flex; flex-direction: column; gap: var(--space-3); }
        folio-app .folio-add-tag { display: flex; align-items: flex-end; gap: var(--space-3); }
        folio-app .folio-add-tag ui-text-field { flex: 1; }
        folio-app .folio-tags { display: flex; flex-wrap: wrap; gap: var(--space-2); }
      </style>
      ${this.rail()}
      <main class="folio-main">${this.main()}</main>
      ${this.dialogs()}`;
  }
}

if (!customElements.get('folio-app')) customElements.define('folio-app', FolioApp);

declare global {
  interface HTMLElementTagNameMap {
    'folio-app': FolioApp;
  }
}
