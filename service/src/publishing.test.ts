import { callerHeaders, type Caller } from '@augur/service-kit';
import { describe, expect, it } from 'vitest';
import { buildApp, type OnFloor } from './app.ts';
import type { FolioAuditEntry } from './audit.ts';
import type { FolioNotice } from './notices.ts';
import { MemoryObjectStore } from './objects.ts';
import { MemoryFolioStore } from './store.ts';

const sam: Caller = { id: 'u-sam', name: 'Sam Okafor', departments: [], roles: [] };
const alex: Caller = { id: 'u-alex', name: 'Alex Rivera', departments: [], roles: [] };
const kim: Caller = { id: 'u-kim', name: 'Kim Lee', departments: [], roles: [] };
const on = (who: Caller, floor: string, role: 'lead' | 'member' = 'member', kind: 'team' | 'personal' | 'org' = 'team'): Caller => ({ ...who, workspace: { id: floor, kind, role } });

/** Sam leads Finance; Alex is on Payroll, below Finance; Kim is on Legal. */
const STANDS_FOR: Record<string, string[]> = {
  'u-sam': ['person:u-sam', 'team:w-fin', 'tree:w-fin', 'org'],
  'u-alex': ['person:u-alex', 'team:w-pay', 'tree:w-fin', 'tree:w-pay', 'org'],
  'u-kim': ['person:u-kim', 'team:w-legal', 'tree:w-legal', 'org'],
};
const TEAMS = [
  { id: 'w-fin', name: 'Finance', within: [], path: ['w-fin'] },
  { id: 'w-pay', name: 'Payroll', within: ['Finance'], path: ['w-fin', 'w-pay'] },
  { id: 'w-legal', name: 'Legal', within: [], path: ['w-legal'] },
];

const setup = async () => {
  const audited: FolioAuditEntry[] = [];
  const told: FolioNotice[] = [];
  const store = new MemoryFolioStore();
  const app = await buildApp({
    store,
    objects: new MemoryObjectStore(),
    audit: async (entry) => void audited.push(entry),
    notify: async (notice) => void told.push(notice),
    principals: async (caller: OnFloor) => STANDS_FOR[caller.id] ?? [`person:${caller.id}`, 'org'],
    directory: async ({ ids }) => ({ people: [], teams: TEAMS.filter((t) => ids?.includes(t.id)) }),
    // Everyone who stands for one of the principals.
    audience: async (principals) => Object.keys(STANDS_FOR).filter((id) => STANDS_FOR[id].some((p) => principals.includes(p))),
  });
  const call = (caller: Caller, method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, headers: callerHeaders(caller), ...(payload ? { payload } : {}) });
  const lead = on(sam, 'w-fin', 'lead');
  const { id: library } = (await call(lead, 'POST', '/v1/libraries', { name: 'Policies' })).json();
  const upload = async (name: string) =>
    (await app.inject({ method: 'POST', url: `/v1/libraries/${library}/documents?filename=${encodeURIComponent(`${name}.md`)}`, headers: { ...callerHeaders(lead), 'content-type': 'text/markdown' }, payload: `# ${name}` })).json();
  const addVersion = (doc: string) =>
    app.inject({ method: 'POST', url: `/v1/libraries/${library}/documents/${doc}/versions?filename=v2.md`, headers: { ...callerHeaders(lead), 'content-type': 'text/markdown' }, payload: '# Two' });
  return { app, call, store, library, lead, upload, addVersion, audited, told };
};

