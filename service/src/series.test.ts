import { callerHeaders, type Caller } from '@augur/service-kit';
import { describe, expect, it } from 'vitest';
import { buildApp, type OnFloor } from './app.ts';
import { nextIssue } from './cadence.ts';
import type { FolioAuditEntry } from './audit.ts';
import type { FolioNotice } from './notices.ts';
import { MemoryObjectStore } from './objects.ts';
import { remindLate } from './series.ts';
import { MemoryFolioStore } from './store.ts';

const sam: Caller = { id: 'u-sam', name: 'Sam Okafor', departments: [], roles: [] };
const alex: Caller = { id: 'u-alex', name: 'Alex Rivera', departments: [], roles: [] };
const kim: Caller = { id: 'u-kim', name: 'Kim Lee', departments: [], roles: [] };
const on = (who: Caller, floor: string, role: 'lead' | 'member' = 'member'): Caller => ({ ...who, workspace: { id: floor, kind: 'team', role } });

/** Sam leads Finance; Alex is on Payroll, below Finance; Kim is on Legal. */
const STANDS_FOR: Record<string, string[]> = {
  'u-sam': ['person:u-sam', 'team:w-fin', 'tree:w-fin', 'org'],
  'u-alex': ['person:u-alex', 'team:w-pay', 'tree:w-fin', 'tree:w-pay', 'org'],
  'u-kim': ['person:u-kim', 'team:w-legal', 'tree:w-legal', 'org'],
};
const TEAMS = [
  { id: 'w-fin', name: 'Finance', within: [], path: ['w-fin'] },
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
    audience: async (principals) => Object.keys(STANDS_FOR).filter((id) => STANDS_FOR[id].some((p) => principals.includes(p))),
  });
  const call = (caller: Caller, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: callerHeaders(caller), ...(payload ? { payload } : {}) });
  const lead = on(sam, 'w-fin', 'lead');
  const { id: library } = (await call(lead, 'POST', '/v1/libraries', { name: 'Reports' })).json();
  const addIssue = async (caller: Caller, series: string, name = 'week.md') =>
    app.inject({ method: 'POST', url: `/v1/libraries/${library}/documents?filename=${name}&series=${series}`, headers: { ...callerHeaders(caller), 'content-type': 'text/markdown' }, payload: '# Cash' });
  return { app, call, store, library, lead, addIssue, audited, told };
};

