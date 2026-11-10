import type { AppContext, FrameState, Notice, RemoteElement, RemoteNode } from '@augur/mfe-sdk/sdk3';
import { describe, expect, it } from 'vitest';
import manifest from '../../manifest.json';
import start from './entry.js';

// The shell, as the app sees it from its worker: what it draws in each root, what it sets on its pane,
// the commands it handles and what it tells the person. Its `ctx.fetch` ends at `answer`, standing in
// for the gateway and the app's service.
const fakeShell = (answer: (path: string) => Response, surface: 'screen' | 'card' = 'screen') => {
  const shell = {
    screen: undefined as RemoteNode,
    about: new Map<string, RemoteNode>(),
    pane: {} as FrameState,
    commands: new Map<string, (detail?: unknown) => unknown>(),
    notified: [] as Notice[],
    fetched: [] as string[],
    card: undefined as RemoteNode,
    navigated: [] as string[],
  };
  const root = (put: (node: RemoteNode) => void) => ({ render: put, clear: () => put(null) });
  const ctx: AppContext = {
    person: { id: 'p1', name: 'Test Person' },
    workspace: { id: 'ws-me', kind: 'personal', name: 'You' },
    path: '/',
    surface,
    onNavigate: () => () => undefined,
    navigate: (path) => void shell.navigated.push(path),
    fetch: async (path) => {
      shell.fetched.push(path);
      return answer(path);
    },
    frame: {
      screen: root((node) => (shell.screen = node)),
      about: (id) => root((node) => shell.about.set(id, node)),
      card: root((node) => (shell.card = node)),
      set: (state) => Object.assign(shell.pane, state),
      under: () => undefined,
      onCommand: (id, handler) => {
        shell.commands.set(id, handler);
        return () => shell.commands.delete(id);
      },
    },
    files: { upload: async () => new Response(null, { status: 501 }), download: async () => undefined, onDrop: () => () => undefined },
    raise: async () => undefined,
    request: async () => Promise.reject(new Error('No app answers that here.')),
    notify: (notice) => void shell.notified.push(notice),
    previewOn: () => false,
  };
  return { ctx, shell };
};

const homeWith = (needsYou: { id: string; title: string; path: string; detail?: string }[] = [], latest: typeof needsYou = []) => () =>
  Response.json({ floor: { id: 'ws-me', kind: 'personal' }, needsYou, latest });
// Services answer every error as problem details (RFC 9457): `detail` is the sentence a person reads.
const refusal = (status: number, detail: string) => () =>
  Response.json({ type: 'about:blank', title: 'Forbidden', status, reason: 'forbidden', detail }, { status, headers: { 'content-type': 'application/problem+json' } });

/** Every element in a tree, depth first. */
const elements = (node: RemoteNode): RemoteElement[] =>
  Array.isArray(node) ? node.flatMap(elements) : node && typeof node === 'object' ? [node, ...elements(node.children)] : [];
const text = (node: RemoteNode) => JSON.stringify(node);
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('Artifacts', () => {
  it('opens Home from its own service through the gateway, what needs you first', async () => {
    const { ctx, shell } = fakeShell(homeWith([{ id: 'd1', title: 'Berth procedure', detail: 'Waiting for your review', path: '/documents/d1' }], [{ id: 'd2', title: 'New starters’ guide', path: '/documents/d2' }]));
    await start(ctx);
    await settle();
    expect(shell.fetched).toEqual([`/api/${manifest.id}/v1/home`]);
    expect(shell.pane.title).toBe('Home');
    const lists = elements(shell.screen).filter((e) => e.type === 'quill-list');
    expect(lists.map((l) => l.props!.label)).toEqual(['Needs you', 'New since you looked']);
    expect(text(lists[0])).toContain('Berth procedure');
    // It draws only Quill's remote vocabulary, by name.
    expect(elements(shell.screen).every((e) => e.type.startsWith('quill-'))).toBe(true);
    (lists[1]!.props!.onOpen as (id: string) => void)('d2');
    expect(shell.navigated).toEqual(['/documents/d2']);
  });

  it('says plainly when nothing needs you', async () => {
    const { ctx, shell } = fakeShell(homeWith());
    await start(ctx);
    await settle();
    expect(text(shell.screen)).toContain('Nothing needs you on this floor.');
  });

  it('says why when the service refuses, and tries again', async () => {
    const { ctx, shell } = fakeShell(refusal(403, 'Only this floor’s members can see it.'));
    await start(ctx);
    await settle();
    expect(text(shell.screen)).toContain('Only this floor’s members can see it.');
    const state = elements(shell.screen).find((e) => e.type === 'quill-state')!;
    (state.props!.onAction as () => void)();
    await settle();
    expect(shell.fetched).toHaveLength(2);
  });

  it('fills each About section its manifest declares', async () => {
    const { ctx, shell } = fakeShell(homeWith());
    await start(ctx);
    await settle();
    expect([...shell.about.keys()]).toEqual(manifest.contributes.about.map((a) => a.id));
    expect(text(shell.about.get('place'))).toContain(manifest.version);
  });

  it('fills its card on Home with how many need you and how many are new', async () => {
    const { ctx, shell } = fakeShell(homeWith([{ id: 'd1', title: 'Berth procedure', path: '/documents/d1' }]), 'card');
    await start(ctx);
    await settle();
    expect(shell.screen).toBeUndefined();
    expect(text(shell.card)).toContain('need you');
    expect(text(shell.card)).toContain('"value":1');
  });
});
