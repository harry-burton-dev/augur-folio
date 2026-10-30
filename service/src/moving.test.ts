import { callerHeaders, type Caller } from '@augur/service-kit';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import type { FolioAuditEntry } from './audit.ts';
import { MOVED_REASON, moveOf, movePublications } from './moving.ts';
import { MemoryObjectStore } from './objects.ts';
import { MemoryFolioStore } from './store.ts';

// Ops sits in Dept; Pay sits in Ops; HR is beside them.
const TEAMS = [
  { id: 'dept', name: 'Dept', within: [], path: ['dept'] },
  { id: 'ops', name: 'Ops', within: ['Dept'], path: ['dept', 'ops'] },
  { id: 'pay', name: 'Pay', within: ['Dept', 'Ops'], path: ['dept', 'ops', 'pay'] },
  { id: 'hr', name: 'HR', within: [], path: ['hr'] },
];
const teams = new Map(TEAMS.map((t) => [t.id, t]));
const directory = async ({ ids }: { ids?: string[] }) => ({ people: [], teams: TEAMS.filter((t) => !ids || ids.includes(t.id)) });

describe('moving publications onto publishing up', () => {
  it('publishes up to the floors above, shares with the rest, and leaves out what the floor sees already', () => {
    expect(moveOf('ops', false, ['tree:ops', 'team:pay', 'tree:dept', 'org', 'team:hr', 'team:gone'], teams)).toEqual({ up: ['dept', 'org'], share: ['team:hr', 'team:gone'] });
    expect(moveOf('org', false, ['org', 'tree:hr'], teams)).toEqual({ up: [], share: [] });
    // From one person's own floor, only the org is above for everyone it went to.
    expect(moveOf('p-sam', true, ['org', 'tree:ops'], teams)).toEqual({ up: ['org'], share: ['tree:ops'] });
  });

  it('moves each document’s publication once, and leaves a series’ issues as they are', async () => {
    const audited: FolioAuditEntry[] = [];
    const store = new MemoryFolioStore();
    const app = await buildApp({ store, objects: new MemoryObjectStore(), audit: async (e) => void audited.push(e), directory });
    const lead: Caller = { id: 'u-lena', name: 'Lena Park', departments: [], roles: [], workspace: { id: 'ops', kind: 'team', role: 'lead' } };
    const call = (method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, headers: callerHeaders(lead), ...(payload ? { payload } : {}) });
    const send = (url: string) => app.inject({ method: 'POST', url, headers: { ...callerHeaders(lead), 'content-type': 'text/markdown' }, payload: '# Hi' });
    const { id: library } = (await call('POST', '/v1/libraries', { name: 'Ops papers' })).json();
    const plan = (await send(`/v1/libraries/${library}/documents?filename=plan.md`)).json();
    const { id: series } = (await call('POST', `/v1/libraries/${library}/series`, { name: 'Weekly', cadence: 'weekly' })).json();
    const week = (await send(`/v1/libraries/${library}/documents?filename=w1.md&series=${series}`)).json();
    await store.publish({ document: plan.id, version: 1, audience: ['tree:dept', 'team:hr'], note: 'For the review', by: 'u-lena' });
    await store.publish({ document: week.id, version: 1, audience: ['tree:dept'], by: 'u-lena' });

    expect(await movePublications({ store, directory, audit: async (e) => void audited.push(e), log: { error: () => {} } })).toBe(1);
    expect((await store.placementsOf(plan.id)).map((p) => [p.from, p.to, p.toPrincipal, p.filter, p.note, p.by])).toEqual([['ops', 'dept', 'tree:dept', ['issued'], 'For the review', 'u-lena']]);
    expect((await store.grants(library, plan.id)).map((g) => [g.principal, g.level])).toEqual([['team:hr', 'read']]);
    expect((await store.publications(plan.id))[0].ended).toMatchObject({ as: 'withdrawn', by: 'folio', reason: MOVED_REASON });
    expect((await store.publications(week.id))[0].ended).toBeUndefined();
    expect(audited.at(-1)).toMatchObject({ actor: 'folio', actorKind: 'service', action: 'document.moved-up', target: plan.id, detail: { up: ['dept'], shared: ['team:hr'] } });

    // Run again, there's nothing left to move.
    expect(await movePublications({ store, directory, audit: async () => {}, log: { error: () => {} } })).toBe(0);
  });
});
