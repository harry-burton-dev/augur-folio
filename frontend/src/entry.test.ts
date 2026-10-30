import { createEventBus, type MountContext, type Workspace } from '@augur/mfe-sdk';
import type { UiContents, UiDialog, UiFilterBar, UiList, UiPageHead, UiRadialMenu, UiReader, UiTagPicker, UiTile, UiTree } from '@augur/ui-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathFor, placeFor, type ReaderState } from './api.js';
import app, { addressFor, placeForIntent, proposeFrom } from './entry.js';
import { DEFAULT_LEVELS, folderTrail, folderTree, type FolioApp } from './folio-app.js';
import { explainPayload } from './folio-share.js';

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
const leaveDoc = { ...travel, id: 'd-2', title: 'Annual leave', folder: 'f-leave', tags: ['t-pol'] };
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

/** Opens Travel policy on its page, then its details, to change it. */
const details = async (el: HTMLElement) => {
  await press(el, 'Travel policy');
  button(el, 'Change it')!.click();
  await settle(el);
};
const settle = async (el: HTMLElement) => {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r));
    await (el.querySelector('folio-app') as FolioApp | null)?.updateComplete;
  }
};
/** Mounts Artifacts at a path: by default inside Policies, the floor's first collection. */
const mounted = async (fetch: MountContext['fetch'], path = '/libraries/l-1') => {
  const el = document.createElement('div');
  document.body.append(el);
  await app.mount(el, ctx(fetch, path));
  await settle(el);
  return el;
};
const list = (el: HTMLElement) => el.querySelector<UiList>('ui-list')!;
/** The tiles on screen, leaving out the dashed one that makes another; by rank, `mid` for folders and `low` for documents. */
const tiles = (el: HTMLElement, rank?: UiTile['rank']) => [...el.querySelectorAll<UiTile>('ui-tile')].filter((t) => !t.add && (!rank || t.rank === rank));
const headings = (el: HTMLElement, rank?: UiTile['rank']) => tiles(el, rank).map((t) => t.heading);
const tile = (el: HTMLElement, heading: string) => tiles(el).find((t) => t.heading === heading)!;
/** Presses a tile, as a click on it does. */
const press = async (el: HTMLElement, heading: string) => {
  tile(el, heading).dispatchEvent(new CustomEvent('ui-open', { bubbles: true }));
  await settle(el);
};
/** The empty space of the grid on screen, whose right-click is about the place itself. */
const grid = (el: HTMLElement) => el.querySelector<HTMLElement>('.folio-grid')!;
/** What the ring offers when something is right-clicked, by label. */
const ring = async (el: HTMLElement, target: Element) => {
  target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await settle(el);
  return el.querySelector<UiRadialMenu>('ui-radial-menu')!.actions.map((a) => a.label);
};
/** Right-clicks something and picks one of its ring's actions. */
const act = async (el: HTMLElement, target: Element, label: string) => {
  target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await settle(el);
  const menu = el.querySelector<UiRadialMenu>('ui-radial-menu')!;
  const action = menu.actions.find((a) => a.label === label);
  if (!action) throw new Error(`No “${label}” in ${JSON.stringify(menu.actions.map((a) => a.label))}`);
  menu.dispatchEvent(new CustomEvent('ui-select', { detail: { action } }));
  await settle(el);
};
/** The title of the screen, and the Back above it. */
const title = (el: HTMLElement) => el.querySelector('.folio-title')?.textContent;
const back = (el: HTMLElement) => el.querySelector('.folio-back')?.textContent?.trim();
/** One of the rail's trees, by its heading ("Open collection", "Series", "Views"), or by its label for the app's own screens. */
const rail = (el: HTMLElement, name: string) => [...el.querySelectorAll<UiTree>('.folio-rail ui-tree')].find((t) => t.heading === name || t.label === name)!;
/** What the drawer says about what's on screen, as its facts. */
const facts = (el: HTMLElement) => Object.fromEntries([...el.querySelectorAll('.folio-facts dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]));
/** A button by its words: a kit button, or one of a page head's actions (two show, the rest are in its ⋯ menu). */
const button = (el: HTMLElement, text: string): HTMLElement | undefined =>
  [...el.querySelectorAll<HTMLElement>('ui-button')].find((b) => b.textContent?.trim() === text) ??
  [...el.querySelectorAll<UiPageHead>('ui-page-head')].flatMap((head) => {
    const action = head.actions.find((a) => a.label === text);
    return action ? [Object.assign(document.createElement('span'), { click: () => head.dispatchEvent(new CustomEvent('ui-action', { detail: { action } })) })] : [];
  })[0];

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
});

describe('folio', () => {
  it('lists a place’s folders and documents as tiles, and uploads what is added', async () => {
    const { fetch, calls } = service({ documents: [travel] });
    const el = await mounted(fetch);
    expect(headings(el, 'mid')).toEqual(['HR', 'IT']);
    expect(headings(el, 'low')).toEqual(['Travel policy']);
    expect(facts(el)).toMatchObject({ 'What it is': 'Collection', Inside: '2 folders, 1 document' });
    // Add offers what may go in here; Add files picks files from the computer.
    el.querySelector('ui-toolbar')!.dispatchEvent(new CustomEvent('ui-add', { detail: { button: el.querySelector('ui-toolbar') } }));
    await settle(el);
    expect(el.querySelector<UiRadialMenu>('ui-radial-menu')!.actions.map((a) => a.label)).toEqual(['Add files', 'New subcollection', 'New series']);
    const input = el.querySelector<HTMLInputElement>('.folio-file')!;
    const pdf = new File(['%PDF'], 'Leave.pdf', { type: 'application/pdf' });
    const md = new File(['# Notes'], 'notes.md');
    Object.defineProperty(input, 'files', { value: [pdf, md, new File(['x'], 'big.pdf')], configurable: true });
    input.dispatchEvent(new Event('change'));
    await settle(el);
    const sent = calls.filter(([m, p]) => m === 'POST' && p.startsWith('/api/folio/v1/libraries/l-1/documents?'));
    expect(sent.map(([, p]) => p)).toEqual([
      '/api/folio/v1/libraries/l-1/documents?filename=Leave.pdf',
      '/api/folio/v1/libraries/l-1/documents?filename=notes.md',
      '/api/folio/v1/libraries/l-1/documents?filename=big.pdf',
    ]);
    expect(fetch.mock.calls.find(([p]) => p.includes('filename=notes.md'))![1]!.headers).toEqual({ 'content-type': 'text/markdown' });
    expect(el.querySelector('ui-note')!.textContent).toBe('Added 2 documents. Couldn’t add big.pdf: A file can be 200 MB at most.');
  });

  it('renames or moves a document, and deletes one', async () => {
    const { fetch, calls } = service({ documents: [travel] });
    const el = await mounted(fetch);
    await details(el);
    button(el, 'Rename or move')!.click();
    await settle(el);
    let dialog = el.querySelector<UiDialog>('ui-dialog')!;
    expect(dialog.querySelector('ui-select')!.options.map((o) => (typeof o === 'string' ? o : o.label))).toEqual(['Policies (the top)', 'HR', 'HR / Leave', 'IT']);
    await dialog.submit!({ title: ' Travel ', folder: 'f-hr' }, dialog);
    expect(calls).toContainEqual(['PATCH', '/api/folio/v1/libraries/l-1/documents/d-1', { title: 'Travel', folder: 'f-hr' }]);
    button(el, 'Change it')!.click();
    await settle(el);
    button(el, 'Delete')!.click();
    await settle(el);
    dialog = el.querySelector<UiDialog>('ui-dialog')!;
    expect(dialog.heading).toBe('Delete Travel policy?');
    await dialog.submit!({}, dialog);
    await settle(el);
    expect(calls).toContainEqual(['DELETE', '/api/folio/v1/libraries/l-1/documents/d-1']);
    // Back in the library, without it.
    expect(el.querySelector('folio-reader')).toBeNull();
    expect(headings(el, 'mid')).toEqual(['HR', 'IT']);
    expect(headings(el, 'low')).toEqual([]);
  });

  it('says which files it turned away', async () => {
    const el = await mounted(service({ documents: [travel] }).fetch);
    await details(el);
    el.querySelector('ui-dialog ui-drop-zone')!.dispatchEvent(new CustomEvent('ui-reject', { detail: { files: [new File(['x'], 'deck.pptx')] } }));
    await settle(el);
    expect(el.querySelector('ui-note')!.textContent).toMatch(/^Artifacts can’t take deck\.pptx/);
  });

  it('opens a document with its versions, downloads one, and takes the next', async () => {
    const { fetch, calls } = service({ documents: [travel] });
    const saved: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download);
    });
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const el = await mounted(fetch);
    await details(el);
    const dialog = el.querySelector<UiDialog>('ui-dialog')!;
    expect(dialog.heading).toBe('Travel policy');
    const versions = dialog.querySelector<UiList>('ui-list')!;
    expect(versions.items.map((i) => [i.title, i.detail, i.actions?.map((a) => a.label)])).toEqual([
      ['Version 2', 'travel.pdf · 1.2 MB · Reader copy ready, 3 pages', ['Download']],
      ['Version 1', 'travel-old.pdf · 900 bytes · No reader copy', ['Download', 'Try again']],
    ]);
    expect(dialog.querySelector('.folio-note')?.textContent).toBe('Version 1 has no reader copy. The file is damaged.');
    versions.dispatchEvent(new CustomEvent('ui-action', { detail: { item: { id: '1' }, action: { id: 'download' } } }));
    await settle(el);
    expect(calls).toContainEqual(['GET', '/api/folio/v1/libraries/l-1/documents/d-1/versions/1/original']);
    expect(saved).toEqual(['travel-old.pdf']);
    dialog.querySelector('ui-drop-zone')!.dispatchEvent(new CustomEvent('ui-files', { detail: { files: [new File(['%PDF'], 'travel v3.pdf')] } }));
    await settle(el);
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/folio/v1/libraries/l-1/documents/d-1/versions?filename=travel+v3.pdf')).toBe(true);
    vi.restoreAllMocks();
  });

  it('opens a document on its own page to read, with its contents, versions and the original', async () => {
    window.history.replaceState(null, '', '/@finance/folio/libraries/l-1');
    URL.createObjectURL = vi.fn(() => 'blob:map');
    URL.revokeObjectURL = vi.fn();
    const { fetch, calls } = service({ documents: [travel] });
    const el = await mounted(fetch);
    await press(el, 'Travel policy');
    expect(window.location.pathname).toBe('/@finance/folio/libraries/l-1/documents/d-1');
    const page = el.querySelector('folio-reader')!;
    expect(page.querySelector('h1')!.textContent).toBe('Travel policy');
    expect(page.querySelector('.folio-reader-head p')!.textContent).toContain('Version 2 · PDF');
    const reader = page.querySelector<UiReader>('ui-reader')!;
    expect(reader.markdown).toBe('# Travel policy\n\nBook through the travel desk.\n\n## Claims\n\nClaim within 30 days.\n\n![A map](images/1.png)\n\n![](https://tracker.example/x.gif)\n');
    // Its own first heading only repeats the title above it, so the contents start below it.
    expect(page.querySelector<UiContents>('ui-contents')!.items.map((i) => i.text)).toEqual(['Claims']);
    // Its own pictures come from Folio; nothing else is fetched.
    expect(calls).toContainEqual(['GET', '/api/folio/v1/libraries/l-1/documents/d-1/versions/2/reader/images/1.png']);
    expect(calls.some(([, p]) => p.includes('tracker'))).toBe(false);
    expect(reader.shadowRoot!.querySelector('img')!.getAttribute('src')).toBe('blob:map');
    // Its facts and versions are in the drawer, as on every screen.
    expect(el.querySelector<UiList>('.folio-reader-drawer ui-list[label="Versions"]')!.items.map((i) => i.title)).toEqual(['Version 2, reading', 'Version 1']);
    page.querySelector<HTMLButtonElement>('.folio-back')!.click();
    await settle(el);
    expect(el.querySelector('folio-reader')).toBeNull();
    expect(window.location.pathname).toBe('/@finance/folio/libraries/l-1');
  });

  it('offers marked words to Data Atlas, saying what it waits for until there are some', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:map');
    URL.revokeObjectURL = vi.fn();
    const { fetch } = service({ documents: [travel] });
    const request = vi.fn(async () => ({ proposal: 'prp_1', queue: 'Finance’s Triage' }));
    const el = document.body.appendChild(document.createElement('div'));
    await app.mount(el, { ...ctx(fetch, '/libraries/l-1/documents/d-1'), request: request as unknown as MountContext['request'] });
    await settle(el);
    const page = el.querySelector('folio-reader')!;
    await page.updateComplete;
    const section = el.querySelector('.folio-reader-drawer .folio-reader-atlas')!;
    const add = section.querySelector('ui-button') as HTMLElement & { disabled: boolean };
    expect(add.disabled).toBe(true);
    expect(section.textContent).toContain('Select the words that name a ship');
    const reader = page.querySelector<UiReader>('ui-reader')!;
    reader.marked = () => ({ text: 'travel desk', anchor: 'b2', context: 'Book through the travel desk.' });
    document.dispatchEvent(new Event('selectionchange'));
    await settle(el);
    expect(section.textContent).toContain('Marked: “travel desk”');
    expect(add.disabled).toBe(false);
    add.click();
    await settle(el);
    expect(request).toHaveBeenCalledWith({
      type: 'entity.propose',
      payload: { source: { app: 'folio', id: 'd-1', version: '2', title: 'Travel policy' }, anchor: 'b2', text: 'travel desk', context: 'Book through the travel desk.' },
    });
    expect(section.querySelector('[role=status]')!.textContent).toBe('Sent to Finance’s Triage. Its leads decide what it names.');
  });

  it('says plainly when there’s no Data Atlas to offer words to', async () => {
    const request = vi.fn(async () => {
      throw new Error('No app you can open handles "entity.propose".');
    });
    await expect(proposeFrom({ request: request as unknown as MountContext['request'] })({ id: 'd-1', title: 'Travel policy' }, { text: 'travel desk', anchor: 'b2', context: '' }, 2)).rejects.toThrow(
      'Data Atlas isn’t open to you on this floor, so there’s nowhere to add it.',
    );
  });

  it('opens straight at an older version from its path, and says there is a newer one', async () => {
    const { fetch, calls } = service({ documents: [travel] });
    const el = await mounted(fetch, '/libraries/l-1/documents/d-1/versions/1');
    const page = el.querySelector('folio-reader')!;
    expect(page.querySelector('.folio-reader-old')!.textContent).toContain('This is version 1. The newest is version 2.');
    // Its reader copy failed: why, and a way to ask again.
    const state = page.querySelector('ui-state')!;
    expect([state.getAttribute('heading'), state.getAttribute('body'), state.getAttribute('action')]).toEqual(['There’s no reader copy of this version', 'The file is damaged.', 'Try again']);
    state.dispatchEvent(new CustomEvent('ui-action'));
    await settle(el);
    expect(calls).toContainEqual(['POST', '/api/folio/v1/libraries/l-1/documents/d-1/versions/1/reader/retry']);
    page.querySelector<HTMLButtonElement>('.folio-reader-old .folio-link')!.click();
    await settle(el);
    expect(el.querySelector<UiReader>('ui-reader')).not.toBeNull();
  });

  it('remembers how a person likes to read, and where they got to', async () => {
    const { fetch } = service({ documents: [travel] });
    let el = await mounted(fetch, '/libraries/l-1/documents/d-1');
    let reader = el.querySelector<UiReader>('ui-reader')!;
    expect([reader.size, reader.width]).toEqual(['medium', 'narrow']);
    button(el, 'Larger')!.click();
    await settle(el);
    expect(reader.size).toBe('large');
    reader.dispatchEvent(new CustomEvent('ui-position', { detail: { anchor: 'b4' }, bubbles: true }));
    await settle(el);
    expect(el.querySelector<UiContents>('ui-contents')!.current).toBe('claims');
    el.remove();

    el = await mounted(fetch, '/libraries/l-1/documents/d-1');
    reader = el.querySelector<UiReader>('ui-reader')!;
    expect(reader.size).toBe('large');
    expect(reader.position).toBe('b4');
    expect(el.querySelector<UiContents>('ui-contents')!.current).toBe('claims');
  });

  it('asks again for a reader copy that failed, and looks again until it is made', async () => {
    const App = customElements.get('folio-app') as unknown as { readerPollMs: number };
    App.readerPollMs = 10;
    const { fetch, calls } = service({ documents: [travel] });
    const el = await mounted(fetch);
    await details(el);
    const versions = () => el.querySelector<UiDialog>('ui-dialog')!.querySelector<UiList>('ui-list')!;
    versions().dispatchEvent(new CustomEvent('ui-action', { detail: { item: { id: '1' }, action: { id: 'retry' } } }));
    await settle(el);
    expect(calls).toContainEqual(['POST', '/api/folio/v1/libraries/l-1/documents/d-1/versions/1/reader/retry']);
    expect(versions().items[1].detail).toBe('travel-old.pdf · 900 bytes · Making the reader copy…');
    const looks = () => calls.filter(([m, p]) => m === 'GET' && p === '/api/folio/v1/libraries/l-1/documents/d-1').length;
    const before = looks();
    await vi.waitFor(() => expect(looks()).toBeGreaterThan(before));
    App.readerPollMs = 4000;
    el.remove();
  });


  it('opens on its front page: what needs the person, what’s new, and their collections', async () => {
    const { fetch, calls } = service();
    const el = await mounted(fetch, '/');
    expect(calls.map(([m, p]) => `${m} ${p}`)).toEqual([
      'GET /api/folio/v1/libraries',
      'GET /api/folio/v1/shared',
      'GET /api/folio/v1/levels',
      'GET /api/folio/v1/received',
      'GET /api/folio/v1/home',
    ]);
    expect(title(el)).toBe('Artifacts');
    expect(el.querySelector('.folio-back')).toBeNull();
    expect(el.querySelector('.folio-app-title')!.getAttribute('aria-current')).toBe('page');
    expect(el.querySelector<UiList>('ui-list[label="Drafts waiting on a lead"]')!.items.map((i) => i.title)).toEqual(['Travel policy']);
    expect(el.querySelector<UiList>('ui-list[label="Published to you"]')!.items.map((i) => [i.title, i.detail])).toEqual([['Shared plan', 'Ops runbooks']]);
    expect(headings(el, 'high')).toEqual(['Policies', 'Reports']);
    expect(el.querySelector<UiTile>('ui-tile[add]')!.heading).toBe('New collection');
    expect(facts(el)).toMatchObject({ Floor: 'Finance', Collections: '2', 'New to you': '1', 'Drafts waiting': '4' });
    expect(rail(el, 'Artifacts').items.map((i) => i.label)).toEqual(['Your collections', 'Shared libraries', 'From below']);
    await app.unmount!(el);
    expect(el.querySelector('folio-app')).toBeNull();
  });

  it('lists the floor’s collections as tiles, and opens one with its folders in the rail', async () => {
    window.history.replaceState(null, '', '/@finance/folio/libraries');
    const { fetch, calls } = service();
    const el = await mounted(fetch, '/libraries');
    expect(title(el)).toBe('Collections on Finance');
    expect(back(el)).toBe('Artifacts');
    expect(rail(el, 'Artifacts').selected).toBe('collections');
    expect(headings(el, 'high')).toEqual(['Policies', 'Reports']);
    // The search above the grid narrows it by name.
    el.querySelector('ui-toolbar')!.dispatchEvent(new CustomEvent('ui-search', { detail: { query: 'rep' } }));
    await settle(el);
    expect(headings(el, 'high')).toEqual(['Reports']);
    el.querySelector('ui-toolbar')!.dispatchEvent(new CustomEvent('ui-search', { detail: { query: '' } }));
    await settle(el);
    await press(el, 'Policies');
    expect(calls.slice(-2).map(([m, p]) => `${m} ${p}`)).toEqual(['GET /api/folio/v1/libraries/l-1', 'GET /api/folio/v1/libraries/l-1/documents?limit=100']);
    expect(window.location.pathname).toBe('/@finance/folio/libraries/l-1');
    expect(title(el)).toBe('Policies');
    expect(back(el)).toBe('Your collections');
    const scope = rail(el, 'Open collection');
    expect(scope.items.map((i) => [i.label, i.children?.map((c) => c.label)])).toEqual([['Policies', ['HR', 'IT']]]);
    expect(scope.selected).toBe('@library');
    expect(rail(el, 'Views').items.map((i) => i.label)).toEqual(['Recent policy']);
    expect(headings(el, 'mid')).toEqual(['HR', 'IT']);
    // Back goes up to the collections.
    el.querySelector<HTMLButtonElement>('.folio-back')!.click();
    await settle(el);
    expect(title(el)).toBe('Collections on Finance');
    expect(window.location.pathname).toBe('/@finance/folio/libraries');
  });

  it('goes into a folder, says where it is, and puts it in the address bar', async () => {
    window.history.replaceState(null, '', '/@finance/folio/libraries/l-1');
    const { fetch } = service();
    const el = await mounted(fetch);
    await press(el, 'HR');
    expect(window.location.pathname).toBe('/@finance/folio/libraries/l-1/f-hr');
    expect(title(el)).toBe('HR');
    expect(back(el)).toBe('Policies');
    expect(facts(el)).toMatchObject({ 'What it is': 'Subcollection', In: 'Policies' });
    expect(headings(el, 'mid')).toEqual(['Leave']);
    expect(rail(el, 'Open collection').selected).toBe('f-hr');
  });

  it('opens straight at a folder from its path', async () => {
    const { fetch } = service();
    const el = await mounted(fetch, '/libraries/l-1/f-leave');
    expect(title(el)).toBe('Leave');
    expect(back(el)).toBe('HR');
    expect(facts(el)).toMatchObject({ 'What it is': 'Series', In: 'HR' });
    expect(rail(el, 'Open collection').selected).toBe('f-leave');
  });

  it('calls them your collections on your own floor', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    const own: Workspace = { ...floor, id: 'w-me', kind: 'personal', name: 'You', role: 'lead' };
    await app.mount(el, { ...ctx(service().fetch, '/libraries'), workspace: own, getWorkspace: () => own });
    await settle(el);
    expect(title(el)).toBe('Your collections');
    expect(facts(el)).toMatchObject({ Collections: '2' });
  });

  it('offers Rename and Remove only on folders the person may change', async () => {
    const { fetch } = service({ lead: false });
    let el = await mounted(fetch);
    const top = await ring(el, grid(el));
    expect(top).toContain('New subcollection');
    expect(top).not.toContain('Rename');
    expect(top).not.toContain('Archive');
    expect(await ring(el, tile(el, 'HR'))).toEqual(['Open', 'Who can see it', 'Rename', 'Remove']);
    expect(await ring(el, tile(el, 'IT'))).toEqual(['Open', 'Who can see it']);
    document.body.innerHTML = '';
    el = await mounted(fetch, '/libraries');
    expect(el.querySelector('ui-tile[add]')).toBeNull();
    document.body.innerHTML = '';
    el = await mounted(fetch, '/libraries/l-1/f-hr');
    expect(await ring(el, grid(el))).toEqual(expect.arrayContaining(['Rename', 'Remove']));
    document.body.innerHTML = '';
    el = await mounted(fetch, '/libraries/l-1/f-it');
    expect(await ring(el, grid(el))).not.toContain('Rename');
  });

  it('makes a collection, and keeps the dialog open with the service’s words when it refuses', async () => {
    const { fetch, calls } = service();
    const el = await mounted(fetch, '/libraries/new');
    const dialog = el.querySelector<UiDialog>('ui-dialog')!;
    expect(dialog.heading).toBe('New collection');
    await expect(dialog.submit!({ name: 'Taken' }, dialog)).rejects.toThrow('There’s already a library called Taken here.');
    await dialog.submit!({ name: ' Board papers ', description: '' }, dialog);
    await settle(el);
    expect(calls).toContainEqual(['POST', '/api/folio/v1/libraries', { name: 'Board papers' }]);
    expect(rail(el, 'Artifacts').items[0].meta).toBe('3');
  });

  it('makes a folder inside the one that is open', async () => {
    const { fetch, calls } = service();
    const el = await mounted(fetch, '/libraries/l-1/f-hr');
    el.querySelector('ui-toolbar')!.dispatchEvent(new CustomEvent('ui-add', { detail: { button: el.querySelector('ui-toolbar') } }));
    await settle(el);
    const menu = el.querySelector<UiRadialMenu>('ui-radial-menu')!;
    expect(menu.actions.map((a) => a.label)).toEqual(['Add files', 'New series']);
    menu.dispatchEvent(new CustomEvent('ui-select', { detail: { action: menu.actions[1] } }));
    await settle(el);
    const dialog = el.querySelector<UiDialog>('ui-dialog')!;
    expect(dialog.heading).toBe('New series');
    await dialog.submit!({ name: 'Sickness', level: 'series', description: ' Each absence ' }, dialog);
    await settle(el);
    expect(calls).toContainEqual(['POST', '/api/folio/v1/libraries/l-1/folders', { name: 'Sickness', parent: 'f-hr', level: 'series', description: 'Each absence' }]);
    expect(headings(el, 'mid')).toEqual(['Leave', 'Sickness']);
  });

  it('archives a collection and moves on to the next', async () => {
    const { fetch, calls } = service();
    const el = await mounted(fetch);
    await act(el, grid(el), 'Archive');
    const dialog = el.querySelector<UiDialog>('ui-dialog')!;
    await dialog.submit!({}, dialog);
    await settle(el);
    expect(calls).toContainEqual(['POST', '/api/folio/v1/libraries/l-1/archive']);
    expect(title(el)).toBe('Reports');
    expect(rail(el, 'Artifacts').items[0].meta).toBe('1');
  });

  it('moves the newest version on through its lifecycle, from the reader', async () => {
    const { fetch, calls } = service({ documents: [travel] });
    const el = await mounted(fetch);
    await press(el, 'Travel policy');
    let track = el.querySelector('.folio-reader-drawer ui-lifecycle') as HTMLElement & { state: string; moves: string[] };
    expect([track.state, track.moves]).toEqual(['in-progress', ['in-review', 'complete']]);
    track.dispatchEvent(new CustomEvent('ui-move', { detail: { state: 'complete' } }));
    await settle(el);
    expect(calls).toContainEqual(['PUT', '/api/folio/v1/libraries/l-1/documents/d-1/versions/2/state', { state: 'complete' }]);
    track = el.querySelector('.folio-reader-drawer ui-lifecycle') as typeof track;
    expect([track.state, track.moves]).toEqual(['complete', ['in-progress', 'in-review', 'issued']]);
    // The versions list says where each is.
    expect(el.querySelector<UiList>('.folio-reader-drawer ui-list[label="Versions"]')!.items.map((i) => i.detail?.split(' · ')[0])).toEqual(['Complete', 'Complete']);
  });

  it('publishes a document up the floors through a filter, with the floors it can’t go to saying why', async () => {
    const { fetch, calls } = service({ documents: [travel] });
    const el = await mounted(fetch);
    await press(el, 'Travel policy');
    button(el, 'Publish up the floors')!.click();
    await settle(el);
    const up = el.querySelector('folio-publish-up')!;
    const where = up.querySelector('ui-select') as HTMLElement & { options: { label: string; disabled?: boolean; detail?: string }[]; value: string };
    expect(where.options.map((o) => [o.label, Boolean(o.disabled), o.detail ?? ''])).toEqual([
      ['Operations', false, ''],
      ['The org', true, 'Publishing to the org needs the publisher role, which an admin can give you.'],
    ]);
    expect((up.querySelector('ui-checkbox-group') as HTMLElement & { values: string[] }).values).toEqual(['complete', 'issued']);
    button(up as HTMLElement, 'Publish to Operations')!.click();
    await settle(el);
    expect(calls).toContainEqual(['POST', '/api/folio/v1/placements', { library: 'l-1', record: { kind: 'document', id: 'd-1' }, to: 'w-ops', filter: ['complete', 'issued'] }]);
    expect(up.querySelector('.folio-note')!.textContent).toBe('Travel policy is on Operations now, showing complete and issued. Its leads were told.');
    expect(up.querySelector<UiList>('ui-list')!.items.map((i) => [i.title, i.detail])).toEqual([['On Operations', 'Shows complete and issued']]);
  });

  it('links a document to another and to a thing in Data Atlas, opens the other end, and unlinks it', async () => {
    const { fetch, calls } = service({ documents: [travel, leaveDoc] });
    const el = document.createElement('div');
    document.body.append(el);
    const c = ctx(fetch);
    (c.request as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: 'entity', id: 'ent_01JB0000000000000000000000', type: 'vessel', label: 'HMS Example' });
    await app.mount(el, c);
    await settle(el);
    await press(el, 'Travel policy');
    const links = el.querySelector('.folio-reader-drawer folio-links')!;
    const lists = () => [...links.querySelectorAll<UiList>('ui-list')].map((l) => [l.label, l.items.map((i) => i.title)]);
    expect(lists()).toEqual([['What links to it', ['Answered by: Something you can’t open links here.']]]);

    const [kind, to] = [...links.querySelectorAll('ui-select')] as (HTMLElement & { options: { value: string; label: string; disabled?: boolean }[]; value: string })[];
    expect(kind.options.map((o) => o.label)).toEqual(['Relates to', 'Supersedes', 'About', 'Serves']);
    kind.dispatchEvent(new CustomEvent('ui-change', { detail: { value: 'supersedes' } }));
    expect(to.options.map((o) => o.label)).toEqual(['Policies', 'HR', 'Leave', 'IT', 'Annual leave']);
    to.dispatchEvent(new CustomEvent('ui-change', { detail: { value: 'd-2' } }));
    await settle(el);
    button(links as HTMLElement, 'Link')!.click();
    await settle(el);
    expect(calls).toContainEqual(['POST', '/api/folio/v1/libraries/l-1/links', { record: 'd-1', relation: 'supersedes', to: { app: 'folio', kind: 'unit', id: 'l-1/d-2' } }]);

    (links.querySelector('ui-select') as HTMLElement).dispatchEvent(new CustomEvent('ui-change', { detail: { value: 'about' } }));
    await settle(el);
    button(links as HTMLElement, 'Choose in Data Atlas')!.click();
    await settle(el);
    expect(c.request).toHaveBeenCalledWith({ type: 'entity.pick', payload: { purpose: 'Say what it’s about' } });
    expect(calls).toContainEqual(['POST', '/api/folio/v1/libraries/l-1/links', { record: 'd-1', relation: 'about', to: { app: 'atlas', kind: 'entity', id: 'ent_01JB0000000000000000000000', label: 'HMS Example' } }]);
    expect(lists()[0]).toEqual(['What it links to', ['Supersedes Annual leave', 'About HMS Example']]);

    const mine = links.querySelector<UiList>('ui-list')!;
    mine.dispatchEvent(new CustomEvent('ui-open', { detail: { item: mine.items[1] } }));
    await settle(el);
    expect(c.raise).toHaveBeenCalledWith({ type: 'entity.open', payload: { kind: 'entity', id: 'ent_01JB0000000000000000000000', type: 'entity', label: 'HMS Example' } });
    mine.dispatchEvent(new CustomEvent('ui-action', { detail: { item: mine.items[1], action: { id: 'unlink' } } }));
    await settle(el);
    expect(calls).toContainEqual(['DELETE', '/api/folio/v1/libraries/l-1/links/k-2?record=d-1']);
    expect(lists()[0]).toEqual(['What it links to', ['Supersedes Annual leave']]);

    // The other end, in Artifacts, opens to read.
    links.querySelector<UiList>('ui-list')!.dispatchEvent(new CustomEvent('ui-open', { detail: { item: { id: 'k-1' } } }));
    await settle(el);
    expect(calls).toContainEqual(['GET', '/api/folio/v1/libraries/l-1/documents/d-2']);
  });

  it('shows what was published up to the floor, each at the version it lets through', async () => {
    window.history.replaceState(null, '', '/@finance/folio/libraries/l-1');
    const { fetch } = service();
    const el = await mounted(fetch);
    const screens = rail(el, 'Artifacts');
    expect(screens.items.find((i) => i.id === 'below')!.meta).toBe('1');
    screens.dispatchEvent(new CustomEvent('ui-select', { detail: { item: { id: 'below' } } }));
    await settle(el);
    expect(window.location.pathname).toBe('/@finance/folio/received');
    expect(title(el)).toBe('From below');
    const waiting = el.querySelector<UiList>('ui-list[label="Published up to this floor"]')!;
    expect(waiting.items.map((i) => [i.title, i.detail])).toEqual([['Quarterly returns', 'From Payroll · Waiting for a place']]);
    waiting.dispatchEvent(new CustomEvent('ui-open', { detail: { item: { id: 'pl-9' } } }));
    await settle(el);
    expect(window.location.pathname).toBe('/@finance/folio/received/pl-9');
    expect([title(el), back(el), el.querySelector('.folio-by')!.textContent]).toEqual(['Quarterly returns', 'From below', 'From Payroll']);
    expect(el.querySelector('.folio-main-inner > .folio-quiet')!.textContent).toContain('Showing complete and issued.');
    expect(facts(el)).toMatchObject({ From: 'Payroll', Showing: 'Complete and Issued' });
    expect(list(el).items.map((i) => [i.title, i.detail])).toEqual([
      ['Q3 return', 'Version 1 · Issued'],
      ['Q4 return', 'Version 3 · Complete · Shown here only: Finance doesn’t show it'],
    ]);
  });

  it('shows a folder’s details and closes it, on the record', async () => {
    const { fetch, calls } = service();
    const el = await mounted(fetch, '/libraries/l-1/f-hr');
    await act(el, grid(el), 'Details');
    const dialog = el.querySelector<UiDialog>('ui-dialog')!;
    expect(dialog.heading).toBe('HR');
    expect((dialog.querySelector('ui-details') as HTMLElement & { items: { label: string; value?: unknown }[] }).items.slice(0, 3).map((d) => [d.label, d.value])).toEqual([
      ['What it is', 'Subcollection'],
      ['What it’s for', undefined],
      ['State', 'Open: Taking new things.'],
    ]);
    expect(dialog.querySelector<UiList>('ui-list')!.items.map((i) => [i.title, i.detail])).toEqual([['Open to Closed', 'Year end']]);
    const track = dialog.querySelector('ui-lifecycle') as HTMLElement & { moves: string[] };
    expect(track.moves).toEqual(['closed', 'archived']);
    track.dispatchEvent(new CustomEvent('ui-move', { detail: { state: 'closed' } }));
    await settle(el);
    expect(calls).toContainEqual(['PUT', '/api/folio/v1/libraries/l-1/folders/f-hr/state', { state: 'closed' }]);

    // Its tags count for everything inside it.
    const tags = el.querySelector('ui-dialog ui-tag-picker') as HTMLElement & { hint: string; values: string[] };
    expect(tags.hint).toBe('They count for everything inside it when you filter.');
    tags.dispatchEvent(new CustomEvent('ui-change', { detail: { values: ['t-pol'] } }));
    await settle(el);
    expect(calls).toContainEqual(['PUT', '/api/folio/v1/libraries/l-1/folders/f-hr/tags', { tags: ['t-pol'] }]);
    expect((el.querySelector('ui-dialog ui-tag-picker') as typeof tags).values).toEqual(['t-pol']);
  });

  it('says when a floor has no collections, and who can start one', async () => {
    const lead = await mounted(service({ libraries: [] }).fetch, '/libraries');
    expect(lead.querySelector<UiTile>('ui-tile[add]')!.heading).toBe('New collection');
    expect(await ring(lead, grid(lead))).toEqual(['New collection', 'Level names']);
    document.body.innerHTML = '';
    const member = await mounted(service({ lead: false, libraries: [] }).fetch, '/libraries');
    expect(member.querySelector('ui-tile[add]')).toBeNull();
    expect(member.querySelector('.folio-grid .folio-quiet')!.textContent).toMatch(/A lead on this floor/);
  });

  it('says so when the service isn’t answering', async () => {
    const el = await mounted(vi.fn(async () => new Response(null, { status: 502 })));
    expect(el.querySelector('ui-state')!.getAttribute('kind')).toBe('error');
    expect(el.querySelector('ui-state')!.getAttribute('body')).toMatch(/isn’t answering/);
  });
  it('filters everywhere below, with folders out of the list, and says where each match is', async () => {
    const { fetch, calls } = service({ documents: [travel, leaveDoc] });
    const el = await mounted(fetch);
    const bar = el.querySelector<UiFilterBar>('ui-filter-bar')!;
    expect(bar.filters.map((f) => [f.id, f.options.map((o) => o.label)])).toEqual([
      ['tag', ['Policy', 'Travel']],
      ['type', ['PDF', 'Word', 'HTML', 'Markdown', 'Text']],
      ['author', ['Alex Rivera']],
      ['since', ['Past week', 'Past month', 'Past three months', 'Past year']],
      ['state', ['Drafts', 'Published', 'Withdrawn']],
    ]);
    bar.dispatchEvent(new CustomEvent('ui-change', { detail: { value: { tag: ['t-pol'], type: ['pdf'] }, sort: 'newest' } }));
    await settle(el);
    expect(calls.at(-1)).toEqual(['GET', '/api/folio/v1/libraries/l-1/documents?below=true&tag=t-pol&type=pdf&sort=newest&limit=100']);
    // Folders leave the grid while it filters: only what matches shows.
    expect(headings(el, 'mid')).toEqual([]);
    expect(headings(el, 'low')).toEqual(['Annual leave']);
    expect(button(el, 'Save view')).toBeDefined();
  });

  it('saves the filters as a view in the side rail, and opens a view from its path', async () => {
    window.history.replaceState(null, '', '/@finance/folio/libraries/l-1');
    const { fetch, calls } = service({ documents: [travel, leaveDoc] });
    const el = await mounted(fetch);
    el.querySelector<UiFilterBar>('ui-filter-bar')!.dispatchEvent(new CustomEvent('ui-change', { detail: { value: { since: ['month'] }, sort: 'title' } }));
    await settle(el);
    button(el, 'Save view')!.click();
    await settle(el);
    const dialog = el.querySelector<UiDialog>('ui-dialog')!;
    expect(dialog.heading).toBe('Save this view');
    await dialog.submit!({ name: ' This month ' }, dialog);
    await settle(el);
    expect(calls).toContainEqual(['POST', '/api/folio/v1/libraries/l-1/views', { name: 'This month', query: { since: 'month' } }]);
    expect(window.location.pathname).toBe('/@finance/folio/libraries/l-1/views/vw-new');

    const opened = await mounted(service({ documents: [travel, leaveDoc] }).fetch, '/libraries/l-1/views/vw-1');
    expect(title(opened)).toBe('Recent policy');
    expect(back(opened)).toBe('Policies');
    const bar = opened.querySelector<UiFilterBar>('ui-filter-bar')!;
    expect([bar.value, bar.sort]).toEqual([{ tag: ['t-pol'] }, 'updated']);
    expect(rail(opened, 'Views').selected).toBe('vw-1');
    expect(await ring(opened, grid(opened))).toEqual(['Rename view', 'Delete view']);
  });

  it('tags a document from its dialog, and adds a new tag when the library allows', async () => {
    const { fetch, calls } = service({ documents: [travel] });
    const el = await mounted(fetch);
    await details(el);
    const picker = el.querySelector<UiTagPicker>('ui-dialog ui-tag-picker')!;
    expect(picker.creatable).toBe(true);
    picker.dispatchEvent(new CustomEvent('ui-change', { detail: { values: ['t-pol'] } }));
    await settle(el);
    expect(calls).toContainEqual(['PUT', '/api/folio/v1/libraries/l-1/documents/d-1/tags', { tags: ['t-pol'] }]);
    picker.dispatchEvent(new CustomEvent('ui-create', { detail: { name: 'Expenses' } }));
    await settle(el);
    expect(calls).toContainEqual(['POST', '/api/folio/v1/libraries/l-1/tags', { name: 'Expenses' }]);
    expect(calls.at(-1)).toEqual(['PUT', '/api/folio/v1/libraries/l-1/documents/d-1/tags', { tags: ['t-pol', 't-new'] }]);
  });

  it('keeps a library’s tags in one dialog, with free tags a lead’s switch', async () => {
    const { fetch, calls } = service();
    const el = await mounted(fetch);
    await act(el, grid(el), 'Tags');
    const dialog = el.querySelector<UiDialog>('ui-dialog')!;
    const [own, org] = [...dialog.querySelectorAll<UiList>('ui-list')];
    expect(own.items.map((i) => [i.title, (i.actions ?? []).map((a) => a.label)])).toEqual([['Travel', ['Rename', 'Remove']]]);
    expect(org.items.map((i) => [i.title, i.actions])).toEqual([['Policy', undefined]]);
    const toggle = dialog.querySelector('ui-toggle')!;
    await toggle.flip();
    expect(calls).toContainEqual(['PATCH', '/api/folio/v1/libraries/l-1', { freeTags: true }]);
    const field = dialog.querySelector<HTMLElement & { value: string }>('ui-text-field[name="new-tag"]')!;
    field.value = 'Expenses';
    button(dialog, 'Add')!.click();
    await settle(el);
    expect(calls).toContainEqual(['POST', '/api/folio/v1/libraries/l-1/tags', { name: 'Expenses' }]);
  });

  it('lets the org’s leads rename the levels, and shows everyone else what they’re called', async () => {
    const { fetch, calls } = service({ renameLevels: true });
    const el = await mounted(fetch, '/libraries');
    await act(el, grid(el), 'Level names');
    const levels = el.querySelector('folio-levels')!;
    const list = () => levels.querySelector<UiList>('ui-list')!;
    expect(list().items.map((i) => i.title)).toEqual(['Collection', 'Subcollection', 'Series', 'Subseries', 'File']);
    expect(list().items[0].detail).toBe('More than one: Collections · Holds subcollections and series and files');
    list().dispatchEvent(new CustomEvent('ui-action', { detail: { item: list().items[0], action: { id: 'rename' } } }));
    await settle(el);
    levels.querySelector('ui-text-field[name="level-name"]')!.dispatchEvent(new CustomEvent('ui-input', { detail: { value: 'Programme' } }));
    levels.querySelector('ui-text-field[name="level-plural"]')!.dispatchEvent(new CustomEvent('ui-input', { detail: { value: 'Programmes' } }));
    await settle(el);
    button(levels, 'Save')!.click();
    await settle(el);
    expect(calls).toContainEqual(['PUT', '/api/folio/v1/levels/collection', { name: 'Programme', plural: 'Programmes' }]);
    expect(list().items[0]).toMatchObject({ title: 'Programme', detail: expect.stringContaining('Its own name is Collection') });
    expect(levels.querySelector('[role=status]')!.textContent).toBe('The whole org calls it Programme now.');
    // The rest of Artifacts calls it that straight away.
    expect(el.querySelector<FolioApp>('folio-app')!.levels[0].name).toBe('Programme');

    list().dispatchEvent(new CustomEvent('ui-action', { detail: { item: list().items[0], action: { id: 'reset' } } }));
    await settle(el);
    expect(calls).toContainEqual(['DELETE', '/api/folio/v1/levels/collection']);
    expect(list().items[0].title).toBe('Collection');
  });

  it('shows the level names, unchangeable, to anyone who isn’t one of the org’s leads', async () => {
    const { fetch } = service();
    const el = await mounted(fetch, '/libraries');
    await act(el, grid(el), 'Level names');
    const levels = el.querySelector('folio-levels')!;
    expect(levels.querySelector<UiList>('ui-list')!.items.every((i) => !i.actions)).toBe(true);
    expect(levels.textContent).toContain('The org’s leads choose what they’re called, from the org’s floor.');
  });

  it('shows who can see a library, and shares it with someone found by name', async () => {
    const { fetch, calls } = service();
    const el = await mounted(fetch);
    await act(el, grid(el), 'Share');
    const share = el.querySelector('folio-share')!;
    expect(el.querySelector('ui-dialog')!.getAttribute('heading')).toBe('Who can see Policies');
    expect(share.querySelector('.folio-share-floor')!.textContent).toContain('Everyone on Finance, and the teams below it, can read it');
    const shared = () => [...share.querySelectorAll<UiList>('ui-list')].at(-1)!.items;
    expect(shared().map((i) => [i.title, i.meta])).toEqual([['Kim Lee', 'Can read']]);

    const picker = share.querySelector('ui-people-picker')!;
    await picker.find('ol');
    await settle(el);
    const found = picker.shadowRoot!.querySelector<UiList>('ui-list')!;
    expect(found.items.map((i) => i.title)).toEqual(['Ola Bello', 'Legal']);
    found.dispatchEvent(new CustomEvent('ui-open', { detail: { item: found.items[0] } }));
    await settle(el);
    share.querySelector('ui-select')!.dispatchEvent(new CustomEvent('ui-change', { detail: { value: 'edit' } }));
    await settle(el);
    button(share, 'Share')!.click();
    await settle(el);
    expect(calls).toContainEqual(['PUT', '/api/folio/v1/libraries/l-1/access/person%3Au4', { level: 'edit' }]);
    expect(shared().map((i) => [i.title, i.meta])).toEqual([['Kim Lee', 'Can read'], ['Ola Bello', 'Can edit']]);
    expect(share.querySelector('[role=status]')!.textContent).toBe('Ola Bello: can edit.');

    // A team goes with the teams below it, unless that's switched off.
    const again = share.querySelector('ui-people-picker')!;
    await again.find('leg');
    await settle(el);
    const teams = again.shadowRoot!.querySelector<UiList>('ui-list')!;
    teams.dispatchEvent(new CustomEvent('ui-open', { detail: { item: teams.items[1] } }));
    await settle(el);
    share.querySelector('ui-toggle')!.dispatchEvent(new CustomEvent('ui-change', { detail: { checked: false } }));
    await settle(el);
    button(share, 'Share')!.click();
    await settle(el);
    expect(calls).toContainEqual(['PUT', '/api/folio/v1/libraries/l-1/access/team%3Aw-legal', { level: 'read' }]);

    const list = [...share.querySelectorAll<UiList>('ui-list')].at(-1)!;
    list.dispatchEvent(new CustomEvent('ui-action', { detail: { item: list.items[0], action: { id: 'remove' } } }));
    await settle(el);
    expect(calls).toContainEqual(['DELETE', '/api/folio/v1/libraries/l-1/access/person%3Au3']);
    expect(shared().map((i) => i.title)).toEqual(['Ola Bello', 'Legal (just that team)']);
  });

  it('shares a folder, and so everything inside it, from inside the folder', async () => {
    const { fetch, calls } = service();
    const el = await mounted(fetch, '/libraries/l-1/f-hr');
    await act(el, grid(el), 'Share');
    const dialog = el.querySelector<UiDialog>('ui-dialog')!;
    expect([dialog.getAttribute('eyebrow'), dialog.heading]).toEqual(['Subcollection', 'Who can see HR']);
    const share = el.querySelector('folio-share')!;
    expect(share.querySelector('.folio-share-floor')!.textContent).toContain('sees everything inside it, while it’s inside');
    const lists = () => [...share.querySelectorAll<UiList>('ui-list')].map((l) => [l.label, l.items.map((i) => i.title)]);
    expect(lists()).toEqual([
      ['Shared with, for this folder', []],
      ['Published up to', ['Everyone in the org']],
      ['Shared with, through its collection', ['Kim Lee']],
    ]);
    expect([...share.querySelectorAll<UiList>('ui-list')][1].items[0].detail).toBe('Up from Payroll through Finance · Shows Complete and Issued');

    const picker = share.querySelector('ui-people-picker')!;
    await picker.find('leg');
    await settle(el);
    const found = picker.shadowRoot!.querySelector<UiList>('ui-list')!;
    found.dispatchEvent(new CustomEvent('ui-open', { detail: { item: found.items[1] } }));
    await settle(el);
    button(share, 'Share')!.click();
    await settle(el);
    expect(calls).toContainEqual(['PUT', '/api/folio/v1/libraries/l-1/folders/f-hr/access/tree%3Aw-legal', { level: 'read' }]);
    expect(lists()[0]).toEqual(['Shared with, for this folder', ['Legal and the teams below it']]);
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

  it('asks for who can open it, explained, and says so when nothing can explain it', async () => {
    const { fetch } = service({ lead: false });
    const context = ctx(fetch);
    const el = document.createElement('div');
    document.body.append(el);
    await app.mount(el, context);
    await settle(el);
    await act(el, grid(el), 'Who can see it');
    const share = el.querySelector('folio-share')!;
    button(share, 'Who can open this, explained')!.click();
    await settle(el);
    expect(context.request).toHaveBeenCalledWith({
      type: 'access.explain',
      payload: {
        thing: { app: 'folio', appName: 'Artifacts', id: 'l-1', title: 'Policies', kind: 'library' },
        audience: [
          { principal: 'tree:w-fin', name: 'Finance', level: 'read', via: 'its floor' },
          { principal: 'person:u3', name: 'Kim Lee', level: 'read', since: KIM.createdAt, via: 'shared with this library' },
        ],
        change: { where: 'Share', allowed: false },
      },
    });
    vi.mocked(context.request).mockRejectedValueOnce(Object.assign(new Error('No app you can open handles "access.explain".'), { name: 'IntentError' }));
    button(share, 'Who can open this, explained')!.click();
    await settle(el);
    expect(share.querySelector('[role=status]')!.textContent).toBe('Couldn’t explain it: No app you can open handles "access.explain". Who can see it is still listed here.');
    // Closing it without an answer is no error.
    vi.mocked(context.request).mockRejectedValueOnce(Object.assign(new Error('closed'), { name: 'IntentCancelled' }));
    share.note = '';
    button(share, 'Who can open this, explained')!.click();
    await settle(el);
    expect(share.querySelector('[role=status]')!.textContent).toBe('');
  });

  it('lets someone who only reads see who can, without changing it', async () => {
    const { fetch } = service({ lead: false });
    const el = await mounted(fetch);
    expect(await ring(el, grid(el))).not.toContain('Share');
    await act(el, grid(el), 'Who can see it');
    const share = el.querySelector('folio-share')!;
    expect(share.querySelector('ui-people-picker')).toBeNull();
    expect(share.querySelector<UiList>('ui-list')!.items[0].actions).toBeUndefined();
  });

  it('lists what was shared from other floors, a library per floor, and reads a document shared alone', async () => {
    const shared = {
      libraries: [{ ...reports, id: 'l-8', workspace: 'w-ops', floor: 'tree:w-ops', name: 'Board papers', level: 'read' }],
      documents: [{ ...travel, id: 'd-9', library: 'l-9', title: 'Shared plan', libraryName: 'Ops runbooks', level: 'read' }],
    };
    window.history.replaceState(null, '', '/@finance/folio/libraries/l-1');
    const { fetch } = service({ shared });
    const el = await mounted(fetch);
    rail(el, 'Artifacts').dispatchEvent(new CustomEvent('ui-select', { detail: { item: { id: 'shared' } } }));
    await settle(el);
    expect(window.location.pathname).toBe('/@finance/folio/shared');
    expect(title(el)).toBe('Shared libraries');
    expect(headings(el, 'high')).toEqual(['A team’s library']);
    expect(headings(el, 'low')).toEqual(['Shared plan']);
    expect(facts(el)).toMatchObject({ Libraries: '1', 'Documents on their own': '1' });
    // A library opens on what it shares.
    await press(el, 'A team’s library');
    expect([title(el), back(el)]).toEqual(['A team’s library', 'Shared libraries']);
    expect(headings(el, 'high')).toEqual(['Board papers']);
    el.querySelector<HTMLButtonElement>('.folio-back')!.click();
    await settle(el);
    await press(el, 'Shared plan');
    expect(window.location.pathname).toBe('/@finance/folio/libraries/l-9/documents/d-9');
    const reader = el.querySelector('folio-reader')!;
    expect(reader.querySelector('.folio-back')!.textContent).toContain('Ops runbooks');
    expect(button(el.querySelector<HTMLElement>('.folio-reader-drawer')!, 'Who can see it')).toBeDefined();
    // Back has no collection to go to: where the person came from.
    reader.querySelector<HTMLButtonElement>('.folio-back')!.click();
    await settle(el);
    expect(title(el)).toBe('Shared libraries');
  });

  it('opens a document shared alone straight from its path', async () => {
    const shared = { libraries: [], documents: [{ ...travel, id: 'd-9', library: 'l-9', title: 'Shared plan', libraryName: 'Ops runbooks', level: 'read' }] };
    const { fetch } = service({ shared });
    const el = await mounted(fetch, '/libraries/l-9/documents/d-9');
    expect(el.querySelector('folio-reader h1')!.textContent).toBe('Shared plan');
  });

  it('leaves the old Publish off a document that isn’t an issue: it’s published up the floors', async () => {
    const { fetch } = service({ documents: [travel] });
    const el = await mounted(fetch);
    await press(el, 'Travel policy');
    // What the reader says about it, and does with it, is in the drawer.
    const reader = el.querySelector<HTMLElement>('.folio-reader-drawer')!;
    expect(reader.querySelector('.folio-reader-publishing')).toBeNull();
    expect(button(reader, 'Publish')).toBeUndefined();
    expect(button(reader, 'Publish up the floors')).toBeDefined();
  });

  it('publishes an issue to the floor’s team and those below it, and withdraws it', async () => {
    const { fetch, calls } = service({ documents: [travel], anIssue: true });
    const el = await mounted(fetch);
    await press(el, 'Travel policy');
    // What the reader says about it, and does with it, is in the drawer.
    const reader = el.querySelector<HTMLElement>('.folio-reader-drawer')!;
    expect(reader.querySelector('.folio-reader-said')!.textContent).toContain('A draft');
    button(reader, 'Publish')!.click();
    await settle(el);
    const publish = el.querySelector('folio-publish')!;
    const [audience] = [...publish.querySelectorAll<UiList>('ui-list')];
    expect(audience.items.map((i) => i.title)).toEqual(['Finance and the teams below it']);
    button(publish, 'Publish version 2')!.click();
    await settle(el);
    expect(calls.find(([m, p]) => m === 'POST' && p.endsWith('/publish'))).toEqual(['POST', '/api/folio/v1/libraries/l-1/documents/d-1/publish', { version: 2, audience: ['tree:w-fin'] }]);
    expect(publish.querySelector('.folio-note')!.textContent).toBe('Version 2 is out to Finance and the teams below it.');
    expect(publish.querySelector('.folio-publish-lead')!.textContent).toContain('Version 2 went out to Finance and the teams below it just now');

    button(publish, 'Withdraw')!.click();
    await settle(el);
    button(publish, 'Withdraw version 2')!.click();
    await settle(el);
    expect(calls.find(([m, p]) => m === 'POST' && p.endsWith('/withdraw'))).toEqual(['POST', '/api/folio/v1/libraries/l-1/documents/d-1/withdraw', {}]);
    expect(publish.querySelector('.folio-publish-lead')!.textContent).toContain('hasn’t been published');
  });

  it('lists what’s been published to the person, and opens one at the version that’s out', async () => {
    const { fetch, calls } = service();
    const el = await mounted(fetch, '/published');
    expect([title(el), back(el)]).toEqual(['Published to you', 'Shared libraries']);
    expect(calls).toContainEqual(['PUT', '/api/folio/v1/published/looked']);
    const rows = list(el);
    expect(rows.items.map((i) => [i.title, i.detail])).toEqual([['Shared plan', 'In Ops runbooks · Version 2 · For Monday']]);
    rows.dispatchEvent(new CustomEvent('ui-open', { detail: { item: rows.items[0] } }));
    await settle(el);
    expect(calls.some(([, p]) => p === '/api/folio/v1/libraries/l-9/documents/d-9')).toBe(true);
    expect(el.querySelector('folio-reader h1')!.textContent).toBe('Shared plan');
  });

  it('opens a document another app asked for, finding its library first', async () => {
    const { fetch, calls } = service();
    const el = document.createElement('div');
    document.body.append(el);
    await app.mount(el, { ...ctx(fetch, '/'), intent: { type: 'document.open', payload: { app: 'folio', id: 'd-9', title: 'Shared plan' } } });
    await settle(el);
    expect(calls.some(([, p]) => p === '/api/folio/v1/documents/d-9')).toBe(true);
    expect(el.querySelector('folio-reader h1')!.textContent).toBe('Shared plan');
  });
});

