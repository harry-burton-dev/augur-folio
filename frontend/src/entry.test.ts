import { createEventBus, type MountContext, type Workspace } from '@augur/mfe-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathFor, placeFor, type ReaderState } from './api.js';
import app, { addressFor, placeForIntent, proposeFrom } from './entry.js';
import { explainPayload } from './access.js';
import { folderTrail, folderTree } from './places.js';
import { DEFAULT_LEVELS } from './words.js';

const floor: Workspace = { id: 'w-fin', kind: 'team', name: 'Finance', slug: 'finance', path: [], role: 'lead' };
const policies = { id: 'l-1', workspace: 'w-fin', name: 'Policies', description: 'How we work', freeTags: false, createdBy: 'u1', createdAt: '', updatedAt: '' };
const reports = { ...policies, id: 'l-2', name: 'Reports', description: '' };
const hr = { id: 'f-hr', library: 'l-1', level: 'subcollection' as const, name: 'HR', description: '', state: 'open' as const, createdBy: 'u1', createdAt: '', updatedAt: '' };
const leave = { id: 'f-leave', library: 'l-1', parent: 'f-hr', level: 'series' as const, name: 'Leave', description: '', state: 'open' as const, createdBy: 'u2', createdAt: '', updatedAt: '' };
const it_ = { id: 'f-it', library: 'l-1', level: 'subcollection' as const, name: 'IT', description: '', state: 'open' as const, createdBy: 'u2', createdAt: '', updatedAt: '' };
const TRAVEL_MD = '# Travel policy\n\nBook through the travel desk.\n\n## Claims\n\nClaim within 30 days.\n\n![A map](images/1.png)\n\n![](https://tracker.example/x.gif)\n';
const READY = { state: 'ready', pages: 3, thumbnail: true } as ReaderState;
const DAMAGED = { state: 'failed', error: 'The file is damaged.', thumbnail: false } as ReaderState;
const v = (number: number, filename = 'travel.pdf', size = 1_234_567, reader = READY) => ({ id: `v-${number}`, document: 'd-1', number, filename, mediaType: 'application/pdf', size, sha256: 'ab', createdBy: 'u2', createdAt: new Date().toISOString(), reader });
const travel = { id: 'd-1', workspace: 'w-fin', library: 'l-1', title: 'Travel policy', createdBy: 'u2', createdAt: '', updatedAt: new Date().toISOString(), latest: v(2), tags: [] as string[], can: { change: true, share: true } };
const tag = (id: string, name: string, library?: string) => ({ id, workspace: library ? 'w-fin' : 'w-org', ...(library ? { library } : {}), name, createdBy: 'u1', createdAt: '' });
const policyTag = tag('t-pol', 'Policy');
const travelTag = tag('t-trv', 'Travel', 'l-1');
const recent = { id: 'vw-1', library: 'l-1', name: 'Recent policy', query: { tags: ['t-pol'], sort: 'updated' }, createdBy: 'u1', createdAt: '' };

const CASH = { id: 's-1', workspace: 'w-fin', library: 'l-1', name: 'Cash report', description: 'Where the money is', cadence: 'weekly', audience: ['tree:w-fin'], tags: [] as string[], createdBy: 'u1', createdAt: '', updatedAt: '', issues: 2, last: { document: 'd-6', number: 2, periodStart: '2026-10-19', period: 'Week 43, 2026' } };
const issue = (id: string, number: number, period: string) => ({ ...travel, id, title: `Cash report: ${period}`, state: 'published', issue: { series: 's-1', number, periodStart: '', period } });

/** A stand-in for Folio's service, answering what the app asks through ctx.fetch. */
const FINANCE = { principal: 'tree:w-fin', kind: 'tree', name: 'Finance', within: [] };
const KIM = { principal: 'person:u3', kind: 'person', name: 'Kim Lee', email: 'kim@example.org', level: 'read', createdBy: 'u1', createdAt: new Date().toISOString() };
const NO_SHARED = { libraries: [] as unknown[], documents: [] as unknown[] };

