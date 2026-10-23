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
}

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
    const res = await this.fetchOnFloor(`/api/folio/v1${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const problem = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new FolioError(res.status >= 500 || !problem.message ? 'Folio isn’t answering. Try again in a moment.' : problem.message, res.status, problem.error);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
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