describe('folio series', () => {
  it('lists a library’s series in the rail and opens one on its own page', async () => {
    const { fetch } = service({ series: [CASH] });
    const el = await mounted(fetch);
    const series = rail(el, 'Series');
    expect(series.items.map((i) => [i.label, i.icon])).toEqual([['Cash report', 'series']]);
    series.dispatchEvent(new CustomEvent('ui-select', { detail: { item: series.items[0] } }));
    await settle(el);
    const page = el.querySelector('folio-series')!;
    expect(page.series).toBe('s-1');
    expect(page.querySelector('ui-heading')!.getAttribute('heading')).toBe('Cash report');
    expect(page.querySelector('.folio-series-facts')!.textContent!.replace(/\s+/g, ' ').trim()).toBe(
      'Every week. Each issue goes out to Finance and the teams below it as it’s added. Next: Week 44, 2026, due by Monday 2 November.',
    );
    expect(page.querySelector<UiList>('ui-list')!.items.map((i) => [i.title, i.detail])).toEqual([
      ['Cash report: Week 43, 2026', 'Issue 2 · Week 43, 2026 · Published'],
      ['Cash report: Week 42, 2026', 'Issue 1 · Week 42, 2026 · Published'],
    ]);
  });

  it('adds the next issue from one file, and follows the series', async () => {
    const { fetch, calls } = service({ series: [CASH] });
    const el = await mounted(fetch, '/libraries/l-1/series/s-1');
    const page = el.querySelector('folio-series')!;
    const zone = page.querySelector('ui-drop-zone')!;
    expect(zone.getAttribute('heading')).toBe('Drop the issue for Week 44, 2026 here');
    zone.dispatchEvent(new CustomEvent('ui-files', { detail: { files: [new File(['%PDF'], 'cash.pdf')] } }));
    await settle(el);
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/folio/v1/libraries/l-1/documents?filename=cash.pdf&series=s-1')).toBe(true);
    expect(page.querySelector('.folio-note')!.textContent).toBe('Cash report: Week 44, 2026 is out to Finance and the teams below it.');
    page.querySelector('ui-toggle')!.dispatchEvent(new CustomEvent('ui-change', { detail: { checked: true } }));
    await settle(el);
    expect(calls).toContainEqual(['PUT', '/api/folio/v1/series/s-1/follow', { following: true }]);
  });

  it('makes a series with a cadence, tags and audience', async () => {
    const { fetch, calls } = service({ series: [CASH] });
    const el = await mounted(fetch);
    await act(el, grid(el), 'New series');
    const dialog = el.querySelector<UiDialog>('ui-dialog')!;
    expect(dialog.heading).toBe('New series');
    await dialog.submit!({ name: ' Board pack ', description: '', cadence: 'monthly', tags: 't-pol', audience: 'tree:w-fin' }, dialog);
    await settle(el);
    expect(calls).toContainEqual(['POST', '/api/folio/v1/libraries/l-1/series', { name: 'Board pack', description: '', cadence: 'monthly', tags: ['t-pol'], audience: ['tree:w-fin'] }]);
    expect(el.querySelector('folio-series')!.series).toBe('s-new');
  });

  it('reads an issue with the ones either side, and goes to its series', async () => {
    const { fetch, calls } = service({ series: [CASH] });
    const el = await mounted(fetch, '/libraries/l-1/documents/d-5');
    // What the reader says about it, and does with it, is in the drawer.
    const reader = el.querySelector<HTMLElement>('.folio-reader-drawer')!;
    expect(reader.querySelector('.folio-reader-series')!.textContent!.replace(/\s+/g, ' ')).toContain('Issue 1, Week 42, 2026, in Cash report');
    // The issues either side are under the title.
    const page = el.querySelector<HTMLElement>('folio-reader')!;
    expect(button(page, 'Previous: Week 41, 2026')).toBeUndefined();
    button(page, 'Next: Week 43, 2026')!.click();
    await settle(el);
    expect(calls.some(([, p]) => p === '/api/folio/v1/libraries/l-1/documents/d-6')).toBe(true);
  });
});

