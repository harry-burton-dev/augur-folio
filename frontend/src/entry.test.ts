import { createEventBus, type MountContext, type Workspace } from '@augur/mfe-sdk';
import type { UiContents, UiDialog, UiFilterBar, UiList, UiReader, UiTagPicker, UiTextField, UiTree } from '@augur/ui-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathFor, placeFor, type ReaderState } from './api.js';
import app, { addressFor, placeForIntent } from './entry.js';
import { folderTrail, folderTree, type FolioApp } from './folio-app.js';

const floor: Workspace = { id: 'w-fin', kind: 'team', name: 'Finance', slug: 'finance', path: [], role: 'lead' };
const policies = { id: 'l-1', workspace: 'w-fin', name: 'Policies', description: 'How we work', freeTags: false, createdBy: 'u1', createdAt: '', updatedAt: '' };
const reports = { ...policies, id: 'l-2', name: 'Reports', description: '' };
const hr = { id: 'f-hr', library: 'l-1', name: 'HR', createdBy: 'u1', createdAt: '' };
const leave = { id: 'f-leave', library: 'l-1', parent: 'f-hr', name: 'Leave', createdBy: 'u2', createdAt: '' };
const it_ = { id: 'f-it', library: 'l-1', name: 'IT', createdBy: 'u2', createdAt: '' };
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
} = {}) => {
  const calls: [string, string, unknown?][] = [];
  let grants: (typeof KIM)[] = [KIM];
  let retried = false;
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
        state: out ? (out.ended ? 'withdrawn' : 'published') : 'draft',
        ...(out && !out.ended ? { published: out } : {}),
        can: { ...travel.can, publish: lead },
        versions: [v(2), v(1, 'travel-old.pdf', 900, retried ? { state: 'queued', thumbnail: false } : DAMAGED)],
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
    if (method === 'POST' && route === '/libraries/l-1/folders') return Response.json({ id: 'f-new', library: 'l-1', name: body.name, ...(body.parent ? { parent: body.parent } : {}), createdBy: 'u1', createdAt: '' }, { status: 201 });
    if (method === 'POST' && route.endsWith('/archive')) return new Response(null, { status: 204 });
    return Response.json({ message: 'Folio isn’t answering.' }, { status: 502 });
  });
  return { fetch, calls };
};

const ctx = (fetch: MountContext['fetch'], path = '/libraries'): MountContext => ({
  user: { id: 'u1', name: 'Sam Okafor', departments: ['Finance'], roles: [] },
  getToken: async () => 't',
  bus: createEventBus(),
  raise: vi.fn(),
  request: vi.fn(),
  notify: vi.fn(),
  path,
  workspace: floor,
  getWorkspace: () => floor,
  fetch,
});

