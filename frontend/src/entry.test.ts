import type { AppContext, FrameState, Notice, RemoteElement, RemoteNode } from '@augur/mfe-sdk/sdk3';
import { describe, expect, it } from 'vitest';
import manifest from '../../manifest.json';
import type { DocumentAnswer, DocumentView, FolderAnswer, LibraryAnswer, PlacementsAnswer, PlacementView, ReceivedAnswer, Rights, VersionView } from '../../service/src/api-types.js';
import start from './entry.js';
import { routeOf } from './routes.js';

// The shell, as the app sees it from its worker: what it draws in each root, what it sets on its pane,
// the commands it handles and what it tells the person. Its `ctx.fetch` ends at `service`, standing in
// for the gateway and the app's service, which answers by method and path.
type Service = (method: string, path: string, body?: unknown) => Response | undefined;

const fakeShell = (service: Service, { surface = 'screen', path = '/' }: { surface?: 'screen' | 'card'; path?: string } = {}) => {
  const shell = {
    screen: undefined as RemoteNode,
    about: new Map<string, RemoteNode>(),
    pane: {} as FrameState,
    under: new Map<string, unknown[]>(),
    commands: new Map<string, (detail?: unknown) => unknown>(),
    notified: [] as Notice[],
    calls: [] as string[],
    uploads: [] as { path: string; name: string }[],
    saved: [] as string[],
    card: undefined as RemoteNode,
    navigated: [] as string[],
    drop: undefined as undefined | ((files: File[]) => void | Promise<void>),
    moved: undefined as undefined | ((path: string) => void),
  };
  const answer = (method: string, path: string, body?: unknown) => {
    shell.calls.push(`${method} ${path}`);
    return service(method, path.replace(`/api/${manifest.id}/v1`, ''), body) ?? Response.json({ detail: `No such route in the test: ${method} ${path}` }, { status: 404 });
  };
  const root = (put: (node: RemoteNode) => void) => ({ render: put, clear: () => put(null) });
  // Cast: the SDK grows within a major, and the test fakes only what Artifacts uses.
  const ctx = {
    person: { id: 'u-tomas', name: 'Tomas Lindqvist' },
    workspace: { id: 'w-port', kind: 'team', name: 'Port operations' },
    path,
    surface,
    onNavigate: (fn: (path: string) => void) => {
      shell.moved = fn;
      return () => undefined;
    },
    navigate: (to: string) => {
      shell.navigated.push(to);
      shell.moved?.(to);
    },
    fetch: async (p: string, init?: RequestInit) => answer(init?.method ?? 'GET', p, init?.body ? JSON.parse(String(init.body)) : undefined),
    frame: {
      screen: root((node) => (shell.screen = node)),
      about: (id: string) => root((node) => shell.about.set(id, node)),
      card: root((node) => (shell.card = node)),
      set: (state: FrameState) => Object.assign(shell.pane, state),
      under: (place: string, items: unknown[]) => void shell.under.set(place, items),
      onCommand: (id: string, handler: (detail?: unknown) => unknown) => {
        shell.commands.set(id, handler);
        return () => shell.commands.delete(id);
      },
    },
    files: {
      upload: async (blob: Blob, p: string) => {
        shell.uploads.push({ path: p, name: (blob as File).name });
        return answer('POST', p.split('?')[0]!) ;
      },
      download: async (p: string) => void shell.saved.push(p),
      onDrop: (fn: (files: File[]) => void) => {
        shell.drop = fn;
        return () => undefined;
      },
    },
    raise: async () => undefined,
    request: async () => Promise.reject(new Error('No app answers that here.')),
    notify: (notice: Notice) => void shell.notified.push(notice),
    previewOn: () => false,
  } as unknown as AppContext;
  return { ctx, shell };
};

/** Every element in a tree, depth first. */
const elements = (node: RemoteNode): RemoteElement[] =>
  Array.isArray(node) ? node.flatMap(elements) : node && typeof node === 'object' ? [node, ...elements(node.children)] : [];