describe('folio on Home', () => {
  const card = async (fetch: MountContext['fetch']) => {
    const el = document.createElement('div');
    document.body.append(el);
    const context = ctx(fetch, '/');
    await app.surfaces!['./Glance'].mount(el, context);
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r));
      await el.querySelector('folio-glance')?.updateComplete;
    }
    return { el, context };
  };

  it('says what’s new to the person and, for a lead, the drafts waiting, and opens them', async () => {
    const { fetch } = service();
    const { el, context } = await card(fetch);
    expect(el.querySelector<HTMLElement & { items: unknown[] }>('ui-facts')!.items).toEqual([
      { value: 1, label: 'New to you' },
      { value: 4, label: 'Drafts' },
    ]);
    const rows = list(el);
    expect(rows.items.map((i) => [i.title, i.detail])).toEqual([['Shared plan', 'From Ops runbooks']]);
    rows.dispatchEvent(new CustomEvent('ui-open', { detail: { item: rows.items[0] } }));
    expect(context.raise).toHaveBeenCalledWith({ type: 'document.open', payload: { app: 'folio', id: 'd-9', title: 'Shared plan' } });
    button(el, 'Published to you')!.click();
    expect(context.raise).toHaveBeenCalledWith({ type: 'folio.open', payload: { path: '/published' } });
    app.surfaces!['./Glance'].unmount!(el);
    expect(el.querySelector('folio-glance')).toBeNull();
  });

  it('leaves drafts out for members', async () => {
    const { fetch } = service({ lead: false });
    const { el } = await card(fetch);
    expect(el.querySelector<HTMLElement & { items: unknown[] }>('ui-facts')!.items).toEqual([{ value: 1, label: 'New to you' }]);
  });
});

