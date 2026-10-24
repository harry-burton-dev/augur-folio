import { randomUUID } from 'node:crypto';
import pg from 'pg';

/** A library: a shelf of documents that belongs to one floor (someone's own, a team's, or the org's). */
export interface Library {
  id: string;
  workspace: string;
  name: string;
  description: string;
  /** Anyone who may tag a document here may also make new tags, not only pick the library's. */
  freeTags: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A folder in a library. Top-level folders have no parent. */
export interface Folder {
  id: string;
  library: string;
  parent?: string;
  name: string;
  createdBy: string;
  createdAt: string;
}

/** One file as it was uploaded. A document's versions are numbered from 1 and never change. */
export interface DocumentVersion {
  id: string;
  document: string;
  number: number;
  /** The name it had on the uploader's computer. */
  filename: string;
  mediaType: string;
  /** In bytes. */
  size: number;
  /** Hex SHA-256 of the file, so a copy can be shown to be the one that was uploaded. */
  sha256: string;
  createdBy: string;
  createdAt: string;
}

/** A version as the store keeps it: with where its file is in the bucket. */
export interface StoredVersion extends DocumentVersion {
  objectKey: string;
}

/** A document: a title over a run of versions, in a library and perhaps a folder. */
export interface FolioDocument {
  id: string;
  workspace: string;
  library: string;
  folder?: string;
  title: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** The newest version. */
  latest: DocumentVersion;
  /** Its tags, by id: the org's or its library's. */
  tags: string[];
}

/**
 * A word to find documents by. The org's tags (no library) are shared by every
 * library; a library's own are its managers' to keep.
 */
export interface Tag {
  id: string;
  workspace: string;
  /** Whose tag it is; none for the org's. */
  library?: string;
  name: string;
  createdBy: string;
  createdAt: string;
}

/** How a list of documents is ordered. */
export type DocumentSort = 'title' | 'newest' | 'updated';
export const DOCUMENT_SORTS: readonly DocumentSort[] = ['title', 'newest', 'updated'];

/** "Changed in the past …", in days, so a saved view keeps meaning the past week, not one week. */
export const SINCE = { week: 7, month: 31, quarter: 92, year: 366 } as const;
export type Since = keyof typeof SINCE;

/** Which documents to list, as the store asks for them. */
export interface DocumentQuery {
  /** The folder; the top of the library when there's none. */
  folder?: string;
  /** Everything inside `folder` too, however deep: the whole library when there's no folder. */
  below?: boolean;
  /** Has every one of these tags. */
  tags?: string[];
  /** Its newest version is one of these. */
  mediaTypes?: string[];
  /** Added by one of these people. */
  authors?: string[];
  /** Changed at or after this time (ISO). */
  from?: string;
  /** Changed before this time (ISO). */
  to?: string;
  sort?: DocumentSort;
  limit?: number;
  offset?: number;
}

/** A page of documents, and how many there are in all. */
export interface DocumentPage {
  documents: FolioDocument[];
  total: number;
}

/** A set of filters as people choose them, kept so a saved view means the same tomorrow. */
export interface ViewQuery {
  folder?: string;
  tags?: string[];
  /** File kinds: pdf, word, html, markdown, text. */
  types?: string[];
  authors?: string[];
  since?: Since;
  from?: string;
  to?: string;
  sort?: DocumentSort;
}

/** A filter set saved in a library, for everyone there, in its side rail. */
export interface SavedView {
  id: string;
  library: string;
  name: string;
  query: ViewQuery;
  createdBy: string;
  createdAt: string;
}

/** Someone who added documents, by the name they last had in Folio. */
export interface Person {
  id: string;
  name: string;
}

/** The most documents in one page of a list. */
export const MAX_PAGE = 200;

/** A file that has reached the bucket, ready to be recorded as a version. */
export interface NewVersion {
  id: string;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  objectKey: string;
  createdBy: string;
}

/** Where a version's file goes in Folio's bucket: by document, so moving a document moves nothing. */
export const objectKeyFor = (document: string, version: string) => `documents/${document}/${version}`;

/** How deep folders may go, so a library stays something people can find their way round. */
export const MAX_FOLDER_DEPTH = 6;

/** Another library on the floor, or another folder beside it, already has the name. */
export class NameTakenError extends Error {}
/** The parent folder isn't in this library, or the new one would go too deep. */
export class BadParentError extends Error {}
/** The folder still has something in it. */
export class NotEmptyError extends Error {}
/** A tag that isn't the org's or this library's. */
export class BadTagError extends Error {}

export interface FolioStore {
  /** The floor's libraries, by name, leaving out archived ones. */
  libraries(workspace: string): Promise<Library[]>;
  /** A library, unless it is archived. */
  library(id: string): Promise<Library | undefined>;
  createLibrary(input: { workspace: string; name: string; description?: string; createdBy: string }): Promise<Library>;
  updateLibrary(id: string, change: { name?: string; description?: string; freeTags?: boolean }): Promise<Library | undefined>;
  /** Takes a library off its floor's list, keeping everything in it. */
  archiveLibrary(id: string, by: string): Promise<boolean>;
  /** A library's folders, by name. */
  folders(library: string): Promise<Folder[]>;
  createFolder(input: { library: string; parent?: string; name: string; createdBy: string }): Promise<Folder>;
  renameFolder(library: string, id: string, name: string): Promise<Folder | undefined>;
  /** Removes an empty folder; false when there was no such folder. */
  deleteFolder(library: string, id: string): Promise<boolean>;
  /** The documents that match, by title unless asked otherwise. */
  documents(library: string, query?: DocumentQuery): Promise<DocumentPage>;
  /** A document, unless it was deleted. */
  document(id: string): Promise<FolioDocument | undefined>;
  /** A document's versions, newest first. */
  versions(document: string): Promise<DocumentVersion[]>;
  version(document: string, number: number): Promise<StoredVersion | undefined>;
  /** A new document with its first version. The folder must be in the library. */
  createDocument(input: { id: string; library: string; folder?: string; title: string; createdBy: string; tags?: string[] }, first: NewVersion): Promise<FolioDocument>;
  /** The next version of a document, or undefined when there is no such document. */
  addVersion(document: string, version: NewVersion): Promise<DocumentVersion | undefined>;
  /** Retitles a document, or moves it: `folder: null` moves it to the top of its library. */
  updateDocument(id: string, change: { title?: string; folder?: string | null }): Promise<FolioDocument | undefined>;
  /** Takes a document out of its library, keeping its files and versions. */
  deleteDocument(id: string, by: string): Promise<boolean>;
  /** Gives a document exactly these tags. Each must be the org's or its library's. */
  setDocumentTags(id: string, tags: string[]): Promise<FolioDocument | undefined>;
  /** The tags a library's documents can have: the org's and its own, by name. */
  tags(library: string): Promise<Tag[]>;
  /** The org's tags, by name. */
  orgTags(): Promise<Tag[]>;
  tag(id: string): Promise<Tag | undefined>;
  /**
   * A new tag for a library, or for the org when there's no library. A library's
   * tag can't have an org tag's name; a new org tag takes in the libraries' tags
   * of its name, so documents tagged with them carry the org's.
   */
  createTag(input: { workspace: string; library?: string; name: string; createdBy: string }): Promise<Tag>;
  renameTag(id: string, name: string): Promise<Tag | undefined>;
  /** Removes a tag from every document and saved view that had it. */
  deleteTag(id: string): Promise<boolean>;
  /** Who added the library's documents, by name. */
  authors(library: string): Promise<Person[]>;
  /** Remembers the name someone has now, to show them by. */
  notePerson(person: Person): Promise<void>;
  views(library: string): Promise<SavedView[]>;
  view(id: string): Promise<SavedView | undefined>;
  createView(input: { library: string; name: string; query: ViewQuery; createdBy: string }): Promise<SavedView>;
  updateView(id: string, change: { name?: string; query?: ViewQuery }): Promise<SavedView | undefined>;
  deleteView(id: string): Promise<boolean>;
}

const sameName = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();
const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/** How deep `parent` sits, 1 for a top-level folder, or 0 when it isn't one of `folders`. */
const depthOf = (folders: readonly Folder[], parent: string) => {
  let depth = 0;
  for (let at = folders.find((f) => f.id === parent); at; at = at.parent ? folders.find((f) => f.id === at!.parent) : undefined) depth++;
  return depth;
};

const checkParent = (folders: readonly Folder[], parent: string | undefined) => {
  if (!parent) return;
  const depth = depthOf(folders, parent);
  if (!depth) throw new BadParentError('That folder isn’t in this library.');
  if (depth >= MAX_FOLDER_DEPTH) throw new BadParentError(`Folders go ${MAX_FOLDER_DEPTH} deep at most.`);
};

const byTitle = (a: FolioDocument, b: FolioDocument) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
const newestFirst = (key: 'createdAt' | 'updatedAt') => (a: FolioDocument, b: FolioDocument) => b[key].localeCompare(a[key]) || b.id.localeCompare(a.id);
const ORDER: Record<DocumentSort, (a: FolioDocument, b: FolioDocument) => number> = { title: byTitle, newest: newestFirst('createdAt'), updated: newestFirst('updatedAt') };
const publicVersion = ({ objectKey: _, ...version }: StoredVersion): DocumentVersion => version;

/** `folder` and every folder inside it. */
const subtree = (folders: readonly Folder[], folder: string) => {
  const ids = new Set<string | undefined>([folder]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of folders)
      if (f.parent && ids.has(f.parent) && !ids.has(f.id)) {
        ids.add(f.id);
        grew = true;
      }
  }
  return ids;
};

