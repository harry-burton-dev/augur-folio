import { callerHeaders, type Caller } from '@augur/service-kit';
import { describe, expect, it } from 'vitest';
import { buildApp, type OnFloor } from './app.ts';
import { MemoryObjectStore } from './objects.ts';
import { MemoryFolioStore } from './store.ts';

const sam: Caller = { id: 'u-sam', name: 'Sam Okafor', departments: [], roles: [] };
const kim: Caller = { id: 'u-kim', name: 'Kim Lee', departments: [], roles: [] };
const on = (who: Caller, floor: string, role: 'lead' | 'member' = 'member'): Caller => ({ ...who, workspace: { id: floor, kind: 'team', role } });

/** Sam leads Finance and is on Payroll; Kim is on Legal. */
const STANDS_FOR: Record<string, string[]> = {
  'u-sam': ['person:u-sam', 'team:w-fin', 'tree:w-fin', 'team:w-pay', 'tree:w-pay', 'org'],
  'u-kim': ['person:u-kim', 'team:w-legal', 'tree:w-legal', 'org'],
};

const setup = async () => {
  const store = new MemoryFolioStore();
  const app = await buildApp({
    store,
    objects: new MemoryObjectStore(),
    audit: async () => undefined,
    notify: async () => undefined,
    principals: async (caller: OnFloor) => STANDS_FOR[caller.id] ?? [`person:${caller.id}`, 'org'],
    directory: async ({ ids }) => ({ people: [], teams: ids?.includes('w-legal') ? [{ id: 'w-legal', name: 'Legal', within: [], path: ['w-legal'] }] : [] }),
    audience: async () => [],
  });
  const call = (caller: Caller, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => app.inject({ method, url, headers: callerHeaders(caller), ...(payload ? { payload } : {}) });
  const upload = async (caller: Caller, library: string, name: string, body = '# Notes') =>
    (await app.inject({ method: 'POST', url: `/v1/libraries/${library}/documents?filename=${name}`, headers: { ...callerHeaders(caller), 'content-type': 'text/markdown' }, payload: body })).json();
  return { store, call, upload };
};

describe('folio in the shell', () => {
  it('answers Find with what the person may read, by title, tags and text', async () => {
    const { store, call, upload } = await setup();
    const lead = { ...on(sam, 'w-fin', 'lead'), roles: ['publisher'] };
    const { id: fin } = (await call(lead, 'POST', '/v1/libraries', { name: 'Policies' })).json();
    const { id: pay } = (await call(on(sam, 'w-pay', 'lead'), 'POST', '/v1/libraries', { name: 'Payroll' })).json();
    const travel = await upload(lead, fin, 'travel-policy.md', '# Travel\n\nBook trains before flights.');
    await store.finishRendition(travel.latest.id, { state: 'ready', engine: 'markdown', engineVersion: '1', readerKey: 'r.md', images: [], text: 'Book trains before flights.' });
    const runs = await upload(on(sam, 'w-pay', 'lead'), pay, 'travel-runs.md');

    const found = (await call(lead, 'GET', '/v1/search?q=travel')).json();
    expect(found.results).toEqual(
      expect.arrayContaining([
        { id: travel.id, title: travel.title, detail: 'In Policies', path: `/libraries/${fin}/documents/${travel.id}` },
        // On another team's floor Sam is on, so it opens there.
        { id: runs.id, title: runs.title, detail: 'In Payroll', path: `/libraries/${pay}/documents/${runs.id}`, workspace: 'w-pay' },
      ]),
    );
    expect((await call(lead, 'GET', '/v1/search?q=trains')).json().results.map((r: { id: string }) => r.id)).toEqual([travel.id]);
    expect((await call(lead, 'GET', '/v1/search?q=')).json()).toEqual({ results: [] });

    // Kim sees nothing until it's published to Legal, then only as its audience.
    const legal = on(kim, 'w-legal');
    expect((await call(legal, 'GET', '/v1/search?q=travel')).json().results).toEqual([]);
    await call(lead, 'POST', `/v1/libraries/${fin}/documents/${travel.id}/publish`, { version: 1, audience: ['team:w-legal'] });
    expect((await call(legal, 'GET', '/v1/search?q=travel')).json().results).toEqual([
      { id: travel.id, title: travel.title, detail: 'Published to you from Policies', path: `/libraries/${fin}/documents/${travel.id}` },
    ]);
    expect((await call(sam, 'GET', '/v1/search?q=travel')).statusCode).toBe(400);

    // The picker finds the same, as whole documents.
    expect((await call(legal, 'GET', '/v1/find?q=travel')).json().documents).toMatchObject([{ id: travel.id, libraryName: 'Policies', audienceOnly: true, published: { version: 1 } }]);
  });

  it('gives Home what’s new since the person last looked, and the floor’s drafts to its leads', async () => {
    const { call, upload } = await setup();
    const lead = { ...on(sam, 'w-fin', 'lead'), roles: ['publisher'] };
    const legal = on(kim, 'w-legal');
    const { id: fin } = (await call(lead, 'POST', '/v1/libraries', { name: 'Policies' })).json();
    const travel = await upload(lead, fin, 'travel.md');
    await upload(lead, fin, 'leave.md');
    expect((await call(legal, 'GET', '/v1/home')).json()).toEqual({ published: { new: 0, documents: [] } });

    await call(lead, 'POST', `/v1/libraries/${fin}/documents/${travel.id}/publish`, { version: 1, audience: ['team:w-legal'] });
    const home = (await call(legal, 'GET', '/v1/home')).json();
    expect(home).toMatchObject({ published: { new: 1, documents: [{ id: travel.id, library: fin, title: travel.title, libraryName: 'Policies' }] } });
    expect(home.drafts).toBeUndefined();

    expect((await call(legal, 'PUT', '/v1/published/looked')).statusCode).toBe(204);
    const after = (await call(legal, 'GET', '/v1/home')).json();
    expect(after.published).toMatchObject({ new: 0, documents: [], since: expect.any(String) });

    expect((await call(lead, 'GET', '/v1/home')).json().drafts).toMatchObject({ total: 1, documents: [{ title: 'leave' }] });
    expect((await call(on(sam, 'w-fin'), 'GET', '/v1/home')).json().drafts).toBeUndefined();
  });
});