const service = ({
  lead = true,
  libraries = [policies, reports],
  folders = [hr, leave, it_],
  documents = [] as (typeof travel & { folder?: string })[],
  views = [recent] as (typeof recent)[],
  shared = NO_SHARED,
  series = [] as unknown[],
  /** Travel policy as a series' issue: only issues still go out one version at a time. */
  anIssue = false,
  /** Whether the caller may rename the levels: the org's leads, on the org's floor. */
  renameLevels = false,
} = {}) => {
  const calls: [string, string, unknown?][] = [];
  let grants: (typeof KIM)[] = [KIM];
  let folderGrants: (typeof KIM)[] = [];
  let levels = DEFAULT_LEVELS.map((l) => ({ ...l }));
  let retried = false;
  /** Travel policy's newest version's lifecycle state, and its steps up the floors. */
  let state = 'in-progress';
  let placed: Record<string, unknown>[] = [];
  /** Travel policy's links, and what links to it. */
  let linked: Record<string, unknown>[] = [];
  /** What's out of Travel policy, if anything. */
  let out: { id: string; version: number; audience: string[]; publishedAt: string; ended?: { as: string; at: string; by: string } } | undefined;
  const named = (p: NonNullable<typeof out>) => ({ ...p, document: 'd-1', library: 'l-1', publishedBy: 'u1', audience: p.audience.map((a) => (a === 'tree:w-fin' ? FINANCE : { principal: a, kind: 'org' })) });
  const deleted = new Set<string>();
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const raw = init?.body;
    const body = raw instanceof Blob ? raw : raw ? JSON.parse(String(raw)) : undefined;
    calls.push(body ? [method, path, body] : [method, path]);
    const route = path.replace('/api/folio/v1', '');
    const [where, query = ''] = route.split('?');
    const params = new URLSearchParams(query);
    if (method === 'GET' && /^\/libraries\/[^/]+\/documents$/.test(where)) {
      const tags = params.getAll('tag');
      const found = documents.filter((d) => !deleted.has(d.id) && (params.get('below') ? true : d.folder === (params.get('folder') ?? undefined)) && tags.every((t) => d.tags.includes(t)));
      return Response.json({ documents: found, total: found.length });
    }
    if (method === 'GET' && where === '/levels') return Response.json({ levels, top: ['collection'], can: { rename: renameLevels } });
    const naming = where.match(/^\/levels\/([a-z]+)$/);
    if (naming) {
      const own = DEFAULT_LEVELS.find((l) => l.id === naming[1])!;
      levels = levels.map((l) => (l.id === own.id ? { ...l, ...(method === 'PUT' ? body : { name: own.name, plural: own.plural }) } : l));
      return Response.json({ levels });
    }
    if (method === 'GET' && where === '/series/s-1')
      return Response.json({ ...CASH, audience: [FINANCE], libraryName: 'Policies', following: false, next: { number: 3, periodStart: '2026-10-26', period: 'Week 44, 2026', dueBy: '2026-11-02', overdue: false }, can: { manage: lead, addIssue: true, publish: lead } });
    if (method === 'GET' && where === '/series/s-1/issues') return Response.json({ documents: [issue('d-6', 2, 'Week 43, 2026'), issue('d-5', 1, 'Week 42, 2026')], total: 2 });
    if (method === 'PUT' && where === '/series/s-1/follow') return Response.json(body);
    if (method === 'POST' && where === '/libraries/l-1/series') return Response.json({ ...CASH, id: 's-new', name: body.name, issues: 0 }, { status: 201 });
    if (method === 'GET' && where === '/libraries/l-1/documents/d-5')
      return Response.json({
        ...issue('d-5', 1, 'Week 42, 2026'),
        libraryName: 'Policies',
        versions: [v(2)],
        run: { id: 's-1', name: 'Cash report', cadence: 'weekly', following: true, next: { id: 'd-6', library: 'l-1', title: 'Cash report: Week 43, 2026', number: 2, period: 'Week 43, 2026' } },
      });
    if (method === 'GET' && where === '/libraries/l-1/documents/d-5/versions/2/reader') return new Response('# Cash\n\nPlenty.', { headers: { 'content-type': 'text/markdown' } });
    if (method === 'PUT' && where === '/libraries/l-1/documents/d-1/tags') return Response.json({ ...travel, tags: body.tags });
    if (method === 'POST' && where === '/libraries/l-1/tags') return Response.json(tag('t-new', body.name, 'l-1'), { status: 201 });
    if (method === 'GET' && where === '/tags') return Response.json({ tags: [policyTag], can: { manage: false } });
    if (method === 'POST' && where === '/libraries/l-1/views') return Response.json({ ...recent, id: 'vw-new', name: body.name, query: body.query }, { status: 201 });
    if (method === 'PATCH' && where === '/libraries/l-1') return Response.json({ ...policies, ...body });
    if (method === 'POST' && where === '/libraries/l-1/documents') {
      if (params.get('filename') === 'big.pdf') return new Response('Payload Too Large', { status: 413 });
      if (params.get('series')) return Response.json({ ...issue('d-7', 3, 'Week 44, 2026'), state: lead ? 'published' : 'draft', ...(lead ? {} : { draft: 'Only whoever manages this library publishes its issues.' }) }, { status: 201 });
      return Response.json({ ...travel, id: 'd-new', title: params.get('filename'), latest: v(1, params.get('filename')!) }, { status: 201 });
    }
    if (method === 'GET' && where === '/libraries/l-1/documents/d-1')
      return Response.json({
        ...travel,
        ...(anIssue ? { issue: { series: 's-1', number: 1, periodStart: '', period: 'Week 43, 2026' } } : {}),
        state: out ? (out.ended ? 'withdrawn' : 'published') : 'draft',
        ...(out && !out.ended ? { published: out } : {}),
        latest: { ...v(2), state },
        can: { ...travel.can, publish: lead, moves: state === 'in-progress' ? ['in-review', 'complete'] : lead ? ['in-progress', 'in-review', 'issued'] : ['in-progress', 'in-review'] },
        versions: [{ ...v(2), state }, { ...v(1, 'travel-old.pdf', 900, retried ? { state: 'queued', thumbnail: false } : DAMAGED), state: 'complete' }],
      });
    if (method === 'PUT' && where === '/libraries/l-1/documents/d-1/versions/2/state') {
      state = body.state;
      return Response.json({ ...v(2), state });
    }
    if (method === 'PUT' && /^\/libraries\/l-1(\/folders\/[^/]+)?\/state$/.test(where)) return Response.json({ ...hr, state: body.state });
    if (method === 'PUT' && where === '/libraries/l-1/folders/f-hr/tags') return Response.json({ ...hr, tags: body.tags });
    if (method === 'GET' && where === '/libraries/l-1/moves') return Response.json({ moves: [{ id: 'm-1', record: 'f-hr', from: 'open', to: 'closed', by: 'u1', note: 'Year end', at: new Date().toISOString() }] });
    if (method === 'GET' && where === '/libraries/l-1/links') {
      const KINDS = [
        { id: 'relates-to', name: 'Relates to', inverse: 'Relates to' },
        { id: 'supersedes', name: 'Supersedes', inverse: 'Superseded by' },
        { id: 'about', name: 'About', inverse: 'Written about in' },
        { id: 'serves', name: 'Serves', inverse: 'Served by' },
      ];
      const back = params.get('record') === 'd-1' ? [{ id: 'k-9', relation: 'responds-to', words: 'Answered by', from: { unavailable: 'Something you can’t open links here.' }, by: 'u5', at: new Date().toISOString() }] : [];
      return Response.json({ kinds: KINDS, links: params.get('record') === 'd-1' ? linked : [], back, can: { change: true } });
    }
    if (method === 'POST' && where === '/libraries/l-1/links') {
      const to = body.to.app === 'folio' ? { ...body.to, label: 'Annual leave', library: 'l-1', record: 'd-2', unitKind: 'document' } : body.to;
      const made = { id: `k-${linked.length + 1}`, relation: body.relation, words: body.relation === 'about' ? 'About' : 'Supersedes', to, by: 'u1', at: new Date().toISOString() };
      linked = [...linked, made];
      return Response.json(made, { status: 201 });
    }
    if (method === 'DELETE' && /^\/libraries\/l-1\/links\/[^/]+$/.test(where)) {
      linked = linked.filter((l) => !where.endsWith(`/${l.id as string}`));
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && where === '/placements') {
      const OPS = { id: 'w-ops', kind: 'team', name: 'Operations', rank: 1, path: ['w-ops'] };
      return Response.json({
        placements: placed,
        owner: placed.length ? OPS : { ...floor, rank: 2 },
        targets: [
          { from: { ...floor, rank: 2 }, to: OPS, ...(placed.length ? { why: 'It’s already there.' } : {}) },
          { from: { ...floor, rank: 2 }, to: { id: 'org', kind: 'org', name: 'The org', rank: 0, path: [] }, why: 'Publishing to the org needs the publisher role, which an admin can give you.' },
        ],
      });
    }
    if (method === 'POST' && where === '/placements') {
      const step = { id: 'pl-1', library: 'l-1', record: { ...body.record, name: 'Travel policy' }, from: 'w-fin', to: body.to, filter: body.filter, by: 'u1', at: new Date().toISOString(), chain: [], toFloor: { id: 'w-ops', kind: 'team', name: 'Operations', rank: 1, path: [] }, can: { change: true, land: false } };
      placed = [step];
      return Response.json(step, { status: 201 });
    }
    if (method === 'GET' && where === '/received')
      return Response.json({
        here: [{ id: 'pl-9', library: 'l-7', record: { kind: 'folder', id: 'f-q', name: 'Quarterly returns', level: 'series' }, from: 'w-pay', to: 'w-fin', filter: ['complete', 'issued'], by: 'u5', at: '', chain: [], fromFloor: { id: 'w-pay', kind: 'team', name: 'Payroll', rank: 2, path: [] } }],
        signposts: [],
      });
    if (method === 'GET' && where === '/received/pl-9')
      return Response.json({
        placement: { id: 'pl-9', library: 'l-7', record: { kind: 'folder', id: 'f-q', name: 'Quarterly returns', level: 'series' }, from: 'w-pay', to: 'w-fin', filter: ['complete', 'issued'], by: 'u5', at: '', chain: [], fromFloor: { id: 'w-pay', kind: 'team', name: 'Payroll', rank: 2, path: [] } },
        folders: [],
        folder: null,
        documents: [{ ...travel, id: 'd-q3', library: 'l-7', title: 'Q3 return', latest: { ...v(1), state: 'issued' } }, { ...travel, id: 'd-q4', library: 'l-7', title: 'Q4 return', latest: { ...v(3), state: 'complete' }, onlyVia: { id: 'w-fin', kind: 'team', name: 'Finance', rank: 1, path: [] } }],
        states: {},
      });
    if (method === 'GET' && where === '/libraries/l-1/documents/d-1/publications') return Response.json({ publications: out ? [named(out)] : [], can: { publish: lead, publishToOrg: false } });
    if (method === 'GET' && where === '/libraries/l-1/documents/d-1/access') return Response.json({ floor: FINANCE, grants: [], library: grants, can: { share: lead } });
    if (method === 'POST' && where === '/libraries/l-1/documents/d-1/publish') {
      out = { id: 'p-1', version: body.version, audience: body.audience, publishedAt: new Date().toISOString() };
      return Response.json(named(out), { status: 201 });
    }
    if (method === 'POST' && where === '/libraries/l-1/documents/d-1/withdraw') {
      out = { ...out!, ended: { as: 'withdrawn', at: new Date().toISOString(), by: 'u1' } };
      return Response.json(named(out));
    }
    if (method === 'GET' && where === '/published')
      return Response.json({
        documents: [{ ...travel, id: 'd-9', library: 'l-9', title: 'Shared plan', libraryName: 'Ops runbooks', state: 'published', published: { id: 'p-9', version: 2, audience: ['team:w-fin'], publishedAt: new Date().toISOString(), note: 'For Monday' } }],
        total: 1,
      });
    if (method === 'GET' && where === '/find')
      return Response.json({
        documents: params.get('q') === 'plan' ? [{ ...travel, id: 'd-9', library: 'l-9', title: 'Shared plan', libraryName: 'Ops runbooks', audienceOnly: true, state: 'published', published: { id: 'p-9', version: 1, audience: ['org'], publishedAt: '' } }] : [],
      });
    if (method === 'PUT' && where === '/published/looked') return new Response(null, { status: 204 });
    if (method === 'GET' && where === '/home')
      return Response.json({
        published: { new: 1, since: '2026-10-20T00:00:00.000Z', documents: [{ id: 'd-9', library: 'l-9', title: 'Shared plan', libraryName: 'Ops runbooks', at: new Date().toISOString() }] },
        ...(lead ? { drafts: { total: 4, documents: [{ id: 'd-1', library: 'l-1', title: 'Travel policy', libraryName: 'Policies', at: new Date().toISOString() }] } } : {}),
      });
    if (method === 'GET' && where === '/documents/d-9') return Response.json({ id: 'd-9', library: 'l-9', title: 'Shared plan', only: 2 });
    if (method === 'GET' && where === '/libraries/l-1/documents/d-1/versions/2/reader') return new Response(TRAVEL_MD, { headers: { 'content-type': 'text/markdown' } });
    if (method === 'GET' && where === '/libraries/l-1/documents/d-1/versions/2/reader/images/1.png') return new Response('png', { headers: { 'content-type': 'image/png' } });
    if (method === 'POST' && where === '/libraries/l-1/documents/d-1/versions/1/reader/retry') {
      retried = true;
      return Response.json({ state: 'queued', thumbnail: false }, { status: 202 });
    }
    if (method === 'GET' && where === '/libraries/l-1/documents/d-1/versions/1/original') return new Response('%PDF old', { headers: { 'content-type': 'application/pdf' } });
    if (method === 'POST' && where === '/libraries/l-1/documents/d-1/versions') return Response.json(v(3), { status: 201 });
    if (method === 'PATCH' && where === '/libraries/l-1/documents/d-1') return Response.json({ ...travel, ...body });
    if (method === 'DELETE' && where === '/libraries/l-1/documents/d-1') {
      deleted.add('d-1');
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && route === '/libraries') return Response.json({ libraries, can: { create: lead } });
    if (method === 'GET' && route === '/shared') return Response.json(shared);
    if (method === 'GET' && where === '/people') return Response.json({ people: [{ id: 'u4', name: 'Ola Bello', email: 'ola@example.org' }], teams: [{ id: 'w-legal', name: 'Legal', within: [] }] });
    if (where === '/libraries/l-1/access') return Response.json({ floor: FINANCE, grants, can: { share: lead } });
    if (where === '/libraries/l-1/folders/f-hr/access')
      return Response.json({
        floor: FINANCE,
        grants: folderGrants,
        library: grants,
        placed: [{ principal: 'org', kind: 'org', filter: ['complete', 'issued'], at: '2026-10-30T09:00:00Z', record: { kind: 'folder', id: 'f-hr' }, chain: ['Payroll', 'Finance'] }],
        can: { share: lead },
      });
    const folderSharing = where.match(/^\/libraries\/l-1\/folders\/f-hr\/access\/(.+)$/);
    if (folderSharing) {
      const principal = decodeURIComponent(folderSharing[1]);
      folderGrants = folderGrants.filter((g) => g.principal !== principal);
      if (method === 'PUT') folderGrants = [...folderGrants, { ...KIM, principal, kind: 'tree', name: 'Legal', level: body.level }];
      return Response.json({ floor: FINANCE, grants: folderGrants, library: grants, can: { share: true } });
    }
    const sharing = where.match(/^\/libraries\/l-1\/access\/(.+)$/);
    if (sharing) {
      const principal = decodeURIComponent(sharing[1]);
      grants = grants.filter((g) => g.principal !== principal);
      if (method === 'PUT') grants = [...grants, { ...KIM, principal, kind: principal.split(':')[0], name: principal === 'person:u4' ? 'Ola Bello' : 'Legal', level: body.level }];
      return Response.json({ floor: FINANCE, grants, can: { share: true } });
    }
    if (method === 'GET' && where === '/libraries/l-9/documents/d-9')
      return Response.json({ ...travel, id: 'd-9', library: 'l-9', title: 'Shared plan', libraryName: 'Ops runbooks', can: { change: false, share: false }, versions: [v(2)] });
    if (method === 'GET' && where === '/libraries/l-9/documents/d-9/versions/2/reader') return new Response('# Shared plan\n\nHello.', { headers: { 'content-type': 'text/markdown' } });
    const one = route.match(/^\/libraries\/([^/]+)$/);
    if (method === 'GET' && one) {
      const lib = libraries.find((l) => l.id === one[1]);
      const mine = lib?.id === 'l-1';
      return lib
        ? Response.json({
            ...lib,
            folders: mine ? folders : [],
            tags: mine ? [policyTag, travelTag] : [policyTag],
            authors: [{ id: 'u2', name: 'Alex Rivera' }],
            views: mine ? views : [],
            series: mine ? series : [],
            can: { manage: lead, addFolders: true, addDocuments: true, addTags: lead, share: lead },
          })
        : Response.json({ message: 'Not here' }, { status: 404 });
    }
    if (method === 'POST' && route === '/libraries') {
      if (body.name === 'Taken') return Response.json({ error: 'name-taken', message: 'There’s already a library called Taken here.' }, { status: 409 });
      return Response.json({ ...policies, id: 'l-new', name: body.name, description: body.description ?? '' }, { status: 201 });
    }
    if (method === 'POST' && route === '/libraries/l-1/folders') return Response.json({ id: 'f-new', library: 'l-1', name: body.name, level: body.level ?? 'subcollection', description: body.description ?? '', state: 'open', ...(body.parent ? { parent: body.parent } : {}), createdBy: 'u1', createdAt: '', updatedAt: '' }, { status: 201 });
    if (method === 'POST' && route.endsWith('/archive')) return new Response(null, { status: 204 });
    return Response.json({ message: 'Artifacts isn’t answering.' }, { status: 502 });
  });
  return { fetch, calls };
};

