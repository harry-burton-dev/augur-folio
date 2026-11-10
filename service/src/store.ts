import { randomUUID } from 'node:crypto';
import type { DatabaseClient, DatabasePool, DatabaseRow } from '@augur/service-kit';
import type { ContainerState, ContentState, Level } from '@augur/records';
import type { FloorKind, FolderLevel, GrantKind, ReaderState, UnitLevel } from './api-types.ts';

/**
 * Artifacts' store: one library per floor, its folders, documents and their versions, tags and grants,
 * in the app's own schema (migrations.ts). Every query keeps to the floor it is asked about; who may see
 * or change what is decided in access.ts, before the store is asked.
 */

export interface FloorRow {
  workspace: string;
  kind: FloorKind;
  freeTags: boolean;
}

export interface FolderRecord {
  id: string;
  workspace: string;
  parent?: string;
  level: FolderLevel;
  name: string;
  description: string;
  state: ContainerState;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
}

export interface VersionRecord {
  id: string;
  document: string;
  number: number;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  objectKey: string;
  state: ContentState;
  createdBy: string;
  createdAt: string;
  /** Where its reader copy is: undefined for a version made before reader copies were. */
  reader?: ReaderState;
  thumbnail: boolean;
}

/** A version's reader copy, as the worker left it. */
export interface RenditionRecord {
  version: string;
  document: string;
  state: ReaderState;
  tries: number;
  why?: string;
  pages?: number;
  readerKey?: string;
  thumbnailKey?: string;
  pictureKeys: string[];
}

/** A reader copy for the worker to make: the version it is of, and where the file is. */
export interface RenditionTask {
  version: string;
  document: string;
  number: number;
  filename: string;
  mediaType: string;
  size: number;
  objectKey: string;
  tries: number;
}

/** What the worker made of a version. */
export type RenditionResult =
  | { state: 'ready'; text: string; pages?: number; readerKey: string; thumbnailKey?: string; pictureKeys: string[] }
  | { state: 'none'; why: string };

export interface DocumentRecord {
  id: string;
  workspace: string;
  folder: string;
  title: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  tags: string[];
  /** The newest version. */
  latest: VersionRecord;
  /** The newest version that is Issued, when one is. */
  issued?: VersionRecord;
}

export interface MoveRecord {
  record: string;
  version?: number;
  from?: string;
  to: string;
  by: string;
  at: string;
  note?: string;
}

export interface TagRecord {
  id: string;
  /** Undefined for one of the org's tags. */
  workspace?: string;
  name: string;
}

export interface GrantRecord {
  workspace: string;
  kind: GrantKind;
  record: string;
  principal: string;
  level: Level;
  createdBy: string;
  createdAt: string;
}

export interface NewVersion {
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  objectKey: string;
  createdBy: string;
}

export interface DocumentQuery {
  /** Only documents with every one of these tags, on the document or a folder above it. */
  tags?: readonly string[];
  /** Only documents whose newest version is in one of these states. */
  lifecycle?: readonly ContentState[];
  sort?: 'title' | 'updated' | 'newest';
  limit?: number;
  offset?: number;
}

export const MAX_PAGE = 200;
export const MAX_SEARCH_WORDS = 8;

/** A folder or document put on a floor above its own (migration 004). Floors as placements name them. */
export interface PlacementRecord {
  id: string;
  /** The floor the record is kept on. */
  workspace: string;
  record: { kind: 'folder' | 'document'; id: string };
  from: string;
  to: string;
  toPrincipal: string;
  filter: ContentState[];
  via?: string;
  /** The folder on the receiving floor it was put in; none while it waits under From below. */
  landed?: string;
  note?: string;
  by: string;
  at: string;
  ended?: { at: string; by: string; reason?: string };
}

export class PlacedError extends Error {}

export class NameTakenError extends Error {}
export class NotEmptyError extends Error {}
export class GoneError extends Error {}

/** The words of a search, lower-cased, each at most 64 characters, at most eight. */
export const searchWords = (q: string) => [...new Set((q.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => w.slice(0, 64)))].slice(0, MAX_SEARCH_WORDS);

/** Where a version's file is kept in the app's bucket. */
export const objectKeyFor = (document: string, version: string) => `documents/${document}/${version}`;

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

const iso = (t: unknown) => new Date(t as string).toISOString();
const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === '23505';