/** Opens Travel policy on its page, then its details, to change it. */
const details = async (el: HTMLElement) => {
  list(el).dispatchEvent(new CustomEvent('ui-open', { detail: { item: { id: 'doc:d-1' } } }));
  await settle(el);
  button(el, 'Change it')!.click();
  await settle(el);
};
const settle = async (el: HTMLElement) => {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r));
    await (el.querySelector('folio-app') as FolioApp | null)?.updateComplete;
  }
};
const mounted = async (fetch: MountContext['fetch'], path?: string) => {
  const el = document.createElement('div');
  document.body.append(el);
  await app.mount(el, ctx(fetch, path));
  await settle(el);
  return el;
};
/** The rail's trees of libraries, folders and views; "For you" is always there, so it's left out. */
const trees = (el: HTMLElement) => [...el.querySelectorAll<UiTree>('ui-tree')].filter((t) => t.label !== 'For you');
const list = (el: HTMLElement) => el.querySelector<UiList>('ui-list')!;
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll<HTMLElement>('ui-button')].find((b) => b.textContent?.trim() === text);

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('folio paths', () => {
  it('reads and writes where Folio is', () => {
    expect(placeFor('/libraries')).toEqual({ adding: false });
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
    expect(placeForIntent({ type: 'document.open', payload: { id: 'd-9' } })).toBeUndefined();
    expect(placeForIntent(undefined)).toBeUndefined();
    expect(placeForIntent({ type: 'folio.open', payload: { path: '/published' } })).toEqual({ published: true, adding: false });
    expect(placeForIntent({ type: 'folio.open', payload: {} })).toBeUndefined();
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
  it('lists a place’s documents under its folders, and uploads what is dropped there', async () => {
    const { fetch, calls } = service({ documents: [travel] });
    const el = await mounted(fetch);
    expect(list(el).items.map((i) => [i.group, i.title, i.detail])).toEqual([
      ['Folders', 'HR', undefined],
      ['Folders', 'IT', undefined],
      ['Documents', 'Travel policy', 'Version 2 · PDF · 1.2 MB'],
    ]);
    const zone = el.querySelector('ui-drop-zone')!;
    expect(zone.getAttribute('heading')).toBe('Drop files to add them to Policies');
    // Tags chosen for what's added go with the next file.
    const picker = el.querySelector<UiTagPicker>('.folio-add ui-tag-picker')!;
    expect(picker.options.map((o) => [o.label, o.detail])).toEqual([['Policy', 'Org'], ['Travel', undefined]]);
    picker.dispatchEvent(new CustomEvent('ui-change', { detail: { values: ['t-trv'] } }));
    zone.dispatchEvent(new CustomEvent('ui-files', { detail: { files: [new File(['%PDF'], 'Leave.pdf')] } }));
    await settle(el);
    picker.dispatchEvent(new CustomEvent('ui-change', { detail: { values: [] } }));
    await settle(el);
    const pdf = new File(['%PDF'], 'Leave.pdf', { type: 'application/pdf' });
    const md = new File(['# Notes'], 'notes.md');
    zone.dispatchEvent(new CustomEvent('ui-files', { detail: { files: [pdf, md, new File(['x'], 'big.pdf')] } }));
    await settle(el);
    const sent = calls.filter(([m, p]) => m === 'POST' && p.startsWith('/api/folio/v1/libraries/l-1/documents?'));
    expect(sent.map(([, p]) => p)).toEqual([
      '/api/folio/v1/libraries/l-1/documents?filename=Leave.pdf&tag=t-trv',
      '/api/folio/v1/libraries/l-1/documents?filename=Leave.pdf',
      '/api/folio/v1/libraries/l-1/documents?filename=notes.md',
      '/api/folio/v1/libraries/l-1/documents?filename=big.pdf',
    ]);
    expect(fetch.mock.calls.find(([p]) => p.includes('filename=notes.md'))![1]!.headers).toEqual({ 'content-type': 'text/markdown' });
    expect(el.querySelector('.folio-note')!.textContent).toBe('Added 2 documents. Couldn’t add big.pdf: A file can be 200 MB at most.');
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
    expect(list(el).items.map((i) => i.title)).toEqual(['HR', 'IT']);
  });

  it('says which files it turned away', async () => {
    const el = await mounted(service().fetch);
    el.querySelector('ui-drop-zone')!.dispatchEvent(new CustomEvent('ui-reject', { detail: { files: [new File(['x'], 'deck.pptx')] } }));
    await settle(el);
    expect(el.querySelector('.folio-note')!.textContent).toMatch(/^Folio can’t take deck\.pptx/);
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
    window.history.replaceState(null, '', '/@finance/folio/libraries');
    URL.createObjectURL = vi.fn(() => 'blob:map');
    URL.revokeObjectURL = vi.fn();
    const { fetch, calls } = service({ documents: [travel] });
    const el = await mounted(fetch);
    list(el).dispatchEvent(new CustomEvent('ui-open', { detail: { item: { id: 'doc:d-1' } } }));
    await settle(el);
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
    expect(page.querySelector<UiList>('ui-list')!.items.map((i) => i.title)).toEqual(['Version 2, reading', 'Version 1']);
    page.querySelector<HTMLButtonElement>('.folio-crumb')!.click();
    await settle(el);
    expect(el.querySelector('folio-reader')).toBeNull();
    expect(window.location.pathname).toBe('/@finance/folio/libraries/l-1');
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


  it('opens the floor’s first library, with its libraries and folders in the side rail', async () => {
    const { fetch, calls } = service();
    const el = await mounted(fetch);
    expect(calls.map(([m, p]) => `${m} ${p}`)).toEqual(['GET /api/folio/v1/libraries', 'GET /api/folio/v1/shared', 'GET /api/folio/v1/libraries/l-1', 'GET /api/folio/v1/libraries/l-1/documents?limit=100']);
    const [libs, folders, views] = trees(el);
    expect(views.items.map((i) => i.label)).toEqual(['Recent policy']);
    expect(libs.heading).toBe('Libraries on Finance');
    expect(libs.items.map((i) => i.label)).toEqual(['Policies', 'Reports']);
    expect(libs.selected).toBe('l-1');
    expect(folders.items.map((i) => i.label)).toEqual(['HR', 'IT']);
    expect(el.querySelector('ui-heading')!.getAttribute('heading')).toBe('Policies');
    expect(el.querySelector('ui-heading')!.getAttribute('eyebrow')).toBe('Libraries on Finance');
    expect(el.querySelector('.folio-trail')).toBeNull();
    expect(list(el).items.map((i) => i.title)).toEqual(['HR', 'IT']);
    await app.unmount!(el);
    expect(el.querySelector('folio-app')).toBeNull();
  });

  it('goes into a folder, says where it is, and puts it in the address bar', async () => {
    window.history.replaceState(null, '', '/@finance/folio/libraries');
    const { fetch } = service();
    const el = await mounted(fetch);
    list(el).dispatchEvent(new CustomEvent('ui-open', { detail: { item: { id: 'f-hr' } } }));
    await settle(el);
    expect(window.location.pathname).toBe('/@finance/folio/libraries/l-1/f-hr');
    expect([...el.querySelectorAll('.folio-crumb')].map((c) => c.textContent)).toEqual(['Policies', 'HR']);
    expect(el.querySelector('ui-heading')!.getAttribute('eyebrow')).toBe('Policies');
    expect(list(el).items.map((i) => i.title)).toEqual(['Leave']);
    expect(trees(el)[1].selected).toBe('f-hr');
  });

  it('opens straight at a folder from its path', async () => {
    const { fetch } = service();
    const el = await mounted(fetch, '/libraries/l-1/f-leave');
    expect(el.querySelector('ui-heading')!.getAttribute('heading')).toBe('Leave');
    expect(el.querySelector('ui-heading')!.getAttribute('eyebrow')).toBe('HR');
    expect(trees(el)[1].selected).toBe('f-leave');
  });

  it('calls them your libraries on your own floor', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    const own: Workspace = { ...floor, id: 'w-me', kind: 'personal', name: 'You', role: 'lead' };
    await app.mount(el, { ...ctx(service().fetch), workspace: own, getWorkspace: () => own });
    await settle(el);
    expect(trees(el)[0].heading).toBe('Your libraries');
  });

  it('offers Rename and Remove only on folders the person may change', async () => {
    const { fetch } = service({ lead: false });
    const el = await mounted(fetch);
    expect(list(el).items.map((i) => [i.title, (i.actions ?? []).map((a) => a.label)])).toEqual([
      ['HR', ['Rename', 'Remove']],
      ['IT', []],
    ]);
    expect(button(el, 'Rename')).toBeUndefined();
    expect(button(el, 'New library')).toBeUndefined();
    expect(button(el, 'New folder')).toBeDefined();
  });

  it('makes a library, and keeps the dialog open with the service’s words when it refuses', async () => {
    const { fetch, calls } = service();
    const el = await mounted(fetch, '/libraries/new');
    const dialog = el.querySelector<UiDialog>('ui-dialog')!;
    expect(dialog.heading).toBe('New library');
    await expect(dialog.submit!({ name: 'Taken' }, dialog)).rejects.toThrow('There’s already a library called Taken here.');
    await dialog.submit!({ name: ' Board papers ', description: '' }, dialog);
    await settle(el);
    expect(calls).toContainEqual(['POST', '/api/folio/v1/libraries', { name: 'Board papers' }]);
    expect(trees(el)[0].items.map((i) => i.label)).toEqual(['Board papers', 'Policies', 'Reports']);
  });

  it('makes a folder inside the one that is open', async () => {
    const { fetch, calls } = service();
    const el = await mounted(fetch, '/libraries/l-1/f-hr');
    button(el, 'New folder')!.click();
    await settle(el);
    const dialog = el.querySelector<UiDialog>('ui-dialog')!;
    await dialog.submit!({ name: 'Sickness' }, dialog);
    await settle(el);
    expect(calls).toContainEqual(['POST', '/api/folio/v1/libraries/l-1/folders', { name: 'Sickness', parent: 'f-hr' }]);
    expect(list(el).items.map((i) => i.title)).toEqual(['Leave', 'Sickness']);
  });

  it('archives a library and moves on to the next', async () => {
    const { fetch, calls } = service();
    const el = await mounted(fetch);
    button(el, 'Archive')!.click();
    await settle(el);
    const dialog = el.querySelector<UiDialog>('ui-dialog')!;
    await dialog.submit!({}, dialog);
    await settle(el);
    expect(calls).toContainEqual(['POST', '/api/folio/v1/libraries/l-1/archive']);
    expect(trees(el)[0].items.map((i) => i.label)).toEqual(['Reports']);
    expect(el.querySelector('ui-heading')!.getAttribute('heading')).toBe('Reports');
  });

  it('says when a floor has no libraries, and who can start one', async () => {
    const lead = await mounted(service({ libraries: [] }).fetch);
    expect(lead.querySelector('ui-state')!.getAttribute('action')).toBe('New library');
    const member = await mounted(service({ lead: false, libraries: [] }).fetch);
    expect(member.querySelector('ui-state')!.getAttribute('body')).toMatch(/A lead on this floor/);
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
    expect(list(el).items.map((i) => [i.title, i.detail])).toEqual([['Annual leave', 'HR / Leave · Version 2 · PDF · 1.2 MB · Policy']]);
    expect(button(el, 'Save view')).toBeDefined();
  });

  it('saves the filters as a view in the side rail, and opens a view from its path', async () => {
    window.history.replaceState(null, '', '/@finance/folio/libraries');
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
    expect(opened.querySelector('ui-heading')!.getAttribute('heading')).toBe('Recent policy');
    const bar = opened.querySelector<UiFilterBar>('ui-filter-bar')!;
    expect([bar.value, bar.sort]).toEqual([{ tag: ['t-pol'] }, 'updated']);
    expect(trees(opened)[2].selected).toBe('vw-1');
    expect(button(opened, 'Delete view')).toBeDefined();
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
    button(el, 'Tags')!.click();
    await settle(el);
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

  it('shows who can see a library, and shares it with someone found by name', async () => {
    const { fetch, calls } = service();
    const el = await mounted(fetch);
    button(el, 'Share')!.click();
    await settle(el);
    const share = el.querySelector('folio-share')!;
    expect(el.querySelector('ui-dialog')!.getAttribute('heading')).toBe('Who can see Policies');
    expect(share.querySelector('.folio-share-floor')!.textContent).toContain('Everyone on Finance, and the teams below it, can read it');
    const shared = () => [...share.querySelectorAll<UiList>('ui-list')].at(-1)!.items;
    expect(shared().map((i) => [i.title, i.meta])).toEqual([['Kim Lee', 'Can read']]);

    share.querySelector<UiTextField>('ui-text-field')!.dispatchEvent(new CustomEvent('ui-input', { detail: { value: 'ol' } }));
    await new Promise((r) => setTimeout(r, 250));
    await settle(el);
    const found = share.querySelector<UiList>('ui-list')!;
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
    share.querySelector<UiTextField>('ui-text-field')!.dispatchEvent(new CustomEvent('ui-input', { detail: { value: 'leg' } }));
    await new Promise((r) => setTimeout(r, 250));
    await settle(el);
    const teams = share.querySelector<UiList>('ui-list')!;
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

  it('lets someone who only reads see who can, without changing it', async () => {
    const { fetch } = service({ lead: false });
    const el = await mounted(fetch);
    expect(button(el, 'Share')).toBeUndefined();
    button(el, 'Who can see it')!.click();
    await settle(el);
    const share = el.querySelector('folio-share')!;
    expect(share.querySelector('ui-text-field')).toBeNull();
    expect(share.querySelector<UiList>('ui-list')!.items[0].actions).toBeUndefined();
  });

  it('lists what was shared from other floors, and reads a document shared alone', async () => {
    const shared = {
      libraries: [{ ...reports, id: 'l-8', name: 'Board papers', level: 'read' }],
      documents: [{ ...travel, id: 'd-9', library: 'l-9', title: 'Shared plan', libraryName: 'Ops runbooks', level: 'read' }],
    };
    window.history.replaceState(null, '', '/@finance/folio/libraries');
    const { fetch } = service({ shared });
    const el = await mounted(fetch);
    const rail = trees(el).find((t) => t.heading === 'Shared with you')!;
    expect(rail.items.map((i) => i.label)).toEqual(['Board papers', 'Shared plan']);
    rail.dispatchEvent(new CustomEvent('ui-select', { detail: { item: rail.items[1] } }));
    await settle(el);
    expect(window.location.pathname).toBe('/@finance/folio/libraries/l-9/documents/d-9');
    const reader = el.querySelector('folio-reader')!;
    expect(reader.querySelector('.folio-crumb')!.textContent).toContain('Ops runbooks');
    expect(button(reader, 'Who can see it')).toBeDefined();
    // Back has no library to go to: the floor's own first one.
    reader.querySelector<HTMLButtonElement>('.folio-crumb')!.click();
    await settle(el);
    expect(el.querySelector('ui-heading')!.getAttribute('heading')).toBe('Policies');
  });

  it('opens a document shared alone straight from its path', async () => {
    const shared = { libraries: [], documents: [{ ...travel, id: 'd-9', library: 'l-9', title: 'Shared plan', libraryName: 'Ops runbooks', level: 'read' }] };
    const { fetch } = service({ shared });
    const el = await mounted(fetch, '/libraries/l-9/documents/d-9');
    expect(el.querySelector('folio-reader h1')!.textContent).toBe('Shared plan');
  });

  it('publishes a version to the floor’s team and those below it, and withdraws it', async () => {
    const { fetch, calls } = service({ documents: [travel] });
    const el = await mounted(fetch);
    list(el).dispatchEvent(new CustomEvent('ui-open', { detail: { item: { id: 'doc:d-1' } } }));
    await settle(el);
    const reader = el.querySelector('folio-reader')!;
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
    expect(el.querySelector('ui-heading')!.getAttribute('heading')).toBe('Published to you');
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
    const rail = trees(el).find((t) => t.heading === 'Series')!;
    expect(rail.items.map((i) => [i.label, i.icon])).toEqual([['Cash report', 'series']]);
    rail.dispatchEvent(new CustomEvent('ui-select', { detail: { item: rail.items[0] } }));
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
    button(el, 'New series')!.click();
    await settle(el);
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
    const reader = el.querySelector('folio-reader')!;
    expect(reader.querySelector('.folio-reader-series')!.textContent!.replace(/\s+/g, ' ')).toContain('Issue 1, Week 42, 2026, in Cash report');
    expect(button(reader, 'Previous: Week 41, 2026')).toBeUndefined();
    button(reader, 'Next: Week 43, 2026')!.click();
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
