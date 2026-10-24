import type { MountContext } from '@augur/mfe-sdk';

export interface Library {
  id: string;
  workspace: string;
  name: string;
  description: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
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
  /** Whether the caller may add versions, retitle, move or delete it. */
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
  can: LibraryRights;
}

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
  private async sendFile<T>(path: string, file: File, query: Record<string, string | undefined>): Promise<T> {
    const kind = fileTypeOf(file.name);
    if (!kind) throw new FolioError('Folio takes PDF, Word (.docx), HTML, Markdown and plain text files.', 415, 'unsupported-type');
    const params = new URLSearchParams(Object.entries({ filename: file.name, ...query }).filter((e): e is [string, string] => Boolean(e[1])));
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

  updateLibrary(id: string, change: { name?: string; description?: string }) {
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

  documents(library: string, folder?: string) {
    return this.call<{ documents: FolioDocument[] }>('GET', `/libraries/${encodeURIComponent(library)}/documents${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`);
  }

  document(library: string, id: string) {
    return this.call<OpenDocument>('GET', `/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(id)}`);
  }

  upload(library: string, file: File, folder?: string) {
    return this.sendFile<FolioDocument>(`/libraries/${encodeURIComponent(library)}/documents`, file, { folder });
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

  /** A version's file exactly as it was uploaded. Each download goes in the audit log. */
  async original(library: string, document: string, number: number): Promise<Blob> {
    const res = await this.fetchOnFloor(`/api/folio/v1/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(document)}/versions/${number}/original`);
    if (!res.ok) await this.answer(res);
    return res.blob();
  }
}

/** Where a path inside Folio points: `/libraries`, `/libraries/new`, `/libraries/<id>`, `/libraries/<id>/<folder>`. */
export interface Place {
  library?: string;
  folder?: string;
  /** Open "New library" straight away (the menu's item). */
  adding: boolean;
}

export const placeFor = (path: string): Place => {
  const [first, second, third] = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (first !== 'libraries' || !second) return { adding: false };
  if (second === 'new') return { adding: true };
  return { library: second, ...(third ? { folder: third } : {}), adding: false };
};

export const pathFor = ({ library, folder }: Omit<Place, 'adding'>) =>
  library ? `/libraries/${encodeURIComponent(library)}${folder ? `/${encodeURIComponent(folder)}` : ''}` : '/libraries';