const find = (node: RemoteNode, type: string) => elements(node).filter((e) => e.type === type);
const text = (node: RemoteNode) => JSON.stringify(node);
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const fire = (el: RemoteElement | undefined, handler: string, detail?: unknown) => (el!.props![handler] as (d?: unknown) => void)(detail);

// The service's answers, as far as these tests need them.
const rights = (over: Partial<Rights> = {}): Rights => ({ level: 'edit', add: true, tag: true, manage: false, share: false, ...over });
const levels = ['collection', 'subcollection', 'series', 'subseries', 'file'].map((id) => ({ id, name: id === 'collection' ? 'Collection' : id[0]!.toUpperCase() + id.slice(1), plural: `${id}s`, holds: [] })) as LibraryAnswer['levels'];
const libraryAnswer = (over: Partial<LibraryAnswer> = {}): LibraryAnswer => ({
  floor: { id: 'w-port', kind: 'team' },
  freeTags: false,
  rights: rights(),
  levels,
  collections: [{ id: 'f-proc', level: 'collection', name: 'Procedures', description: '', state: 'open', tags: [], createdBy: 'u-lead', createdAt: '2026-11-01T09:00:00Z', updatedAt: '2026-11-01T09:00:00Z' }],
  ...over,
});
const folderAnswer: FolderAnswer = {
  folder: { id: 'f-berths', parent: 'f-proc', level: 'subcollection', name: 'Berths', description: 'How ships come alongside', state: 'open', tags: [], createdBy: 'u-lead', createdAt: '2026-11-01T09:00:00Z', updatedAt: '2026-11-01T09:00:00Z' },
  path: [
    { id: 'f-proc', name: 'Procedures', level: 'collection' },
    { id: 'f-berths', name: 'Berths', level: 'subcollection' },
  ],
  folders: [],
  rights: rights(),
  holds: ['series', 'file'],
  received: [],
};
const version = (number: number, over: Partial<VersionView> = {}): VersionView => ({ number, filename: `berth-procedure-v${number}.pdf`, mediaType: 'application/pdf', size: 52000, state: 'in-progress', createdBy: 'u-tomas', createdByName: 'Tomas Lindqvist', createdAt: '2026-11-02T10:00:00Z', reader: 'ready', thumbnail: true, ...over });
const documentView = (latest: VersionView): DocumentView => ({ id: 'd-berth', folder: 'f-berths', title: 'Berth procedure', tags: [], createdBy: 'u-tomas', createdAt: '2026-11-02T10:00:00Z', updatedAt: '2026-11-03T10:00:00Z', latest });
const documentAnswer = (over: Partial<DocumentAnswer> = {}): DocumentAnswer => ({
  floor: { id: 'w-port', kind: 'team' },
  document: documentView(version(2)),
  path: folderAnswer.path,
  versions: [version(2), version(1, { state: 'retired' })],
  moves: [{ version: 2, to: 'in-progress', by: 'u-tomas', byName: 'Tomas Lindqvist', at: '2026-11-03T10:00:00Z' }],
  rights: rights({ share: true, manage: true, level: 'manage' }),
  next: [
    { to: 'in-review', allowed: true },
    { to: 'issued', allowed: false, why: 'Only whoever manages it can do that.' },
  ],
  ...over,
});

