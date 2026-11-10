import { CALLER_TOKEN_HEADER, callerAudienceOf, callerCheckFor, callerSigner, readManifest, signDelegation, type AppPeople, type Caller } from '@augur/service-kit';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { DATABASE_URL, testDatabase } from './db.testing.ts';
import { contentDisposition, titleFromFilename } from './library.ts';
import { MemoryObjectStore } from './objects.ts';
import { memoryInbox } from './platform.ts';
import { purgeDeleted } from './retention.ts';

const manifest = readManifest(import.meta.url);
const fromGateway = '172.18.0.9';
const db = testDatabase('folio_library_test');

type Floor = { id: string; kind: 'personal' | 'team' | 'org'; role: 'member' | 'lead' };
const port: Floor = { id: 'w-port', kind: 'team', role: 'member' };
const person = (id: string, name: string, workspace: Floor, roles: string[] = []): Caller => ({ id, name, departments: [], roles, workspace });
// The seed's cast, as far as these tests need it: a lead and an editor of one team, a reader, and someone on another floor.
const lead = person('u-lead', 'Ada Lead', { ...port, role: 'lead' });
const tomas = person('u-tomas', 'Tomas Lindqvist', port, ['editor']);
const lucia = person('u-lucia', 'Lucia Ferreira', port);
const hamid = person('u-hamid', 'Hamid Sadeghi', { id: 'w-finance', kind: 'team', role: 'member' }, ['editor']);

/** Identity, as far as these tests ask it: each person stands for themselves, their team and the org. */
const people: AppPeople = {
  principals: async (id, workspace) => [`person:${id}`, ...(workspace.kind === 'team' ? [`team:${workspace.id}`, `tree:${workspace.id}`] : []), 'org'],
  directory: async ({ q, ids }) => ({
    people: [hamid, tomas, lucia].filter((p) => (q ? p.name.toLowerCase().includes(q.toLowerCase()) : ids?.includes(p.id))).map((p) => ({ id: p.id, name: p.name })),
    teams: [],
  }),
  audience: async () => [],
};

const setUp = async (maxUploadBytes?: number) => {
  const gateway = callerSigner();
  const objects = new MemoryObjectStore();
  const inbox = memoryInbox();
  const app = await buildApp({ manifest, callers: callerCheckFor(gateway, callerAudienceOf(manifest)), store: db.store, objects, inbox, people, ...(maxUploadBytes ? { maxUploadBytes } : {}) });
  const as = (caller: Caller) => {
    const headers = async () => ({ [CALLER_TOKEN_HEADER]: await signDelegation(gateway, caller, { app: manifest.id, scopes: (manifest.scopes as string[]) ?? [] }) });
    const call = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) => app.inject({ remoteAddress: fromGateway, method, url: `/v1${url}`, headers: await headers(), ...(payload === undefined ? {} : { payload: payload as object }) });
    const upload = async (url: string, body: string | Buffer, type = 'application/pdf') => app.inject({ remoteAddress: fromGateway, method: 'POST', url: `/v1${url}`, headers: { ...(await headers()), 'content-type': type }, payload: body });
    return { call, upload };
  };
  return { app, objects, inbox, as };
};

/** A collection with a folder in it, made by the lead, and a document Tomas added there. */
const aDocument = async (s: Awaited<ReturnType<typeof setUp>>) => {
  const collection = (await s.as(lead).call('POST', '/folders', { name: 'Procedures' })).json();
  const folder = (await s.as(tomas).call('POST', '/folders', { parent: collection.id, name: 'Berths' })).json();
  const added = await s.as(tomas).upload(`/folders/${folder.id}/documents?filename=${encodeURIComponent('berth-procedure_v1.pdf')}`, '%PDF-1.7 berth');
  return { collection, folder, document: added.json(), added };
};

describe('words for files', () => {
  it('makes a title from a file’s name, and a header any browser saves it under', () => {
    expect(titleFromFilename('C:\\fakepath\\berth-procedure_v1.pdf')).toBe('berth procedure v1');
    expect(contentDisposition('Plan “B”.pdf')).toBe(`attachment; filename="Plan _B_.pdf"; filename*=UTF-8''Plan%20%E2%80%9CB%E2%80%9D.pdf`);
  });
});