const folderOf = (r: DatabaseRow): FolderRecord => ({
  id: r.id as string,
  workspace: r.workspace_id as string,
  ...(r.parent_id ? { parent: r.parent_id as string } : {}),
  level: r.level as FolderLevel,
  name: r.name as string,
  description: r.description as string,
  state: r.state as ContainerState,
  createdBy: r.created_by as string,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  tags: ((r.tags as string[] | null) ?? []).filter(Boolean),
});

const versionOf = (r: DatabaseRow): VersionRecord => ({
  id: r.id as string,
  document: r.document_id as string,
  number: r.number as number,
  filename: r.filename as string,
  mediaType: r.media_type as string,
  size: Number(r.size_bytes),
  sha256: r.sha256 as string,
  objectKey: r.object_key as string,
  state: r.state as ContentState,
  createdBy: r.created_by as string,
  createdAt: iso(r.created_at),
  ...(r.reader ? { reader: r.reader as ReaderState } : {}),
  thumbnail: Boolean(r.thumbnail),
});

/** A version's columns with its reader copy's state, from `document_versions v`. */
const VERSION_SELECT = `
  select v.*, (select r.state from renditions r where r.version_id = v.id) as reader,
    (select r.thumbnail_key is not null from renditions r where r.version_id = v.id) as thumbnail
  from document_versions v`;

/** How long a try may wait before the next: a minute, then five. */
const RETRY_AFTER_SECONDS = [60, 300];
/** Tries before a reader copy is given up on. */
export const RENDITION_TRIES = 3;
/** At most this much of a document's text goes into Find (a tsvector holds at most 1 MB). */
export const MAX_FIND_TEXT = 256 * 1024;

const VERSION_JSON = (alias: string) =>
  `json_build_object('id', ${alias}.id, 'document_id', ${alias}.document_id, 'number', ${alias}.number, 'filename', ${alias}.filename, 'media_type', ${alias}.media_type,
    'size_bytes', ${alias}.size_bytes, 'sha256', ${alias}.sha256, 'object_key', ${alias}.object_key, 'state', ${alias}.state, 'created_by', ${alias}.created_by, 'created_at', ${alias}.created_at,
    'reader', (select r.state from renditions r where r.version_id = ${alias}.id), 'thumbnail', (select r.thumbnail_key is not null from renditions r where r.version_id = ${alias}.id))`;

/** A document with its tags, newest version and newest Issued version, as one row. */
const DOCUMENT_SELECT = `
  select d.id, d.workspace_id, d.folder_id, d.title, d.created_by, d.created_at, d.updated_at, d.deleted_at,
    coalesce((select array_agg(t.name order by lower(t.name)) from document_tags dt join tags t on t.id = dt.tag_id where dt.document_id = d.id), '{}') as tags,
    (select ${VERSION_JSON('v')} from document_versions v where v.document_id = d.id order by v.number desc limit 1) as latest,
    (select ${VERSION_JSON('v')} from document_versions v where v.document_id = d.id and v.state = 'issued' order by v.number desc limit 1) as issued
  from documents d`;

const documentOf = (r: DatabaseRow): DocumentRecord => ({
  id: r.id as string,
  workspace: r.workspace_id as string,
  folder: r.folder_id as string,
  title: r.title as string,
  createdBy: r.created_by as string,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  ...(r.deleted_at ? { deletedAt: iso(r.deleted_at) } : {}),
  tags: (r.tags as string[]) ?? [],
  latest: versionOf(r.latest as DatabaseRow),
  ...(r.issued ? { issued: versionOf(r.issued as DatabaseRow) } : {}),
});

const FOLDER_SELECT = `
  select f.*, coalesce((select array_agg(t.name order by lower(t.name)) from folder_tags ft join tags t on t.id = ft.tag_id where ft.folder_id = f.id), '{}') as tags
  from folders f`;

const ORDER: Record<NonNullable<DocumentQuery['sort']>, string> = {
  title: 'lower(d.title), d.id',
  updated: 'd.updated_at desc, d.id',
  newest: 'd.created_at desc, d.id',
};

export class Store {
  constructor(readonly pool: DatabasePool) {}