describe('folio as a picker', () => {
  const picker = async (fetch: MountContext['fetch'], payload: object) => {
    const el = document.createElement('div');
    document.body.append(el);
    const reply = { respond: vi.fn(), cancel: vi.fn() };
    await app.mount(el, { ...ctx(fetch, '/'), intent: { type: 'document.pick', payload }, reply });
    const settled = async () => {
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r));
        await el.querySelector('folio-picker')?.updateComplete;
      }
    };
    await settled();
    return { el, reply, settled };
  };

  it('answers another app with the document picked from a library, in the kinds it takes', async () => {
    const pdf = { ...travel, latest: v(2) };
    const notes = { ...travel, id: 'd-3', title: 'Notes', latest: { ...v(1, 'notes.md'), mediaType: 'text/markdown' } };
    const { fetch, calls } = service({ documents: [pdf, notes] });
    const { el, reply } = await picker(fetch, { purpose: 'Attach a policy', accept: ['application/pdf'] });
    expect(el.querySelector('folio-app')).toBeNull();
    expect(el.querySelector('ui-heading')!.getAttribute('heading')).toBe('Attach a policy');
    expect(calls.some(([, p]) => p.startsWith('/api/folio/v1/libraries/l-1/documents?') && p.includes('below=true'))).toBe(true);
    const rows = list(el);
    expect(rows.items.map((i) => [i.title, i.detail])).toEqual([['Travel policy', 'In Policies · Version 2 · PDF']]);
    expect(el.querySelector('.folio-note')!.textContent).toBe('One other isn’t the kind of file asked for.');
    rows.dispatchEvent(new CustomEvent('ui-open', { detail: { item: rows.items[0] } }));
    expect(reply.respond).toHaveBeenCalledWith({ app: 'folio', id: 'd-1', version: '2', title: 'Travel policy' });
  });

  it('finds by what’s typed, picks the version published to the person, and cancels', async () => {
    const { fetch } = service();
    const { el, reply, settled } = await picker(fetch, {});
    expect(el.querySelector('ui-heading')!.getAttribute('heading')).toBe('Pick a document');
    el.querySelector('ui-text-field')!.dispatchEvent(new CustomEvent('ui-input', { detail: { value: 'plan' } }));
    await new Promise((r) => setTimeout(r, 250));
    await settled();
    const rows = list(el);
    expect(rows.items.map((i) => [i.title, i.detail])).toEqual([['Shared plan', 'In Ops runbooks · Version 1 · PDF']]);
    rows.dispatchEvent(new CustomEvent('ui-open', { detail: { item: rows.items[0] } }));
    expect(reply.respond).toHaveBeenCalledWith({ app: 'folio', id: 'd-9', version: '1', title: 'Shared plan' });
    button(el, 'Cancel')!.click();
    expect(reply.cancel).toHaveBeenCalled();
  });
});