const ctx = (fetch: MountContext['fetch'], path = '/libraries/l-1'): MountContext => ({
  user: { id: 'u1', name: 'Sam Okafor', departments: ['Finance'], roles: [] },
  getToken: async () => 't',
  bus: createEventBus(),
  raise: vi.fn(),
  request: vi.fn(),
  notify: vi.fn(),
  path,
  workspace: floor,
  getWorkspace: () => floor,
  previewOn: () => false,
  fetch,
});

/** React renders, the fetches answer, React renders again. */
const reactSettled = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r));
};
/** A Quill list's rows, as title and detail. */
const rowsOf = (el: Element) => [...el.querySelectorAll('.quill-list-row')].map((r) => [r.querySelector('.quill-list-text b')?.textContent, r.querySelector('.quill-list-text span')?.textContent]);
/** Quill facts, as label and value. */
const factsOf = (el: Element) => [...el.querySelectorAll('.quill-fact')].map((f) => [f.querySelector('dt')?.textContent, f.querySelector('dd')?.textContent]);
/** A React button by its words. */
const reactButton = (el: Element, text: string) => [...el.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === text);

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('folio paths', () => {
  it('reads and writes where Folio is', () => {
    expect(placeFor('/')).toEqual({ home: true, adding: false });
    expect(placeFor('/libraries')).toEqual({ collections: true, adding: false });
    expect(placeFor('/shared')).toEqual({ shared: true, adding: false });
    expect(pathFor({ home: true })).toBe('/');
    expect(pathFor({ shared: true })).toBe('/shared');
    expect(pathFor({})).toBe('/libraries');
    expect(placeFor('/libraries/new')).toEqual({ adding: true });
    expect(placeFor('/libraries/l-1/f%20x')).toEqual({ library: 'l-1', folder: 'f x', adding: false });
    expect(placeFor('/libraries/l-1/views/vw-1')).toEqual({ library: 'l-1', view: 'vw-1', adding: false });
    expect(pathFor({ library: 'l-1', view: 'vw-1', folder: 'f-hr' })).toBe('/libraries/l-1/views/vw-1');
    expect(pathFor({ library: 'l-1', folder: 'f x' })).toBe('/libraries/l-1/f%20x');
    expect(addressFor('/@finance/folio/libraries', '/libraries', { library: 'l-1' })).toBe('/@finance/folio/libraries/l-1');
    expect(addressFor('/@finance/folio', '/', { library: 'l-1' })).toBe('/@finance/folio/libraries/l-1');
    expect(addressFor('/elsewhere', '/libraries', {})).toBeUndefined();
    expect(placeFor('/libraries/l-1/series/s-1')).toEqual({ library: 'l-1', series: 's-1', adding: false });
    expect(pathFor({ library: 'l-1', series: 's-1' })).toBe('/libraries/l-1/series/s-1');
    expect(placeFor('/published')).toEqual({ published: true, adding: false });
    expect(pathFor({ published: true })).toBe('/published');
  });

  it('starts at a document another app asked to open', () => {
    expect(placeForIntent({ type: 'document.open', payload: { app: 'folio', id: 'd-9', version: '2', title: 'Shared plan' } })).toEqual({ document: 'd-9', version: 2, adding: false });
    expect(placeForIntent({ type: 'document.open', payload: { app: 'other', id: 'd-9', title: 'Theirs' } })).toBeUndefined();
    const unit = (id: string, level: string) => placeForIntent({ type: 'unit.open', payload: { kind: 'unit', app: 'folio', id, level, name: 'It' } });
    expect(unit('l-1', 'collection')).toEqual({ library: 'l-1', adding: false });
    expect(unit('l-1/f-hr', 'series')).toEqual({ library: 'l-1', folder: 'f-hr', adding: false });
    expect(unit('l-1/d-1', 'file')).toEqual({ library: 'l-1', document: 'd-1', adding: false });
    expect(unit('l-1/f-hr', 'folder')).toBeUndefined();
    expect(placeForIntent({ type: 'document.open', payload: { id: 'd-9' } })).toBeUndefined();
    expect(placeForIntent(undefined)).toBeUndefined();
    expect(placeForIntent({ type: 'folio.open', payload: { path: '/published' } })).toEqual({ published: true, adding: false });
    expect(placeForIntent({ type: 'folio.open', payload: {} })).toBeUndefined();
    expect(placeForIntent({ type: 'library.open', payload: { app: 'folio', id: 'l-2', name: 'Reports' } })).toEqual({ library: 'l-2', adding: false });
    expect(placeForIntent({ type: 'library.open', payload: { app: 'other', id: 'l-2', name: 'Theirs' } })).toBeUndefined();
  });

  it('nests folders and finds the way down to one', () => {
    expect(folderTree([hr, leave, it_])).toEqual([
      { id: 'f-hr', label: 'HR', icon: 'folder', children: [{ id: 'f-leave', label: 'Leave', icon: 'folder' }] },
      { id: 'f-it', label: 'IT', icon: 'folder' },
    ]);
    expect(folderTrail([hr, leave, it_], 'f-leave').map((f) => f.name)).toEqual(['HR', 'Leave']);
    expect(folderTrail([hr], undefined)).toEqual([]);
  });

  it('says plainly when there’s no Data Atlas to offer words to', async () => {
    const request = vi.fn(async () => {
      throw new Error('No app you can open handles "entity.propose".');
    });
    await expect(proposeFrom({ request: request as unknown as MountContext['request'] })({ id: 'd-1', title: 'Travel policy' }, { text: 'travel desk', anchor: 'b2', context: '' }, 2)).rejects.toThrow(
      'Data Atlas isn’t open to you on this floor, so there’s nowhere to add it.',
    );
  });

  it('explains who reaches it by its being published up, with the floors it came through and what it shows', () => {
    const asked = explainPayload(
      {
        floor: { ...FINANCE, kind: 'tree' as const },
        grants: [],
        placed: [
          { principal: 'org', kind: 'org', filter: ['issued'], at: '2026-10-30T09:00:00Z', record: { kind: 'folder', id: 'f-hr' }, chain: ['Payroll', 'Finance'] },
          { principal: 'tree:w-dept', kind: 'tree', name: 'Dept', filter: ['complete', 'issued'], at: '2026-10-29T09:00:00Z', record: { kind: 'library', id: 'l-1' }, chain: ['Finance'] },
        ],
        can: { share: false },
      },
      { id: 'f-hr', title: 'HR', kind: 'folder' },
    );
    expect(asked.thing.kind).toBe('folder');
    expect(asked.audience.slice(1)).toEqual([
      { principal: 'org', level: 'read', since: '2026-10-30T09:00:00Z', via: 'published up to them', chain: ['Payroll', 'Finance'], shows: ['Issued'] },
      { principal: 'tree:w-dept', name: 'Dept', level: 'read', since: '2026-10-29T09:00:00Z', via: 'published up inside something', chain: ['Finance'], shows: ['Complete', 'Issued'] },
    ]);
  });
});