/** A view's tags with `from` swapped for `to`, or dropped when there's no `to`. */
const retag = (query: ViewQuery, from: ReadonlySet<string>, to?: string): ViewQuery => {
  if (!query.tags?.some((t) => from.has(t))) return query;
  const tags = [...new Set(query.tags.map((t) => (from.has(t) ? to : t)).filter((t): t is string => Boolean(t)))];
  return { ...query, tags };
};

const pageOf = (query: DocumentQuery) => ({ limit: Math.min(query.limit ?? MAX_PAGE, MAX_PAGE), offset: query.offset ?? 0 });

/** Keeps everything in memory: for tests and `pnpm dev:app`. */
export class MemoryFolioStore implements FolioStore {
  private readonly shelves = new Map<string, Library & { archivedAt?: string }>();
  private readonly folderList: Folder[] = [];
  private readonly docs = new Map<string, Omit<FolioDocument, 'latest' | 'tags'> & { deletedAt?: string }>();
  private readonly versionList: StoredVersion[] = [];
  private readonly tagList: Tag[] = [];
  private readonly docTags = new Map<string, Set<string>>();
  private readonly viewList: SavedView[] = [];
  private readonly people = new Map<string, string>();

  async libraries(workspace: string) {
    return [...this.shelves.values()].filter((l) => l.workspace === workspace && !l.archivedAt).map(({ archivedAt: _, ...l }) => l).sort(byName);
  }

  async library(id: string) {
    const found = this.shelves.get(id);
    if (!found || found.archivedAt) return undefined;
    const { archivedAt: _, ...library } = found;
    return library;
  }

  async createLibrary({ workspace, name, description = '', createdBy }: { workspace: string; name: string; description?: string; createdBy: string }) {
    if ((await this.libraries(workspace)).some((l) => sameName(l.name, name))) throw new NameTakenError(`There’s already a library called ${name} here.`);
    const now = new Date().toISOString();
    const library: Library = { id: randomUUID(), workspace, name, description, freeTags: false, createdBy, createdAt: now, updatedAt: now };
    this.shelves.set(library.id, { ...library });
    return library;
  }