  /** Runs `fn` in one transaction. */
  async tx<T>(fn: (client: DatabaseClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  /** The floor's library, made the first time anyone opens Artifacts on it. */
  async floor(workspace: string, kind: FloorKind): Promise<FloorRow> {
    await this.pool.query('insert into floors (workspace_id, kind) values ($1, $2) on conflict (workspace_id) do nothing', [workspace, kind]);
    const { rows } = await this.pool.query('select workspace_id, kind, free_tags from floors where workspace_id = $1', [workspace]);
    return { workspace: rows[0]!.workspace_id as string, kind: rows[0]!.kind as FloorKind, freeTags: rows[0]!.free_tags as boolean };
  }

  /** A floor's library, when anyone has opened Artifacts there. */
  async floorRow(workspace: string): Promise<FloorRow | undefined> {
    const { rows } = await this.pool.query('select workspace_id, kind, free_tags from floors where workspace_id = $1', [workspace]);
    return rows[0] ? { workspace: rows[0].workspace_id as string, kind: rows[0].kind as FloorKind, freeTags: rows[0].free_tags as boolean } : undefined;
  }

  async setFreeTags(workspace: string, freeTags: boolean) {
    await this.pool.query('update floors set free_tags = $2 where workspace_id = $1', [workspace, freeTags]);
  }

  /** Every folder on a floor: a floor's tree is small enough to walk in the service. */
  async folders(workspace: string): Promise<FolderRecord[]> {
    const { rows } = await this.pool.query(`${FOLDER_SELECT} where f.workspace_id = $1 order by lower(f.name), f.id`, [workspace]);
    return rows.map(folderOf);
  }

  async folder(id: string): Promise<FolderRecord | undefined> {
    const { rows } = await this.pool.query(`${FOLDER_SELECT} where f.id = $1`, [id]);
    return rows[0] ? folderOf(rows[0]) : undefined;
  }

  async createFolder(input: { workspace: string; parent?: string; level: FolderLevel; name: string; description?: string; createdBy: string }): Promise<FolderRecord> {
    const id = newId('f');
    try {
      await this.pool.query('insert into folders (id, workspace_id, parent_id, level, name, description, created_by) values ($1, $2, $3, $4, $5, $6, $7)', [
        id,
        input.workspace,
        input.parent ?? null,
        input.level,
        input.name.trim(),
        input.description ?? '',
        input.createdBy,
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError(`There’s already something called “${input.name.trim()}” here.`);
      throw err;
    }
    return (await this.folder(id))!;
  }

  async updateFolder(id: string, change: { name?: string; description?: string }) {
    try {
      await this.pool.query('update folders set name = coalesce($2, name), description = coalesce($3, description), updated_at = now() where id = $1', [id, change.name?.trim() ?? null, change.description ?? null]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError(`There’s already something called “${change.name?.trim()}” here.`);
      throw err;
    }
    return this.folder(id);
  }

  async setFolderState(folder: FolderRecord, to: ContainerState, by: string, note?: string) {
    await this.tx(async (c) => {
      await c.query('update folders set state = $2, updated_at = now() where id = $1', [folder.id, to]);
      await c.query('insert into state_moves (workspace_id, record_id, from_state, to_state, moved_by, note) values ($1, $2, $3, $4, $5, $6)', [folder.workspace, folder.id, folder.state, to, by, note ?? null]);
    });
    return this.folder(folder.id);
  }

  /** Deletes an empty folder: one that holds a folder or a document, even a deleted one, stays. */
  async deleteFolder(id: string) {
    await this.tx(async (c) => {
      const { rows } = await c.query('select (exists (select 1 from folders where parent_id = $1) or exists (select 1 from documents where folder_id = $1)) as held', [id]);
      if (rows[0]?.held) throw new NotEmptyError('Only an empty folder can be deleted: move or delete what’s in it first.');
      await c.query('delete from folder_tags where folder_id = $1', [id]);
      await c.query('delete from grants where record_id = $1', [id]);
      await c.query('delete from folders where id = $1', [id]);
    });
  }

  async createDocument(input: { workspace: string; folder: string; title: string; createdBy: string; tags?: readonly string[] }, first: NewVersion & { id: string }, documentId = newId('d')) {
    await this.tx(async (c) => {
      await c.query('insert into documents (id, workspace_id, folder_id, title, created_by) values ($1, $2, $3, $4, $5)', [documentId, input.workspace, input.folder, input.title.trim(), input.createdBy]);
      await this.#insertVersion(c, input.workspace, documentId, 1, first);
      if (input.tags?.length) await this.#tag(c, documentId, input.workspace, input.tags);
    });
    return (await this.document(documentId))!;
  }

  async #insertVersion(c: DatabaseClient, workspace: string, document: string, number: number, v: NewVersion & { id: string }) {
    await c.query(
      `insert into document_versions (id, workspace_id, document_id, number, filename, media_type, size_bytes, sha256, object_key, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [v.id, workspace, document, number, v.filename, v.mediaType, v.size, v.sha256, v.objectKey, v.createdBy],
    );
    await c.query('insert into state_moves (workspace_id, record_id, version_number, to_state, moved_by) values ($1, $2, $3, $4, $5)', [workspace, document, number, 'in-progress', v.createdBy]);
    // Its reader copy waits for the worker from the moment the version exists.
    await c.query('insert into renditions (version_id, workspace_id, document_id) values ($1, $2, $3)', [v.id, workspace, document]);
  }

  /** Adds the next version. Its number is one past the newest, decided under a lock on the document. */
  async addVersion(document: DocumentRecord, v: NewVersion & { id: string }) {
    await this.tx(async (c) => {
      const { rows } = await c.query('select coalesce(max(number), 0) + 1 as next from document_versions where document_id = (select id from documents where id = $1 for update)', [document.id]);
      await this.#insertVersion(c, document.workspace, document.id, rows[0]!.next as number, v);
      await c.query('update documents set updated_at = now() where id = $1', [document.id]);
    });
    return (await this.document(document.id))!;
  }

  async document(id: string, { deleted = false } = {}): Promise<DocumentRecord | undefined> {
    const { rows } = await this.pool.query(`${DOCUMENT_SELECT} where d.id = $1 ${deleted ? '' : 'and d.deleted_at is null'}`, [id]);
    return rows[0] ? documentOf(rows[0]) : undefined;
  }

  async versions(document: string): Promise<VersionRecord[]> {
    const { rows } = await this.pool.query(`${VERSION_SELECT} where v.document_id = $1 order by v.number desc`, [document]);
    return rows.map(versionOf);
  }

  async version(document: string, number: number): Promise<VersionRecord | undefined> {
    const { rows } = await this.pool.query(`${VERSION_SELECT} where v.document_id = $1 and v.number = $2`, [document, number]);
    return rows[0] ? versionOf(rows[0]) : undefined;
  }

  /** The documents in one folder, or in any of `folders`, a page at a time. */
  async documents(folders: readonly string[], query: DocumentQuery = {}): Promise<{ documents: DocumentRecord[]; total: number }> {
    if (!folders.length) return { documents: [], total: 0 };
    const where = ['d.folder_id = any($1)', 'd.deleted_at is null'];
    const values: unknown[] = [folders];
    if (query.lifecycle?.length) {
      values.push(query.lifecycle);
      where.push(`(select v.state from document_versions v where v.document_id = d.id order by v.number desc limit 1) = any($${values.length})`);
    }
    for (const tag of query.tags ?? []) {
      values.push(tag.toLocaleLowerCase());
      const n = values.length;
      // A tag counts when the document has it, or any folder above it does.
      where.push(`(exists (select 1 from document_tags dt join tags t on t.id = dt.tag_id where dt.document_id = d.id and lower(t.name) = $${n})
        or exists (with recursive up (id) as (select d.folder_id union all select f.parent_id from folders f join up on f.id = up.id where f.parent_id is not null)
          select 1 from folder_tags ft join tags t on t.id = ft.tag_id where ft.folder_id in (select id from up) and lower(t.name) = $${n}))`);
    }
    const limit = Math.min(query.limit ?? MAX_PAGE, MAX_PAGE);
    const offset = query.offset ?? 0;
    const { rows } = await this.pool.query(`${DOCUMENT_SELECT} where ${where.join(' and ')} order by ${ORDER[query.sort ?? 'title']} limit ${limit} offset ${offset}`, values);
    const count = await this.pool.query(`select count(*)::int as n from documents d where ${where.join(' and ')}`, values);
    return { documents: rows.map(documentOf), total: count.rows[0]!.n as number };
  }

  async updateDocument(id: string, change: { title?: string; folder?: string }) {
    await this.pool.query('update documents set title = coalesce($2, title), folder_id = coalesce($3, folder_id), updated_at = now() where id = $1', [id, change.title?.trim() ?? null, change.folder ?? null]);
    return this.document(id);
  }

  async deleteDocument(id: string, by: string) {
    const { rowCount } = await this.pool.query('update documents set deleted_at = now(), deleted_by = $2 where id = $1 and deleted_at is null', [id, by]);
    return rowCount === 1;
  }

  async restoreDocument(id: string) {
    const { rowCount } = await this.pool.query('update documents set deleted_at = null, deleted_by = null where id = $1 and deleted_at is not null and purged_at is null', [id]);
    return rowCount === 1;
  }

  /** Moves a version on in its life, keeping the move. Fails with GoneError when someone moved it first. */
  async moveVersion(document: DocumentRecord, version: VersionRecord, to: ContentState, by: string, note?: string) {
    await this.tx(async (c) => {
      const { rowCount } = await c.query('update document_versions set state = $3 where document_id = $1 and number = $2 and state = $4', [document.id, version.number, to, version.state]);
      if (rowCount !== 1) throw new GoneError('Someone else moved this version on just now: look again.');
      await c.query('insert into state_moves (workspace_id, record_id, version_number, from_state, to_state, moved_by, note) values ($1, $2, $3, $4, $5, $6, $7)', [
        document.workspace,
        document.id,
        version.number,
        version.state,
        to,
        by,
        note ?? null,
      ]);
      await c.query('update documents set updated_at = now() where id = $1', [document.id]);
    });
    return (await this.document(document.id))!;
  }

  async moves(record: string): Promise<MoveRecord[]> {
    const { rows } = await this.pool.query('select * from state_moves where record_id = $1 order by id desc limit 200', [record]);
    return rows.map((r) => ({
      record: r.record_id as string,
      ...(r.version_number != null ? { version: r.version_number as number } : {}),
      ...(r.from_state ? { from: r.from_state as string } : {}),
      to: r.to_state as string,
      by: r.moved_by as string,
      at: iso(r.moved_at),
      ...(r.note ? { note: r.note as string } : {}),
    }));
  }

  /** The versions waiting for review on a floor, oldest first. */
  async inReview(workspace: string, limit = 20): Promise<{ document: string; title: string; number: number; since: string }[]> {
    const { rows } = await this.pool.query(
      `select d.id, d.title, v.number, (select max(m.moved_at) from state_moves m where m.record_id = d.id and m.version_number = v.number and m.to_state = 'in-review') as since
       from document_versions v join documents d on d.id = v.document_id
       where v.workspace_id = $1 and v.state = 'in-review' and d.deleted_at is null order by since limit $2`,
      [workspace, limit],
    );
    return rows.map((r) => ({ document: r.id as string, title: r.title as string, number: r.number as number, since: iso(r.since) }));
  }

  /** Documents on a floor changed since a time, newest first. */
  async changedSince(workspace: string, since: string | undefined, limit = 10): Promise<DocumentRecord[]> {
    const { rows } = await this.pool.query(`${DOCUMENT_SELECT} where d.workspace_id = $1 and d.deleted_at is null and ($2::timestamptz is null or d.updated_at > $2) order by d.updated_at desc limit $3`, [
      workspace,
      since ?? null,
      limit,
    ]);
    return rows.map(documentOf);
  }

  async looked(person: string, workspace: string): Promise<string | undefined> {
    const { rows } = await this.pool.query('select at from looked where person_id = $1 and workspace_id = $2', [person, workspace]);
    return rows[0] ? iso(rows[0].at) : undefined;
  }

  async setLooked(person: string, workspace: string, at = new Date()) {
    await this.pool.query('insert into looked (person_id, workspace_id, at) values ($1, $2, $3) on conflict (person_id, workspace_id) do update set at = excluded.at', [person, workspace, at]);
  }

  /** Documents on a floor whose title, or the text of their newest version, has every word as the start of one. */
  async search(workspace: string, words: readonly string[], limit = 10): Promise<DocumentRecord[]> {
    if (!words.length) return [];
    const query = words.map((w) => `${w.replace(/[^\p{L}\p{N}]/gu, '')}:*`).join(' & ');
    const { rows } = await this.pool.query(`${DOCUMENT_SELECT} where d.workspace_id = $1 and d.deleted_at is null and (d.title_words @@ to_tsquery('simple', $2)
      or exists (select 1 from renditions r where r.version_id = (select v.id from document_versions v where v.document_id = d.id order by v.number desc limit 1) and r.text_words @@ to_tsquery('simple', $2)))
      order by d.updated_at desc limit $3`, [
      workspace,
      query,
      limit,
    ]);
    return rows.map(documentOf);
  }

  // Tags

  /** The org's tags and the floor's own. */
  async tags(workspace: string): Promise<TagRecord[]> {
    const { rows } = await this.pool.query('select id, workspace_id, name from tags where workspace_id is null or workspace_id = $1 order by lower(name)', [workspace]);
    return rows.map((r) => ({ id: r.id as string, ...(r.workspace_id ? { workspace: r.workspace_id as string } : {}), name: r.name as string }));
  }

  async createTag(input: { workspace?: string; name: string; createdBy: string }): Promise<TagRecord> {
    const id = newId('t');
    try {
      await this.pool.query('insert into tags (id, workspace_id, name, created_by) values ($1, $2, $3, $4)', [id, input.workspace ?? null, input.name.trim(), input.createdBy]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError(`There’s already a tag called “${input.name.trim()}”.`);
      throw err;
    }
    return { id, ...(input.workspace ? { workspace: input.workspace } : {}), name: input.name.trim() };
  }

  async #tagIds(c: DatabaseClient | DatabasePool, workspace: string, names: readonly string[]) {
    const { rows } = await c.query('select id, lower(name) as name from tags where (workspace_id is null or workspace_id = $1) and lower(name) = any($2)', [workspace, names.map((n) => n.toLocaleLowerCase())]);
    const found = new Map(rows.map((r) => [r.name as string, r.id as string]));
    const missing = names.filter((n) => !found.has(n.toLocaleLowerCase()));
    return { ids: [...found.values()], missing };
  }

  async #tag(c: DatabaseClient, document: string, workspace: string, names: readonly string[]) {
    const { ids, missing } = await this.#tagIds(c, workspace, names);
    if (missing.length) throw new GoneError(`There’s no tag called “${missing[0]}” here.`);
    await c.query('delete from document_tags where document_id = $1', [document]);
    for (const tag of ids) await c.query('insert into document_tags (document_id, tag_id) values ($1, $2)', [document, tag]);
  }

  /** Sets a document's tags to exactly these, by name. */
  async setDocumentTags(document: DocumentRecord, names: readonly string[]) {
    await this.tx((c) => this.#tag(c, document.id, document.workspace, names));
    return this.document(document.id);
  }

  async setFolderTags(folder: FolderRecord, names: readonly string[]) {
    await this.tx(async (c) => {
      const { ids, missing } = await this.#tagIds(c, folder.workspace, names);
      if (missing.length) throw new GoneError(`There’s no tag called “${missing[0]}” here.`);
      await c.query('delete from folder_tags where folder_id = $1', [folder.id]);
      for (const tag of ids) await c.query('insert into folder_tags (folder_id, tag_id) values ($1, $2)', [folder.id, tag]);
    });
    return this.folder(folder.id);
  }

  // Grants

  /** Every grant on a floor: on its library, its folders and its documents. */
  async grants(workspace: string): Promise<GrantRecord[]> {
    const { rows } = await this.pool.query('select * from grants where workspace_id = $1 order by created_at', [workspace]);
    return rows.map(grantOf);
  }

  /** Every grant to any of these principals, on any floor: what has been shared with someone. */
  async grantsTo(principals: readonly string[]): Promise<GrantRecord[]> {
    const { rows } = await this.pool.query('select * from grants where principal = any($1) order by created_at desc limit 500', [principals]);
    return rows.map(grantOf);
  }

  async grant(input: Omit<GrantRecord, 'createdAt'>) {
    await this.pool.query(
      `insert into grants (workspace_id, record_kind, record_id, principal, level, created_by) values ($1, $2, $3, $4, $5, $6)
       on conflict (record_id, principal) do update set level = excluded.level, created_by = excluded.created_by, created_at = now()`,
      [input.workspace, input.kind, input.record, input.principal, input.level, input.createdBy],
    );
  }

  async revoke(record: string, principal: string) {
    const { rowCount } = await this.pool.query('delete from grants where record_id = $1 and principal = $2', [record, principal]);
    return rowCount === 1;
  }

  // People and level names

  /** Keeps the name someone goes by, to show them by. */
  async seen(person: { id: string; name: string }) {
    if (!person.name) return;
    await this.pool.query('insert into people (id, name) values ($1, $2) on conflict (id) do update set name = excluded.name, seen_at = now() where people.name <> excluded.name', [person.id, person.name]);
  }

  async names(ids: readonly string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const { rows } = await this.pool.query('select id, name from people where id = any($1)', [[...new Set(ids)]]);
    return new Map(rows.map((r) => [r.id as string, r.name as string]));
  }

  async levelNames(): Promise<Partial<Record<UnitLevel, { name: string; plural: string }>>> {
    const { rows } = await this.pool.query('select level, name, plural from level_names');
    return Object.fromEntries(rows.map((r) => [r.level as string, { name: r.name as string, plural: r.plural as string }]));
  }

  async setLevelName(level: UnitLevel, name: { name: string; plural: string } | null, by: string) {
    if (!name) await this.pool.query('delete from level_names where level = $1', [level]);
    else
      await this.pool.query('insert into level_names (level, name, plural, updated_by) values ($1, $2, $3, $4) on conflict (level) do update set name = excluded.name, plural = excluded.plural, updated_by = excluded.updated_by, updated_at = now()', [
        level,
        name.name.trim(),
        name.plural.trim(),
        by,
      ]);
  }

  // Retention

  /** Deleted documents past the retention days whose files haven't been cleared yet, with every file's key. */
  async purgeable(days: number, limit = 50): Promise<{ id: string; keys: string[] }[]> {
    const { rows } = await this.pool.query(
      `select d.id, array(select v.object_key from document_versions v where v.document_id = d.id
         union all select k from renditions r, unnest(array_remove(array[r.reader_key, r.thumbnail_key], null) || r.picture_keys) k where r.document_id = d.id) as keys
       from documents d
       where d.deleted_at is not null and d.purged_at is null and d.deleted_at < now() - make_interval(days => $1) order by d.deleted_at limit $2`,
      [days, limit],
    );
    return rows.map((r) => ({ id: r.id as string, keys: r.keys as string[] }));
  }

  async purged(id: string) {
    await this.tx(async (c) => {
      await c.query('update documents set purged_at = now() where id = $1', [id]);
      // Its text leaves Find with its files.
      await c.query(`update renditions set state = 'none', why = 'It was deleted, and its files have been cleared.', text_words = null, reader_key = null, thumbnail_key = null, picture_keys = '{}' where document_id = $1`, [id]);
    });
  }

  // Reader copies

  async rendition(version: string): Promise<RenditionRecord | undefined> {
    const { rows } = await this.pool.query('select * from renditions where version_id = $1', [version]);
    return rows[0] ? renditionOf(rows[0]) : undefined;
  }

  /**
   * Takes the oldest reader copy that is due, for `leaseSeconds`: one queued and due, or one whose last
   * worker stopped holding it. SKIP LOCKED, so two workers never take the same one. One taken for the last
   * time and lost again is given up on first.
   */
  async takeRendition(leaseSeconds: number): Promise<RenditionTask | undefined> {
    await this.pool.query(
      `update renditions set state = 'failed', finished_at = now(), lease_until = null, why = 'Making its reader copy stopped part way, ${RENDITION_TRIES} times.'
       where state = 'working' and lease_until < now() and tries >= $1`,
      [RENDITION_TRIES],
    );
    const { rows } = await this.pool.query(
      `update renditions r set state = 'working', tries = r.tries + 1, lease_until = now() + make_interval(secs => $1)
       from document_versions v
       where v.id = r.version_id and r.version_id = (
         select version_id from renditions
         where (state = 'queued' and queued_at <= now()) or (state = 'working' and lease_until < now())
         order by queued_at limit 1 for update skip locked)
       returning r.version_id, r.document_id, r.tries, v.number, v.filename, v.media_type, v.size_bytes, v.object_key`,
      [leaseSeconds],
    );
    const r = rows[0];
    return r
      ? {
          version: r.version_id as string,
          document: r.document_id as string,
          number: r.number as number,
          filename: r.filename as string,
          mediaType: r.media_type as string,
          size: Number(r.size_bytes),
          objectKey: r.object_key as string,
          tries: r.tries as number,
        }
      : undefined;
  }

  /** Keeps what the worker made. False when it no longer held the copy (its lease ran out and another took it). */
  async finishRendition(task: RenditionTask, result: RenditionResult): Promise<boolean> {
    const { rowCount } =
      result.state === 'ready'
        ? await this.pool.query(
            `update renditions set state = 'ready', finished_at = now(), lease_until = null, why = null, pages = $3, reader_key = $4, thumbnail_key = $5, picture_keys = $6,
               text_words = to_tsvector('simple', $7) where version_id = $1 and state = 'working' and tries = $2`,
            [task.version, task.tries, result.pages ?? null, result.readerKey, result.thumbnailKey ?? null, result.pictureKeys, result.text.slice(0, MAX_FIND_TEXT)],
          )
        : await this.pool.query(`update renditions set state = 'none', finished_at = now(), lease_until = null, why = $3 where version_id = $1 and state = 'working' and tries = $2`, [
            task.version,
            task.tries,
            result.why,
          ]);
    return rowCount === 1;
  }

  /** A try that failed: queued again after a wait, or given up on after the last. */
  async failRendition(task: RenditionTask, why: string) {
    const last = task.tries >= RENDITION_TRIES;
    await this.pool.query(
      `update renditions set state = $3, lease_until = null, why = $4, finished_at = case when $3 = 'failed' then now() end,
         queued_at = case when $3 = 'queued' then now() + make_interval(secs => $5) else queued_at end
       where version_id = $1 and state = 'working' and tries = $2`,
      [task.version, task.tries, last ? 'failed' : 'queued', why, RETRY_AFTER_SECONDS[task.tries - 1] ?? 300],
    );
  }

  /** Asks for a reader copy again, from three fresh tries. Only one that failed. */
  async retryRendition(version: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`update renditions set state = 'queued', tries = 0, why = null, queued_at = now(), finished_at = null where version_id = $1 and state = 'failed'`, [version]);
    return rowCount === 1;
  }

  // Publishing up

  async place(input: Omit<PlacementRecord, 'id' | 'at' | 'ended'>): Promise<PlacementRecord> {
    const id = newId('p');
    try {
      await this.pool.query(
        `insert into placements (id, workspace_id, record_kind, record_id, from_floor, to_floor, to_principal, filter, via, landed_folder, note, placed_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [id, input.workspace, input.record.kind, input.record.id, input.from, input.to, input.toPrincipal, input.filter, input.via ?? null, input.landed ?? null, input.note ?? null, input.by],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new PlacedError('It’s already on that floor.');
      throw err;
    }
    return (await this.placement(id))!;
  }

  async placement(id: string): Promise<PlacementRecord | undefined> {
    const { rows } = await this.pool.query('select * from placements where id = $1', [id]);
    return rows[0] ? placementOf(rows[0]) : undefined;
  }

  /** Every placement of these records, taken back or not, oldest first. */
  async placementsOf(records: readonly string[]): Promise<PlacementRecord[]> {
    if (!records.length) return [];
    const { rows } = await this.pool.query('select * from placements where record_id = any($1) order by placed_at, id', [[...new Set(records)]]);
    return rows.map(placementOf);
  }

  /** What is on a floor through publishing up, live, newest first. */
  async placementsTo(floor: string, limit = 200): Promise<PlacementRecord[]> {
    const { rows } = await this.pool.query('select * from placements where to_floor = $1 and ended_at is null order by placed_at desc limit $2', [floor, limit]);
    return rows.map(placementOf);
  }

  /** What a floor's leads put in one of its folders. */
  async landedIn(folder: string): Promise<PlacementRecord[]> {
    const { rows } = await this.pool.query('select * from placements where landed_folder = $1 and ended_at is null order by placed_at desc limit 200', [folder]);
    return rows.map(placementOf);
  }

  async landPlacement(id: string, folder: string | null) {
    await this.pool.query('update placements set landed_folder = $2 where id = $1 and ended_at is null', [id, folder]);
    return this.placement(id);
  }

  /** Takes these back, once each. */
  async endPlacements(ids: readonly string[], by: string, reason?: string): Promise<PlacementRecord[]> {
    const { rows } = await this.pool.query('update placements set ended_at = now(), ended_by = $2, ended_reason = $3 where id = any($1) and ended_at is null returning *', [[...ids], by, reason ?? null]);
    return rows.map(placementOf);
  }

}

const renditionOf = (r: DatabaseRow): RenditionRecord => ({
  version: r.version_id as string,
  document: r.document_id as string,
  state: r.state as ReaderState,
  tries: r.tries as number,
  ...(r.why ? { why: r.why as string } : {}),
  ...(r.pages != null ? { pages: r.pages as number } : {}),
  ...(r.reader_key ? { readerKey: r.reader_key as string } : {}),
  ...(r.thumbnail_key ? { thumbnailKey: r.thumbnail_key as string } : {}),
  pictureKeys: (r.picture_keys as string[] | null) ?? [],
});

const grantOf = (r: DatabaseRow): GrantRecord => ({
  workspace: r.workspace_id as string,
  kind: r.record_kind as GrantKind,
  record: r.record_id as string,
  principal: r.principal as string,
  level: r.level as Level,
  createdBy: r.created_by as string,
  createdAt: iso(r.created_at),
});

const placementOf = (r: DatabaseRow): PlacementRecord => ({
  id: r.id as string,
  workspace: r.workspace_id as string,
  record: { kind: r.record_kind as 'folder' | 'document', id: r.record_id as string },
  from: r.from_floor as string,
  to: r.to_floor as string,
  toPrincipal: r.to_principal as string,
  filter: r.filter as ContentState[],
  ...(r.via ? { via: r.via as string } : {}),
  ...(r.landed_folder ? { landed: r.landed_folder as string } : {}),
  ...(r.note ? { note: r.note as string } : {}),
  by: r.placed_by as string,
  at: iso(r.placed_at),
  ...(r.ended_at ? { ended: { at: iso(r.ended_at), by: r.ended_by as string, ...(r.ended_reason ? { reason: r.ended_reason as string } : {}) } } : {}),
});
