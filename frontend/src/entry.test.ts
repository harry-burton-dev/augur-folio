import { createEventBus, type MountContext, type Workspace } from '@augur/mfe-sdk';
import type { UiDialog, UiFilterBar, UiList, UiTagPicker, UiTree } from '@augur/ui-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathFor, placeFor, type ReaderState } from './api.js';
import app, { addressFor } from './entry.js';
import { folderTrail, folderTree, type FolioApp } from './folio-app.js';

const floor: Workspace = { id: 'w-fin', kind: 'team', name: 'Finance', slug: 'finance', path: [], role: 'lead' };
const policies = { id: 'l-1', workspace: 'w-fin', name: 'Policies', description: 'How we work', freeTags: false, createdBy: 'u1', createdAt: '', updatedAt: '' };
const reports = { ...policies, id: 'l-2', name: 'Reports', description: '' };
const hr = { id: 'f-hr', library: 'l-1', name: 'HR', createdBy: 'u1', createdAt: '' };
const leave = { id: 'f-leave', library: 'l-1', parent: 'f-hr', name: 'Leave', createdBy: 'u2', createdAt: '' };
const it_ = { id: 'f-it', library: 'l-1', name: 'IT', createdBy: 'u2', createdAt: '' };
const READY = { state: 'ready', pages: 3, thumbnail: true } as ReaderState;
const DAMAGED = { state: 'failed', error: 'The file is damaged.', thumbnail: false } as ReaderState;
const v = (number: number, filename = 'travel.pdf', size = 1_234_567, reader = READY) => ({ id: `v-${number}`, document: 'd-1', number, filename, mediaType: 'application/pdf', size, sha256: 'ab', createdBy: 'u2', createdAt: new Date().toISOString(), reader });
const travel = { id: 'd-1', workspace: 'w-fin', library: 'l-1', title: 'Travel policy', createdBy: 'u2', createdAt: '', updatedAt: new Date().toISOString(), latest: v(2), tags: [] as string[], can: { change: true } };
const tag = (id: string, name: string, library?: string) => ({ id, workspace: library ? 'w-fin' : 'w-org', ...(library ? { library } : {}), name, createdBy: 'u1', createdAt: '' });
const policyTag = tag('t-pol', 'Policy');
const travelTag = tag('t-trv', 'Travel', 'l-1');
const leaveDoc = { ...travel, id: 'd-2', title: 'Annual leave', folder: 'f-leave', tags: ['t-pol'] };
const recent = { id: 'vw-1', library: 'l-1', name: 'Recent policy', query: { tags: ['t-pol'], sort: 'updated' }, createdBy: 'u1', createdAt: '' };

