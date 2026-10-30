import { callerHeaders, type Caller } from '@augur/service-kit';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import type { FolioAuditEntry } from './audit.ts';
import { MemoryObjectStore } from './objects.ts';
import { MemoryFolioStore } from './store.ts';

const person = (id: string, name: string): Caller => ({ id, name, departments: [], roles: [] });
const sam = person('u-sam', 'Sam Okafor');
const kim = person('u-kim', 'Kim Lee');
const own = (who: Caller): Caller => ({ ...who, workspace: { id: `p-${who.id}`, kind: 'personal', role: 'lead' } });

const setup = async () => {
  const audited: FolioAuditEntry[] = [];
  const app = await buildApp({
    store: new MemoryFolioStore(),
    objects: new MemoryObjectStore(),
    audit: async (entry) => void audited.push(entry),
    principals: async (caller) => [`person:${caller.id}`, 'org'],
    directory: async ({ ids }) => ({ people: [{ id: 'u-kim', name: 'Kim Lee' }].filter((p) => !ids || ids.includes(p.id)), teams: [] }),
  });
  const call = (caller: Caller, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: callerHeaders(caller), ...(payload ? { payload } : {}) });
  const send = (caller: Caller, url: string, body: string) => app.inject({ method: 'POST', url, headers: { ...callerHeaders(caller), 'content-type': 'text/markdown' }, payload: body });

  const { id: library } = (await call(own(sam), 'POST', '/v1/libraries', { name: 'My work' })).json();
  const plan = (await send(own(sam), `/v1/libraries/${library}/documents?filename=plan.md`, '# Plan')).json();
  const notes = (await send(own(sam), `/v1/libraries/${library}/documents?filename=notes.md`, '# Notes')).json();
  return { call, audited, library, plan, notes };
};

const unit = (library: string, record: string) => ({ app: 'folio', kind: 'unit', id: `${library}/${record}` });

describe('folio relationships', () => {
  it('links a record to another, both ways, and unlinks it', async () => {
    const { call, audited, library, plan, notes } = await setup();
    const linked = await call(own(sam), 'POST', `/v1/libraries/${library}/links`, { record: notes.id, relation: 'responds-to', to: unit(library, plan.id) });
    expect(linked.statusCode).toBe(201);
    expect(linked.json()).toMatchObject({ relation: 'responds-to', words: 'Responds to', to: { label: 'plan', record: plan.id, unitKind: 'document' } });
    expect((await call(own(sam), 'POST', `/v1/libraries/${library}/links`, { record: notes.id, relation: 'responds-to', to: unit(library, plan.id) })).statusCode).toBe(409);

    const mine = (await call(own(sam), 'GET', `/v1/libraries/${library}/links?record=${notes.id}`)).json();
    expect(mine).toMatchObject({ links: [{ relation: 'responds-to' }], back: [], can: { change: true } });
    expect(mine.kinds.map((k: { id: string }) => k.id)).toContain('about');
    const theirs = (await call(own(sam), 'GET', `/v1/libraries/${library}/links?record=${plan.id}`)).json();
    expect(theirs).toMatchObject({ links: [], back: [{ words: 'Answered by', from: { record: notes.id, name: 'notes' } }] });

    expect((await call(own(sam), 'DELETE', `/v1/libraries/${library}/links/${linked.json().id}?record=${notes.id}`)).statusCode).toBe(204);
    expect((await call(own(sam), 'GET', `/v1/libraries/${library}/links?record=${plan.id}`)).json().back).toEqual([]);
    expect(audited.map((a) => a.action).filter((a) => a.startsWith('record.'))).toEqual(['record.linked', 'record.unlinked']);
  });

  it('links to things in other apps only by the kinds that fit', async () => {
    const { call, library, plan, notes } = await setup();
    const link = (relation: string, to: object) => call(own(sam), 'POST', `/v1/libraries/${library}/links`, { record: plan.id, relation, to });
    const ship = { app: 'atlas', kind: 'entity', id: 'e-1', label: 'HMS Example' };
    expect((await link('about', ship)).json()).toMatchObject({ to: { app: 'atlas', label: 'HMS Example' } });
    expect((await link('about', unit(library, notes.id))).json().message).toContain('Data Atlas');
    expect((await link('serves', ship)).json().message).toContain('Mandate');
    expect((await link('serves', { app: 'mandate', kind: 'intent', id: 'i-1' })).statusCode).toBe(201);
    expect((await link('relates-to', unit(library, plan.id))).json().message).toContain('itself');
    expect((await link('relates-to', { app: 'folio', kind: 'unit', id: `${library}/nope` })).statusCode).toBe(400);
    expect((await link('likes', ship)).statusCode).toBe(400);
    expect((await link('about', { app: 'atlas' })).statusCode).toBe(400);
  });

  it('shows a linked record the caller can’t open, and lets only whoever may change it link', async () => {
    const { call, library, plan, notes } = await setup();
    await call(own(sam), 'POST', `/v1/libraries/${library}/links`, { record: notes.id, relation: 'relates-to', to: unit(library, plan.id) });
    expect((await call(own(kim), 'GET', `/v1/libraries/${library}/links?record=${notes.id}`)).statusCode).toBe(404);

    await call(own(sam), 'PUT', `/v1/libraries/${library}/documents/${notes.id}/access/person:u-kim`, { level: 'read' });
    const seen = (await call(own(kim), 'GET', `/v1/libraries/${library}/links?record=${notes.id}`)).json();
    expect(seen).toMatchObject({ links: [{ to: { unavailable: 'plan isn’t shared with you.' } }], can: { change: false } });
    expect((await call(own(kim), 'POST', `/v1/libraries/${library}/links`, { record: notes.id, relation: 'relates-to', to: { app: 'atlas', kind: 'entity', id: 'e-1' } })).statusCode).toBe(403);
  });
});
