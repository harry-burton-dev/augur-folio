import { callerHeaders, PeopleUnavailable, type Caller } from '@augur/service-kit';
import { describe, expect, it } from 'vitest';
import { buildApp, type OnFloor } from './app.ts';
import type { FolioAuditEntry } from './audit.ts';
import { MemoryObjectStore } from './objects.ts';
import { MemoryFolioStore } from './store.ts';

const sam: Caller = { id: 'u-sam', name: 'Sam Okafor', departments: [], roles: [] };
const alex: Caller = { id: 'u-alex', name: 'Alex Rivera', departments: [], roles: [] };
const kim: Caller = { id: 'u-kim', name: 'Kim Lee', departments: [], roles: [] };
const on = (who: Caller, floor: string, role: 'lead' | 'member' = 'member', kind: 'team' | 'personal' = 'team'): Caller => ({ ...who, workspace: { id: floor, kind, role } });

/** Sam leads Finance; Alex is on Payroll, below Finance; Kim is on Legal. */
const STANDS_FOR: Record<string, string[]> = {
  'u-sam': ['person:u-sam', 'team:w-fin', 'tree:w-fin', 'org'],
  'u-alex': ['person:u-alex', 'team:w-pay', 'tree:w-fin', 'tree:w-pay', 'org'],
  'u-kim': ['person:u-kim', 'team:w-legal', 'tree:w-legal', 'org'],
};
const DIRECTORY = {
  people: [
    { id: 'u-sam', name: 'Sam Okafor', email: 'sam@example.org' },
    { id: 'u-alex', name: 'Alex Rivera' },
    { id: 'u-kim', name: 'Kim Lee' },
  ],
  teams: [
    { id: 'w-fin', name: 'Finance', within: [] },
    { id: 'w-pay', name: 'Payroll', within: ['Finance'] },
    { id: 'w-legal', name: 'Legal', within: [] },
  ],
};

const setup = async ({ identityDown = false } = {}) => {
  const audited: FolioAuditEntry[] = [];
  const app = await buildApp({
    store: new MemoryFolioStore(),
    objects: new MemoryObjectStore(),
    audit: async (entry) => void audited.push(entry),
    principals: async (caller: OnFloor) => {
      if (identityDown) throw new PeopleUnavailable('identity is down');
      return STANDS_FOR[caller.id] ?? [`person:${caller.id}`, 'org'];
    },
    directory: async ({ q, ids }) => ({
      people: DIRECTORY.people.filter((p) => (ids ? ids.includes(p.id) : p.name.toLowerCase().includes(q!.toLowerCase()))),
      teams: DIRECTORY.teams.filter((t) => (ids ? ids.includes(t.id) : t.name.toLowerCase().includes(q!.toLowerCase()))),
    }),
  });
  const call = (caller: Caller, method: 'GET' | 'PUT' | 'DELETE' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: callerHeaders(caller), ...(payload ? { payload } : {}) });
  const { id: library } = (await call(on(sam, 'w-fin', 'lead'), 'POST', '/v1/libraries', { name: 'Policies' })).json();
  const upload = async (caller: Caller, name: string) =>
    (await app.inject({ method: 'POST', url: `/v1/libraries/${library}/documents?filename=${encodeURIComponent(`${name}.md`)}`, headers: { ...callerHeaders(caller), 'content-type': 'text/markdown' }, payload: `# ${name}` })).json();
  return { app, call, library, upload, audited };
};