describe('folio series', () => {
  it('adds the next issue in one step: numbered, titled, tagged and published to the series’ audience', async () => {
    const { call, library, lead, addIssue, audited, told } = await setup();
    const { id: tag } = (await call(lead, 'POST', `/v1/libraries/${library}/tags`, { name: 'Cash' })).json();
    const made = await call(lead, 'POST', `/v1/libraries/${library}/series`, { name: 'Cash report', cadence: 'weekly', audience: ['tree:w-fin'], tags: [tag] });
    expect(made.statusCode).toBe(201);
    const run = made.json();
    expect(run).toMatchObject({ name: 'Cash report', cadence: 'weekly', issues: 0, following: false, next: { number: 1, overdue: false }, can: { manage: true, addIssue: true } });
    expect(audited.at(-1)).toMatchObject({ action: 'series.created', target: run.id });

    // Alex follows it; Sam publishes, so only Alex is told.
    expect((await call(on(alex, 'w-fin'), 'PUT', `/v1/series/${run.id}/follow`, { following: true })).json()).toEqual({ following: true });
    const issue = await addIssue(lead, run.id);
    expect(issue.statusCode).toBe(201);
    const period = nextIssue('weekly', undefined).period;
    expect(issue.json()).toMatchObject({ title: `Cash report: ${period}`, tags: [tag], state: 'published', issue: { series: run.id, number: 1, period }, published: { version: 1, audience: ['tree:w-fin'] } });
    expect(told).toEqual([expect.objectContaining({ recipients: ['u-alex'], title: `Cash report: ${period} is out`, link: `/libraries/${library}/documents/${issue.json().id}` })]);
    expect(audited.map((a) => a.action)).toEqual(expect.arrayContaining(['document.uploaded', 'document.published']));

    // A member adds one too, but it waits as a draft for whoever manages the library.
    const second = (await addIssue(on(alex, 'w-fin'), run.id)).json();
    expect(second).toMatchObject({ issue: { number: 2 }, state: 'draft', draft: expect.stringContaining('manages this library') });
    expect(told).toHaveLength(1);

    const reader = (await call(on(alex, 'w-fin'), 'GET', `/v1/libraries/${library}/documents/${second.id}`)).json();
    expect(reader.run).toMatchObject({ id: run.id, name: 'Cash report', cadence: 'weekly', following: true, previous: { id: issue.json().id, number: 1 } });
    expect(reader.run.next).toBeUndefined();
    const listed = (await call(lead, 'GET', `/v1/libraries/${library}/documents?series=${run.id}&sort=period&below=true`)).json();
    expect(listed.documents.map((d: { issue: { number: number } }) => d.issue.number)).toEqual([2, 1]);
    expect((await call(lead, 'GET', `/v1/libraries/${library}`)).json().series.map((s: { name: string }) => s.name)).toEqual(['Cash report']);
    expect((await call(lead, 'GET', `/v1/libraries/${library}/series`)).json()).toMatchObject({ series: [{ issues: 2, next: { number: 3 } }], can: { create: true } });

    // A series with issues stays; one with none can go.
    expect((await call(lead, 'DELETE', `/v1/libraries/${library}/series/${run.id}`)).statusCode).toBe(409);
    expect((await addIssue(lead, 'nope')).json().error).toBe('bad-series');
  });

  it('lets its audience read, list and follow it from their own floor', async () => {
    const { call, library, lead, addIssue, told } = await setup();
    const publisher = { ...lead, roles: ['publisher'] };
    const run = (await call(publisher, 'POST', `/v1/libraries/${library}/series`, { name: 'Legal digest', cadence: 'monthly', audience: ['team:w-legal'] })).json();
    const kim1 = on(kim, 'w-legal');
    expect((await call(kim1, 'GET', `/v1/series/${run.id}`)).json()).toMatchObject({
      name: 'Legal digest',
      libraryName: 'Reports',
      audience: [{ principal: 'team:w-legal', name: 'Legal' }],
      can: { manage: false, addIssue: false },
    });
    expect((await call(kim1, 'PUT', `/v1/series/${run.id}/follow`, { following: true })).statusCode).toBe(200);

    const one = (await addIssue(publisher, run.id)).json();
    const two = (await addIssue(publisher, run.id)).json();
    expect(told.map((n) => n.recipients)).toEqual([['u-kim'], ['u-kim']]);
    const issues = (await call(kim1, 'GET', `/v1/series/${run.id}/issues`)).json();
    expect(issues.documents.map((d: { id: string }) => d.id)).toEqual([two.id, one.id]);
    const reading = (await call(kim1, 'GET', `/v1/libraries/${library}/documents/${one.id}`)).json();
    expect(reading).toMatchObject({ only: 1, run: { following: true, next: { id: two.id, number: 2 } } });

    // Withdrawn, it's gone from either side.
    await call(lead, 'POST', `/v1/libraries/${library}/documents/${two.id}/withdraw`, {});
    expect((await call(kim1, 'GET', `/v1/libraries/${library}/documents/${one.id}`)).json().run.next).toBeUndefined();
    // Someone neither in its library nor its audience can't see it at all.
    expect((await call(on({ ...kim, id: 'u-out' }, 'w-out'), 'GET', `/v1/series/${run.id}`)).statusCode).toBe(404);
  });

  it('lets only managers keep series, and only to an audience they may publish to', async () => {
    const { call, library, lead } = await setup();
    expect((await call(on(alex, 'w-fin'), 'POST', `/v1/libraries/${library}/series`, { name: 'Mine', cadence: 'weekly' })).statusCode).toBe(403);
    expect((await call(lead, 'POST', `/v1/libraries/${library}/series`, { name: 'Org', cadence: 'weekly', audience: ['org'] })).json().error).toBe('publisher-only');
    expect((await call(lead, 'POST', `/v1/libraries/${library}/series`, { name: 'Odd', cadence: 'daily' })).statusCode).toBe(400);
    const run = (await call(lead, 'POST', `/v1/libraries/${library}/series`, { name: 'Board pack', cadence: 'adhoc' })).json();
    expect((await call(lead, 'POST', `/v1/libraries/${library}/series`, { name: 'board pack', cadence: 'adhoc' })).json().error).toBe('name-taken');
    const changed = await call(lead, 'PATCH', `/v1/libraries/${library}/series/${run.id}`, { cadence: 'quarterly', description: 'Each quarter' });
    expect(changed.json()).toMatchObject({ cadence: 'quarterly', description: 'Each quarter', audience: [] });
    expect((await call(lead, 'PATCH', `/v1/libraries/${library}/series/${run.id}`, { audience: ['team:w-legal'] })).json().error).toBe('publisher-only');
    expect((await call(on(alex, 'w-fin'), 'PATCH', `/v1/libraries/${library}/series/${run.id}`, { name: 'X' })).statusCode).toBe(403);
    expect((await call(lead, 'DELETE', `/v1/libraries/${library}/series/${run.id}`)).statusCode).toBe(204);
    expect((await call(lead, 'GET', `/v1/series/${run.id}`)).statusCode).toBe(404);
  });

  it('reminds the owner once when an issue is late', async () => {
    const { call, store, library, lead, addIssue } = await setup();
    const run = (await call(lead, 'POST', `/v1/libraries/${library}/series`, { name: 'Cash report', cadence: 'weekly' })).json();
    await call(lead, 'POST', `/v1/libraries/${library}/series`, { name: 'Board pack', cadence: 'adhoc' });
    await addIssue(lead, run.id);
    const told: Parameters<Parameters<typeof remindLate>[0]['notify']>[0][] = [];
    const notify = async (notice: (typeof told)[number]) => void told.push(notice);
    const log = { error: () => undefined };
    const next = nextIssue('weekly', (await store.series(run.id))!.last);

    await remindLate({ store, notify, log });
    expect(told).toEqual([]);
    const late = new Date(new Date(next.dueAt!).getTime() + 1000);
    await remindLate({ store, notify, log, now: late });
    await remindLate({ store, notify, log, now: late });
    expect(told).toEqual([
      { recipients: ['u-sam'], workspace: 'w-fin', title: 'Cash report is late', detail: expect.stringContaining(`The issue for ${next.period} was due by the end of`), link: `/libraries/${library}/series/${run.id}` },
    ]);
  });
});
