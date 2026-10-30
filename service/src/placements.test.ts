import { callerHeaders, type Caller, type DirectoryTeam } from '@augur/service-kit';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import type { FolioAuditEntry } from './audit.ts';
import type { FolioNotice } from './notices.ts';
import { MemoryObjectStore } from './objects.ts';
import { MemoryFolioStore } from './store.ts';

// Dept is a team at the top; Ops sits in it. Sam and Lena are on Ops (Lena leads it); Alex is on Dept; Kim only the org.
const TEAMS: DirectoryTeam[] = [
  { id: 'dept', name: 'Dept', within: [], path: ['dept'] },
  { id: 'ops', name: 'Ops', within: ['Dept'], path: ['dept', 'ops'] },
  { id: 'hr', name: 'HR', within: [], path: ['hr'] },
];
const PRINCIPALS: Record<string, string[]> = {
  'u-sam': ['person:u-sam', 'team:ops', 'tree:dept', 'tree:ops', 'org'],
  'u-lena': ['person:u-lena', 'team:ops', 'tree:dept', 'tree:ops', 'org'],
  'u-alex': ['person:u-alex', 'team:dept', 'tree:dept', 'org'],
  'u-kim': ['person:u-kim', 'org'],
};
const MEMBERS: Record<string, string[]> = { 'tree:ops': ['u-sam', 'u-lena'], 'tree:dept': ['u-sam', 'u-lena', 'u-alex'], org: Object.keys(PRINCIPALS) };

const person = (id: string, name: string, roles: string[] = []): Caller => ({ id, name, departments: [], roles });
const sam = person('u-sam', 'Sam Okafor');
const lena = person('u-lena', 'Lena Park');
const alex = person('u-alex', 'Alex Rivera', ['publisher']);
const kim = person('u-kim', 'Kim Lee');
const own = (who: Caller): Caller => ({ ...who, workspace: { id: `p-${who.id}`, kind: 'personal', role: 'lead' } });
const on = (who: Caller, floor: string, role: 'lead' | 'member' = 'member'): Caller =>
  ({ ...who, workspace: floor === 'org' ? { id: 'w-org', kind: 'org', role } : { id: floor, kind: 'team', role } });

const setup = async () => {
  const audited: FolioAuditEntry[] = [];
  const told: FolioNotice[] = [];
  const app = await buildApp({
    store: new MemoryFolioStore(),
    objects: new MemoryObjectStore(),
    audit: async (entry) => void audited.push(entry),
    notify: async (notice) => void told.push(notice),
    principals: async (caller) => PRINCIPALS[caller.id] ?? [`person:${caller.id}`, 'org'],
    directory: async ({ ids }) => ({ people: [], teams: TEAMS.filter((t) => !ids || ids.includes(t.id)) }),
    audience: async (principals) => [...new Set(principals.flatMap((p) => MEMBERS[p] ?? []))],
  });
  const call = (caller: Caller, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: callerHeaders(caller), ...(payload ? { payload } : {}) });
  const send = (caller: Caller, url: string, body: string) => app.inject({ method: 'POST', url, headers: { ...callerHeaders(caller), 'content-type': 'text/markdown' }, payload: body });

  // Sam's own floor: a series of reports, one complete and one still in progress.
  const { id: library } = (await call(own(sam), 'POST', '/v1/libraries', { name: 'My work' })).json();
  const reports = (await call(own(sam), 'POST', `/v1/libraries/${library}/folders`, { name: 'Reports', level: 'series' })).json();
  const done = (await send(own(sam), `/v1/libraries/${library}/documents?filename=q3.md&folder=${reports.id}`, '# Q3')).json();
  await call(own(sam), 'PUT', `/v1/libraries/${library}/documents/${done.id}/versions/1/state`, { state: 'complete' });
  const draft = (await send(own(sam), `/v1/libraries/${library}/documents?filename=q4.md&folder=${reports.id}`, '# Q4')).json();
  return { call, audited, told, library, reports, done, draft };
};

const WORKING = ['in-progress', 'in-review', 'complete'];