describe('folio on Home', () => {
  const card = async (fetch: MountContext['fetch']) => {
    const el = document.createElement('div');
    document.body.append(el);
    const context = ctx(fetch, '/');
    await app.surfaces!['./Glance'].mount(el, context);
    await reactSettled();
    return { el, context };
  };

  it('says what’s new to the person and, for a lead, the drafts waiting, and opens them', async () => {
    const { fetch } = service();
    const { el, context } = await card(fetch);
    expect(factsOf(el)).toEqual([
      ['New to you', '1'],
      ['Drafts', '4'],
    ]);
    expect(rowsOf(el)).toEqual([['Shared plan', 'From Ops runbooks']]);
    el.querySelector<HTMLElement>('.quill-list-row')!.click();
    expect(context.raise).toHaveBeenCalledWith({ type: 'document.open', payload: { app: 'folio', id: 'd-9', title: 'Shared plan' } });
    reactButton(el, 'Published to you')!.click();
    expect(context.raise).toHaveBeenCalledWith({ type: 'folio.open', payload: { path: '/published' } });
    app.surfaces!['./Glance'].unmount!(el);
    await reactSettled();
    expect(el.querySelector('[data-folio-glance]')).toBeNull();
  });

  it('leaves drafts out for members', async () => {
    const { fetch } = service({ lead: false });
    const { el } = await card(fetch);
    expect(factsOf(el)).toEqual([['New to you', '1']]);
  });
});