describe.skipIf(!DATABASE_URL)('the library', () => {
  it('opens one library per floor, where only its leads make collections', async () => {
    const s = await setUp();
    const library = (await s.as(lucia).call('GET', '/library')).json();
    expect(library).toMatchObject({ floor: { id: 'w-port', kind: 'team' }, collections: [], rights: { level: 'read', add: false } });
    expect(library.levels.map((l: { id: string }) => l.id)).toEqual(['collection', 'subcollection', 'series', 'subseries', 'file']);
    const refused = await s.as(tomas).call('POST', '/folders', { name: 'Procedures' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ reason: 'forbidden', whoCanChange: expect.any(String) });
    expect((await s.as(lead).call('POST', '/folders', { name: 'Procedures' })).statusCode).toBe(201);
    expect((await s.as(lead).call('POST', '/folders', { name: 'procedures' })).json()).toMatchObject({ reason: 'name_taken' });
    expect((await s.as(lucia).call('GET', '/library')).json().collections.map((c: { name: string }) => c.name)).toEqual(['Procedures']);
  });

  it('nests folders by level, the next one down unless someone says, never turned round', async () => {
    const s = await setUp();
    const { collection, folder } = await aDocument(s);
    expect(folder.level).toBe('subcollection');
    const series = (await s.as(tomas).call('POST', '/folders', { parent: folder.id, name: 'Weekly notices', level: 'series' })).json();
    expect(series.level).toBe('series');
    const back = await s.as(tomas).call('POST', '/folders', { parent: series.id, name: 'Wrong way', level: 'subcollection' });
    expect(back.statusCode).toBe(400);
    const opened = (await s.as(lucia).call('GET', `/folders/${series.id}`)).json();
    expect(opened.path.map((p: { name: string }) => p.name)).toEqual(['Procedures', 'Berths', 'Weekly notices']);
    expect(opened.rights).toMatchObject({ level: 'read', add: false, why: expect.any(String) });
    expect((await s.as(lucia).call('GET', `/folders/${collection.id}`)).json().folders.map((f: { name: string }) => f.name)).toEqual(['Berths']);
  });

  it('keeps an uploaded file as it was sent, and gives it back under its name', async () => {
    const s = await setUp();
    const { folder, document, added } = await aDocument(s);
    expect(added.statusCode).toBe(201);
    expect(document).toMatchObject({ title: 'berth procedure v1', latest: { number: 1, filename: 'berth-procedure_v1.pdf', mediaType: 'application/pdf', size: 14, state: 'in-progress', createdByName: 'Tomas Lindqvist' } });
    const file = await s.as(lucia).call('GET', `/documents/${document.id}/versions/1/file`);
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe('%PDF-1.7 berth');
    expect(file.headers['content-disposition']).toContain('berth-procedure_v1.pdf');
    expect((await s.as(lucia).call('GET', `/folders/${folder.id}/documents`)).json()).toMatchObject({ total: 1, documents: [{ id: document.id }] });
    // A reader can't add, and nothing is kept of what they sent.
    expect((await s.as(lucia).upload(`/folders/${folder.id}/documents?filename=x.pdf`, 'x')).statusCode).toBe(403);
    expect(s.objects.files.size).toBe(1);
  });

  it('refuses a file past the limit or an empty one, keeping nothing', async () => {
    const s = await setUp(8);
    const { folder } = await aDocument(await setUp());
    const big = await s.as(tomas).upload(`/folders/${folder.id}/documents?filename=big.pdf`, '0123456789');
    expect(big.statusCode).toBe(413);
    const empty = await s.as(tomas).upload(`/folders/${folder.id}/documents?filename=empty.pdf`, '');
    expect([400, 413]).toContain(empty.statusCode);
    expect(s.objects.files.size).toBe(0);
  });

  it('sends a version for review to the floor’s leads’ Inbox, and closes it once issued (T2, T3)', async () => {
    const s = await setUp();
    const { document } = await aDocument(s);
    const sent = await s.as(tomas).call('POST', `/documents/${document.id}/versions/1/state`, { to: 'in-review' });
    expect(sent.json().latest.state).toBe('in-review');
    const [key, item] = [...s.inbox.items][0]!;
    expect(key).toMatch(/^review\//);
    expect(item).toMatchObject({ kind: 'review', owner: { kind: 'team', id: 'w-port', role: 'lead' }, state: 'open', path: `/documents/${document.id}`, workspace: 'w-port' });
    expect((await s.as(lead).call('GET', '/home')).json().needsYou).toEqual([expect.objectContaining({ title: document.title, path: `/documents/${document.id}` })]);
    // An editor can't issue; the lead can, and the review is done.
    const tooFar = await s.as(tomas).call('POST', `/documents/${document.id}/versions/1/state`, { to: 'issued' });
    expect(tooFar.statusCode).toBe(409);
    expect(tooFar.json().reason).toBe('bad_move');
    const about = (await s.as(tomas).call('GET', `/documents/${document.id}`)).json();
    expect(about.next).toContainEqual(expect.objectContaining({ to: 'issued', allowed: false, why: expect.any(String) }));
    expect((await s.as(lead).call('POST', `/documents/${document.id}/versions/1/state`, { to: 'issued', note: 'Checked' })).json().issued.number).toBe(1);
    expect(item.state).toBe('done');
    const moves = (await s.as(lucia).call('GET', `/documents/${document.id}`)).json().moves;
    expect(moves[0]).toMatchObject({ version: 1, from: 'in-review', to: 'issued', by: 'u-lead', byName: 'Ada Lead', note: 'Checked' });
    expect((await s.as(lead).call('GET', '/home')).json().needsYou).toEqual([]);
  });

  it('puts out version 2 without taking version 1 away (T7)', async () => {
    const s = await setUp();
    const { document } = await aDocument(s);
    await s.as(lead).call('POST', `/documents/${document.id}/versions/1/state`, { to: 'issued' });
    const second = await s.as(tomas).upload(`/documents/${document.id}/versions?filename=berth-procedure_v2.pdf`, '%PDF-1.7 v2');
    expect(second.json()).toMatchObject({ latest: { number: 2, state: 'in-progress' }, issued: { number: 1 } });
    const about = (await s.as(lucia).call('GET', `/documents/${document.id}`)).json();
    expect(about.versions.map((v: { number: number; state: string }) => [v.number, v.state])).toEqual([
      [2, 'in-progress'],
      [1, 'issued'],
    ]);
  });

  it('shares a document sideways, read only, and nothing else of the floor opens (T6)', async () => {
    const s = await setUp();
    const { folder, document } = await aDocument(s);
    const other = (await s.as(tomas).upload(`/folders/${folder.id}/documents?filename=other.pdf`, 'other')).json();
    expect((await s.as(hamid).call('GET', `/documents/${document.id}`)).statusCode).toBe(404);
    expect((await s.as(tomas).call('PUT', '/grants', { kind: 'document', record: document.id, principal: 'person:u-hamid', level: 'read' })).statusCode).toBe(403);
    expect((await s.as(lead).call('PUT', '/grants', { kind: 'document', record: document.id, principal: 'person:u-hamid', level: 'read' })).statusCode).toBe(200);
    expect((await s.as(lead).call('GET', `/grants?kind=document&record=${document.id}`)).json().grants).toEqual([expect.objectContaining({ principal: 'person:u-hamid', name: 'Hamid Sadeghi', level: 'read' })]);
    expect((await s.as(hamid).call('GET', '/shared')).json().items).toEqual([expect.objectContaining({ kind: 'document', id: document.id, floor: 'w-port', level: 'read', path: `/documents/${document.id}` })]);
    const read = (await s.as(hamid).call('GET', `/documents/${document.id}`)).json();
    expect(read.rights).toMatchObject({ level: 'read', add: false, manage: false });
    expect((await s.as(hamid).call('GET', `/documents/${document.id}/versions/1/file`)).statusCode).toBe(200);
    expect((await s.as(hamid).call('GET', `/documents/${other.id}`)).statusCode).toBe(404);
    expect((await s.as(hamid).call('GET', `/folders/${folder.id}`)).statusCode).toBe(404);
    expect((await s.as(hamid).upload(`/documents/${document.id}/versions?filename=mine.pdf`, 'mine')).statusCode).toBe(403);
    expect((await s.as(lead).call('DELETE', `/grants?kind=document&record=${document.id}&principal=person:u-hamid`)).statusCode).toBe(204);
    expect((await s.as(hamid).call('GET', `/documents/${document.id}`)).statusCode).toBe(404);
  });

  it('finds documents on the floor by the start of each word, only what the person may open (T1)', async () => {
    const s = await setUp();
    const { document } = await aDocument(s);
    const found = (await s.as(lucia).call('GET', `/search?q=${encodeURIComponent('Berth proc')}`)).json();
    expect(found.results).toEqual([{ id: document.id, title: document.title, detail: 'Procedures › Berths · In progress', path: `/documents/${document.id}` }]);
    expect((await s.as(lucia).call('GET', '/search?q=tide')).json().results).toEqual([]);
    expect((await s.as(hamid).call('GET', '/search?q=berth')).json().results).toEqual([]);
  });

  it('filters a folder by tags, its own or a folder’s above, and by lifecycle', async () => {
    const s = await setUp();
    const { collection, folder, document } = await aDocument(s);
    const plain = (await s.as(tomas).upload(`/folders/${folder.id}/documents?filename=plain.pdf`, 'plain')).json();
    expect((await s.as(tomas).call('POST', '/tags', { name: 'Safety' })).statusCode).toBe(403);
    expect((await s.as(lead).call('POST', '/tags', { name: 'Safety' })).statusCode).toBe(201);
    expect((await s.as(lead).call('POST', '/tags', { name: 'Tides' })).statusCode).toBe(201);
    expect((await s.as(tomas).call('PUT', `/documents/${document.id}/tags`, { tags: ['safety'] })).json().tags).toEqual(['Safety']);
    expect((await s.as(tomas).call('PUT', `/documents/${document.id}/tags`, { tags: ['Nope'] })).statusCode).toBe(409);
    const titles = async (query: string) => (await s.as(lucia).call('GET', `/folders/${folder.id}/documents?${query}`)).json().documents.map((d: { id: string }) => d.id);
    expect(await titles('tags=Safety')).toEqual([document.id]);
    await s.as(lead).call('PUT', `/folders/${collection.id}/tags`, { tags: ['Tides'] });
    expect((await titles('tags=Tides')).sort()).toEqual([document.id, plain.id].sort());
    await s.as(tomas).call('POST', `/documents/${plain.id}/versions/1/state`, { to: 'in-review' });
    expect(await titles('lifecycle=in-review')).toEqual([plain.id]);
  });

  it('takes nothing new into a closed folder, and says who can open it', async () => {
    const s = await setUp();
    const { folder } = await aDocument(s);
    expect((await s.as(tomas).call('POST', `/folders/${folder.id}/state`, { to: 'closed' })).statusCode).toBe(409);
    expect((await s.as(lead).call('POST', `/folders/${folder.id}/state`, { to: 'closed' })).json().state).toBe('closed');
    const refused = await s.as(tomas).upload(`/folders/${folder.id}/documents?filename=late.pdf`, 'late');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reason: 'closed', whoCanChange: expect.any(String) });
    expect((await s.as(tomas).call('GET', `/folders/${folder.id}`)).json().rights).toMatchObject({ add: false, why: expect.stringContaining('closed') });
  });

  it('deletes a document, and clears its files once the retention days have passed', async () => {
    const s = await setUp();
    const { folder, document } = await aDocument(s);
    expect((await s.as(tomas).call('DELETE', `/documents/${document.id}`)).statusCode).toBe(403);
    expect((await s.as(lead).call('DELETE', `/folders/${folder.id}`)).json().reason).toBe('not_empty');
    expect((await s.as(lead).call('DELETE', `/documents/${document.id}`)).statusCode).toBe(204);
    expect((await s.as(lucia).call('GET', `/documents/${document.id}`)).statusCode).toBe(404);
    expect(await purgeDeleted({ store: db.store, objects: s.objects, days: 30, log: console })).toBe(0);
    await db.pool.query(`update documents set deleted_at = now() - interval '31 days' where id = $1`, [document.id]);
    expect(await purgeDeleted({ store: db.store, objects: s.objects, days: 30, log: { info: () => undefined } })).toBe(1);
    expect(s.objects.files.size).toBe(0);
  });

  it('finds people to share with, and says so when it can’t', async () => {
    const s = await setUp();
    expect((await s.as(lead).call('GET', '/people?q=ham')).json()).toEqual({ query: 'ham', items: [{ kind: 'person', id: 'u-hamid', name: 'Hamid Sadeghi' }] });
  });

  it('says what changed since the person last looked', async () => {
    const s = await setUp();
    const { document } = await aDocument(s);
    expect((await s.as(lucia).call('GET', '/home')).json().latest).toEqual([expect.objectContaining({ id: document.id, detail: 'In progress · version 1' })]);
    expect((await s.as(lucia).call('POST', '/home/looked')).statusCode).toBe(204);
    const home = (await s.as(lucia).call('GET', '/home')).json();
    expect(home.latest).toEqual([]);
    expect(home.since).toEqual(expect.any(String));
  });
});
