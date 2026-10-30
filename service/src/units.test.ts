import { callerHeaders, type Caller } from '@augur/service-kit';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import type { FolioAuditEntry } from './audit.ts';
import { MemoryObjectStore } from './objects.ts';
import { MemoryFolioStore } from './store.ts';

const sam: Caller = { id: 'u-sam', name: 'Sam Okafor', departments: [], roles: [] };
const alex: Caller = { id: 'u-alex', name: 'Alex Rivera', departments: [], roles: [] };
const kim: Caller = { id: 'u-kim', name: 'Kim Lee', departments: [], roles: [] };
const lead = (who: Caller, floor = 'w-fin', kind: 'team' | 'org' = 'team'): Caller => ({ ...who, workspace: { id: floor, kind, role: 'lead' } });
const member = (who: Caller, floor = 'w-fin'): Caller => ({ ...who, workspace: { id: floor, kind: 'team', role: 'member' } });

const setup = async () => {
  const audited: FolioAuditEntry[] = [];
  const app = await buildApp({ store: new MemoryFolioStore(), objects: new MemoryObjectStore(), audit: async (entry) => void audited.push(entry) });
  const call = (caller: Caller, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: callerHeaders(caller), ...(payload ? { payload } : {}) });
  const send = (caller: Caller, url: string, body: string) => app.inject({ method: 'POST', url, headers: { ...callerHeaders(caller), 'content-type': 'text/markdown' }, payload: body });
  const { id: library } = (await call(lead(sam), 'POST', '/v1/libraries', { name: 'Reports' })).json();
  return { call, send, audited, library };
};

describe('folio units', () => {
  it('builds a library from its levels, in the org’s own words', async () => {
    const { call, library } = await setup();
    const levels = (await call(member(alex), 'GET', '/v1/levels')).json();
    expect(levels.levels.map((l: { id: string }) => l.id)).toEqual(['collection', 'subcollection', 'series', 'subseries', 'file']);
    expect(levels.can).toEqual({ rename: false });
    const sub = (await call(member(alex), 'POST', `/v1/libraries/${library}/folders`, { name: 'Weekly', description: 'Every Friday' })).json();
    expect(sub).toMatchObject({ level: 'subcollection', description: 'Every Friday', state: 'open' });
    const series = (await call(member(alex), 'POST', `/v1/libraries/${library}/folders`, { name: 'Cash', parent: sub.id, level: 'series' })).json();
    expect(series.level).toBe('series');

    // Only the org's leads rename levels, from the org's floor; refusals use the new names.
    expect((await call(lead(sam), 'PUT', '/v1/levels/series', { name: 'Run', plural: 'Runs' })).statusCode).toBe(403);
    const renamed = await call(lead(sam, 'org', 'org'), 'PUT', '/v1/levels/series', { name: ' Run ', plural: 'Runs' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().levels.find((l: { id: string }) => l.id === 'series')).toMatchObject({ name: 'Run', plural: 'Runs' });
    const wrong = await call(member(alex), 'POST', `/v1/libraries/${library}/folders`, { name: 'Upside down', parent: series.id, level: 'subcollection' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toEqual({ error: 'bad-parent', message: 'A subcollection can’t go in a run: only subseries, files can.' });
    expect((await call(lead(sam, 'org', 'org'), 'DELETE', '/v1/levels/series')).json().levels.find((l: { id: string }) => l.id === 'series').name).toBe('Series');
  });

  it('closes, archives and opens again, for whoever manages it, on the record', async () => {
    const { call, send, audited, library } = await setup();
    const sub = (await call(member(alex), 'POST', `/v1/libraries/${library}/folders`, { name: 'Weekly' })).json();
    expect((await call(member(alex), 'PUT', `/v1/libraries/${library}/folders/${sub.id}/state`, { state: 'closed' })).json().error).toBe('bad-move');
    expect((await call(lead(sam), 'PUT', `/v1/libraries/${library}/folders/${sub.id}/state`, { state: 'closed', note: 'Year end' })).json().state).toBe('closed');
    const late = await send(member(alex), `/v1/libraries/${library}/documents?filename=late.md&folder=${sub.id}`, '# Late');
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe('closed');
    expect((await call(member(alex), 'GET', `/v1/libraries/${library}/moves?folder=${sub.id}`)).json().moves).toEqual([expect.objectContaining({ from: 'open', to: 'closed', by: 'u-sam', note: 'Year end' })]);

    expect((await call(lead(sam), 'PUT', `/v1/libraries/${library}/state`, { state: 'archived' })).json().state).toBe('archived');
    expect((await call(member(alex), 'GET', '/v1/libraries')).json().libraries).toEqual([]);
    expect((await call(member(alex), 'GET', '/v1/libraries?archived=true')).json().libraries).toEqual([]);
    expect((await call(lead(sam), 'GET', '/v1/libraries?archived=true')).json().libraries).toEqual([expect.objectContaining({ id: library, state: 'archived' })]);
    expect((await call(lead(sam), 'PUT', `/v1/libraries/${library}/state`, { state: 'open' })).json().state).toBe('open');
    expect(audited.map((a) => a.action).filter((a) => a.startsWith('library.') || a.startsWith('folder.'))).toEqual(['library.created', 'folder.closed', 'library.archived', 'library.opened']);
  });

  it('moves each version through its lifecycle: editors to complete, managers to issued', async () => {
    const { call, send, audited, library } = await setup();
    const doc = (await send(member(alex), `/v1/libraries/${library}/documents?filename=cash.md`, '# Cash')).json();
    const at = `/v1/libraries/${library}/documents/${doc.id}`;
    expect((await call(member(alex), 'GET', at)).json().can.moves).toEqual(['in-review', 'complete']);
    expect((await call(member(kim), 'PUT', `${at}/versions/1/state`, { state: 'in-review' })).json().error).toBe('bad-move');
    expect((await call(member(alex), 'PUT', `${at}/versions/1/state`, { state: 'complete' })).json()).toMatchObject({ number: 1, state: 'complete' });
    const refused = await call(member(alex), 'PUT', `${at}/versions/1/state`, { state: 'issued' });
    expect(refused.json()).toEqual({ error: 'bad-move', message: 'Only whoever manages it can make it Issued.' });
    expect((await call(lead(sam), 'PUT', `${at}/versions/1/state`, { state: 'issued', note: 'Signed off' })).json().state).toBe('issued');
    expect((await call(lead(sam), 'PUT', `${at}/versions/1/state`, { state: 'issued' })).json().error).toBe('bad-move');
    expect((await call(lead(sam), 'PUT', `${at}/versions/7/state`, { state: 'issued' })).statusCode).toBe(404);
    expect((await call(member(kim), 'GET', `${at}/moves`)).json().moves.map((m: { to: string }) => m.to)).toEqual(['issued', 'complete']);
    expect(audited.at(-1)).toMatchObject({ action: 'document.issued', target: doc.id, detail: { version: 1, from: 'complete', to: 'issued', note: 'Signed off' } });
    expect((await call(member(kim), 'GET', `/v1/libraries/${library}/documents?lifecycle=issued`)).json().total).toBe(1);
    expect((await call(member(kim), 'GET', `/v1/libraries/${library}/documents?lifecycle=complete`)).json().total).toBe(0);
  });
});
