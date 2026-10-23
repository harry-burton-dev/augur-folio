import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BadParentError, MAX_FOLDER_DEPTH, MemoryFolioStore, NameTakenError, NotEmptyError, PgFolioStore, type FolioStore } from './store.ts';

/** The same behaviour from every store. */
const behavesLikeAStore = (make: () => FolioStore, reset: () => Promise<void> = async () => {}) => {
  let store: FolioStore;
  beforeEach(async () => {
    await reset();
    store = make();
  });

  it('keeps each floor’s libraries to itself, by name, one of each name', async () => {
    const policies = await store.createLibrary({ workspace: 'w-fin', name: 'Policies', createdBy: 'u-1' });
    await store.createLibrary({ workspace: 'w-fin', name: 'Board papers', description: 'Minutes and packs', createdBy: 'u-1' });
    await store.createLibrary({ workspace: 'w-legal', name: 'Policies', createdBy: 'u-2' });
    expect((await store.libraries('w-fin')).map((l) => l.name)).toEqual(['Board papers', 'Policies']);
    expect((await store.libraries('w-legal')).map((l) => l.workspace)).toEqual(['w-legal']);
    expect(await store.library(policies.id)).toMatchObject({ name: 'Policies', workspace: 'w-fin', description: '', createdBy: 'u-1' });
    await expect(store.createLibrary({ workspace: 'w-fin', name: 'policies', createdBy: 'u-3' })).rejects.toBeInstanceOf(NameTakenError);
  });

  it('renames a library, and archives one so its name is free again', async () => {
    const a = await store.createLibrary({ workspace: 'w-fin', name: 'Policies', createdBy: 'u-1' });
    const b = await store.createLibrary({ workspace: 'w-fin', name: 'Reports', createdBy: 'u-1' });
    await expect(store.updateLibrary(b.id, { name: 'POLICIES' })).rejects.toBeInstanceOf(NameTakenError);
    expect(await store.updateLibrary(b.id, { description: 'Every week' })).toMatchObject({ name: 'Reports', description: 'Every week' });
    expect(await store.archiveLibrary(a.id, 'u-1')).toBe(true);
    expect(await store.archiveLibrary(a.id, 'u-1')).toBe(false);
    expect(await store.library(a.id)).toBeUndefined();
    expect(await store.updateLibrary(a.id, { name: 'Old' })).toBeUndefined();
    expect((await store.updateLibrary(b.id, { name: 'Policies' }))?.name).toBe('Policies');
  });

  it('nests folders, one name per place, so deep and no deeper', async () => {
    const lib = await store.createLibrary({ workspace: 'w-fin', name: 'Policies', createdBy: 'u-1' });
    const other = await store.createLibrary({ workspace: 'w-fin', name: 'Other', createdBy: 'u-1' });
    const hr = await store.createFolder({ library: lib.id, name: 'HR', createdBy: 'u-1' });
    const leave = await store.createFolder({ library: lib.id, parent: hr.id, name: 'Leave', createdBy: 'u-2' });
    await store.createFolder({ library: lib.id, name: 'Leave', createdBy: 'u-2' });
    await expect(store.createFolder({ library: lib.id, parent: hr.id, name: 'leave', createdBy: 'u-2' })).rejects.toBeInstanceOf(NameTakenError);
    await expect(store.createFolder({ library: other.id, parent: hr.id, name: 'X', createdBy: 'u-2' })).rejects.toBeInstanceOf(BadParentError);
    const folders = (await store.folders(lib.id)).map((f) => [f.name, f.parent ?? null]);
    expect(folders.map(([name]) => name)).toEqual(['HR', 'Leave', 'Leave']);
    expect(folders).toEqual(expect.arrayContaining([['Leave', hr.id], ['Leave', null]]));
    let parent = leave.id;
    for (let depth = 3; depth <= MAX_FOLDER_DEPTH; depth++) parent = (await store.createFolder({ library: lib.id, parent, name: `L${depth}`, createdBy: 'u-1' })).id;
    await expect(store.createFolder({ library: lib.id, parent, name: 'Too deep', createdBy: 'u-1' })).rejects.toBeInstanceOf(BadParentError);
  });

  it('renames folders, and removes only empty ones', async () => {
    const lib = await store.createLibrary({ workspace: 'w-fin', name: 'Policies', createdBy: 'u-1' });
    const hr = await store.createFolder({ library: lib.id, name: 'HR', createdBy: 'u-1' });
    const it_ = await store.createFolder({ library: lib.id, name: 'IT', createdBy: 'u-1' });
    const leave = await store.createFolder({ library: lib.id, parent: hr.id, name: 'Leave', createdBy: 'u-1' });
    await expect(store.renameFolder(lib.id, it_.id, 'hr')).rejects.toBeInstanceOf(NameTakenError);
    expect((await store.renameFolder(lib.id, it_.id, 'IT and security'))?.name).toBe('IT and security');
    expect(await store.renameFolder('elsewhere', it_.id, 'X')).toBeUndefined();
    await expect(store.deleteFolder(lib.id, hr.id)).rejects.toBeInstanceOf(NotEmptyError);
    expect(await store.deleteFolder(lib.id, leave.id)).toBe(true);
    expect(await store.deleteFolder(lib.id, hr.id)).toBe(true);
    expect(await store.deleteFolder(lib.id, hr.id)).toBe(false);
    expect((await store.folders(lib.id)).map((f) => f.name)).toEqual(['IT and security']);
  });
};

describe('MemoryFolioStore', () => behavesLikeAStore(() => new MemoryFolioStore()));

// Runs wherever DATABASE_URL points at a Postgres; CI starts one for it.
describe.runIf(process.env.DATABASE_URL)('PgFolioStore', () => {
  let admin: pg.Pool;
  let store: PgFolioStore;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await admin.query('drop schema if exists folio cascade');
    store = await PgFolioStore.connect(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    await store?.close();
    await admin?.end();
  });

  behavesLikeAStore(
    () => store,
    async () => {
      await admin.query('truncate folio.folders, folio.libraries');
    },
  );

  it('migrates once, however often it starts', async () => {
    await Promise.all([store.migrate(), store.migrate()]);
    const { rows } = await admin.query('select id from folio.migrations');
    expect(rows.map((r) => r.id)).toEqual(['001_libraries']);
  });
});