describe('folio as a picker', () => {
  const picker = async (fetch: MountContext['fetch'], payload: object) => {
    const el = document.createElement('div');
    document.body.append(el);
    const reply = { respond: vi.fn(), cancel: vi.fn() };
    await app.mount(el, { ...ctx(fetch, '/'), intent: { type: 'document.pick', payload }, reply });
    await reactSettled();
    return { el, reply };
  };

  it('answers another app with the document picked from a library, in the kinds it takes', async () => {
    const pdf = { ...travel, latest: v(2) };
    const notes = { ...travel, id: 'd-3', title: 'Notes', latest: { ...v(1, 'notes.md'), mediaType: 'text/markdown' } };
    const { fetch, calls } = service({ documents: [pdf, notes] });
    const { el, reply } = await picker(fetch, { purpose: 'Attach a policy', accept: ['application/pdf'] });
    expect(el.querySelector('folio-app')).toBeNull();
    expect(el.querySelector('[role="heading"]')!.textContent).toBe('Attach a policy');
    expect(calls.some(([, p]) => p.startsWith('/api/folio/v1/libraries/l-1/documents?') && p.includes('below=true'))).toBe(true);
    expect(rowsOf(el)).toEqual([['Travel policy', 'In Policies · Version 2 · PDF']]);
    expect(el.querySelector('[data-hidden]')!.textContent).toBe('One other isn’t the kind of file asked for.');
    el.querySelector<HTMLElement>('.quill-list-row')!.click();
    expect(reply.respond).toHaveBeenCalledWith({ app: 'folio', id: 'd-1', version: '2', title: 'Travel policy' });
  });

  it('finds by what’s typed, picks the version published to the person, and cancels', async () => {
    const { fetch } = service();
    const { el, reply } = await picker(fetch, {});
    expect(el.querySelector('[role="heading"]')!.textContent).toBe('Pick a document');
    const input = el.querySelector('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'plan');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    await reactSettled();
    expect(rowsOf(el)).toEqual([['Shared plan', 'In Ops runbooks · Version 1 · PDF']]);
    el.querySelector<HTMLElement>('.quill-list-row')!.click();
    expect(reply.respond).toHaveBeenCalledWith({ app: 'folio', id: 'd-9', version: '1', title: 'Shared plan' });
    reactButton(el, 'Cancel')!.click();
    expect(reply.cancel).toHaveBeenCalled();
  });
});

describe('Artifacts, new layout (PDR-010)', () => {
  /** React renders, the fetches answer, React renders again. */
  const ready = async () => {
    for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r));
  };
  const open = async (path: string, options: Parameters<typeof service>[0] = {}) => {
    const s = service({ documents: [travel], ...options });
    const el = document.createElement('div');
    document.body.append(el);
    window.history.replaceState(null, '', `/@finance/folio${path === '/' ? '' : path}`);
    await app.mount(el, ctx(s.fetch, path));
    await ready();
    return { el, calls: s.calls };
  };
  const tile = (name: string) => [...document.querySelectorAll<HTMLElement>('.quill-tile')].find((t) => t.querySelector('.quill-tile-name')?.textContent === name);
  const ring = () => [...document.querySelectorAll('[role="menuitem"]')].map((i) => i.querySelector('.quill-ring-label')!.textContent);
  const pressRing = async (label: string) => {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.querySelector('.quill-ring-label')!.textContent === label)!;
    item.click();
    await new Promise((r) => setTimeout(r, 400));
    await ready();
  };

  it('opens on the front page its config describes: what needs you, then what’s new', async () => {
    await open('/');
    expect(document.querySelector('.quill-title-name')!.textContent).toBe('Artifacts');
    expect(document.querySelector('#front-actions')!.textContent).toContain('Actions');
    expect([...document.querySelectorAll('.quill-reel-light')].map((l) => l.getAttribute('aria-label'))).toContain('Bring in the next action. 1 waiting.');
    expect(document.querySelector('.quill-frame')!.textContent).toContain('Collections on Finance');
  });

  it('shows a collection as tiles, lights the path in the rail, and keeps every action on the object', async () => {
    await open('/libraries/l-1');
    expect(tile('HR')).toBeDefined();
    expect(tile('Travel policy')!.getAttribute('data-kind')).toBe('document');
    expect(document.querySelector('[role="treeitem"][aria-current="page"]')!.textContent).toContain('Policies');
    tile('Travel policy')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await ready();
    expect(ring()).toEqual(['Open', 'Download', 'Share', 'Publish', 'Publish up', 'Rename', 'Delete']);
    await pressRing('Rename');
    const field = document.querySelector<HTMLInputElement>('.augur-dialog input')!;
    expect(field.value).toBe('Travel policy');
  });

  it('opens a folder in place, and the path follows it', async () => {
    await open('/libraries/l-1');
    tile('HR')!.click();
    await ready();
    expect(window.location.pathname).toBe('/@finance/folio/libraries/l-1/f-hr');
    expect(tile('Leave')).toBeDefined();
    const lit = [...document.querySelectorAll('.quill-tree-lit')].map((r) => r.querySelector('.quill-tree-label')!.textContent);
    expect(lit).toEqual(['Policies', 'HR']);
  });

  it('adds the files picked where the person is, and says so', async () => {
    const { el, calls } = await open('/libraries/l-1');
    const input = el.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input, 'files', { value: [new File(['%PDF'], 'Leave.pdf', { type: 'application/pdf' }), new File(['# Notes'], 'notes.md')], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await ready();
    expect(calls.filter(([m, p]) => m === 'POST' && p.startsWith('/api/folio/v1/libraries/l-1/documents?')).map(([, p]) => p)).toEqual([
      '/api/folio/v1/libraries/l-1/documents?filename=Leave.pdf',
      '/api/folio/v1/libraries/l-1/documents?filename=notes.md',
    ]);
    expect(el.textContent).toContain('2 files added.');
  });

  it('publishes a document up the floors from its ring, through a filter', async () => {
    const { calls } = await open('/libraries/l-1');
    tile('Travel policy')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await ready();
    await pressRing('Publish up');
    reactButton(document.body, 'Publish to Operations')!.click();
    await ready();
    expect(calls).toContainEqual(['POST', '/api/folio/v1/placements', { library: 'l-1', record: { kind: 'document', id: 'd-1' }, to: 'w-ops', filter: ['complete', 'issued'] }]);
  });

  it('says so when the service isn’t answering', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    await app.mount(el, ctx(vi.fn(async () => new Response(null, { status: 502 })), '/libraries/l-1'));
    await ready();
    expect(el.querySelector('[role=status],[role=alert]')!.textContent).toMatch(/isn’t answering/);
  });

  it('opens a series on its own page, adds the next issue, and follows it', async () => {
    const { el, calls } = await open('/libraries/l-1/series/s-1', { series: [CASH] });
    const page = el.querySelector<HTMLElement>('[data-folio-series]')!;
    expect(page.querySelector('[role="heading"]')!.textContent).toBe('Cash report');
    expect(page.querySelector('.folio-series-facts')!.textContent!.replace(/\s+/g, ' ').trim()).toBe(
      'Every week. Each issue goes out to Finance and the teams below it as it’s added.Next: Week 44, 2026, due by Monday 2 November.',
    );
    expect(rowsOf(page)).toEqual([
      ['Cash report: Week 43, 2026', 'Issue 2 · Week 43, 2026 · Published'],
      ['Cash report: Week 42, 2026', 'Issue 1 · Week 42, 2026 · Published'],
    ]);
    const input = page.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [new File(['%PDF'], 'cash.pdf', { type: 'application/pdf' })], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await ready();
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/folio/v1/libraries/l-1/documents?filename=cash.pdf&series=s-1')).toBe(true);
    expect(page.querySelector('[role="status"]')!.textContent).toBe('Cash report: Week 44, 2026 is out to Finance and the teams below it.');
    page.querySelector<HTMLElement>('[role="switch"], input[type="checkbox"]')!.click();
    await ready();
    expect(calls).toContainEqual(['PUT', '/api/folio/v1/series/s-1/follow', { following: true }]);
  });

  it('makes a series from a collection’s ring, and opens it', async () => {
    const { el, calls } = await open('/libraries/l-1', { series: [CASH] });
    el.querySelector('.quill-tiles')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await ready();
    expect(ring()).toContain('New series');
    await pressRing('New series');
    const dialog = document.querySelector<HTMLElement>('.augur-dialog')!;
    expect(dialog.textContent).toContain('New series');
    const name = dialog.querySelector<HTMLInputElement>('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, ' Board pack ');
    name.dispatchEvent(new Event('input', { bubbles: true }));
    await ready();
    [...dialog.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === 'Make it')!.click();
    await ready();
    expect(calls).toContainEqual(['POST', '/api/folio/v1/libraries/l-1/series', { name: 'Board pack', description: '', cadence: 'weekly', tags: [], audience: [] }]);
    expect(window.location.pathname).toBe('/@finance/folio/libraries/l-1/series/s-new');
  });

  it('lets the org’s leads rename the levels from the shelf’s ring, and the shelf follows', async () => {
    const { calls } = await open('/libraries', { renameLevels: true });
    document.querySelector('.quill-tiles')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await ready();
    await pressRing('Level names');
    const levels = document.querySelector<HTMLElement>('[data-folio-levels]')!;
    expect(rowsOf(levels).map(([title]) => title)).toEqual(['Collection', 'Subcollection', 'Series', 'Subseries', 'File']);
    expect(rowsOf(levels)[0]![1]).toBe('More than one: Collections · Holds subcollections and series and files');
    reactButton(levels.querySelector('.quill-list-row')!, 'Rename')!.click();
    await ready();
    const [name, plural] = [...levels.querySelectorAll<HTMLInputElement>('.folio-levels-form input')];
    for (const [input, text] of [[name!, 'Programme'], [plural!, 'Programmes']] as const) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await ready();
    reactButton(levels, 'Save')!.click();
    await ready();
    expect(calls).toContainEqual(['PUT', '/api/folio/v1/levels/collection', { name: 'Programme', plural: 'Programmes' }]);
    expect(levels.querySelector('[role=status]')!.textContent).toBe('The whole org calls it Programme now.');
    expect(document.querySelector('.quill-tile')!.textContent).toContain('Programme');
  });

  it('opens a saved view with its filters chosen and its name on the Views menu', async () => {
    const { el, calls } = await open('/libraries/l-1/views/vw-1');
    await ready();
    expect(el.querySelector('.quill-filter-bar')).not.toBeNull();
    expect(el.querySelector('.quill-filter-chips')?.textContent ?? el.textContent).toContain('Policy');
    expect(calls.some(([m, path]) => m === 'GET' && String(path).includes('tag=t-pol'))).toBe(true);
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.startsWith('Views ('))).toBe(true);
  });

  it('opens what came from below in the new layout', async () => {
    const { el } = await open('/received/pl-9');
    await ready();
    expect(el.querySelector('.folio-arrived')).not.toBeNull();
    expect(el.textContent).toContain('Q3 return');
    expect(el.textContent).not.toContain('isn’t in the new layout yet');
  });

  it('reads a document with its contents beside it and its facts in the drawer', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:map');
    URL.revokeObjectURL = vi.fn();
    const { el, calls } = await open('/libraries/l-1/documents/d-1');
    await ready();
    const head = el.querySelector<HTMLElement>('.folio-reading-head')!;
    expect(head.querySelector('h1')!.textContent).toBe('Travel policy');
    expect(head.querySelector('p')!.textContent).toContain('Version 2 · PDF');
    const article = el.querySelector<HTMLElement>('.quill-reader')!;
    expect(article.textContent).toContain('Book through the travel desk.');
    // Its own first heading only repeats the title above it, so the contents start below it.
    expect([...el.querySelectorAll('.quill-contents a')].map((a) => a.textContent)).toEqual(['Claims']);
    expect(calls).toContainEqual(['GET', '/api/folio/v1/libraries/l-1/documents/d-1/versions/2/reader/images/1.png']);
    expect(calls.some(([, p]) => p.includes('tracker'))).toBe(false);
    expect(article.querySelector('img')!.getAttribute('src')).toBe('blob:map');
    const side = el.querySelector<HTMLElement>('.folio-reading-side')!;
    expect(rowsOf(side).map(([t]) => t).filter((t) => t?.startsWith('Version'))).toEqual(['Version 2, reading', 'Version 1']);
  });

  it('moves the newest version on through its lifecycle from the drawer', async () => {
    const { el, calls } = await open('/libraries/l-1/documents/d-1');
    await ready();
    const moves = () => [...el.querySelectorAll('.quill-lifecycle-moves button')].map((b) => b.textContent);
    expect(el.querySelector('.quill-lifecycle [aria-current="step"]')!.textContent).toBe('In progress');
    expect(moves()).toEqual(['Make it In review', 'Make it Complete']);
    reactButton(el, 'Make it Complete')!.click();
    await ready();
    expect(calls).toContainEqual(['PUT', '/api/folio/v1/libraries/l-1/documents/d-1/versions/2/state', { state: 'complete' }]);
    expect(el.querySelector('.quill-lifecycle [aria-current="step"]')!.textContent).toBe('Complete');
  });

  it('changes a document from the drawer: its tags, and renaming it', async () => {
    const { el, calls } = await open('/libraries/l-1/documents/d-1');
    await ready();
    reactButton(el, 'Change it')!.click();
    await ready();
    const dialog = document.querySelector<HTMLElement>('.augur-dialog')!;
    expect(dialog.querySelector('[role="heading"], h2')!.textContent).toBe('Travel policy');
    expect(rowsOf(dialog).map(([t]) => t)).toEqual(['Version 2', 'Version 1']);
    reactButton(dialog, 'Rename or move')!.click();
    await ready();
    const field = document.querySelector<HTMLInputElement>('.augur-dialog input[name="title"], .augur-dialog input')!;
    expect(field.value).toBe('Travel policy');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'Travel rules');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await ready();
    reactButton(document.querySelector<HTMLElement>('.augur-dialog')!, 'Save')!.click();
    await ready();
    expect(calls).toContainEqual(['PATCH', '/api/folio/v1/libraries/l-1/documents/d-1', { title: 'Travel rules', folder: null }]);
  });


  it('keeps a collection’s tags and details in the new layout, from the space between its tiles', async () => {
    const { el, calls } = await open('/libraries/l-1');
    el.querySelector<HTMLElement>('.quill-tiles')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await ready();
    expect(ring()).toEqual(['Add files', 'New subcollection', 'New series', 'Share', 'Details', 'Tags', 'Save this view']);
    await pressRing('Tags');
    const tags = document.querySelector<HTMLElement>('[data-folio-tags]')!;
    expect(tags).not.toBeNull();
    expect(calls.some(([m, p]) => m === 'GET' && p.endsWith('/tags'))).toBe(true);
    [...document.querySelectorAll<HTMLElement>('.augur-dialog button')].find((b) => b.textContent?.endsWith('Done'))!.click();
    await ready();
    el.querySelector<HTMLElement>('.quill-tiles')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await ready();
    await pressRing('Details');
    const details = document.querySelector<HTMLElement>('[data-folio-details]')!;
    expect(details.querySelector('.quill-lifecycle [aria-current="step"]')!.textContent).toBe('Open');
    expect(calls).toContainEqual(['GET', '/api/folio/v1/libraries/l-1/moves']);
  });

});