describe('folio publishing', () => {
  it('publishes a version to a team, who read that version alone and are told', async () => {
    const { call, store, library, lead, upload, addVersion, audited, told } = await setup();
    const doc = await upload('Travel');
    await addVersion(doc.id);
    const base = `/v1/libraries/${library}/documents/${doc.id}`;

    // Legal is beyond Finance: Sam publishes there as a publisher.
    const res = await call({ ...lead, roles: ['publisher'] }, 'POST', `${base}/publish`, { version: 1, audience: ['team:w-legal'], note: 'Approved on Monday' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ version: 1, audience: [{ principal: 'team:w-legal', kind: 'team', name: 'Legal' }], note: 'Approved on Monday', publishedBy: 'u-sam' });
    expect(audited.at(-1)).toMatchObject({ actor: 'u-sam', action: 'document.published', target: doc.id, workspace: 'w-fin', detail: { version: 1, audience: ['team:w-legal'], note: 'Approved on Monday' } });
    expect(told).toEqual([
      {
        recipients: ['u-kim'],
        workspace: 'w-fin',
        title: 'New in Policies: Travel',
        detail: 'Approved on Monday',
        link: `/libraries/${library}/documents/${doc.id}`,
        actions: [{ label: 'Read', intent: { type: 'document.open', payload: { app: 'folio', id: doc.id, version: '1', title: 'Travel' } } }],
      },
    ]);
    expect(store.outbox.map((e) => e.topic)).toContain('folio.document.published');

    // Kim reads the version that's out, and nothing else of it or its library.
    const kim1 = on(kim, 'w-legal');
    const opened = (await call(kim1, 'GET', base)).json();
    expect(opened).toMatchObject({ only: 1, latest: { number: 1 }, state: 'published', can: { change: false, share: false, publish: false } });
    expect(opened.versions.map((v: { number: number }) => v.number)).toEqual([1]);
    expect((await call(kim1, 'GET', `${base}/versions/1/original`)).statusCode).toBe(200);
    expect((await call(kim1, 'GET', `${base}/versions/2/original`)).statusCode).toBe(404);
    expect((await call(kim1, 'GET', `${base}/versions/2/reader`)).statusCode).toBe(404);
    expect((await call(kim1, 'GET', `${base}/access`)).statusCode).toBe(404);
    expect((await call(kim1, 'GET', `${base}/publications`)).statusCode).toBe(404);
    expect((await call(kim1, 'GET', `/v1/libraries/${library}`)).statusCode).toBe(404);
    expect((await call(kim1, 'GET', '/v1/published')).json().documents.map((d: { title: string; libraryName: string }) => [d.title, d.libraryName])).toEqual([['Travel', 'Policies']]);
    expect((await call(kim1, 'GET', `/v1/documents/${doc.id}`)).json()).toEqual({ id: doc.id, library, title: 'Travel', only: 1 });

    // Withdrawn, it's gone from them, and the record says why.
    const withdrawn = await call(lead, 'POST', `${base}/withdraw`, { reason: 'Superseded by the new policy' });
    expect(withdrawn.json()).toMatchObject({ ended: { as: 'withdrawn', by: 'u-sam', reason: 'Superseded by the new policy' } });
    expect(audited.at(-1)).toMatchObject({ action: 'document.withdrawn', detail: { version: 1, reason: 'Superseded by the new policy' } });
    expect((await call(kim1, 'GET', base)).statusCode).toBe(404);
    expect((await call(kim1, 'GET', '/v1/published')).json().documents).toEqual([]);
    expect((await call(lead, 'POST', `${base}/withdraw`, {})).json().error).toBe('not-published');

    const history = (await call(lead, 'GET', `${base}/publications`)).json();
    expect(history.publications.map((p: { version: number; ended?: { as: string } }) => [p.version, p.ended?.as])).toEqual([[1, 'withdrawn']]);
    expect(history.can).toEqual({ publish: true, publishToOrg: false });
  });

  it('lets a team’s leads publish to their team and below; beyond that needs the publisher role', async () => {
    const { call, library, lead, upload, told } = await setup();
    const doc = await upload('Travel');
    const publish = (caller: Caller, audience: string[]) => call(caller, 'POST', `/v1/libraries/${library}/documents/${doc.id}/publish`, { version: 1, audience });

    expect((await publish(lead, ['team:w-fin', 'tree:w-pay'])).statusCode).toBe(201);
    // Sam published it, so only Alex is told.
    expect(told.at(-1)?.recipients).toEqual(['u-alex']);
    expect((await publish(lead, ['team:w-legal'])).json().error).toBe('publisher-only');
    expect((await publish(lead, ['org'])).json()).toMatchObject({ error: 'publisher-only', message: expect.stringContaining('the whole org') });
    expect((await publish({ ...lead, roles: ['publisher'] }, ['org'])).statusCode).toBe(201);
    expect(told.at(-1)?.title).toBe('New in Policies: Travel');

    // Members add drafts; only managers publish.
    expect((await publish(on(alex, 'w-fin'), ['team:w-fin'])).statusCode).toBe(403);
    expect((await publish(lead, ['person:u-kim'])).json().error).toBe('bad-audience');
    expect((await publish(lead, ['team:w-nowhere'])).json().error).toBe('unknown-team');
    expect((await call(lead, 'POST', `/v1/libraries/${library}/documents/${doc.id}/publish`, { version: 7, audience: ['team:w-fin'] })).statusCode).toBe(404);
  });

  it('publishes from your own floor only with the publisher role', async () => {
    const { app, call } = await setup();
    const me = on(alex, 'p-alex', 'lead', 'personal');
    const { id: library } = (await call(me, 'POST', '/v1/libraries', { name: 'Notes' })).json();
    const doc = (await app.inject({ method: 'POST', url: `/v1/libraries/${library}/documents?filename=Plan.md`, headers: { ...callerHeaders(me), 'content-type': 'text/markdown' }, payload: '# Plan' })).json();
    const publish = (caller: Caller) => call(caller, 'POST', `/v1/libraries/${library}/documents/${doc.id}/publish`, { version: 1, audience: ['team:w-pay'] });
    expect((await publish(me)).json()).toMatchObject({ error: 'publisher-only', message: expect.stringContaining('share it') });
    expect((await publish({ ...me, roles: ['publisher'] })).statusCode).toBe(201);
  });
});