describe('folio publishing up the floors', () => {
  it('offers the floors above, saying why one can’t be chosen', async () => {
    const { call, library, reports } = await setup();
    const targets = async (who: Caller) => (await call(who, 'GET', `/v1/placements?library=${library}&record=${reports.id}`)).json().targets;
    // Above Sam's own floor: the teams Sam is on and the ones they sit in, and the org, which needs the publisher role.
    expect((await targets(own(sam))).map((t: { to: { id: string }; why?: string }) => [t.to.id, t.why ?? ''])).toEqual([
      ['ops', ''],
      ['dept', ''],
      ['org', 'Publishing to the org needs the publisher role, which an admin can give you.'],
    ]);
    const placed = (await call(own(sam), 'POST', '/v1/placements', { library, record: { kind: 'folder', id: reports.id }, to: 'ops', filter: ['complete'] })).json();
    // Ops' lead may take it on up, showing no more than reached Ops; a member of Ops isn't offered anything.
    expect(await targets(on(lena, 'ops', 'lead'))).toEqual([
      expect.objectContaining({ from: expect.objectContaining({ id: 'ops' }), to: expect.objectContaining({ id: 'dept' }), via: placed.id, most: ['complete'] }),
      expect.objectContaining({ to: expect.objectContaining({ id: 'org' }), why: expect.stringContaining('publisher role') }),
    ]);
    expect(await targets(on(sam, 'ops'))).toEqual([]);
    expect((await targets(own(sam)))[0]).toMatchObject({ to: { id: 'ops' }, why: 'It’s already there.' });
  });

  it('publishes up only, through a filter, by whoever manages it', async () => {
    const { call, told, audited, library, reports } = await setup();
    const record = { kind: 'folder', id: reports.id };
    const to = (floor: string, filter = WORKING) => ({ library, record, to: floor, filter });
    expect((await call(own(sam), 'POST', '/v1/placements', to('hr'))).json()).toMatchObject({ error: 'bad-placement', message: expect.stringContaining('share it instead') });
    expect((await call(own(sam), 'POST', '/v1/placements', to('org'))).json().error).toBe('publisher-only');
    expect((await call(on(kim, 'ops'), 'POST', '/v1/placements', to('ops'))).statusCode).toBe(404);
    expect((await call(own(sam), 'POST', '/v1/placements', { ...to('ops'), filter: [] })).statusCode).toBe(400);

    const placed = await call(own(sam), 'POST', '/v1/placements', { ...to('ops'), note: 'For the stand-up' });
    expect(placed.statusCode).toBe(201);
    expect(placed.json()).toMatchObject({
      from: 'p-u-sam',
      to: 'ops',
      toPrincipal: 'tree:ops',
      filter: WORKING,
      record: { kind: 'folder', level: 'series', name: 'Reports' },
      toFloor: { name: 'Ops', rank: 2 },
      owner: { id: 'ops' },
    });
    expect((await call(own(sam), 'POST', '/v1/placements', to('ops'))).json().message).toContain('already on that floor');
    // Ops is told once, Sam isn't.
    expect(told).toEqual([expect.objectContaining({ recipients: ['u-lena'], title: 'Reports is on Ops', detail: 'For the stand-up', link: `/received/${placed.json().id}` })]);
    expect(audited.at(-1)).toMatchObject({ action: 'record.published', target: reports.id, detail: { from: 'p-u-sam', to: 'ops', filter: WORKING } });
  });

  it('goes on up from the floor that received it, never showing more, and the top floor owns it', async () => {
    const { call, library, reports, done, draft } = await setup();
    const first = (await call(own(sam), 'POST', '/v1/placements', { library, record: { kind: 'folder', id: reports.id }, to: 'ops', filter: WORKING })).json();
    const onUp = { library, record: { kind: 'folder', id: reports.id }, to: 'dept', via: first.id };
    expect((await call(on(sam, 'ops'), 'POST', '/v1/placements', { ...onUp, filter: ['complete'] })).statusCode).toBe(403);
    expect((await call(on(lena, 'ops', 'lead'), 'POST', '/v1/placements', { ...onUp, filter: ['complete', 'issued'] })).json().message).toContain('can’t show more');
    const second = await call(on(lena, 'ops', 'lead'), 'POST', '/v1/placements', { ...onUp, filter: ['complete'] });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({ from: 'ops', to: 'dept', owner: { id: 'dept', name: 'Dept' } });
    expect(second.json().chain.map((s: { to: { id: string } }) => s.to.id)).toEqual(['ops', 'dept']);

    // Lena is on both: she sees it once, on Dept, with everything either floor shows her; Ops points there.
    const onOps = (await call(on(lena, 'ops'), 'GET', '/v1/received')).json();
    expect(onOps.here).toEqual([]);
    expect(onOps.signposts).toEqual([expect.objectContaining({ placement: second.json().id, to: expect.objectContaining({ id: 'dept' }), record: expect.objectContaining({ name: 'Reports' }) })]);
    const onDept = (await call(on(lena, 'dept'), 'GET', '/v1/received')).json();
    expect(onDept.here.map((h: { id: string }) => h.id)).toEqual([second.json().id]);
    expect(onDept.here[0].states).toMatchObject({ complete: { id: 'dept' }, 'in-progress': { id: 'ops' } });
    const inside = (await call(on(lena, 'dept'), 'GET', `/v1/received/${second.json().id}`)).json();
    expect(inside.documents.map((d: { id: string; latest: { state: string }; onlyVia?: { id: string } }) => [d.id, d.latest.state, d.onlyVia?.id])).toEqual([
      [done.id, 'complete', undefined],
      [draft.id, 'in-progress', 'ops'],
    ]);

    // Alex is only on Dept: he sees what Dept was shown, and can read it, but nothing else.
    const alexSees = (await call(on(alex, 'dept'), 'GET', `/v1/received/${second.json().id}`)).json();
    expect(alexSees.documents.map((d: { id: string }) => d.id)).toEqual([done.id]);
    expect((await call(on(alex, 'dept'), 'GET', `/v1/libraries/${library}/documents/${done.id}`)).json()).toMatchObject({ only: 1, latest: { number: 1 } });
    expect((await call(on(alex, 'dept'), 'GET', `/v1/libraries/${library}/documents/${draft.id}`)).statusCode).toBe(404);
    expect((await call(on(kim, 'dept'), 'GET', `/v1/received/${second.json().id}`)).statusCode).toBe(404);

    // Narrowing a step below narrows the ones above it, and takes back one left showing nothing.
    await call(own(sam), 'PATCH', `/v1/placements/${first.id}`, { filter: ['in-progress', 'complete'] });
    expect((await call(own(sam), 'PATCH', `/v1/placements/${second.json().id}`, { filter: ['complete'] })).statusCode).toBe(403);
    await call(own(sam), 'PATCH', `/v1/placements/${first.id}`, { filter: ['in-progress'] });
    const history = (await call(own(sam), 'GET', `/v1/placements?library=${library}&record=${reports.id}`)).json();
    expect(history.placements.map((p: { to: string; filter: string[]; ended?: object }) => [p.to, p.filter, Boolean(p.ended)])).toEqual([
      ['ops', ['in-progress'], false],
      ['dept', ['complete'], true],
    ]);
    expect(history.owner).toMatchObject({ id: 'ops' });
  });

  it('says who it reaches by being published up: the floors it came through, and what each shows', async () => {
    const { call, library, reports, done } = await setup();
    const first = (await call(own(sam), 'POST', '/v1/placements', { library, record: { kind: 'folder', id: reports.id }, to: 'ops', filter: WORKING })).json();
    await call(on(lena, 'ops', 'lead'), 'POST', '/v1/placements', { library, record: { kind: 'folder', id: reports.id }, to: 'dept', via: first.id, filter: ['complete'] });
    const placed = (url: string) => call(own(sam), 'GET', url).then((r) => r.json().placed as { principal: string; name?: string; filter: string[]; chain: string[]; record: { id: string } }[] | undefined);
    const expected = [
      { principal: 'tree:ops', name: 'Ops', filter: WORKING, chain: ['Your own floor'], record: { kind: 'folder', id: reports.id } },
      { principal: 'tree:dept', name: 'Dept', filter: ['complete'], chain: ['Your own floor', 'Ops'], record: { kind: 'folder', id: reports.id } },
    ];
    // A document inside it, the folder itself, and not the library above it.
    expect(await placed(`/v1/libraries/${library}/documents/${done.id}/access`)).toMatchObject(expected);
    expect(await placed(`/v1/libraries/${library}/folders/${reports.id}/access`)).toMatchObject(expected);
    expect(await placed(`/v1/libraries/${library}/access`)).toBeUndefined();
  });

  it('takes back a step and every step that went on up from it, and keeps them all on the record', async () => {
    const { call, audited, library, reports, done } = await setup();
    const first = (await call(own(sam), 'POST', '/v1/placements', { library, record: { kind: 'folder', id: reports.id }, to: 'ops', filter: WORKING })).json();
    const second = (await call(on(lena, 'ops', 'lead'), 'POST', '/v1/placements', { library, record: { kind: 'folder', id: reports.id }, to: 'dept', via: first.id, filter: ['complete'] })).json();
    expect((await call(own(sam), 'GET', `/v1/placements/${first.id}/above`)).json().above).toEqual([expect.objectContaining({ id: 'dept' })]);
    expect((await call(on(alex, 'dept'), 'POST', `/v1/placements/${first.id}/withdraw`, {})).statusCode).toBe(403);
    const back = await call(own(sam), 'POST', `/v1/placements/${first.id}/withdraw`, { reason: 'Wrong numbers' });
    expect(back.json().withdrawn.map((w: { id: string }) => w.id).sort()).toEqual([first.id, second.id].sort());
    expect(audited.at(-1)).toMatchObject({ action: 'record.withdrawn', detail: { placement: first.id, also: [second.id], reason: 'Wrong numbers' } });
    expect((await call(on(alex, 'dept'), 'GET', '/v1/received')).json()).toEqual({ here: [], signposts: [] });
    expect((await call(on(alex, 'dept'), 'GET', `/v1/libraries/${library}/documents/${done.id}`)).statusCode).toBe(404);
    const history = (await call(own(sam), 'GET', `/v1/placements?library=${library}&record=${reports.id}`)).json();
    expect(history.placements.every((p: { ended?: object }) => p.ended)).toBe(true);
    expect(history.owner).toMatchObject({ id: `p-u-sam` });
  });

  it('lands where the receiving floor’s leads put it, where its level fits', async () => {
    const { call, library, reports } = await setup();
    const { id: shelf } = (await call(on(lena, 'ops', 'lead'), 'POST', '/v1/libraries', { name: 'Team work' })).json();
    const sub = (await call(on(lena, 'ops', 'lead'), 'POST', `/v1/libraries/${shelf}/folders`, { name: 'Weekly' })).json();
    const series = (await call(on(lena, 'ops', 'lead'), 'POST', `/v1/libraries/${shelf}/folders`, { name: 'Minutes', level: 'series' })).json();
    const placed = (await call(own(sam), 'POST', '/v1/placements', { library, record: { kind: 'folder', id: reports.id }, to: 'ops', filter: WORKING })).json();
    expect(placed.landed).toBeUndefined();
    expect((await call(on(sam, 'ops'), 'PUT', `/v1/placements/${placed.id}/landing`, { library: shelf, folder: sub.id })).statusCode).toBe(403);
    expect((await call(on(lena, 'ops', 'lead'), 'PUT', `/v1/placements/${placed.id}/landing`, { library: shelf, folder: series.id })).json().message).toBe('A series can’t go in a series: only subseries, files can.');
    expect((await call(on(lena, 'ops', 'lead'), 'PUT', `/v1/placements/${placed.id}/landing`, { library, folder: undefined })).json().error).toBe('bad-landing');
    expect((await call(on(lena, 'ops', 'lead'), 'PUT', `/v1/placements/${placed.id}/landing`, { library: shelf, folder: sub.id })).json().landed).toEqual({ library: shelf, folder: sub.id });
    expect((await call(on(lena, 'ops', 'lead'), 'DELETE', `/v1/placements/${placed.id}/landing`)).json().landed).toBeUndefined();
  });
});
