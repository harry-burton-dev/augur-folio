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
export class MemoryFolioStore implements FolioStore {
  private readonly shelves = new Map<string, Library & { archivedAt?: string }>();
  private readonly folderList: Folder[] = [];

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
    this.folderList.splice(this.folderList.findIndex((f) => f.id === id), 1);
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
  constructor(private readonly pool: pg.Pool) {}

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
      await client.query('create schema if not exists folio');
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
    const { rows } = await this.pool.query<{ found: boolean; children: boolean }>(
      `select exists (select 1 from folio.folders where id = $2 and library_id = $1) as found,
              exists (select 1 from folio.folders where parent_id = $2) as children`,
      [library, id],
    );
    if (!rows[0].found) return false;
    if (rows[0].children) throw new NotEmptyError('Empty the folder first: it has folders in it.');
    try {
      const { rowCount } = await this.pool.query('delete from folio.folders where id = $2 and library_id = $1', [library, id]);
      return rowCount === 1;
    } catch (err) {
      // A folder made inside it in the meantime.
      if ((err as { code?: string }).code === '23503') throw new NotEmptyError('Empty the folder first: it has folders in it.');
      throw err;
    }
  }
}