  async updateLibrary(id: string, change: { name?: string; description?: string; freeTags?: boolean }) {
    const library = await this.library(id);
    if (!library) return undefined;
    if (change.name !== undefined && (await this.libraries(library.workspace)).some((l) => l.id !== id && sameName(l.name, change.name!)))
      throw new NameTakenError(`There’s already a library called ${change.name} here.`);
    const defined = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined));
    const next = { ...library, ...defined, updatedAt: new Date().toISOString() };
    this.shelves.set(id, next);
    return next;
  }

  async archiveLibrary(id: string) {
    const found = this.shelves.get(id);
    if (!found || found.archivedAt) return false;
    found.archivedAt = new Date().toISOString();
    return true;
  }

  async folders(library: string) {
    return this.folderList.filter((f) => f.library === library).sort(byName);
  }

  async createFolder({ library, parent, name, createdBy }: { library: string; parent?: string; name: string; createdBy: string }) {
    const folders = await this.folders(library);
    checkParent(folders, parent);
    if (folders.some((f) => f.parent === parent && sameName(f.name, name))) throw new NameTakenError(`There’s already a folder called ${name} there.`);
    const folder: Folder = { id: randomUUID(), library, ...(parent ? { parent } : {}), name, createdBy, createdAt: new Date().toISOString() };
    this.folderList.push(folder);
    return folder;
  }

  async renameFolder(library: string, id: string, name: string) {
    const folders = await this.folders(library);
    const folder = folders.find((f) => f.id === id);
    if (!folder) return undefined;
    if (folders.some((f) => f.id !== id && f.parent === folder.parent && sameName(f.name, name))) throw new NameTakenError(`There’s already a folder called ${name} there.`);
    folder.name = name;
    return { ...folder };
  }

  async deleteFolder(library: string, id: string) {
    const folders = await this.folders(library);
    if (!folders.some((f) => f.id === id)) return false;
    if (folders.some((f) => f.parent === id)) throw new NotEmptyError('Empty the folder first: it has folders in it.');
    if ([...this.docs.values()].some((d) => d.folder === id && !d.deletedAt)) throw new NotEmptyError('Empty the folder first: it has documents in it.');
    this.folderList.splice(this.folderList.findIndex((f) => f.id === id), 1);
    return true;
  }

  private withLatest(doc: Omit<FolioDocument, 'latest' | 'tags'> & { deletedAt?: string }): FolioDocument {
    const { deletedAt: _, ...rest } = doc;
    const latest = this.versionList.filter((v) => v.document === doc.id).reduce((a, b) => (b.number > a.number ? b : a));
    return { ...rest, latest: publicVersion(latest), tags: [...(this.docTags.get(doc.id) ?? [])].sort() };
  }

  private async checkFolder(library: string, folder: string | undefined) {
    if (folder && !(await this.folders(library)).some((f) => f.id === folder)) throw new BadParentError('That folder isn’t in this library.');
  }

  private checkTags(library: string, tags: readonly string[]) {
    for (const id of tags) {
      const tag = this.tagList.find((t) => t.id === id);
      if (!tag || (tag.library && tag.library !== library)) throw new BadTagError('That tag isn’t the org’s or this library’s.');
    }
  }

  async documents(library: string, query: DocumentQuery = {}) {
    const places: ReadonlySet<string | undefined> | undefined = query.below ? (query.folder ? subtree(await this.folders(library), query.folder) : undefined) : new Set([query.folder]);
    const matching = [...this.docs.values()]
      .filter((d) => d.library === library && !d.deletedAt && (!places || places.has(d.folder)))
      .map((d) => this.withLatest(d))
      .filter(
        (d) =>
          (!query.tags?.length || query.tags.every((t) => d.tags.includes(t))) &&
          (!query.mediaTypes?.length || query.mediaTypes.includes(d.latest.mediaType)) &&
          (!query.authors?.length || query.authors.includes(d.createdBy)) &&
          (!query.from || d.updatedAt >= new Date(query.from).toISOString()) &&
          (!query.to || d.updatedAt < new Date(query.to).toISOString()),
      )
      .sort(ORDER[query.sort ?? 'title']);
    const { limit, offset } = pageOf(query);
    return { documents: matching.slice(offset, offset + limit), total: matching.length };
  }

  async document(id: string) {
    const doc = this.docs.get(id);
    return doc && !doc.deletedAt ? this.withLatest(doc) : undefined;
  }

  async versions(document: string) {
    return this.versionList.filter((v) => v.document === document).sort((a, b) => b.number - a.number).map(publicVersion);
  }

  async version(document: string, number: number) {
    const found = this.versionList.find((v) => v.document === document && v.number === number);
    return found && { ...found };
  }

  async createDocument({ id, library, folder, title, createdBy, tags = [] }: { id: string; library: string; folder?: string; title: string; createdBy: string; tags?: string[] }, first: NewVersion) {
    const shelf = await this.library(library);
    if (!shelf) throw new BadParentError('There’s no such library.');
    await this.checkFolder(library, folder);
    this.checkTags(library, tags);
    const now = new Date().toISOString();
    this.docs.set(id, { id, workspace: shelf.workspace, library, ...(folder ? { folder } : {}), title, createdBy, createdAt: now, updatedAt: now });
    this.versionList.push({ ...first, document: id, number: 1, createdAt: now });
    if (tags.length) this.docTags.set(id, new Set(tags));
    return this.withLatest(this.docs.get(id)!);
  }

  async addVersion(document: string, version: NewVersion) {
    const doc = this.docs.get(document);
    if (!doc || doc.deletedAt) return undefined;
    const number = Math.max(...this.versionList.filter((v) => v.document === document).map((v) => v.number)) + 1;
    const stored: StoredVersion = { ...version, document, number, createdAt: new Date().toISOString() };
    this.versionList.push(stored);
    doc.updatedAt = stored.createdAt;
    return publicVersion(stored);
  }

  async updateDocument(id: string, change: { title?: string; folder?: string | null }) {
    const doc = this.docs.get(id);
    if (!doc || doc.deletedAt) return undefined;
    if (change.folder) await this.checkFolder(doc.library, change.folder);
    if (change.title !== undefined) doc.title = change.title;
    if (change.folder !== undefined) {
      if (change.folder) doc.folder = change.folder;
      else delete doc.folder;
    }
    doc.updatedAt = new Date().toISOString();
    return this.withLatest(doc);
  }

  async deleteDocument(id: string) {
    const doc = this.docs.get(id);
    if (!doc || doc.deletedAt) return false;
    doc.deletedAt = new Date().toISOString();
    return true;
  }

  async setDocumentTags(id: string, tags: string[]) {
    const doc = this.docs.get(id);
    if (!doc || doc.deletedAt) return undefined;
    this.checkTags(doc.library, tags);
    this.docTags.set(id, new Set(tags));
    return this.withLatest(doc);
  }

  async tags(library: string) {
    return this.tagList.filter((t) => !t.library || t.library === library).map((t) => ({ ...t })).sort(byName);
  }

  async orgTags() {
    return this.tagList.filter((t) => !t.library).map((t) => ({ ...t })).sort(byName);
  }

  async tag(id: string) {
    const tag = this.tagList.find((t) => t.id === id);
    return tag && { ...tag };
  }

  /** Before `tag` takes `name`: refuses a clash, and for an org tag takes in the libraries' tags of that name. */
  private claim(tag: Pick<Tag, 'id' | 'library'>, name: string) {
    const clash = this.tagList.find((t) => t.id !== tag.id && sameName(t.name, name) && (!t.library || t.library === tag.library));
    if (clash) throw new NameTakenError(clash.library || !tag.library ? `There’s already a tag called ${name}.` : `${clash.name} is already one of the org’s tags.`);
    if (tag.library) return;
    const absorbed = new Set(this.tagList.filter((t) => t.library && sameName(t.name, name)).map((t) => t.id));
    if (!absorbed.size) return;
    for (const set of this.docTags.values()) {
      if (![...set].some((t) => absorbed.has(t))) continue;
      for (const t of absorbed) set.delete(t);
      set.add(tag.id);
    }
    for (const view of this.viewList) view.query = retag(view.query, absorbed, tag.id);
    for (let i = this.tagList.length - 1; i >= 0; i--) if (absorbed.has(this.tagList[i].id)) this.tagList.splice(i, 1);
  }

  async createTag({ workspace, library, name, createdBy }: { workspace: string; library?: string; name: string; createdBy: string }) {
    const tag: Tag = { id: randomUUID(), workspace, ...(library ? { library } : {}), name, createdBy, createdAt: new Date().toISOString() };
    this.claim(tag, name);
    this.tagList.push(tag);
    return { ...tag };
  }

  async renameTag(id: string, name: string) {
    const tag = this.tagList.find((t) => t.id === id);
    if (!tag) return undefined;
    this.claim(tag, name);
    tag.name = name;
    return { ...tag };
  }

  async deleteTag(id: string) {
    const at = this.tagList.findIndex((t) => t.id === id);
    if (at < 0) return false;
    this.tagList.splice(at, 1);
    for (const set of this.docTags.values()) set.delete(id);
    for (const view of this.viewList) view.query = retag(view.query, new Set([id]));
    return true;
  }

  async authors(library: string) {
    const ids = new Set([...this.docs.values()].filter((d) => d.library === library && !d.deletedAt).map((d) => d.createdBy));
    return [...ids].map((id) => ({ id, name: this.people.get(id) ?? '' })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async notePerson({ id, name }: Person) {
    this.people.set(id, name);
  }

  async views(library: string) {
    return this.viewList.filter((v) => v.library === library).map((v) => ({ ...v })).sort(byName);
  }

  async view(id: string) {
    const view = this.viewList.find((v) => v.id === id);
    return view && { ...view };
  }

  async createView({ library, name, query, createdBy }: { library: string; name: string; query: ViewQuery; createdBy: string }) {
    if (this.viewList.some((v) => v.library === library && sameName(v.name, name))) throw new NameTakenError(`There’s already a view called ${name} here.`);
    const view: SavedView = { id: randomUUID(), library, name, query, createdBy, createdAt: new Date().toISOString() };
    this.viewList.push(view);
    return { ...view };
  }

  async updateView(id: string, change: { name?: string; query?: ViewQuery }) {
    const view = this.viewList.find((v) => v.id === id);
    if (!view) return undefined;
    if (change.name !== undefined && this.viewList.some((v) => v.id !== id && v.library === view.library && sameName(v.name, change.name!)))
      throw new NameTakenError(`There’s already a view called ${change.name} here.`);
    if (change.name !== undefined) view.name = change.name;
    if (change.query) view.query = change.query;
    return { ...view };
  }

  async deleteView(id: string) {
    const at = this.viewList.findIndex((v) => v.id === id);
    if (at < 0) return false;
    this.viewList.splice(at, 1);
    return true;
  }
}

/**
 * Schema changes, applied in order and recorded so each runs once. Folio owns the `folio`
 * schema, made for its own database login by the platform (docs/app-storage.md).
 * Every table carries the floor it belongs to, so every query can keep to one floor.
 */
export const migrations: { id: string; sql: string }[] = [
  {
    id: '001_libraries',
    sql: `
      create table folio.libraries (
        id text primary key,
        workspace_id text not null,
        name text not null,
        description text not null default '',
        created_by text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        archived_by text,
        archived_at timestamptz
      );
      -- One name per floor among the libraries in use; an archived one gives its name up.
      create unique index libraries_name on folio.libraries (workspace_id, lower(name)) where archived_at is null;
      create table folio.folders (
        id text primary key,
        workspace_id text not null,
        library_id text not null references folio.libraries (id),
        parent_id text references folio.folders (id),
        name text not null,
        created_by text not null,
        created_at timestamptz not null default now()
      );
      -- One name per place: top-level folders compare with each other, others with their siblings.
      create unique index folders_name on folio.folders (library_id, coalesce(parent_id, ''), lower(name));
      create index folders_parent on folio.folders (parent_id);`,
  },
  {
    id: '002_documents',
    sql: `
      create table folio.documents (
        id text primary key,
        workspace_id text not null,
        library_id text not null references folio.libraries (id),
        folder_id text references folio.folders (id),
        title text not null,
        created_by text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_by text,
        deleted_at timestamptz
      );
      create index documents_place on folio.documents (library_id, folder_id) where deleted_at is null;
      -- Every file as it was uploaded; a version is never changed, only followed by the next.
      create table folio.document_versions (
        id text primary key,
        workspace_id text not null,
        document_id text not null references folio.documents (id),
        number integer not null,
        filename text not null,
        media_type text not null,
        size_bytes bigint not null,
        sha256 text not null,
        object_key text not null,
        created_by text not null,
        created_at timestamptz not null default now(),
        unique (document_id, number)
      );`,
  },
  {
    id: '003_tags_views',
    sql: `
      alter table folio.libraries add column free_tags boolean not null default false;
      -- The org's tags have no library; a library's tags are its own. One of each name in each.
      create table folio.tags (
        id text primary key,
        workspace_id text not null,
        library_id text references folio.libraries (id),
        name text not null,
        created_by text not null,
        created_at timestamptz not null default now()
      );
      create unique index tags_name on folio.tags (coalesce(library_id, ''), lower(name));
      create table folio.document_tags (
        document_id text not null references folio.documents (id),
        tag_id text not null references folio.tags (id),
        workspace_id text not null,
        primary key (document_id, tag_id)
      );
      create index document_tags_tag on folio.document_tags (tag_id);
      create table folio.views (
        id text primary key,
        workspace_id text not null,
        library_id text not null references folio.libraries (id),
        name text not null,
        query jsonb not null,
        created_by text not null,
        created_at timestamptz not null default now()
      );
      create unique index views_name on folio.views (library_id, lower(name));
      -- The name each person had when they last added something, to show them by.
      create table folio.people (
        id text primary key,
        name text not null,
        seen_at timestamptz not null default now()
      );
      create index documents_updated on folio.documents (library_id, updated_at desc) where deleted_at is null;`,
  },
];

type LibraryRow = { id: string; workspace_id: string; name: string; description: string; free_tags: boolean; created_by: string; created_at: Date; updated_at: Date };
type FolderRow = { id: string; library_id: string; parent_id: string | null; name: string; created_by: string; created_at: Date };

const fromLibraryRow = (r: LibraryRow): Library => ({
  id: r.id,
  workspace: r.workspace_id,
  name: r.name,
  description: r.description,
  freeTags: r.free_tags,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

type VersionRow = { id: string; document_id: string; number: number; filename: string; media_type: string; size_bytes: string; sha256: string; object_key: string; created_by: string; created_at: Date };
type DocumentRow = {
  id: string;
  workspace_id: string;
  library_id: string;
  folder_id: string | null;
  title: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  latest: Omit<VersionRow, 'created_at' | 'size_bytes'> & { created_at: string; size_bytes: number };
  tags: string[];
  total?: string;
};
type TagRow = { id: string; workspace_id: string; library_id: string | null; name: string; created_by: string; created_at: Date };
type ViewRow = { id: string; library_id: string; name: string; query: ViewQuery; created_by: string; created_at: Date };

const fromTagRow = (r: TagRow): Tag => ({
  id: r.id,
  workspace: r.workspace_id,
  ...(r.library_id ? { library: r.library_id } : {}),
  name: r.name,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
});

const fromViewRow = (r: ViewRow): SavedView => ({ id: r.id, library: r.library_id, name: r.name, query: r.query, createdBy: r.created_by, createdAt: r.created_at.toISOString() });
const TAG_COLUMNS = 'id, workspace_id, library_id, name, created_by, created_at';
const VIEW_COLUMNS = 'id, library_id, name, query, created_by, created_at';

const fromVersionRow = (r: VersionRow): StoredVersion => ({
  id: r.id,
  document: r.document_id,
  number: r.number,
  filename: r.filename,
  mediaType: r.media_type,
  size: Number(r.size_bytes),
  sha256: r.sha256,
  objectKey: r.object_key,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
});

const fromDocumentRow = (r: DocumentRow): FolioDocument => ({
  id: r.id,
  workspace: r.workspace_id,
  library: r.library_id,
  ...(r.folder_id ? { folder: r.folder_id } : {}),
  title: r.title,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  latest: publicVersion(fromVersionRow({ ...r.latest, size_bytes: String(r.latest.size_bytes), created_at: new Date(r.latest.created_at) })),
  tags: r.tags,
});

/** A document with its newest version (`v`) and its tags, as one row, with how many rows match in all. */
const DOCUMENT_SELECT = `
  select d.id, d.workspace_id, d.library_id, d.folder_id, d.title, d.created_by, d.created_at, d.updated_at,
    to_jsonb(v) - 'workspace_id' as latest,
    array(select dt.tag_id from folio.document_tags dt where dt.document_id = d.id order by dt.tag_id) as tags,
    count(*) over () as total
  from folio.documents d
  cross join lateral (select * from folio.document_versions dv where dv.document_id = d.id order by dv.number desc limit 1) v`;
const VERSION_COLUMNS = 'id, document_id, number, filename, media_type, size_bytes, sha256, object_key, created_by, created_at';

const fromFolderRow = (r: FolderRow): Folder => ({
  id: r.id,
  library: r.library_id,
  ...(r.parent_id ? { parent: r.parent_id } : {}),
  name: r.name,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
});

/** Postgres says a unique index refused the row. */
const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === '23505';

const LIBRARY_COLUMNS = 'id, workspace_id, name, description, free_tags, created_by, created_at, updated_at';
const DOCUMENT_ORDER: Record<DocumentSort, string> = { title: 'lower(d.title), d.id', newest: 'd.created_at desc, d.id desc', updated: 'd.updated_at desc, d.id desc' };
const FOLDER_COLUMNS = 'id, library_id, parent_id, name, created_by, created_at';

export class PgFolioStore implements FolioStore {
  // A plain field, not a parameter property: `pnpm dev:app` runs this file with Node's type stripping.
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  static async connect(connectionString: string) {
    const store = new PgFolioStore(new pg.Pool({ connectionString }));
    await store.migrate();
    return store;
  }

  /** Brings the schema up to date. Safe to run from several instances at once. */
  async migrate() {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query("select pg_advisory_xact_lock(hashtext('folio.migrate'))");
      // On a server the platform makes the schema for Folio's login, which may not create schemas
      // itself: Postgres checks that right even for "if not exists", so only ask when there is none.
      const { rowCount } = await client.query("select 1 from pg_namespace where nspname = 'folio'");
      if (!rowCount) await client.query('create schema folio');
      await client.query('create table if not exists folio.migrations (id text primary key, applied_at timestamptz not null default now())');
      const { rows } = await client.query<{ id: string }>('select id from folio.migrations');
      const applied = new Set(rows.map((r) => r.id));
      for (const m of migrations.filter((m) => !applied.has(m.id))) {
        await client.query(m.sql);
        await client.query('insert into folio.migrations (id) values ($1)', [m.id]);
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }

  async libraries(workspace: string) {
    const { rows } = await this.pool.query<LibraryRow>(
      `select ${LIBRARY_COLUMNS} from folio.libraries where workspace_id = $1 and archived_at is null order by lower(name), id`,
      [workspace],
    );
    return rows.map(fromLibraryRow);
  }

  async library(id: string) {
    const { rows } = await this.pool.query<LibraryRow>(`select ${LIBRARY_COLUMNS} from folio.libraries where id = $1 and archived_at is null`, [id]);
    return rows[0] && fromLibraryRow(rows[0]);
  }

  async createLibrary({ workspace, name, description = '', createdBy }: { workspace: string; name: string; description?: string; createdBy: string }) {
    try {
      const { rows } = await this.pool.query<LibraryRow>(
        `insert into folio.libraries (id, workspace_id, name, description, created_by) values ($1, $2, $3, $4, $5) returning ${LIBRARY_COLUMNS}`,
        [randomUUID(), workspace, name, description, createdBy],
      );
      return fromLibraryRow(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError(`There’s already a library called ${name} here.`);
      throw err;
    }
  }

  async updateLibrary(id: string, change: { name?: string; description?: string; freeTags?: boolean }) {
    try {
      const { rows } = await this.pool.query<LibraryRow>(
        `update folio.libraries set name = coalesce($2, name), description = coalesce($3, description), free_tags = coalesce($4, free_tags), updated_at = now()
          where id = $1 and archived_at is null returning ${LIBRARY_COLUMNS}`,
        [id, change.name ?? null, change.description ?? null, change.freeTags ?? null],
      );
      return rows[0] && fromLibraryRow(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError(`There’s already a library called ${change.name} here.`);
      throw err;
    }
  }

  async archiveLibrary(id: string, by: string) {
    const { rowCount } = await this.pool.query('update folio.libraries set archived_by = $2, archived_at = now() where id = $1 and archived_at is null', [id, by]);
    return rowCount === 1;
  }

  async folders(library: string) {
    const { rows } = await this.pool.query<FolderRow>(`select ${FOLDER_COLUMNS} from folio.folders where library_id = $1 order by lower(name), id`, [library]);
    return rows.map(fromFolderRow);
  }

  async createFolder({ library, parent, name, createdBy }: { library: string; parent?: string; name: string; createdBy: string }) {
    checkParent(await this.folders(library), parent);
    try {
      const { rows } = await this.pool.query<FolderRow>(
        `insert into folio.folders (id, workspace_id, library_id, parent_id, name, created_by)
          select $1, workspace_id, id, $3, $4, $5 from folio.libraries where id = $2 returning ${FOLDER_COLUMNS}`,
        [randomUUID(), library, parent ?? null, name, createdBy],
      );
      if (!rows[0]) throw new BadParentError('There’s no such library.');
      return fromFolderRow(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError(`There’s already a folder called ${name} there.`);
      throw err;
    }
  }

  async renameFolder(library: string, id: string, name: string) {
    try {
      const { rows } = await this.pool.query<FolderRow>(`update folio.folders set name = $3 where id = $2 and library_id = $1 returning ${FOLDER_COLUMNS}`, [library, id, name]);
      return rows[0] && fromFolderRow(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError(`There’s already a folder called ${name} there.`);
      throw err;
    }
  }

  async deleteFolder(library: string, id: string) {
    const { rows } = await this.pool.query<{ found: boolean; children: boolean; documents: boolean }>(
      `select exists (select 1 from folio.folders where id = $2 and library_id = $1) as found,
              exists (select 1 from folio.folders where parent_id = $2) as children,
              exists (select 1 from folio.documents where folder_id = $2 and deleted_at is null) as documents`,
      [library, id],
    );
    if (!rows[0].found) return false;
    if (rows[0].children) throw new NotEmptyError('Empty the folder first: it has folders in it.');
    if (rows[0].documents) throw new NotEmptyError('Empty the folder first: it has documents in it.');
    try {
      const { rowCount } = await this.pool.query('delete from folio.folders where id = $2 and library_id = $1', [library, id]);
      return rowCount === 1;
    } catch (err) {
      // A folder made inside it in the meantime.
      if ((err as { code?: string }).code === '23503') throw new NotEmptyError('Empty the folder first: it has folders in it.');
      throw err;
    }
  }
  async documents(library: string, query: DocumentQuery = {}): Promise<DocumentPage> {
    const params: unknown[] = [library];
    const param = (value: unknown) => `$${params.push(value)}`;
    const where = ['d.library_id = $1', 'd.deleted_at is null'];
    let place = '';
    if (!query.below) where.push(`d.folder_id is not distinct from ${param(query.folder ?? null)}::text`);
    else if (query.folder) {
      place = `with recursive place (id) as (
          select id from folio.folders where id = ${param(query.folder)} and library_id = $1
          union all select f.id from folio.folders f join place on f.parent_id = place.id)`;
      where.push('d.folder_id in (select id from place)');
    }
    const tags = [...new Set(query.tags ?? [])];
    if (tags.length) where.push(`(select count(*) from folio.document_tags dt where dt.document_id = d.id and dt.tag_id = any(${param(tags)}::text[])) = ${param(tags.length)}`);
    if (query.mediaTypes?.length) where.push(`v.media_type = any(${param(query.mediaTypes)}::text[])`);
    if (query.authors?.length) where.push(`d.created_by = any(${param(query.authors)}::text[])`);
    if (query.from) where.push(`d.updated_at >= ${param(query.from)}::timestamptz`);
    if (query.to) where.push(`d.updated_at < ${param(query.to)}::timestamptz`);
    const { limit, offset } = pageOf(query);
    const { rows } = await this.pool.query<DocumentRow>(
      `${place} ${DOCUMENT_SELECT} where ${where.join(' and ')} order by ${DOCUMENT_ORDER[query.sort ?? 'title']} limit ${param(limit)} offset ${param(offset)}`,
      params,
    );
    // Past the last page there are no rows to carry the count, so count again.
    const total: number = rows[0] ? Number(rows[0].total) : offset ? (await this.documents(library, { ...query, offset: 0, limit: 1 })).total : 0;
    return { documents: rows.map(fromDocumentRow), total };
  }

  async document(id: string) {
    const { rows } = await this.pool.query<DocumentRow>(`${DOCUMENT_SELECT} where d.id = $1 and d.deleted_at is null`, [id]);
    return rows[0] && fromDocumentRow(rows[0]);
  }

  async versions(document: string) {
    const { rows } = await this.pool.query<VersionRow>(`select ${VERSION_COLUMNS} from folio.document_versions where document_id = $1 order by number desc`, [document]);
    return rows.map((r) => publicVersion(fromVersionRow(r)));
  }

  async version(document: string, number: number) {
    const { rows } = await this.pool.query<VersionRow>(`select ${VERSION_COLUMNS} from folio.document_versions where document_id = $1 and number = $2`, [document, number]);
    return rows[0] && fromVersionRow(rows[0]);
  }

  private async insertVersion(client: pg.PoolClient, document: string, number: number, v: NewVersion) {
    const { rows } = await client.query<VersionRow>(
      `insert into folio.document_versions (id, workspace_id, document_id, number, filename, media_type, size_bytes, sha256, object_key, created_by)
        select $1, workspace_id, id, $3, $4, $5, $6, $7, $8, $9 from folio.documents where id = $2 returning ${VERSION_COLUMNS}`,
      [v.id, document, number, v.filename, v.mediaType, v.size, v.sha256, v.objectKey, v.createdBy],
    );
    return fromVersionRow(rows[0]);
  }

  /** Runs `work` in one transaction. */
  private async inTransaction<T>(work: (client: pg.PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  async createDocument({ id, library, folder, title, createdBy, tags = [] }: { id: string; library: string; folder?: string; title: string; createdBy: string; tags?: string[] }, first: NewVersion) {
    await this.inTransaction(async (client) => {
      const { rowCount } = await client.query(
        `insert into folio.documents (id, workspace_id, library_id, folder_id, title, created_by)
          select $1, l.workspace_id, l.id, $3, $4, $5 from folio.libraries l
          where l.id = $2 and l.archived_at is null and ($3::text is null or exists (select 1 from folio.folders f where f.id = $3 and f.library_id = l.id))`,
        [id, library, folder ?? null, title, createdBy],
      );
      if (!rowCount) throw new BadParentError(folder ? 'That folder isn’t in this library.' : 'There’s no such library.');
      await this.insertVersion(client, id, 1, first);
      await this.writeTags(client, id, tags);
    });
    return (await this.document(id))!;
  }

  async addVersion(document: string, version: NewVersion) {
    return this.inTransaction(async (client) => {
      // Lock the document's row first, then count, so two uploads at once get the next two numbers.
      const { rowCount } = await client.query('select 1 from folio.documents where id = $1 and deleted_at is null for update', [document]);
      if (!rowCount) return undefined;
      const { rows } = await client.query<{ next: number }>('select coalesce(max(number), 0) + 1 as next from folio.document_versions where document_id = $1', [document]);
      const added = await this.insertVersion(client, document, rows[0].next, version);
      await client.query('update folio.documents set updated_at = now() where id = $1', [document]);
      return publicVersion(added);
    });
  }

  async updateDocument(id: string, change: { title?: string; folder?: string | null }) {
    const { rowCount } = await this.pool.query(
      `update folio.documents d set
          title = coalesce($2, d.title),
          folder_id = case when $3 then $4 else d.folder_id end,
          updated_at = now()
        where d.id = $1 and d.deleted_at is null
          and ($4::text is null or exists (select 1 from folio.folders f where f.id = $4 and f.library_id = d.library_id))`,
      [id, change.title ?? null, change.folder !== undefined, change.folder ?? null],
    );
    if (!rowCount) {
      if (change.folder && (await this.document(id))) throw new BadParentError('That folder isn’t in this library.');
      return undefined;
    }
    return this.document(id);
  }

  async deleteDocument(id: string, by: string) {
    const { rowCount } = await this.pool.query('update folio.documents set deleted_by = $2, deleted_at = now() where id = $1 and deleted_at is null', [id, by]);
    return rowCount === 1;
  }
  /** Replaces a document's tags inside `client`'s transaction; BadTagError for one that isn't the org's or its library's. */
  private async writeTags(client: pg.PoolClient, document: string, tags: readonly string[]) {
    const wanted = [...new Set(tags)];
    await client.query('delete from folio.document_tags where document_id = $1', [document]);
    if (!wanted.length) return;
    const { rowCount } = await client.query(
      `insert into folio.document_tags (document_id, tag_id, workspace_id)
        select d.id, t.id, d.workspace_id from folio.documents d join folio.tags t on t.library_id is null or t.library_id = d.library_id
        where d.id = $1 and t.id = any($2::text[])`,
      [document, wanted],
    );
    if (rowCount !== wanted.length) throw new BadTagError('That tag isn’t the org’s or this library’s.');
  }

  async setDocumentTags(id: string, tags: string[]) {
    const found = await this.inTransaction(async (client) => {
      const { rowCount } = await client.query('select 1 from folio.documents where id = $1 and deleted_at is null for update', [id]);
      if (!rowCount) return false;
      await this.writeTags(client, id, tags);
      return true;
    });
    return found ? this.document(id) : undefined;
  }

  async tags(library: string) {
    const { rows } = await this.pool.query<TagRow>(`select ${TAG_COLUMNS} from folio.tags where library_id is null or library_id = $1 order by lower(name), id`, [library]);
    return rows.map(fromTagRow);
  }

  async orgTags() {
    const { rows } = await this.pool.query<TagRow>(`select ${TAG_COLUMNS} from folio.tags where library_id is null order by lower(name), id`);
    return rows.map(fromTagRow);
  }

  async tag(id: string) {
    const { rows } = await this.pool.query<TagRow>(`select ${TAG_COLUMNS} from folio.tags where id = $1`, [id]);
    return rows[0] && fromTagRow(rows[0]);
  }

  /**
   * Before a tag takes `name`, inside the transaction: refuses a clash, and for an org
   * tag says which libraries' tags of that name it takes in.
   */
  private async claim(client: pg.PoolClient, tag: { id: string; library?: string }, name: string) {
    // One name changes hands at a time, so two leads can't each half-merge it.
    await client.query("select pg_advisory_xact_lock(hashtext('folio.tags'), hashtext(lower($1)))", [name]);
    const { rows: clash } = await client.query<{ name: string; library_id: string | null }>(
      'select name, library_id from folio.tags where id <> $1 and lower(name) = lower($2) and (library_id is null or library_id is not distinct from $3)',
      [tag.id, name, tag.library ?? null],
    );
    if (clash[0]) throw new NameTakenError(clash[0].library_id || !tag.library ? `There’s already a tag called ${name}.` : `${clash[0].name} is already one of the org’s tags.`);
    if (tag.library) return [];
    const { rows } = await client.query<{ id: string }>('select id from folio.tags where library_id is not null and lower(name) = lower($1)', [name]);
    return rows.map((r) => r.id);
  }

  /** After an org tag is in: documents and views with the tags it took in now carry it, and those tags go. */
  private async absorb(client: pg.PoolClient, into: string, absorbed: readonly string[]) {
    if (!absorbed.length) return;
    await client.query(
      `insert into folio.document_tags (document_id, tag_id, workspace_id)
        select document_id, $1, workspace_id from folio.document_tags where tag_id = any($2::text[]) on conflict do nothing`,
      [into, absorbed],
    );
    await this.untagViews(client, absorbed, into);
    await client.query('delete from folio.document_tags where tag_id = any($1::text[])', [absorbed]);
    await client.query('delete from folio.tags where id = any($1::text[])', [absorbed]);
  }

  private async untagViews(client: pg.PoolClient, tags: readonly string[], to?: string) {
    const { rows } = await client.query<{ id: string; query: ViewQuery }>("select id, query from folio.views where query -> 'tags' ?| $1::text[] for update", [tags]);
    const from = new Set(tags);
    for (const view of rows) await client.query('update folio.views set query = $2 where id = $1', [view.id, JSON.stringify(retag(view.query, from, to))]);
  }

  async createTag({ workspace, library, name, createdBy }: { workspace: string; library?: string; name: string; createdBy: string }) {
    const id = randomUUID();
    try {
      return await this.inTransaction(async (client) => {
        const absorbed = await this.claim(client, { id, library }, name);
        const { rows } = await client.query<TagRow>(
          `insert into folio.tags (id, workspace_id, library_id, name, created_by) values ($1, $2, $3, $4, $5) returning ${TAG_COLUMNS}`,
          [id, workspace, library ?? null, name, createdBy],
        );
        await this.absorb(client, id, absorbed);
        return fromTagRow(rows[0]);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError(`There’s already a tag called ${name}.`);
      throw err;
    }
  }

  async renameTag(id: string, name: string) {
    try {
      return await this.inTransaction(async (client) => {
        const { rows: found } = await client.query<TagRow>(`select ${TAG_COLUMNS} from folio.tags where id = $1 for update`, [id]);
        if (!found[0]) return undefined;
        const tag = fromTagRow(found[0]);
        const absorbed = await this.claim(client, tag, name);
        await this.absorb(client, id, absorbed);
        const { rows } = await client.query<TagRow>(`update folio.tags set name = $2 where id = $1 returning ${TAG_COLUMNS}`, [id, name]);
        return fromTagRow(rows[0]);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError(`There’s already a tag called ${name}.`);
      throw err;
    }
  }

  async deleteTag(id: string) {
    return this.inTransaction(async (client) => {
      await this.untagViews(client, [id]);
      await client.query('delete from folio.document_tags where tag_id = $1', [id]);
      const { rowCount } = await client.query('delete from folio.tags where id = $1', [id]);
      return rowCount === 1;
    });
  }

  async authors(library: string) {
    const { rows } = await this.pool.query<Person>(
      `select a.created_by as id, coalesce(p.name, '') as name
        from (select distinct created_by from folio.documents where library_id = $1 and deleted_at is null) a
        left join folio.people p on p.id = a.created_by
        order by coalesce(p.name, ''), a.created_by`,
      [library],
    );
    return rows;
  }

  async notePerson({ id, name }: Person) {
    await this.pool.query('insert into folio.people (id, name) values ($1, $2) on conflict (id) do update set name = excluded.name, seen_at = now()', [id, name]);
  }

  async views(library: string) {
    const { rows } = await this.pool.query<ViewRow>(`select ${VIEW_COLUMNS} from folio.views where library_id = $1 order by lower(name), id`, [library]);
    return rows.map(fromViewRow);
  }

  async view(id: string) {
    const { rows } = await this.pool.query<ViewRow>(`select ${VIEW_COLUMNS} from folio.views where id = $1`, [id]);
    return rows[0] && fromViewRow(rows[0]);
  }

  async createView({ library, name, query, createdBy }: { library: string; name: string; query: ViewQuery; createdBy: string }) {
    try {
      const { rows } = await this.pool.query<ViewRow>(
        `insert into folio.views (id, workspace_id, library_id, name, query, created_by)
          select $1, workspace_id, id, $3, $4, $5 from folio.libraries where id = $2 returning ${VIEW_COLUMNS}`,
        [randomUUID(), library, name, JSON.stringify(query), createdBy],
      );
      if (!rows[0]) throw new BadParentError('There’s no such library.');
      return fromViewRow(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError(`There’s already a view called ${name} here.`);
      throw err;
    }
  }

  async updateView(id: string, change: { name?: string; query?: ViewQuery }) {
    try {
      const { rows } = await this.pool.query<ViewRow>(
        `update folio.views set name = coalesce($2, name), query = coalesce($3::jsonb, query) where id = $1 returning ${VIEW_COLUMNS}`,
        [id, change.name ?? null, change.query ? JSON.stringify(change.query) : null],
      );
      return rows[0] && fromViewRow(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError(`There’s already a view called ${change.name} here.`);
      throw err;
    }
  }

  async deleteView(id: string) {
    const { rowCount } = await this.pool.query('delete from folio.views where id = $1', [id]);
    return rowCount === 1;
  }
}
