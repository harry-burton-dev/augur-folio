import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { following, periodStart } from './cadence.ts';
import { BadParentError, BadTagError, MAX_FOLDER_DEPTH, MemoryFolioStore, NameTakenError, NotEmptyError, PgFolioStore, objectKeyFor, TOPICS, type FolioStore, type NewVersion, type OutboxEvent } from './store.ts';

const file = (doc: string, id: string, size = 10, by = 'u-1', mediaType = 'application/pdf'): NewVersion => ({ id, filename: `${id}.pdf`, mediaType, size, sha256: 'ab'.repeat(32), objectKey: objectKeyFor(doc, id), createdBy: by });
const titles = async (store: FolioStore, library: string, query = {}) => (await store.documents(library, query)).documents.map((d) => d.title);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** The same behaviour from every store. */
const behavesLikeAStore = (make: () => FolioStore, reset: () => Promise<void> = async () => {}, told: (store: FolioStore) => Promise<OutboxEvent[]>) => {
  let store: FolioStore;
  beforeEach(async () => {
    await reset();
    store = make();
  });

  it('keeps each floor’s libraries to itself, by name, one of each name', async () => {
    const policies = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Policies', createdBy: 'u-1' });
    await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Board papers', description: 'Minutes and packs', createdBy: 'u-1' });
    await store.createLibrary({ workspace: 'w-legal', floor: 'tree:w-legal', name: 'Policies', createdBy: 'u-2' });
    expect((await store.libraries('w-fin')).map((l) => l.name)).toEqual(['Board papers', 'Policies']);
    expect((await store.libraries('w-legal')).map((l) => l.workspace)).toEqual(['w-legal']);
    expect(await store.library(policies.id)).toMatchObject({ name: 'Policies', workspace: 'w-fin', description: '', createdBy: 'u-1' });
    await expect(store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'policies', createdBy: 'u-3' })).rejects.toBeInstanceOf(NameTakenError);
  });

  it('renames a library, and archives one so its name is free again', async () => {
    const a = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Policies', createdBy: 'u-1' });
    const b = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Reports', createdBy: 'u-1' });
    await expect(store.updateLibrary(b.id, { name: 'POLICIES' })).rejects.toBeInstanceOf(NameTakenError);
    expect(await store.updateLibrary(b.id, { description: 'Every week' })).toMatchObject({ name: 'Reports', description: 'Every week' });
    expect(await store.archiveLibrary(a.id, 'u-1')).toBe(true);
    expect(await store.archiveLibrary(a.id, 'u-1')).toBe(false);
    expect(await store.library(a.id)).toBeUndefined();
    expect(await store.updateLibrary(a.id, { name: 'Old' })).toBeUndefined();
    expect((await store.updateLibrary(b.id, { name: 'Policies' }))?.name).toBe('Policies');
  });

  it('nests folders, one name per place, so deep and no deeper', async () => {
    const lib = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Policies', createdBy: 'u-1' });
    const other = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Other', createdBy: 'u-1' });
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
    const lib = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Policies', createdBy: 'u-1' });
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

  it('keeps documents in their folder, newest version first, and numbers versions in turn', async () => {
    const lib = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Policies', createdBy: 'u-1' });
    const hr = await store.createFolder({ library: lib.id, name: 'HR', createdBy: 'u-1' });
    const travel = await store.createDocument({ id: 'd-travel', library: lib.id, title: 'Travel policy', createdBy: 'u-1' }, file('d-travel', 'v-1', 1200));
    expect(travel).toMatchObject({ id: 'd-travel', workspace: 'w-fin', library: lib.id, title: 'Travel policy', latest: { number: 1, size: 1200, filename: 'v-1.pdf' } });
    expect(travel.folder).toBeUndefined();
    expect(travel.latest).not.toHaveProperty('objectKey');
    await store.createDocument({ id: 'd-leave', library: lib.id, folder: hr.id, title: 'Annual leave', createdBy: 'u-2' }, file('d-leave', 'v-2'));
    expect(await titles(store, lib.id)).toEqual(['Travel policy']);
    expect(await titles(store, lib.id, { folder: hr.id })).toEqual(['Annual leave']);
    const [second, third] = await Promise.all([store.addVersion('d-travel', file('d-travel', 'v-3', 20, 'u-2')), store.addVersion('d-travel', file('d-travel', 'v-4', 30))]);
    expect([second?.number, third?.number].sort()).toEqual([2, 3]);
    expect((await store.versions('d-travel')).map((v) => v.number)).toEqual([3, 2, 1]);
    expect((await store.document('d-travel'))?.latest.number).toBe(3);
    expect(await store.version('d-travel', 1)).toMatchObject({ number: 1, objectKey: 'documents/d-travel/v-1', sha256: 'ab'.repeat(32) });
    expect(await store.version('d-travel', 9)).toBeUndefined();
    expect(await store.addVersion('nope', file('nope', 'v-5'))).toBeUndefined();
  });

  it('refuses a document in another library’s folder', async () => {
    const lib = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Policies', createdBy: 'u-1' });
    const other = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Other', createdBy: 'u-1' });
    const theirs = await store.createFolder({ library: other.id, name: 'Theirs', createdBy: 'u-1' });
    await expect(store.createDocument({ id: 'd-1', library: lib.id, folder: theirs.id, title: 'X', createdBy: 'u-1' }, file('d-1', 'v-1'))).rejects.toBeInstanceOf(BadParentError);
    await store.createDocument({ id: 'd-2', library: lib.id, title: 'X', createdBy: 'u-1' }, file('d-2', 'v-2'));
    await expect(store.updateDocument('d-2', { folder: theirs.id })).rejects.toBeInstanceOf(BadParentError);
  });

  it('retitles and moves documents, and deletes them out of sight', async () => {
    const lib = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Policies', createdBy: 'u-1' });
    const hr = await store.createFolder({ library: lib.id, name: 'HR', createdBy: 'u-1' });
    await store.createDocument({ id: 'd-1', library: lib.id, title: 'Leave', createdBy: 'u-1' }, file('d-1', 'v-1'));
    expect(await store.updateDocument('d-1', { title: 'Annual leave', folder: hr.id })).toMatchObject({ title: 'Annual leave', folder: hr.id });
    await expect(store.deleteFolder(lib.id, hr.id)).rejects.toBeInstanceOf(NotEmptyError);
    expect((await store.updateDocument('d-1', { folder: null }))?.folder).toBeUndefined();
    expect((await store.updateDocument('d-1', { title: 'Leave' }))?.folder).toBeUndefined();
    expect(await store.deleteDocument('d-1', 'u-1')).toBe(true);
    expect(await store.deleteDocument('d-1', 'u-1')).toBe(false);
    expect(await store.document('d-1')).toBeUndefined();
    expect(await store.documents(lib.id)).toEqual({ documents: [], total: 0 });
    expect(await store.updateDocument('d-1', { title: 'Back' })).toBeUndefined();
    expect(await store.deleteFolder(lib.id, hr.id)).toBe(true);
  });

  it('keeps the org’s tags and each library’s, one of each name, and takes free tags only when asked', async () => {
    const lib = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Policies', createdBy: 'u-1' });
    const other = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Reports', createdBy: 'u-1' });
    expect(lib.freeTags).toBe(false);
    expect((await store.updateLibrary(lib.id, { freeTags: true }))?.freeTags).toBe(true);
    expect((await store.library(lib.id))?.freeTags).toBe(true);
    const policy = await store.createTag({ workspace: 'w-org', name: 'Policy', createdBy: 'u-1' });
    const travel = await store.createTag({ workspace: 'w-fin', library: lib.id, name: 'Travel', createdBy: 'u-1' });
    await store.createTag({ workspace: 'w-fin', library: other.id, name: 'Travel', createdBy: 'u-1' });
    await expect(store.createTag({ workspace: 'w-fin', library: lib.id, name: 'travel', createdBy: 'u-1' })).rejects.toBeInstanceOf(NameTakenError);
    await expect(store.createTag({ workspace: 'w-fin', library: lib.id, name: 'POLICY', createdBy: 'u-1' })).rejects.toThrow('Policy is already one of the org’s tags.');
    await expect(store.createTag({ workspace: 'w-org', name: 'policy', createdBy: 'u-1' })).rejects.toBeInstanceOf(NameTakenError);
    expect((await store.tags(lib.id)).map((t) => [t.name, t.library ?? 'org'])).toEqual([['Policy', 'org'], ['Travel', lib.id]]);
    expect((await store.orgTags()).map((t) => t.id)).toEqual([policy.id]);
    expect(await store.renameTag(travel.id, 'Travel and expenses')).toMatchObject({ name: 'Travel and expenses', library: lib.id });
    await expect(store.renameTag(travel.id, 'Policy')).rejects.toBeInstanceOf(NameTakenError);
    expect(await store.renameTag('nope', 'X')).toBeUndefined();
  });

  it('tags documents with the org’s and their library’s tags only', async () => {
    const lib = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Policies', createdBy: 'u-1' });
    const other = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Reports', createdBy: 'u-1' });
    const policy = await store.createTag({ workspace: 'w-org', name: 'Policy', createdBy: 'u-1' });
    const travel = await store.createTag({ workspace: 'w-fin', library: lib.id, name: 'Travel', createdBy: 'u-1' });
    const theirs = await store.createTag({ workspace: 'w-fin', library: other.id, name: 'Weekly', createdBy: 'u-1' });
    const doc = await store.createDocument({ id: 'd-1', library: lib.id, title: 'Travel policy', createdBy: 'u-1', tags: [travel.id] }, file('d-1', 'v-1'));
    expect(doc.tags).toEqual([travel.id]);
    await expect(store.createDocument({ id: 'd-2', library: lib.id, title: 'X', createdBy: 'u-1', tags: [theirs.id] }, file('d-2', 'v-2'))).rejects.toBeInstanceOf(BadTagError);
    expect(await store.document('d-2')).toBeUndefined();
    expect((await store.setDocumentTags('d-1', [policy.id, travel.id, policy.id]))?.tags).toEqual([policy.id, travel.id].sort());
    await expect(store.setDocumentTags('d-1', [theirs.id])).rejects.toBeInstanceOf(BadTagError);
    expect((await store.document('d-1'))?.tags).toEqual([policy.id, travel.id].sort());
    expect(await store.setDocumentTags('nope', [])).toBeUndefined();
    expect(await store.deleteTag(travel.id)).toBe(true);
    expect(await store.deleteTag(travel.id)).toBe(false);
    expect((await store.document('d-1'))?.tags).toEqual([policy.id]);
  });

  it('takes a library’s tags into a new org tag of the same name, documents and views too', async () => {
    const lib = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Policies', createdBy: 'u-1' });
    const other = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Reports', createdBy: 'u-1' });
    const mine = await store.createTag({ workspace: 'w-fin', library: lib.id, name: 'finance', createdBy: 'u-1' });
    const theirs = await store.createTag({ workspace: 'w-fin', library: other.id, name: 'Finance', createdBy: 'u-1' });
    const keep = await store.createTag({ workspace: 'w-fin', library: lib.id, name: 'Budget', createdBy: 'u-1' });
    await store.createDocument({ id: 'd-1', library: lib.id, title: 'Budget', createdBy: 'u-1', tags: [mine.id, keep.id] }, file('d-1', 'v-1'));
    await store.createDocument({ id: 'd-2', library: other.id, title: 'Q3', createdBy: 'u-1', tags: [theirs.id] }, file('d-2', 'v-2'));
    const view = await store.createView({ library: lib.id, name: 'Money', query: { tags: [mine.id, keep.id], sort: 'newest' }, createdBy: 'u-1' });
    const org = await store.createTag({ workspace: 'w-org', name: 'Finance', createdBy: 'u-9' });
    expect((await store.tags(lib.id)).map((t) => t.name)).toEqual(['Budget', 'Finance']);
    expect(await store.tag(mine.id)).toBeUndefined();
    expect((await store.document('d-1'))?.tags).toEqual([org.id, keep.id].sort());
    expect((await store.document('d-2'))?.tags).toEqual([org.id]);
    expect((await store.view(view.id))?.query).toEqual({ tags: [org.id, keep.id], sort: 'newest' });
    // And renaming an org tag onto a library's takes that one in too.
    const tax = await store.createTag({ workspace: 'w-org', name: 'Tax', createdBy: 'u-9' });
    expect(await store.renameTag(tax.id, 'budget')).toMatchObject({ name: 'budget' });
    expect((await store.document('d-1'))?.tags).toEqual([org.id, tax.id].sort());
    expect((await store.view(view.id))?.query.tags).toEqual([org.id, tax.id]);
    await store.deleteTag(org.id);
    expect((await store.view(view.id))?.query.tags).toEqual([tax.id]);
  });

  it('filters by tags, kinds, authors and time, inside a folder and below it, sorted and paged', async () => {
    const lib = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Policies', createdBy: 'u-1' });
    const hr = await store.createFolder({ library: lib.id, name: 'HR', createdBy: 'u-1' });
    const leave = await store.createFolder({ library: lib.id, parent: hr.id, name: 'Leave', createdBy: 'u-1' });
    const policy = await store.createTag({ workspace: 'w-org', name: 'Policy', createdBy: 'u-1' });
    const draft = await store.createTag({ workspace: 'w-fin', library: lib.id, name: 'Draft', createdBy: 'u-1' });
    await store.createDocument({ id: 'd-1', library: lib.id, title: 'Code of conduct', createdBy: 'u-1', tags: [policy.id] }, file('d-1', 'v-1'));
    await tick();
    await store.createDocument({ id: 'd-2', library: lib.id, folder: hr.id, title: 'Hiring', createdBy: 'u-2', tags: [policy.id, draft.id] }, file('d-2', 'v-2', 10, 'u-2', 'text/markdown'));
    await tick();
    await store.createDocument({ id: 'd-3', library: lib.id, folder: leave.id, title: 'Annual leave', createdBy: 'u-1', tags: [draft.id] }, file('d-3', 'v-3'));
    await tick();
    const mid = new Date().toISOString();
    await tick();
    await store.updateDocument('d-1', { title: 'Conduct' });

    expect(await titles(store, lib.id, { below: true })).toEqual(['Annual leave', 'Conduct', 'Hiring']);
    expect(await titles(store, lib.id, { folder: hr.id, below: true })).toEqual(['Annual leave', 'Hiring']);
    expect(await titles(store, lib.id, { folder: hr.id })).toEqual(['Hiring']);
    expect(await titles(store, lib.id, { below: true, tags: [policy.id] })).toEqual(['Conduct', 'Hiring']);
    expect(await titles(store, lib.id, { below: true, tags: [policy.id, draft.id] })).toEqual(['Hiring']);
    expect(await titles(store, lib.id, { below: true, mediaTypes: ['text/markdown'] })).toEqual(['Hiring']);
    expect(await titles(store, lib.id, { below: true, authors: ['u-1'] })).toEqual(['Annual leave', 'Conduct']);
    expect(await titles(store, lib.id, { below: true, from: mid })).toEqual(['Conduct']);
    expect(await titles(store, lib.id, { below: true, to: mid })).toEqual(['Annual leave', 'Hiring']);
    expect(await titles(store, lib.id, { below: true, sort: 'newest' })).toEqual(['Annual leave', 'Hiring', 'Conduct']);
    expect(await titles(store, lib.id, { below: true, sort: 'updated' })).toEqual(['Conduct', 'Annual leave', 'Hiring']);
    const page = await store.documents(lib.id, { below: true, sort: 'newest', limit: 2, offset: 1 });
    expect([page.documents.map((d) => d.title), page.total]).toEqual([['Hiring', 'Conduct'], 3]);
    expect((await store.documents(lib.id, { below: true, offset: 5 })).total).toBe(3);
    expect(await titles(store, lib.id, { folder: 'elsewhere', below: true })).toEqual([]);
  });

  it('writes down who may read each document, from its floor and its grants', async () => {
    const lib = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Policies', createdBy: 'u-1' });
    const other = await store.createLibrary({ workspace: 'w-ops', floor: 'tree:w-ops', name: 'Runbooks', createdBy: 'u-2' });
    await store.createDocument({ id: 'd-1', library: lib.id, title: 'Travel', createdBy: 'u-1' }, file('d-1', 'v-1'));
    await store.createDocument({ id: 'd-2', library: lib.id, title: 'Expenses', createdBy: 'u-1' }, file('d-2', 'v-2'));
    await store.createDocument({ id: 'd-3', library: other.id, title: 'On call', createdBy: 'u-2' }, file('d-3', 'v-3'));
    expect(await store.readers('d-1')).toEqual(['tree:w-fin']);

    await store.setGrant({ library: lib.id, principal: 'person:u-9', level: 'read', by: 'u-1' });
    await store.setGrant({ library: lib.id, document: 'd-2', principal: 'team:w-legal', level: 'edit', by: 'u-1' });
    expect(await store.readers('d-1')).toEqual(['person:u-9', 'tree:w-fin']);
    expect(await store.readers('d-2')).toEqual(['person:u-9', 'team:w-legal', 'tree:w-fin']);
    expect((await store.grants(lib.id)).map((g) => [g.principal, g.level, g.document])).toEqual([['person:u-9', 'read', undefined]]);
    expect((await store.grants(lib.id, 'd-2')).map((g) => [g.principal, g.level])).toEqual([['team:w-legal', 'edit']]);
    // Granting again changes how far, never doubles up.
    await store.setGrant({ library: lib.id, principal: 'person:u-9', level: 'manage', by: 'u-1' });
    expect((await store.grants(lib.id)).map((g) => g.level)).toEqual(['manage']);

    // Lists keep to what the reader may see.
    expect(await titles(store, lib.id, { readers: ['team:w-legal'] })).toEqual(['Expenses']);
    expect(await titles(store, lib.id, { readers: ['tree:w-fin'] })).toEqual(['Expenses', 'Travel']);
    expect(await titles(store, lib.id, { readers: ['org'] })).toEqual([]);

    // Shared from other floors: a whole library, or one document of one the reader can't otherwise see.
    const shared = await store.shared(['person:u-9', 'team:w-legal'], 'w-ops');
    expect(shared.libraries.map((l) => [l.name, l.level])).toEqual([['Policies', 'manage']]);
    expect(shared.documents).toEqual([]);
    const legal = await store.shared(['team:w-legal'], 'w-legal');
    expect(legal.libraries).toEqual([]);
    expect(legal.documents.map((d) => [d.title, d.level])).toEqual([['Expenses', 'edit']]);
    expect((await store.shared(['team:w-legal'], 'w-fin')).documents).toEqual([]);

    await store.setGrant({ library: lib.id, document: 'd-2', principal: 'team:w-legal', level: null, by: 'u-1' });
    expect(await store.readers('d-2')).toEqual(['person:u-9', 'tree:w-fin']);
    await expect(store.setGrant({ library: lib.id, document: 'd-3', principal: 'org', level: 'read', by: 'u-1' })).rejects.toBeInstanceOf(BadParentError);
  });

  it('names the people it has seen, by name or by id', async () => {
    await store.notePerson({ id: 'u-1', name: 'Alex Rivera' });
    await store.notePerson({ id: 'u-2', name: 'Sam 100% Okafor' });
    expect(await store.people({ q: 'riv' })).toEqual([{ id: 'u-1', name: 'Alex Rivera' }]);
    expect((await store.people({ q: '%' })).map((p) => p.id)).toEqual(['u-2']);
    expect((await store.people({ ids: ['u-2', 'u-3'] })).map((p) => p.id)).toEqual(['u-2']);
  });

  it('names authors by the name Folio last saw', async () => {
    const lib = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Policies', createdBy: 'u-1' });
    await store.notePerson({ id: 'u-2', name: 'Sam' });
    await store.notePerson({ id: 'u-1', name: 'Alex' });
    await store.notePerson({ id: 'u-1', name: 'Alex Rivera' });
    await store.createDocument({ id: 'd-1', library: lib.id, title: 'A', createdBy: 'u-1' }, file('d-1', 'v-1'));
    await store.createDocument({ id: 'd-2', library: lib.id, title: 'B', createdBy: 'u-2' }, file('d-2', 'v-2'));
    await store.createDocument({ id: 'd-3', library: lib.id, title: 'C', createdBy: 'u-3' }, file('d-3', 'v-3'));
    await store.deleteDocument('d-3', 'u-1');
    expect(await store.authors(lib.id)).toEqual([{ id: 'u-1', name: 'Alex Rivera' }, { id: 'u-2', name: 'Sam' }]);
  });

  it('saves views in a library, one of each name', async () => {
    const lib = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Policies', createdBy: 'u-1' });
    const other = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Reports', createdBy: 'u-1' });
    const view = await store.createView({ library: lib.id, name: 'Recent PDFs', query: { types: ['pdf'], since: 'month', sort: 'updated' }, createdBy: 'u-2' });
    await store.createView({ library: other.id, name: 'Recent PDFs', query: {}, createdBy: 'u-2' });
    await store.createView({ library: lib.id, name: 'All', query: {}, createdBy: 'u-2' });
    await expect(store.createView({ library: lib.id, name: 'recent pdfs', query: {}, createdBy: 'u-1' })).rejects.toBeInstanceOf(NameTakenError);
    expect((await store.views(lib.id)).map((v) => v.name)).toEqual(['All', 'Recent PDFs']);
    expect(await store.view(view.id)).toMatchObject({ library: lib.id, createdBy: 'u-2', query: { types: ['pdf'], since: 'month', sort: 'updated' } });
    expect(await store.updateView(view.id, { name: 'PDFs this month' })).toMatchObject({ name: 'PDFs this month', query: { since: 'month' } });
    expect(await store.updateView(view.id, { query: { sort: 'title' } })).toMatchObject({ name: 'PDFs this month', query: { sort: 'title' } });
    await expect(store.updateView(view.id, { name: 'all' })).rejects.toBeInstanceOf(NameTakenError);
    expect(await store.deleteView(view.id)).toBe(true);
    expect(await store.deleteView(view.id)).toBe(false);
    expect(await store.updateView(view.id, { name: 'X' })).toBeUndefined();
  });

  it('queues a rendition for every version, and keeps what the worker made of it', async () => {
    const lib = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Policies', createdBy: 'u-1' });
    const doc = await store.createDocument({ id: 'd-1', library: lib.id, title: 'Travel', createdBy: 'u-1' }, file('d-1', 'v-1'));
    expect(doc.latest.reader).toEqual({ state: 'queued', thumbnail: false });
    expect(await store.rendition('v-1')).toMatchObject({ version: 'v-1', state: 'queued', attempts: 0, images: [] });
    expect(await store.rendition('v-nope')).toBeUndefined();
    expect(await store.retryRendition('v-1')).toBe(false);

    await store.finishRendition('v-1', { state: 'ready', engine: 'docling', engineVersion: '2.14.0', readerKey: 'renditions/v-1/reader.md', thumbnailKey: 'renditions/v-1/thumbnail.png', images: ['1.png'], pages: 3, text: 'Travel policy' });
    const reader = { state: 'ready', pages: 3, thumbnail: true, engine: 'docling 2.14.0' };
    expect((await store.document('d-1'))?.latest.reader).toEqual(reader);
    expect((await store.version('d-1', 1))?.reader).toEqual(reader);
    expect(await store.rendition('v-1')).toMatchObject({ ...reader, attempts: 1, readerKey: 'renditions/v-1/reader.md', images: ['1.png'], text: 'Travel policy' });

    const next = await store.addVersion('d-1', file('d-1', 'v-2'));
    expect(next?.reader.state).toBe('queued');
    await store.finishRendition('v-2', { state: 'failed', error: 'The file is damaged.' });
    expect((await store.versions('d-1')).map((v) => v.reader)).toEqual([{ state: 'failed', error: 'The file is damaged.', thumbnail: false }, reader]);
    expect(await store.retryRendition('v-2')).toBe(true);
    expect(await store.rendition('v-2')).toMatchObject({ state: 'queued', attempts: 0 });
    expect((await store.rendition('v-2'))?.error).toBeUndefined();
  });

  it('publishes one version at a time to an audience, and withdraws it', async () => {
    const lib = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Policies', createdBy: 'u-1' });
    await store.createDocument({ id: 'd-1', library: lib.id, title: 'Travel', createdBy: 'u-1' }, file('d-1', 'v-1'));
    await store.addVersion('d-1', file('d-1', 'v-2'));
    await store.createDocument({ id: 'd-2', library: lib.id, title: 'Expenses', createdBy: 'u-1' }, file('d-2', 'v-3'));
    expect((await store.document('d-1'))?.state).toBe('draft');
    expect(await store.publish({ document: 'd-1', version: 9, audience: ['org'], by: 'u-1' })).toBeUndefined();

    const first = await store.publish({ document: 'd-1', version: 1, audience: ['tree:w-fin', 'team:w-legal', 'tree:w-fin'], note: 'Approved by the board', by: 'u-1' });
    expect(first).toMatchObject({ document: 'd-1', library: lib.id, version: 1, audience: ['team:w-legal', 'tree:w-fin'], note: 'Approved by the board', publishedBy: 'u-1' });
    expect(await store.document('d-1')).toMatchObject({ state: 'published', published: { id: first!.id, version: 1 } });
    await tick();
    // Publishing again replaces it: one version is out at a time.
    const second = await store.publish({ document: 'd-1', version: 2, audience: ['org'], by: 'u-2' });
    const history = await store.publications('d-1');
    expect(history.map((p) => [p.version, p.ended?.as])).toEqual([[2, undefined], [1, 'replaced']]);
    expect(history[1].ended?.by).toBe('u-2');

    expect((await store.publishedTo(['team:w-legal'])).documents).toEqual([]);
    const toMe = await store.publishedTo(['person:u-5', 'org']);
    expect(toMe.total).toBe(1);
    expect(toMe.documents.map((d) => [d.title, d.libraryName, d.published.version])).toEqual([['Travel', 'Policies', 2]]);
    expect(await titles(store, lib.id, { states: ['published'] })).toEqual(['Travel']);
    expect(await titles(store, lib.id, { states: ['draft'] })).toEqual(['Expenses']);

    const withdrawn = await store.withdraw({ document: 'd-1', by: 'u-1', reason: 'Out of date' });
    expect(withdrawn).toMatchObject({ id: second!.id, ended: { as: 'withdrawn', by: 'u-1', reason: 'Out of date' } });
    expect(await store.withdraw({ document: 'd-1', by: 'u-1' })).toBeUndefined();
    const doc = await store.document('d-1');
    expect(doc?.state).toBe('withdrawn');
    expect(doc?.published).toBeUndefined();
    expect((await store.publishedTo(['org'])).documents).toEqual([]);
    expect(await titles(store, lib.id, { states: ['withdrawn', 'draft'] })).toEqual(['Expenses', 'Travel']);

    // Deleted or archived, nothing is out.
    await store.publish({ document: 'd-2', version: 1, audience: ['org'], by: 'u-1' });
    await store.deleteDocument('d-2', 'u-1');
    expect((await store.publishedTo(['org'])).total).toBe(0);
  });

  it('numbers a series’ issues in turn, a period each, and finds the ones either side', async () => {
    const lib = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Reports', createdBy: 'u-1' });
    const other = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Other', createdBy: 'u-1' });
    const weekly = await store.createTag({ workspace: 'w-fin', library: lib.id, name: 'Weekly', createdBy: 'u-1' });
    const run = await store.createSeries({ library: lib.id, name: 'Cash report', cadence: 'weekly', audience: ['tree:w-fin', 'org', 'org'], tags: [weekly.id], createdBy: 'u-1' });
    expect(run).toMatchObject({ name: 'Cash report', cadence: 'weekly', audience: ['org', 'tree:w-fin'], tags: [weekly.id], issues: 0, description: '' });
    expect(run.last).toBeUndefined();
    await expect(store.createSeries({ library: lib.id, name: 'cash REPORT', cadence: 'monthly', createdBy: 'u-1' })).rejects.toBeInstanceOf(NameTakenError);
    await expect(store.createSeries({ library: other.id, name: 'Bad', cadence: 'monthly', tags: [weekly.id], createdBy: 'u-1' })).rejects.toBeInstanceOf(BadTagError);
    await expect(store.createDocument({ id: 'd-x', library: other.id, title: 'X', createdBy: 'u-1', series: run.id }, file('d-x', 'v-x'))).rejects.toBeInstanceOf(BadParentError);

    const first = await store.createDocument({ id: 'd-1', library: lib.id, title: 'One', createdBy: 'u-1', series: run.id }, file('d-1', 'v-1'));
    const now = periodStart('weekly', new Date());
    expect(first.issue).toMatchObject({ series: run.id, number: 1, periodStart: now });
    expect(first.issue!.period).toMatch(/^Week \d+, \d{4}$/);
    const second = await store.createDocument({ id: 'd-2', library: lib.id, title: 'Two', createdBy: 'u-1', series: run.id }, file('d-2', 'v-2'));
    expect(second.issue).toMatchObject({ number: 2, periodStart: following('weekly', now) });
    await store.createDocument({ id: 'd-3', library: lib.id, title: 'Three', createdBy: 'u-1', series: run.id }, file('d-3', 'v-3'));
    await store.createDocument({ id: 'd-plain', library: lib.id, title: 'Plain', createdBy: 'u-1' }, file('d-plain', 'v-plain'));
    expect(await store.series(run.id)).toMatchObject({ issues: 3, last: { document: 'd-3', number: 3 } });
    expect((await store.seriesIn(lib.id)).map((s) => s.name)).toEqual(['Cash report']);

    expect(await titles(store, lib.id, { series: run.id, sort: 'period' })).toEqual(['Three', 'Two', 'One']);
    expect(await titles(store, lib.id, { sort: 'period' })).toEqual(['Three', 'Two', 'One', 'Plain']);
    // Only the ones they may read, or that were published to them, either side.
    expect(await store.neighbours('d-2', ['tree:w-fin'])).toMatchObject({ previous: { id: 'd-1', number: 1, title: 'One' }, next: { id: 'd-3', number: 3 } });
    expect(await store.neighbours('d-2', ['team:w-legal'])).toEqual({});
    await store.publish({ document: 'd-3', version: 1, audience: ['team:w-legal'], by: 'u-1' });
    expect(await store.neighbours('d-2', ['team:w-legal'])).toEqual({ next: { id: 'd-3', library: lib.id, title: 'Three', number: 3, period: expect.any(String) } });
    expect(await titles(store, lib.id, { series: run.id, readers: ['team:w-legal'] })).toEqual([]);
    expect(await titles(store, lib.id, { series: run.id, readers: ['team:w-legal'], audience: true })).toEqual(['Three']);
    expect(await store.neighbours('d-plain', ['tree:w-fin'])).toEqual({});

    // A deleted issue's number goes to the next one, and a series with issues stays.
    await store.deleteDocument('d-3', 'u-1');
    expect((await store.createDocument({ id: 'd-4', library: lib.id, title: 'Four', createdBy: 'u-1', series: run.id }, file('d-4', 'v-4'))).issue?.number).toBe(3);
    await expect(store.deleteSeries(run.id)).rejects.toBeInstanceOf(NotEmptyError);
    const empty = await store.createSeries({ library: lib.id, name: 'Board pack', cadence: 'adhoc', createdBy: 'u-1' });
    expect(await store.deleteSeries(empty.id)).toBe(true);
    expect(await store.deleteSeries(empty.id)).toBe(false);
  });

  it('changes a series, keeps its tags with the tags, follows it, and marks a late issue once', async () => {
    const lib = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Reports', createdBy: 'u-1' });
    const a = await store.createTag({ workspace: 'w-fin', library: lib.id, name: 'Cash', createdBy: 'u-1' });
    const b = await store.createTag({ workspace: 'w-fin', library: lib.id, name: 'Board', createdBy: 'u-1' });
    const run = await store.createSeries({ library: lib.id, name: 'Cash report', cadence: 'weekly', tags: [a.id, b.id], createdBy: 'u-1' });
    await store.createSeries({ library: lib.id, name: 'Board pack', cadence: 'adhoc', createdBy: 'u-1' });
    await expect(store.updateSeries(run.id, { name: 'board PACK' })).rejects.toBeInstanceOf(NameTakenError);
    expect(await store.updateSeries(run.id, { name: 'Cash', cadence: 'monthly', audience: ['org'], description: 'Each month' })).toMatchObject({ name: 'Cash', cadence: 'monthly', audience: ['org'], description: 'Each month' });
    await store.deleteTag(b.id);
    expect((await store.series(run.id))?.tags).toEqual([a.id]);
    const org = await store.createTag({ workspace: 'w-org', name: 'cash', createdBy: 'u-9' });
    expect((await store.series(run.id))?.tags).toEqual([org.id]);
    expect(await store.updateSeries('nope', { name: 'X' })).toBeUndefined();

    await store.follow(run.id, 'u-2', true);
    await store.follow(run.id, 'u-3', true);
    await store.follow(run.id, 'u-2', true);
    await store.follow(run.id, 'u-3', false);
    expect(await store.followers(run.id)).toEqual(['u-2']);

    // Only series that come out on a cadence and have had an issue can be late.
    expect(await store.timedSeries()).toEqual([]);
    await store.createDocument({ id: 'd-1', library: lib.id, title: 'One', createdBy: 'u-1', series: run.id }, file('d-1', 'v-1'));
    expect((await store.timedSeries()).map((s) => s.name)).toEqual(['Cash']);
    expect(await store.markReminded(run.id, '2026-11-01')).toBe(true);
    expect(await store.markReminded(run.id, '2026-11-01')).toBe(false);
    expect(await store.markReminded(run.id, '2026-12-01')).toBe(true);
  });

  it('tells other apps what happened, with ids and no titles', async () => {
    const lib = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Policies', createdBy: 'u-1' });
    await store.createDocument({ id: 'd-1', library: lib.id, title: 'Travel', createdBy: 'u-1' }, file('d-1', 'v-1'));
    await store.addVersion('d-1', file('d-1', 'v-2'));
    await store.setGrant({ library: lib.id, principal: 'team:w-legal', level: 'read', by: 'u-1' });
    const out = await store.publish({ document: 'd-1', version: 2, audience: ['org'], by: 'u-1' });
    await store.withdraw({ document: 'd-1', by: 'u-1' });
    await store.deleteDocument('d-1', 'u-1');
    const events = await told(store);
    expect(events.map((e) => e.topic)).toEqual([
      TOPICS.versionCreated,
      TOPICS.versionCreated,
      TOPICS.readersChanged,
      TOPICS.published,
      TOPICS.readersChanged,
      TOPICS.withdrawn,
      TOPICS.readersChanged,
      TOPICS.deleted,
    ]);
    expect(events.every((e) => e.workspace === 'w-fin')).toBe(true);
    expect(events[1].payload).toEqual({ document: 'd-1', library: lib.id, version: 2 });
    expect(events[3].payload).toEqual({ document: 'd-1', library: lib.id, version: 2, publication: out!.id, audience: ['org'] });
    expect(JSON.stringify(events)).not.toContain('Travel');
  });
};

describe('MemoryFolioStore', () => behavesLikeAStore(() => new MemoryFolioStore(), undefined, async (store) => (store as MemoryFolioStore).outbox));

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
      await admin.query('truncate folio.series_followers, folio.series, folio.outbox, folio.publications, folio.readers, folio.grants, folio.renditions, folio.views, folio.document_tags, folio.tags, folio.people, folio.document_versions, folio.documents, folio.folders, folio.libraries');
    },
    async () => (await admin.query('select topic, workspace_id as workspace, payload from folio.outbox order by id')).rows,
  );

  it('migrates once, however often it starts', async () => {
    await Promise.all([store.migrate(), store.migrate()]);
    const { rows } = await admin.query('select id from folio.migrations');
    expect(rows.map((r) => r.id)).toEqual(['001_libraries', '002_documents', '003_tags_views', '004_renditions', '005_access', '006_publishing', '007_series']);
  });

  it('tells the rendition worker of each new version once it is saved', async () => {
    const listener = await admin.connect();
    try {
      const heard: string[] = [];
      listener.on('notification', (n) => heard.push(n.payload ?? ''));
      await listener.query('listen folio_renditions');
      const lib = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Heard', createdBy: 'u-1' });
      await store.createDocument({ id: 'd-heard', library: lib.id, title: 'Travel', createdBy: 'u-1' }, file('d-heard', 'v-heard'));
      await store.addVersion('d-heard', file('d-heard', 'v-heard-2'));
      await expect.poll(() => heard).toEqual(['v-heard', 'v-heard-2']);
    } finally {
      listener.release();
    }
  });
});