const port = { id: 'w-port', kind: 'team' as const, name: 'Port Services', rank: 2 };
const ops = { id: 'w-ops', kind: 'team' as const, name: 'Operations', rank: 1 };
const org = { id: 'org', kind: 'org' as const, name: 'The org', rank: 0 };
const placement = (over: Partial<PlacementView> = {}): PlacementView => ({
  id: 'p-1',
  record: { kind: 'document', id: 'd-berth', name: 'Berth procedure', level: 'file' },
  from: port,
  to: ops,
  filter: ['complete', 'issued'],
  by: 'u-lead',
  byName: 'Ada Lead',
  at: '2026-11-04T10:00:00Z',
  can: { withdraw: true, land: false },
  ...over,
});
const placements = (over: Partial<PlacementsAnswer> = {}): PlacementsAnswer => ({
  record: { kind: 'document', id: 'd-berth', name: 'Berth procedure', level: 'file' },
  own: port,
  owner: port,
  placements: [],
  targets: [
    { from: port, to: ops },
    { from: port, to: org, why: 'Publishing to the org needs the publisher role, which an admin can give you.' },
  ],
  ...over,
});
const received = (over: Partial<ReceivedAnswer> = {}): ReceivedAnswer => ({
  here: [{ placement: placement({ can: { withdraw: true, land: true } }), states: ['complete', 'issued'], version: version(1, { state: 'issued' }) }],
  signposts: [],
  places: [{ id: 'f-ops-proc', label: 'Procedures', level: 'collection' }],
  ...over,
});

const theLibrary = (over: Record<string, () => Response> = {}): Service => (method, path) => {
  const key = `${method} ${path.split('?')[0]}`;
  if (over[key]) return over[key]!();
  switch (key) {
    case 'GET /home':
      return Response.json({ floor: { id: 'w-port', kind: 'team' }, needsYou: [{ id: 'd-berth/2', title: 'Berth procedure', detail: 'Version 2 is waiting for review.', path: '/documents/d-berth' }], latest: [] });
    case 'GET /library':
      return Response.json(libraryAnswer());
    case 'GET /folders/f-berths':
      return Response.json(folderAnswer);
    case 'GET /folders/f-berths/documents':
      return Response.json({ documents: [documentView(version(2))], total: 1 });
    case 'POST /folders/f-berths/documents':
      return Response.json(documentView(version(1)), { status: 201 });
    case 'GET /documents/d-berth':
      return Response.json(documentAnswer());
    case 'GET /documents/d-berth/versions/2/reader':
    case 'GET /documents/d-berth/versions/1/reader':
      return Response.json({ state: 'ready', markdown: '# Berth procedure\n\nShips come alongside on the flood.', retry: false });
    case 'GET /grants':
      return Response.json({ grants: [{ kind: 'document', record: 'd-berth', principal: 'person:u-hamid', name: 'Hamid Sadeghi', level: 'read', createdBy: 'u-lead', createdAt: '2026-11-03T10:00:00Z' }] });
    case 'POST /documents/d-berth/versions/2/state':
      return Response.json({ ok: true });
    case 'GET /people':
      return Response.json({ query: 'lu', items: [{ kind: 'person', id: 'u-lucia', name: 'Lucia Ferreira' }] });
    case 'PUT /grants':
      return Response.json({ ok: true });
    case 'GET /placements':
      return Response.json(placements());
    case 'POST /placements':
      return Response.json(placement(), { status: 201 });
    case 'GET /received':
      return Response.json(received({ here: [], places: [] }));
    case 'PUT /placements/p-1/landing':
      return Response.json(placement({ landed: { folder: 'f-ops-proc', name: 'Procedures' } }));
    case 'GET /documents/d-berth/links':
      return Response.json({
        kinds: [
          { id: 'relates-to', name: 'Relates to', inverse: 'Relates to', available: true },
          { id: 'supersedes', name: 'Supersedes', inverse: 'Superseded by', available: true },
          { id: 'about', name: 'About', inverse: 'Written about in', available: false, why: 'Saying what a document is about comes in the next version of Artifacts.' },
        ],
        links: [],
        back: [{ id: 'l-1', relation: 'supersedes', words: 'Superseded by', from: { app: 'folio', kind: 'document', id: 'd-new', label: 'Berth procedure 2027' }, by: 'u-tomas', at: '2026-11-04T10:00:00Z' }],
        can: { change: true },
      });
    case 'GET /search':
      return Response.json({ results: [{ id: 'd-old', title: 'Berth procedure 2025', detail: 'Procedures › Berths · Retired' }] });
    case 'POST /documents/d-berth/links':
      return Response.json({ id: 'l-2' }, { status: 201 });
    case 'GET /shared':
      return Response.json({ items: [{ kind: 'document', id: 'd-tide', title: 'Tide tables', floor: 'w-finance', level: 'read', path: '/documents/d-tide' }] });
  }
  return undefined;
};

