import { createEventBus, type MountContext, type Workspace } from '@augur/mfe-sdk';
import type { UiDialog, UiList, UiTree } from '@augur/ui-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathFor, placeFor } from './api.js';
import app, { addressFor } from './entry.js';
import { folderTrail, folderTree, type FolioApp } from './folio-app.js';

const floor: Workspace = { id: 'w-fin', kind: 'team', name: 'Finance', slug: 'finance', path: [], role: 'lead' };
const policies = { id: 'l-1', workspace: 'w-fin', name: 'Policies', description: 'How we work', createdBy: 'u1', createdAt: '', updatedAt: '' };
const reports = { ...policies, id: 'l-2', name: 'Reports', description: '' };
const hr = { id: 'f-hr', library: 'l-1', name: 'HR', createdBy: 'u1', createdAt: '' };
const leave = { id: 'f-leave', library: 'l-1', parent: 'f-hr', name: 'Leave', createdBy: 'u2', createdAt: '' };
const it_ = { id: 'f-it', library: 'l-1', name: 'IT', createdBy: 'u2', createdAt: '' };

/** A stand-in for Folio's service, answering what the app asks through ctx.fetch. */
const service = ({ lead = true, libraries = [policies, reports], folders = [hr, leave, it_] } = {}) => {
  const calls: [string, string, unknown?][] = [];
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push(body ? [method, path, body] : [method, path]);
    const route = path.replace('/api/folio/v1', '');
    if (method === 'GET' && route === '/libraries') return Response.json({ libraries, can: { create: lead } });
    const one = route.match(/^\/libraries\/([^/]+)$/);
    if (method === 'GET' && one) {
      const lib = libraries.find((l) => l.id === one[1]);
      return lib ? Response.json({ ...lib, folders: lib.id === 'l-1' ? folders : [], can: { manage: lead, addFolders: true } }) : Response.json({ message: 'Not here' }, { status: 404 });
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
  it('opens the floor’s first library, with its libraries and folders in the side rail', async () => {
    const { fetch, calls } = service();
    const el = await mounted(fetch);
    expect(calls.map(([m, p]) => `${m} ${p}`)).toEqual(['GET /api/folio/v1/libraries', 'GET /api/folio/v1/libraries/l-1']);
    const [libs, folders] = trees(el);
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
});
