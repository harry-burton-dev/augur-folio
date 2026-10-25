import type { MountContext } from '@augur/mfe-sdk';

export interface Library {
  id: string;
  workspace: string;
  name: string;
  description: string;
  /** Anyone who may tag a document here may make new tags too. */
  freeTags: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A tag: the org's when it has no library, else that library's own. */
export interface Tag {
  id: string;
  workspace: string;
  library?: string;
  name: string;
  createdBy: string;
  createdAt: string;
}

export type DocumentSort = 'title' | 'newest' | 'updated';
export type Since = 'week' | 'month' | 'quarter' | 'year';

/** A set of filters, as a saved view keeps it. */
export interface ViewQuery {
  folder?: string;
  tags?: string[];
  types?: string[];
  authors?: string[];
  since?: Since;
  sort?: DocumentSort;
}

export interface SavedView {
  id: string;
  library: string;
  name: string;
  query: ViewQuery;
  createdBy: string;
  createdAt: string;
}

export interface Person {
  id: string;
  name: string;
}

/** Which documents to list: a view's filters, whether to look in every folder below, and the page. */
export interface ListQuery extends ViewQuery {
  below?: boolean;
  limit?: number;
  offset?: number;
}

export interface Folder {
  id: string;
  library: string;
  parent?: string;
  name: string;
  createdBy: string;
  createdAt: string;
}

export interface LibraryRights {
  manage: boolean;
  addFolders: boolean;
  addDocuments: boolean;
  /** Make new tags: leads, or anyone when the library takes free tags. */
  addTags: boolean;
}

/** How a version's reader copy is coming along: the rendition worker makes it after upload. */
export interface ReaderState {
  state: 'queued' | 'running' | 'ready' | 'failed';
  /** Why it failed, in words a person can act on. */
  error?: string;
  /** How many pages the original has, when it has pages (PDF). */
  pages?: number;
  thumbnail: boolean;
  engine?: string;
}

export interface DocumentVersion {
  id: string;
  document: string;
  number: number;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  createdBy: string;
  createdAt: string;
  reader: ReaderState;
}

export interface FolioDocument {
  id: string;
  workspace: string;
  library: string;
  folder?: string;
  title: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  latest: DocumentVersion;
  /** Tag ids: the org's or its library's. */
  tags: string[];
  /** Whether the caller may add versions, retag, retitle, move or delete it. */
  can: { change: boolean };
}

export interface OpenDocument extends FolioDocument {
  /** Newest first. */
  versions: DocumentVersion[];
}

/** What Folio takes, by file ending, and the media type each is sent as. */
export const FILE_TYPES: Record<string, { type: string; word: string }> = {
  '.pdf': { type: 'application/pdf', word: 'PDF' },
  '.docx': { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', word: 'Word' },
  '.html': { type: 'text/html', word: 'HTML' },
  '.htm': { type: 'text/html', word: 'HTML' },
  '.md': { type: 'text/markdown', word: 'Markdown' },
  '.markdown': { type: 'text/markdown', word: 'Markdown' },
  '.txt': { type: 'text/plain', word: 'Text' },
};

/** File kinds as the list filters by them. */
export const KINDS: { value: string; label: string }[] = [
  { value: 'pdf', label: 'PDF' },
  { value: 'word', label: 'Word' },
  { value: 'html', label: 'HTML' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'text', label: 'Text' },
];

/** For a drop zone's or file input's `accept`. */
export const ACCEPT = Object.keys(FILE_TYPES).join(',');
export const MAX_UPLOAD_MB = 200;

const endingOf = (filename: string) => (filename.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase();
export const fileTypeOf = (filename: string) => FILE_TYPES[endingOf(filename)];

/** A size people read: "840 KB", "1.2 MB". */
export const sizeWords = (bytes: number) =>
  bytes < 1024 ? `${bytes} bytes` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

export interface OpenLibrary extends Library {
  folders: Folder[];
  /** The org's tags and the library's own, by name. */
  tags: Tag[];
  /** Who added its documents. */
  authors: Person[];
  views: SavedView[];
  can: LibraryRights;
}

/** The address a list of documents is asked for at: each value of a filter once. */
export const listParams = (q: ListQuery) => {
  const params = new URLSearchParams();
  if (q.folder) params.set('folder', q.folder);
  if (q.below) params.set('below', 'true');
  for (const t of q.tags ?? []) params.append('tag', t);
  for (const t of q.types ?? []) params.append('type', t);
  for (const a of q.authors ?? []) params.append('author', a);
  if (q.since) params.set('since', q.since);
  if (q.sort && q.sort !== 'title') params.set('sort', q.sort);
  if (q.limit) params.set('limit', String(q.limit));
  if (q.offset) params.set('offset', String(q.offset));
  return params;
};

/** Folio's service said no; `message` is meant for people. */
export class FolioError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Folio's own API, through the gateway, always for the floor the app is on. */
export class FolioApi {
  constructor(private readonly fetchOnFloor: MountContext['fetch']) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.answer<T>(
      await this.fetchOnFloor(`/api/folio/v1${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      }),
    );
  }

  /** The answer's body, or a FolioError in words people can act on. */
  private async answer<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const problem = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      // The gateway stops a file past the app's limit before Folio sees it, in its own words.
      if (res.status === 413) throw new FolioError(problem.error === 'too-large' && problem.message ? problem.message : `A file can be ${MAX_UPLOAD_MB} MB at most.`, 413, 'too-large');
      throw new FolioError(res.status >= 500 || !problem.message ? 'Folio isn’t answering. Try again in a moment.' : problem.message, res.status, problem.error);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** Sends a file as it is, streamed, typed by its ending. */
  private async sendFile<T>(path: string, file: File, query: Record<string, string | undefined>, tags: readonly string[] = []): Promise<T> {
    const kind = fileTypeOf(file.name);
    if (!kind) throw new FolioError('Folio takes PDF, Word (.docx), HTML, Markdown and plain text files.', 415, 'unsupported-type');
    const params = new URLSearchParams(Object.entries({ filename: file.name, ...query }).filter((e): e is [string, string] => Boolean(e[1])));
    for (const t of tags) params.append('tag', t);
    return this.answer<T>(await this.fetchOnFloor(`/api/folio/v1${path}?${params}`, { method: 'POST', headers: { 'content-type': kind.type }, body: file }));
  }

  libraries() {
    return this.call<{ libraries: Library[]; can: { create: boolean } }>('GET', '/libraries');
  }

  library(id: string) {
    return this.call<OpenLibrary>('GET', `/libraries/${encodeURIComponent(id)}`);
  }

  createLibrary(name: string, description?: string) {
    return this.call<Library>('POST', '/libraries', { name, ...(description ? { description } : {}) });
  }

  updateLibrary(id: string, change: { name?: string; description?: string; freeTags?: boolean }) {
    return this.call<Library>('PATCH', `/libraries/${encodeURIComponent(id)}`, change);
  }

  archiveLibrary(id: string) {
    return this.call<void>('POST', `/libraries/${encodeURIComponent(id)}/archive`);
  }

  createFolder(library: string, name: string, parent?: string) {
    return this.call<Folder>('POST', `/libraries/${encodeURIComponent(library)}/folders`, { name, ...(parent ? { parent } : {}) });
  }

  renameFolder(library: string, id: string, name: string) {
    return this.call<Folder>('PATCH', `/libraries/${encodeURIComponent(library)}/folders/${encodeURIComponent(id)}`, { name });
  }

  deleteFolder(library: string, id: string) {
    return this.call<void>('DELETE', `/libraries/${encodeURIComponent(library)}/folders/${encodeURIComponent(id)}`);
  }

  documents(library: string, query: ListQuery = {}) {
    const params = listParams(query).toString();
    return this.call<{ documents: FolioDocument[]; total: number }>('GET', `/libraries/${encodeURIComponent(library)}/documents${params ? `?${params}` : ''}`);
  }

  document(library: string, id: string) {
    return this.call<OpenDocument>('GET', `/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(id)}`);
  }

  upload(library: string, file: File, folder?: string, tags: readonly string[] = []) {
    return this.sendFile<FolioDocument>(`/libraries/${encodeURIComponent(library)}/documents`, file, { folder }, tags);
  }

  setTags(library: string, document: string, tags: string[]) {
    return this.call<FolioDocument>('PUT', `/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(document)}/tags`, { tags });
  }

  /** The org's tags, and whether the caller keeps them (a lead on the org's floor). */
  orgTags() {
    return this.call<{ tags: Tag[]; can: { manage: boolean } }>('GET', '/tags');
  }

  /** A tag for the library, or for the org when `library` is undefined. */
  createTag(library: string | undefined, name: string) {
    return this.call<Tag>('POST', library ? `/libraries/${encodeURIComponent(library)}/tags` : '/tags', { name });
  }

  renameTag(tag: Tag, name: string) {
    return this.call<Tag>('PATCH', `${tag.library ? `/libraries/${encodeURIComponent(tag.library)}` : ''}/tags/${encodeURIComponent(tag.id)}`, { name });
  }

  deleteTag(tag: Tag) {
    return this.call<void>('DELETE', `${tag.library ? `/libraries/${encodeURIComponent(tag.library)}` : ''}/tags/${encodeURIComponent(tag.id)}`);
  }

  createView(library: string, name: string, query: ViewQuery) {
    return this.call<SavedView>('POST', `/libraries/${encodeURIComponent(library)}/views`, { name, query });
  }

  updateView(library: string, id: string, change: { name?: string; query?: ViewQuery }) {
    return this.call<SavedView>('PATCH', `/libraries/${encodeURIComponent(library)}/views/${encodeURIComponent(id)}`, change);
  }

  deleteView(library: string, id: string) {
    return this.call<void>('DELETE', `/libraries/${encodeURIComponent(library)}/views/${encodeURIComponent(id)}`);
  }

  addVersion(library: string, document: string, file: File) {
    return this.sendFile<DocumentVersion>(`/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(document)}/versions`, file, {});
  }

  updateDocument(library: string, id: string, change: { title?: string; folder?: string | null }) {
    return this.call<FolioDocument>('PATCH', `/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(id)}`, change);
  }

  deleteDocument(library: string, id: string) {
    return this.call<void>('DELETE', `/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(id)}`);
  }

  /** Asks again for a reader copy that failed. */
  retryReader(library: string, document: string, number: number) {
    return this.call<ReaderState>('POST', `/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(document)}/versions/${number}/reader/retry`);
  }

  /** A version's reader copy, as Markdown. */
  async reader(library: string, document: string, number: number): Promise<string> {
    const res = await this.fetchOnFloor(`${this.versionPath(library, document, number)}/reader`);
    if (!res.ok) await this.answer(res);
    return res.text();
  }

  /** A picture a version's reader copy shows, by its name there (`1.png`). */
  async readerImage(library: string, document: string, number: number, name: string): Promise<Blob> {
    const res = await this.fetchOnFloor(`${this.versionPath(library, document, number)}/reader/images/${encodeURIComponent(name)}`);
    if (!res.ok) await this.answer(res);
    return res.blob();
  }

  private versionPath(library: string, document: string, number: number) {
    return `/api/folio/v1/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(document)}/versions/${number}`;
  }

  /** A version's file exactly as it was uploaded. Each download goes in the audit log. */
  async original(library: string, document: string, number: number): Promise<Blob> {
    const res = await this.fetchOnFloor(`/api/folio/v1/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(document)}/versions/${number}/original`);
    if (!res.ok) await this.answer(res);
    return res.blob();
  }
}

/**
 * Where a path inside Folio points: `/libraries`, `/libraries/new`, `/libraries/<id>`,
 * `/libraries/<id>/<folder>`, or a saved view, `/libraries/<id>/views/<view>`.
 */
export interface Place {
  library?: string;
  folder?: string;
  view?: string;
  /** A document being read, and which version of it (the newest when there's none). */
  document?: string;
  version?: number;
  /** Open "New library" straight away (the menu's item). */
  adding: boolean;
}

export const placeFor = (path: string): Place => {
  const [first, second, third, fourth, fifth, sixth] = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (first !== 'libraries' || !second) return { adding: false };
  if (second === 'new') return { adding: true };
  if (third === 'documents' && fourth) {
    const version = fifth === 'versions' && /^[1-9]\d*$/.test(sixth ?? '') ? Number(sixth) : undefined;
    return { library: second, document: fourth, ...(version ? { version } : {}), adding: false };
  }
  if (third === 'views') return { library: second, ...(fourth ? { view: fourth } : {}), adding: false };
  return { library: second, ...(third ? { folder: third } : {}), adding: false };
};

export const pathFor = ({ library, folder, view, document, version }: Omit<Place, 'adding'>) => {
  if (!library) return '/libraries';
  const at = `/libraries/${encodeURIComponent(library)}`;
  if (document) return `${at}/documents/${encodeURIComponent(document)}${version ? `/versions/${version}` : ''}`;
  return view ? `${at}/views/${encodeURIComponent(view)}` : folder ? `${at}/${encodeURIComponent(folder)}` : at;
};