describe('where a path leads', () => {
  it('reads the rail’s places, folders and documents, and nothing else', () => {
    expect(routeOf('/')).toEqual({ kind: 'home' });
    expect(routeOf('/library')).toEqual({ kind: 'library' });
    expect(routeOf('/folders/f-berths')).toEqual({ kind: 'folder', id: 'f-berths' });
    expect(routeOf('/documents/d-berth/versions/2')).toEqual({ kind: 'document', id: 'd-berth', version: 2 });
    expect(routeOf('/received/p-1/folders/f-berths')).toEqual({ kind: 'received', id: 'p-1', folder: 'f-berths' });
    expect(routeOf('/documents/d%2F..')).toEqual({ kind: 'missing', path: '/documents/d%2F..' });
  });
});

describe('Artifacts', () => {
  it('opens Home from its own service through the gateway, what needs you first', async () => {
    const { ctx, shell } = fakeShell(theLibrary());
    await start(ctx);
    await settle();
    expect(shell.calls).toContain(`GET /api/${manifest.id}/v1/home`);
    expect(shell.pane.title).toBe('Home');
    const lists = find(shell.screen, 'quill-list');
    expect(lists.map((l) => l.props!.label)).toEqual(['Needs you', 'New since you looked']);
    expect(text(lists[0])).toContain('Berth procedure');
    // It draws only Quill's remote vocabulary, by name.
    expect(elements(shell.screen).every((e) => e.type.startsWith('quill-'))).toBe(true);
    // The rail shows the library's collections under Library.
    expect(shell.under.get('library')).toEqual([{ label: 'Procedures', icon: 'library', path: '/folders/f-proc' }]);
    fire(lists[0], 'onOpen', 'd-berth/2');
    expect(shell.navigated).toEqual(['/documents/d-berth']);
  });

  it('says why when the service refuses, and tries again', async () => {
    const { ctx, shell } = fakeShell(theLibrary({ 'GET /home': () => Response.json({ detail: 'Only this floor’s members can see it.' }, { status: 403 }) }));
    await start(ctx);
    await settle();
    expect(text(shell.screen)).toContain('Only this floor’s members can see it.');
    fire(find(shell.screen, 'quill-state')[0], 'onAction');
    await settle();
    expect(shell.calls.filter((c) => c.endsWith('/home'))).toHaveLength(2);
  });

  it('walks the library: collections as tiles, and only the floor’s leads make them', async () => {
    const { ctx, shell } = fakeShell(theLibrary(), { path: '/library' });
    await start(ctx);
    await settle();
    const tiles = find(shell.screen, 'quill-kind-tile');
    expect(tiles.map((t) => t.props!.name)).toEqual(['Procedures']);
    expect(tiles[0]!.props!.thing).toEqual({ kind: 'collection', id: 'f-proc', label: 'Procedures' });
    expect(find(shell.screen, 'quill-add-tile')[0]!.props!.reason).toContain('leads');
    expect(shell.pane.actions).toEqual([{ command: 'collection.new', unavailable: 'Only the floor’s leads make collections.' }]);
    fire(tiles[0], 'onOpen');
    await settle();
    expect(shell.navigated).toEqual(['/folders/f-proc']);
  });

  it('shows a folder’s path, its documents as rows, and asks again when the filter changes', async () => {
    const { ctx, shell } = fakeShell(theLibrary(), { path: '/folders/f-berths' });
    await start(ctx);
    await settle();
    expect(shell.pane.title).toBe('Berths');
    const head = find(shell.screen, 'quill-page-head')[0]!;
    expect(head.props!.trail).toEqual([
      { id: 'library', label: 'Library' },
      { id: 'f-proc', label: 'Procedures' },
    ]);
    const rows = find(shell.screen, 'quill-list')[0]!;
    expect(rows.props!.items).toEqual([expect.objectContaining({ id: 'd-berth', title: 'Berth procedure', thing: { kind: 'document', id: 'd-berth', label: 'Berth procedure' } })]);
    expect(find(shell.screen, 'quill-add-tile')[0]!.props!.label).toBe('New series');
    fire(find(shell.screen, 'quill-filter-bar')[0], 'onChange', { value: { lifecycle: ['issued'] }, sort: 'title' });
    await settle();
    expect(shell.calls.at(-1)).toBe(`GET /api/${manifest.id}/v1/folders/f-berths/documents?sort=title&limit=200&lifecycle=issued`);
  });

  it('adds each file dropped on a folder as a document there', async () => {
    const { ctx, shell } = fakeShell(theLibrary(), { path: '/folders/f-berths' });
    await start(ctx);
    await settle();
    await shell.drop!([new File(['a'], 'Mooring lines.pdf', { type: 'application/pdf' }), new File(['b'], 'Pilots.docx')]);
    await settle();
    expect(shell.uploads.map((u) => u.path)).toEqual([
      `/api/${manifest.id}/v1/folders/f-berths/documents?filename=Mooring%20lines.pdf`,
      `/api/${manifest.id}/v1/folders/f-berths/documents?filename=Pilots.docx`,
    ]);
    expect(shell.notified.at(-1)?.title).toBe('Added 2 documents.');
  });

  it('reads a document, with its versions under it and its facts in About', async () => {
    const { ctx, shell } = fakeShell(theLibrary(), { path: '/documents/d-berth' });
    await start(ctx);
    await settle();
    expect(shell.pane.title).toBe('Berth procedure');
    expect(shell.pane.width).toBe('read');
    expect(find(shell.screen, 'quill-reader')[0]!.props).toMatchObject({ markdown: expect.stringContaining('on the flood'), title: 'Berth procedure' });
    expect(find(shell.screen, 'quill-page-head')[0]!.props!.eyebrow).toBe('In progress · version 2');
    expect(text(find(shell.screen, 'quill-section')[0])).toContain('Version 1');
    expect(text(shell.about.get('lifecycle'))).toContain('In progress');
    expect(text(shell.about.get('place'))).toContain('Port operations');
    expect(text(shell.about.get('access'))).toContain('Hamid Sadeghi');
    expect(find(shell.about.get('floors'), 'quill-floor-path')[0]!.props!.floors).toEqual([expect.objectContaining({ name: 'Port Services', owner: true, here: true, line: 'Kept here' })]);
    expect(shell.pane.actions).toContainEqual({ command: 'document.publish' });
  });

  it('publishes up through a dialog that lists every floor above, with why for any it can’t reach', async () => {
    const { ctx, shell } = fakeShell(theLibrary(), { path: '/documents/d-berth' });
    await start(ctx);
    await settle();
    await shell.commands.get('document.publish')!();
    await settle();
    const dialog = find(shell.screen, 'quill-dialog')[0]!;
    expect(dialog.props!.heading).toBe('Publish “Berth procedure” up');
    expect(find(dialog, 'quill-choice')[0]!.props).toMatchObject({
      value: 'w-ops',
      options: [
        { value: 'w-ops', label: 'Operations' },
        { value: 'org', label: 'The org', disabled: true, reason: expect.stringContaining('publisher role') },
      ],
    });
    expect(find(dialog, 'quill-checkbox-group')[0]!.props!.value).toEqual(['complete', 'issued']);
    fire(find(dialog, 'quill-checkbox-group')[0], 'onChange', ['issued']);
    fire(dialog, 'onSubmit', {});
    await settle();
    expect(shell.calls).toContain(`POST /api/${manifest.id}/v1/placements`);
    expect(shell.notified.at(-1)?.title).toBe('Published “Berth procedure” up to Operations.');
  });

  it('lists what came up from below, and its leads give it a place', async () => {
    const { ctx, shell } = fakeShell(theLibrary({ 'GET /received': () => Response.json(received()) }), { path: '/below' });
    await start(ctx);
    await settle();
    const waiting = find(shell.screen, 'quill-list')[0]!;
    expect(waiting.props!.items).toEqual([expect.objectContaining({ id: 'p-1', title: 'Berth procedure', detail: 'From Port Services · Issued, version 1', actions: [{ id: 'land', label: 'Give it a place' }] })]);
    fire(waiting, 'onAction', { item: 'p-1', action: 'land' });
    await settle();
    const dialog = find(shell.screen, 'quill-dialog')[0]!;
    expect(find(dialog, 'quill-choice')[0]!.props!.options).toEqual([expect.objectContaining({ value: 'f-ops-proc', label: 'Procedures' }), { value: '', label: 'Leave it under From below' }]);
    fire(dialog, 'onSubmit', { folder: 'f-ops-proc' });
    await settle();
    expect(shell.calls).toContain(`PUT /api/${manifest.id}/v1/placements/p-1/landing`);
    expect(shell.notified.at(-1)?.title).toBe('“Berth procedure” is in Procedures now.');
    fire(find(shell.screen, 'quill-list')[0], 'onOpen', 'p-1');
    expect(shell.navigated.at(-1)).toBe('/documents/d-berth');
  });

  it('links a document to another found by title, and shows the links back to it', async () => {
    const { ctx, shell } = fakeShell(theLibrary(), { path: '/documents/d-berth' });
    await start(ctx);
    await settle();
    expect(text(shell.about.get('links'))).toContain('Superseded by Berth procedure 2027');
    expect(text(shell.about.get('links'))).toContain('About: Saying what a document is about');
    await shell.commands.get('document.link')!();
    await settle();
    let dialog = find(shell.screen, 'quill-dialog')[0]!;
    expect(find(dialog, 'quill-choice')[0]!.props!.options).toContainEqual(expect.objectContaining({ value: 'about', disabled: true }));
    fire(find(dialog, 'quill-choice')[0], 'onChange', 'supersedes');
    fire(find(dialog, 'quill-text-field')[0], 'onCommit', '2025');
    await settle();
    dialog = find(shell.screen, 'quill-dialog')[0]!;
    fire(find(dialog, 'quill-choice')[1], 'onChange', 'd-old');
    fire(dialog, 'onSubmit', {});
    await settle();
    expect(shell.calls).toContain(`POST /api/${manifest.id}/v1/documents/d-berth/links`);
    expect(shell.notified.at(-1)?.title).toBe('Linked “Berth procedure”.');
  });

  it('shows a signpost on the floor below where its one place is higher up', async () => {
    const placed = { placement: 'p-1', to: ops, landed: 'Procedures' };
    const { ctx, shell } = fakeShell(theLibrary({ 'GET /folders/f-berths/documents': () => Response.json({ documents: [{ ...documentView(version(1)), placed }], total: 1 }) }), { path: '/folders/f-berths' });
    await start(ctx);
    await settle();
    expect((find(shell.screen, 'quill-list')[0]!.props!.items as unknown[])[0]).toMatchObject({ meta: 'Its place is on Operations, in Procedures' });
  });

  it('says what is happening when its copy to read isn’t made yet, and offers the original', async () => {
    const { ctx, shell } = fakeShell(
      theLibrary({ 'GET /documents/d-berth/versions/2/reader': () => Response.json({ state: 'none', why: 'Artifacts can’t show a .xlsx file here.', retry: false }) }),
      { path: '/documents/d-berth' },
    );
    await start(ctx);
    await settle();
    const state = find(shell.screen, 'quill-state')[0]!;
    expect(state.props).toMatchObject({ kind: 'empty', body: 'Artifacts can’t show a .xlsx file here.', action: 'Download berth-procedure-v2.pdf' });
    fire(state, 'onAction');
    await settle();
    expect(shell.saved).toEqual([`/api/${manifest.id}/v1/documents/d-berth/versions/2/file`]);
  });

  it('moves the newest version along, offering only the moves the person can make', async () => {
    const { ctx, shell } = fakeShell(theLibrary(), { path: '/documents/d-berth' });
    await start(ctx);
    await settle();
    await shell.commands.get('document.move')!();
    await settle();
    const dialog = find(shell.screen, 'quill-dialog')[0]!;
    expect(dialog.props!.heading).toBe('Move version 2 to…');
    const choice = find(dialog, 'quill-choice')[0]!;
    expect(choice.props!.options).toEqual([
      expect.objectContaining({ value: 'in-review', label: 'In review' }),
      expect.objectContaining({ value: 'issued', disabled: true, reason: 'Only whoever manages it can do that.' }),
    ]);
    fire(dialog, 'onSubmit', { to: 'in-review', note: 'Ready for Ada' });
    await settle();
    expect(shell.calls).toContain(`POST /api/${manifest.id}/v1/documents/d-berth/versions/2/state`);
    expect(find(shell.screen, 'quill-dialog')).toEqual([]);
  });

  it('shares a document with someone found by name', async () => {
    const { ctx, shell } = fakeShell(theLibrary(), { path: '/documents/d-berth' });
    await start(ctx);
    await settle();
    await shell.commands.get('document.share')!();
    await settle();
    let picker = find(shell.screen, 'quill-people-picker')[0]!;
    fire(picker, 'onQuery', 'lu');
    await settle();
    picker = find(shell.screen, 'quill-people-picker')[0]!;
    expect(picker.props!.found).toEqual({ query: 'lu', items: [{ kind: 'person', id: 'u-lucia', name: 'Lucia Ferreira' }] });
    fire(picker, 'onChange', [{ kind: 'person', id: 'u-lucia', name: 'Lucia Ferreira' }]);
    fire(find(shell.screen, 'quill-dialog')[0], 'onSubmit', { level: 'read' });
    await settle();
    expect(shell.calls).toContain(`PUT /api/${manifest.id}/v1/grants`);
    expect(shell.notified.at(-1)?.title).toBe('Shared “Berth procedure” with Lucia Ferreira.');
  });

  it('runs a radial command on the thing it was opened on', async () => {
    const { ctx, shell } = fakeShell(theLibrary(), { path: '/folders/f-berths' });
    await start(ctx);
    await settle();
    shell.commands.get('document.open')!({ thing: { kind: 'document', id: 'd-berth', label: 'Berth procedure' } });
    await settle();
    expect(shell.navigated).toEqual(['/documents/d-berth']);
  });

  it('lists what other floors shared, and says plainly that nothing came from below yet', async () => {
    const { ctx, shell } = fakeShell(theLibrary(), { path: '/shared' });
    await start(ctx);
    await settle();
    expect(text(shell.screen)).toContain('Tide tables');
    shell.moved!('/below');
    await settle();
    expect(text(shell.screen)).toContain('Nothing has been published up to this floor yet.');
  });

  it('fills each About section its manifest declares', async () => {
    const { ctx, shell } = fakeShell(theLibrary());
    await start(ctx);
    await settle();
    expect([...shell.about.keys()]).toEqual(manifest.contributes.about.map((a) => a.id));
    expect(text(shell.about.get('place'))).toContain(manifest.version);
  });

  it('fills its card on Home with how many need you and how many are new', async () => {
    const { ctx, shell } = fakeShell(theLibrary(), { surface: 'card' });
    await start(ctx);
    await settle();
    expect(shell.screen).toBeUndefined();
    expect(text(shell.card)).toContain('need you');
    expect(text(shell.card)).toContain('"value":1');
  });
});