describe('folio access', () => {
  it('lets in anyone who can stand on the library’s floor, from wherever they are', async () => {
    const { call, library, upload } = await setup();
    const doc = await upload(on(sam, 'w-fin', 'lead'), 'Travel');
    // Alex is on a team below Finance: standing on Finance they may add, from their own team they may read.
    expect((await call(on(alex, 'w-fin'), 'GET', `/v1/libraries/${library}`)).json().can).toMatchObject({ addDocuments: true, manage: false, share: false });
    const fromBelow = await call(on(alex, 'w-pay'), 'GET', `/v1/libraries/${library}`);
    expect(fromBelow.json().can).toMatchObject({ addDocuments: false, addFolders: false, manage: false });
    expect((await call(on(alex, 'w-pay'), 'GET', `/v1/libraries/${library}/documents/${doc.id}`)).statusCode).toBe(200);
    expect((await call(on(alex, 'w-pay'), 'POST', `/v1/libraries/${library}/folders`, { name: 'Mine' })).statusCode).toBe(403);
    // Kim isn't: nothing about it is given away.
    expect((await call(on(kim, 'w-legal'), 'GET', `/v1/libraries/${library}`)).statusCode).toBe(404);
    expect((await call(on(kim, 'w-legal'), 'GET', `/v1/libraries/${library}/documents/${doc.id}`)).statusCode).toBe(404);
    expect((await call(on(kim, 'w-legal'), 'GET', `/v1/libraries/${library}/access`)).statusCode).toBe(404);
  });

  it('keeps a library on someone’s own floor to them', async () => {
    const { call } = await setup();
    const mine = (await call(on(alex, 'p-alex', 'lead', 'personal'), 'POST', '/v1/libraries', { name: 'Notes' })).json();
    expect(mine.floor).toBe('person:u-alex');
    expect((await call(on(sam, 'w-fin', 'lead'), 'GET', `/v1/libraries/${mine.id}`)).statusCode).toBe(404);
    expect((await call(on(alex, 'w-pay'), 'GET', `/v1/libraries/${mine.id}`)).json().can.manage).toBe(false);
  });

  it('shares a library with a team, which then reads it from its own floor', async () => {
    const { call, library, upload, audited } = await setup();
    const lead = on(sam, 'w-fin', 'lead');
    await upload(lead, 'Travel');
    const shared = await call(lead, 'PUT', `/v1/libraries/${library}/access/team:w-legal`, { level: 'read' });
    expect(shared.statusCode).toBe(200);
    expect(shared.json()).toMatchObject({
      floor: { principal: 'tree:w-fin', kind: 'tree', name: 'Finance' },
      grants: [{ principal: 'team:w-legal', kind: 'team', name: 'Legal', level: 'read', createdBy: 'u-sam' }],
      can: { share: true },
    });
    expect(audited.at(-1)).toMatchObject({ actor: 'u-sam', action: 'access.granted', target: library, workspace: 'w-fin', detail: { principal: 'team:w-legal', level: 'read' } });

    const kim1 = on(kim, 'w-legal');
    expect((await call(kim1, 'GET', `/v1/libraries/${library}/documents`)).json().documents.map((d: { title: string }) => d.title)).toEqual(['Travel']);
    expect((await call(kim1, 'GET', '/v1/shared')).json().libraries.map((l: { name: string; level: string }) => [l.name, l.level])).toEqual([['Policies', 'read']]);
    // Read means read: nothing added.
    expect((await call(kim1, 'POST', `/v1/libraries/${library}/folders`, { name: 'Ours' })).statusCode).toBe(403);
    // Anyone who can see it can see who else can, but only its managers change that.
    expect((await call(kim1, 'GET', `/v1/libraries/${library}/access`)).json().can.share).toBe(false);
    expect((await call(kim1, 'PUT', `/v1/libraries/${library}/access/person:u-kim`, { level: 'manage' })).statusCode).toBe(403);

    // Edit lets them add and change anyone's documents; manage lets them share it on.
    await call(lead, 'PUT', `/v1/libraries/${library}/access/team:w-legal`, { level: 'edit' });
    expect(audited.at(-1)).toMatchObject({ action: 'access.changed', detail: { level: 'edit', was: 'read' } });
    const listed = (await call(kim1, 'GET', `/v1/libraries/${library}/documents`)).json().documents;
    expect(listed[0].can).toEqual({ change: true, share: false });
    expect((await call(kim1, 'POST', `/v1/libraries/${library}/folders`, { name: 'Ours' })).statusCode).toBe(201);

    await call(lead, 'DELETE', `/v1/libraries/${library}/access/team:w-legal`);
    expect(audited.at(-1)).toMatchObject({ action: 'access.removed', detail: { principal: 'team:w-legal', was: 'edit' } });
    expect((await call(kim1, 'GET', `/v1/libraries/${library}`)).statusCode).toBe(404);
  });

  it('shares one document, and only that', async () => {
    const { call, library, upload } = await setup();
    const lead = on(sam, 'w-fin', 'lead');
    const travel = await upload(lead, 'Travel');
    await upload(lead, 'Pay scales');
    const res = await call(lead, 'PUT', `/v1/libraries/${library}/documents/${travel.id}/access/person:u-kim`, { level: 'manage' });
    expect(res.json()).toMatchObject({ floor: { principal: 'tree:w-fin' }, library: [], grants: [{ principal: 'person:u-kim', name: 'Kim Lee', level: 'manage' }], can: { share: true } });

    const kim1 = on(kim, 'w-legal');
    const opened = await call(kim1, 'GET', `/v1/libraries/${library}/documents/${travel.id}`);
    expect(opened.json()).toMatchObject({ title: 'Travel', libraryName: 'Policies', level: 'manage', can: { change: true, share: true } });
    expect((await call(kim1, 'GET', `/v1/libraries/${library}`)).statusCode).toBe(404);
    const shared = (await call(kim1, 'GET', '/v1/shared')).json();
    expect(shared.libraries).toEqual([]);
    expect(shared.documents.map((d: { title: string; libraryName: string }) => [d.title, d.libraryName])).toEqual([['Travel', 'Policies']]);
    // Managing it, Kim may share it on, but with no one already in by the floor.
    expect((await call(kim1, 'PUT', `/v1/libraries/${library}/documents/${travel.id}/access/team:w-legal`, { level: 'read' })).statusCode).toBe(200);
    expect((await call(kim1, 'PUT', `/v1/libraries/${library}/documents/${travel.id}/access/tree:w-fin`, { level: 'read' })).json().error).toBe('already-in');
  });

  it('shares only with people and teams that exist', async () => {
    const { call, library } = await setup();
    const lead = on(sam, 'w-fin', 'lead');
    const put = (principal: string) => call(lead, 'PUT', `/v1/libraries/${library}/access/${encodeURIComponent(principal)}`, { level: 'read' });
    expect((await put('person:u-nobody')).json().error).toBe('unknown-principal');
    expect((await put('group:w-legal')).json().error).toBe('bad-principal');
    expect((await put('org')).statusCode).toBe(200);
    expect((await call(lead, 'PUT', `/v1/libraries/${library}/access/org`, { level: 'admin' })).statusCode).toBe(400);
  });

  it('finds people and teams to share with, leaving out the one asking', async () => {
    const { call } = await setup();
    const found = (await call(on(sam, 'w-fin'), 'GET', '/v1/people?q=a')).json();
    expect(found.people.map((p: { id: string }) => p.id)).toEqual(['u-alex']);
    expect(found.teams.map((t: { name: string }) => t.name)).toEqual(['Finance', 'Payroll', 'Legal']);
    expect((await call(on(sam, 'w-fin'), 'GET', '/v1/people')).json()).toEqual({ people: [], teams: [] });
  });

  it('lets nothing through while identity can’t say who the caller is', async () => {
    const { call } = await setup({ identityDown: true });
    const res = await call(on(sam, 'w-fin', 'lead'), 'GET', '/v1/shared');
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('unavailable');
  });
});