/** A stand-in for Folio's service, answering what the app asks through ctx.fetch. */
const service = ({ lead = true, libraries = [policies, reports], folders = [hr, leave, it_], documents = [] as (typeof travel & { folder?: string })[], views = [recent] as (typeof recent)[] } = {}) => {
  const calls: [string, string, unknown?][] = [];
  let retried = false;
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
      const found = documents.filter((d) => (params.get('below') ? true : d.folder === (params.get('folder') ?? undefined)) && tags.every((t) => d.tags.includes(t)));
      return Response.json({ documents: found, total: found.length });
    }
    if (method === 'PUT' && where === '/libraries/l-1/documents/d-1/tags') return Response.json({ ...travel, tags: body.tags });
    if (method === 'POST' && where === '/libraries/l-1/tags') return Response.json(tag('t-new', body.name, 'l-1'), { status: 201 });
    if (method === 'GET' && where === '/tags') return Response.json({ tags: [policyTag], can: { manage: false } });
    if (method === 'POST' && where === '/libraries/l-1/views') return Response.json({ ...recent, id: 'vw-new', name: body.name, query: body.query }, { status: 201 });
    if (method === 'PATCH' && where === '/libraries/l-1') return Response.json({ ...policies, ...body });
    if (method === 'POST' && where === '/libraries/l-1/documents') {
      if (params.get('filename') === 'big.pdf') return new Response('Payload Too Large', { status: 413 });
      return Response.json({ ...travel, id: 'd-new', title: params.get('filename'), latest: v(1, params.get('filename')!) }, { status: 201 });
    }
    if (method === 'GET' && where === '/libraries/l-1/documents/d-1') return Response.json({ ...travel, versions: [v(2), v(1, 'travel-old.pdf', 900, retried ? { state: 'queued', thumbnail: false } : DAMAGED)] });
    if (method === 'POST' && where === '/libraries/l-1/documents/d-1/versions/1/reader/retry') {
      retried = true;
      return Response.json({ state: 'queued', thumbnail: false }, { status: 202 });
    }
    if (method === 'GET' && where === '/libraries/l-1/documents/d-1/versions/1/original') return new Response('%PDF old', { headers: { 'content-type': 'application/pdf' } });
    if (method === 'POST' && where === '/libraries/l-1/documents/d-1/versions') return Response.json(v(3), { status: 201 });
    if (method === 'PATCH' && where === '/libraries/l-1/documents/d-1') return Response.json({ ...travel, ...body });
    if (method === 'DELETE' && where === '/libraries/l-1/documents/d-1') return new Response(null, { status: 204 });
    if (method === 'GET' && route === '/libraries') return Response.json({ libraries, can: { create: lead } });
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
            can: { manage: lead, addFolders: true, addDocuments: true, addTags: lead },
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
const trees = (el: HTMLElement) => [...el.querySelectorAll<UiTree>('ui-tree')];
const list = (el: HTMLElement) => el.querySelector<UiList>('ui-list')!;
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll<HTMLElement>('ui-button')].find((b) => b.textContent?.trim() === text);

afterEach(() => {
  document.body.innerHTML = '';
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
    list(el).dispatchEvent(new CustomEvent('ui-open', { detail: { item: { id: 'doc:d-1' } } }));
    await settle(el);
    button(el, 'Rename or move')!.click();
    await settle(el);
    let dialog = el.querySelector<UiDialog>('ui-dialog')!;
    expect(dialog.querySelector('ui-select')!.options.map((o) => (typeof o === 'string' ? o : o.label))).toEqual(['Policies (the top)', 'HR', 'HR / Leave', 'IT']);
    await dialog.submit!({ title: ' Travel ', folder: 'f-hr' }, dialog);
    expect(calls).toContainEqual(['PATCH', '/api/folio/v1/libraries/l-1/documents/d-1', { title: 'Travel', folder: 'f-hr' }]);
    list(el).dispatchEvent(new CustomEvent('ui-open', { detail: { item: { id: 'doc:d-1' } } }));
    await settle(el);
    button(el, 'Delete')!.click();
    await settle(el);
    dialog = el.querySelector<UiDialog>('ui-dialog')!;
    expect(dialog.heading).toBe('Delete Travel policy?');
    await dialog.submit!({}, dialog);
    await settle(el);
    expect(calls).toContainEqual(['DELETE', '/api/folio/v1/libraries/l-1/documents/d-1']);
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
    list(el).dispatchEvent(new CustomEvent('ui-open', { detail: { item: { id: 'doc:d-1' } } }));
    await settle(el);
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

  it('asks again for a reader copy that failed, and looks again until it is made', async () => {
    const App = customElements.get('folio-app') as unknown as { readerPollMs: number };
    App.readerPollMs = 10;
    const { fetch, calls } = service({ documents: [travel] });
    const el = await mounted(fetch);
    list(el).dispatchEvent(new CustomEvent('ui-open', { detail: { item: { id: 'doc:d-1' } } }));
    await settle(el);
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
    expect(calls.map(([m, p]) => `${m} ${p}`)).toEqual(['GET /api/folio/v1/libraries', 'GET /api/folio/v1/libraries/l-1', 'GET /api/folio/v1/libraries/l-1/documents?limit=100']);
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
    list(el).dispatchEvent(new CustomEvent('ui-open', { detail: { item: { id: 'doc:d-1' } } }));
    await settle(el);
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
});
