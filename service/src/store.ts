import { randomUUID } from 'node:crypto';
import pg from 'pg';

/** A library: a shelf of documents that belongs to one floor (someone's own, a team's, or the org's). */
export interface Library {
  id: string;
  workspace: string;
  name: string;
  description: string;
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
}

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

export interface FolioStore {
  /** The floor's libraries, by name, leaving out archived ones. */
  libraries(workspace: string): Promise<Library[]>;
  /** A library, unless it is archived. */
  library(id: string): Promise<Library | undefined>;
  createLibrary(input: { workspace: string; name: string; description?: string; createdBy: string }): Promise<Library>;
  updateLibrary(id: string, change: { name?: string; description?: string }): Promise<Library | undefined>;
  /** Takes a library off its floor's list, keeping everything in it. */
  archiveLibrary(id: string, by: string): Promise<boolean>;
  /** A library's folders, by name. */
  folders(library: string): Promise<Folder[]>;
  createFolder(input: { library: string; parent?: string; name: string; createdBy: string }): Promise<Folder>;
  renameFolder(library: string, id: string, name: string): Promise<Folder | undefined>;
  /** Removes an empty folder; false when there was no such folder. */
  deleteFolder(library: string, id: string): Promise<boolean>;
  /** The documents in a folder, or at the top of the library when `folder` is undefined, by title. */
  documents(library: string, folder?: string): Promise<FolioDocument[]>;
  /** A document, unless it was deleted. */
  document(id: string): Promise<FolioDocument | undefined>;
  /** A document's versions, newest first. */
  versions(document: string): Promise<DocumentVersion[]>;
  version(document: string, number: number): Promise<StoredVersion | undefined>;
  /** A new document with its first version. The folder must be in the library. */
  createDocument(input: { id: string; library: string; folder?: string; title: string; createdBy: string }, first: NewVersion): Promise<FolioDocument>;
  /** The next version of a document, or undefined when there is no such document. */
  addVersion(document: string, version: NewVersion): Promise<DocumentVersion | undefined>;
  /** Retitles a document, or moves it: `folder: null` moves it to the top of its library. */
  updateDocument(id: string, change: { title?: string; folder?: string | null }): Promise<FolioDocument | undefined>;
  /** Takes a document out of its library, keeping its files and versions. */
  deleteDocument(id: string, by: string): Promise<boolean>;
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

/** Keeps everything in memory: for tests and `pnpm dev:app`. */
const byTitle = (a: FolioDocument, b: FolioDocument) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
const publicVersion = ({ objectKey: _, ...version }: StoredVersion): DocumentVersion => version;

export class MemoryFolioStore implements FolioStore {
  private readonly shelves = new Map<string, Library & { archivedAt?: string }>();
  private readonly folderList: Folder[] = [];
  private readonly docs = new Map<string, Omit<FolioDocument, 'latest'> & { deletedAt?: string }>();
  private readonly versionList: StoredVersion[] = [];

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
    const library: Library = { id: randomUUID(), workspace, name, description, createdBy, createdAt: now, updatedAt: now };
    this.shelves.set(library.id, { ...library });
    return library;
  }

  async updateLibrary(id: string, change: { name?: string; description?: string }) {
    const library = await this.library(id);
    if (!library) return undefined;
    if (change.name !== undefined && (await this.libraries(library.workspace)).some((l) => l.id !== id && sameName(l.name, change.name!)))
      throw new NameTakenError(`There’s already a library called ${change.name} here.`);
    const next = { ...library, ...change, updatedAt: new Date().toISOString() };
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

  private withLatest(doc: Omit<FolioDocument, 'latest'> & { deletedAt?: string }): FolioDocument {
    const { deletedAt: _, ...rest } = doc;
    const latest = this.versionList.filter((v) => v.document === doc.id).reduce((a, b) => (b.number > a.number ? b : a));
    return { ...rest, latest: publicVersion(latest) };
  }

  private async checkFolder(library: string, folder: string | undefined) {
    if (folder && !(await this.folders(library)).some((f) => f.id === folder)) throw new BadParentError('That folder isn’t in this library.');
  }

  async documents(library: string, folder?: string) {
    return [...this.docs.values()].filter((d) => d.library === library && d.folder === folder && !d.deletedAt).map((d) => this.withLatest(d)).sort(byTitle);
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

  async createDocument({ id, library, folder, title, createdBy }: { id: string; library: string; folder?: string; title: string; createdBy: string }, first: NewVersion) {
    const shelf = await this.library(library);
    if (!shelf) throw new BadParentError('There’s no such library.');
    await this.checkFolder(library, folder);
    const now = new Date().toISOString();
    this.docs.set(id, { id, workspace: shelf.workspace, library, ...(folder ? { folder } : {}), title, createdBy, createdAt: now, updatedAt: now });
    this.versionList.push({ ...first, document: id, number: 1, createdAt: now });
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
];

type LibraryRow = { id: string; workspace_id: string; name: string; description: string; created_by: string; created_at: Date; updated_at: Date };
type FolderRow = { id: string; library_id: string; parent_id: string | null; name: string; created_by: string; created_at: Date };

const fromLibraryRow = (r: LibraryRow): Library => ({
  id: r.id,
  workspace: r.workspace_id,
  name: r.name,
  description: r.description,
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
};

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
});

/** A document with its newest version, as one row. */
const DOCUMENT_SELECT = `
  select d.id, d.workspace_id, d.library_id, d.folder_id, d.title, d.created_by, d.created_at, d.updated_at,
    (select to_jsonb(v) - 'workspace_id' from folio.document_versions v where v.document_id = d.id order by v.number desc limit 1) as latest
  from folio.documents d`;
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

const LIBRARY_COLUMNS = 'id, workspace_id, name, description, created_by, created_at, updated_at';
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

  async updateLibrary(id: string, change: { name?: string; description?: string }) {
    try {
      const { rows } = await this.pool.query<LibraryRow>(
        `update folio.libraries set name = coalesce($2, name), description = coalesce($3, description), updated_at = now()
          where id = $1 and archived_at is null returning ${LIBRARY_COLUMNS}`,
        [id, change.name ?? null, change.description ?? null],
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
  async documents(library: string, folder?: string) {
    const { rows } = await this.pool.query<DocumentRow>(
      `${DOCUMENT_SELECT} where d.library_id = $1 and d.folder_id is not distinct from $2 and d.deleted_at is null order by lower(d.title), d.id`,
      [library, folder ?? null],
    );
    return rows.map(fromDocumentRow);
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

  async createDocument({ id, library, folder, title, createdBy }: { id: string; library: string; folder?: string; title: string; createdBy: string }, first: NewVersion) {
    await this.inTransaction(async (client) => {
      const { rowCount } = await client.query(
        `insert into folio.documents (id, workspace_id, library_id, folder_id, title, created_by)
          select $1, l.workspace_id, l.id, $3, $4, $5 from folio.libraries l
          where l.id = $2 and l.archived_at is null and ($3::text is null or exists (select 1 from folio.folders f where f.id = $3 and f.library_id = l.id))`,
        [id, library, folder ?? null, title, createdBy],
      );
      if (!rowCount) throw new BadParentError(folder ? 'That folder isn’t in this library.' : 'There’s no such library.');
      await this.insertVersion(client, id, 1, first);
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
}
