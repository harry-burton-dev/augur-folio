import { defineApp, type AppContext, type FrameAction, type RemoteNode } from '@augur/mfe-sdk/sdk3';
import manifest from '../../manifest.json';
import type {
  ContentState,
  DocumentAnswer,
  DocumentPage,
  FolderAnswer,
  FolderLevel,
  GrantView,
  Home,
  LevelInfo,
  LibraryAnswer,
  PeopleAnswer,
  PlacementsAnswer,
  PlacementView,
  ReaderAnswer,
  ReceivedAnswer,
  ReceivedFolderAnswer,
  ReceivedItem,
  RecordKind,
  SharedItem,
} from '../../service/src/api-types.js';
import { apiFor, Refused } from './api.js';
import { dialogFor, targetKey, type Dialog, type Principal } from './dialogs.js';
import { accessAbout, documentScreen, floorsAbout, lifecycleAbout, linksAbout, placeAbout, shownVersion, type DocumentData } from './document.js';
import { belowScreen, DEFAULT_FILTER, folderScreen, libraryScreen, receivedFolderScreen, sharedScreen, type FolderData, type Load, type RowFilter } from './library.js';
import { pathOf, routeOf, type Route } from './routes.js';
import { card, floorFacts, home, nothingOpen, type Asked } from './screen.js';

/**
 * What the shell runs in Artifacts' worker (the manifest's `frontend.entry`): `start(ctx)`, once, with
 * the person, the floor and the calls the bridge carries. The shell draws the app bar, the rail (Home,
 * Library with its collections under it, Shared with you, From below) and the About panel from the
 * manifest; Artifacts fills the screen, its pane's title and actions, and its About sections. A new floor
 * starts the worker again.
 */

/** How often a reader copy still being made is asked after, and for how long. */
const READER_POLL_MS = 4000;
const READER_POLLS = 45;

const whyOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What a new placement shows at first: what's finished. */
const FIRST_FILTER: ContentState[] = ['complete', 'issued'];

export const startArtifacts = (ctx: AppContext) => {
  const api = apiFor(ctx);
  let route: Route = routeOf(ctx.path);
  let homeAsked: Asked = { kind: 'asking' };
  let library: Load<LibraryAnswer> = { kind: 'asking' };
  let folder: Load<FolderData> = { kind: 'asking' };
  let filter: RowFilter = DEFAULT_FILTER;
  let doc: Load<DocumentData> = { kind: 'asking' };
  let shared: Load<SharedItem[]> = { kind: 'asking' };
  let below: Load<ReceivedAnswer> = { kind: 'asking' };
  let received: Load<ReceivedFolderAnswer> = { kind: 'asking' };
  let dialog: Dialog | undefined;
  /** Each load counts up, so an answer to a screen the person has left is dropped. */
  let turn = 0;
  let poll: ReturnType<typeof setTimeout> | undefined;

  const levels = (): LevelInfo[] => (library.kind === 'answered' ? library.value.levels : []);
  const go = (to: Route) => ctx.navigate(pathOf(to));

  // Drawing

  const unavailable = (why: string | undefined, ok: boolean) => (ok ? {} : { unavailable: why ?? 'You can’t do that here.' });

  const actions = (): FrameAction[] => {
    if (route.kind === 'library' && library.kind === 'answered')
      return [{ command: 'collection.new', ...unavailable(`Only the floor’s leads make collections.`, library.value.rights.manage) }];
    if (route.kind === 'folder' && folder.kind === 'answered') return [{ command: 'document.add', ...unavailable(folder.value.folder.rights.why, folder.value.folder.rights.add) }];
    if (route.kind === 'document' && doc.kind === 'answered') {
      const { rights } = doc.value.answer;
      return [
        { command: 'document.move', ...unavailable(rights.why, rights.level !== 'read') },
        { command: 'document.share', ...unavailable(rights.why, rights.share) },
        { command: 'document.download' },
        { command: 'document.add', label: 'Add a version', ...unavailable(rights.why, rights.add) },
        { command: 'document.publish', ...unavailable(publishWhy(doc.value.placements), Boolean(doc.value.placements?.targets.some((t) => !t.why))) },
      ];
    }
    return [];
  };

  /** Why it can't be published up from here, for the action that says so. */
  const publishWhy = (up: PlacementsAnswer | undefined) =>
    !up ? 'Its steps up the floors couldn’t be asked for. Try again in a moment.' : !up.targets.length ? 'Only whoever manages it publishes it up, from its own floor, or the leads of a floor that received it.' : (up.targets[0]?.why ?? 'It’s on every floor above it can reach.');

  const title = () => {
    switch (route.kind) {
      case 'home':
        return 'Home';
      case 'library':
        return 'Library';
      case 'folder':
        return folder.kind === 'answered' ? folder.value.folder.folder.name : 'Library';
      case 'document':
        return doc.kind === 'answered' ? doc.value.answer.document.title : 'Document';
      case 'shared':
        return 'Shared with you';
      case 'below':
        return 'From below';
      case 'received':
        return received.kind === 'answered' ? received.value.folder.name : 'From below';
      case 'missing':
        return manifest.name;
    }
  };

  const screen = (): RemoteNode => {
    switch (route.kind) {
      case 'home':
        return home(homeAsked, { retry: () => void open(), open: (item) => ctx.navigate(item.path) });
      case 'library':
        return libraryScreen(library, { retry: () => void open(), open: (id) => go({ kind: 'folder', id }), newFolder: () => void newFolder() });
      case 'folder':
        return folderScreen(folder, filter, {
          retry: () => void open(),
          open: (id) => go({ kind: 'folder', id }),
          newFolder: () => void newFolder(),
          trail: (id) => go(id === 'library' ? { kind: 'library' } : { kind: 'folder', id }),
          filter: (f) => {
            filter = f;
            void loadFolder(route.kind === 'folder' ? route.id : '', turn);
          },
          openDocument: (id) => go({ kind: 'document', id }),
          add: () => void addFiles(),
          openReceived: (item) => openReceived(item),
          land: (item) => void land(item),
        });
      case 'document':
        return documentScreen(doc, {
          retry: () => void open(),
          trail: (id) => go(id === 'library' ? { kind: 'library' } : { kind: 'folder', id }),
          version: (number) => route.kind === 'document' && go({ kind: 'document', id: route.id, version: number }),
          download: () => void download(),
          readAgain: () => void readAgain(),
        });
      case 'shared':
        return sharedScreen(shared, { retry: () => void open(), open: (item) => ctx.navigate(item.path) });
      case 'below':
        return belowScreen(below, {
          retry: () => void open(),
          open: (item) => openReceived(item),
          land: (item) => void land(item),
          signpost: (_placement, kind, id) => (kind === 'document' ? go({ kind: 'document', id }) : say('Its place is on a floor higher up.', 'Open it from that floor’s From below or library.')),
        });
      case 'received':
        return receivedFolderScreen(received, levels(), {
          retry: () => void open(),
          trail: (id) => (id === 'below' ? go({ kind: 'below' }) : route.kind === 'received' && go({ kind: 'received', id: route.id, folder: id })),
          open: (folder) => route.kind === 'received' && go({ kind: 'received', id: route.id, folder }),
          openDocument: (id) => go({ kind: 'document', id }),
        });
      case 'missing':
        return [
          { type: 'quill-state', props: { kind: 'empty', heading: 'There’s nothing at this address.', body: 'It may have moved, or been deleted.', action: 'Go to the library', size: 'region', onAction: () => go({ kind: 'library' }) } },
        ];
    }
  };

  const about = () => {
    for (const section of manifest.contributes.about) {
      const root = ctx.frame.about(section.id);
      if (route.kind !== 'document' || doc.kind !== 'answered') {
        root.render(section.id === 'place' && route.kind !== 'document' ? floorFacts(ctx) : nothingOpen(section.label));
        continue;
      }
      const data = doc.value;
      if (section.id === 'lifecycle') root.render(lifecycleAbout(data));
      else if (section.id === 'place') root.render(placeAbout(data, ctx.workspace));
      else if (section.id === 'access') root.render(accessAbout(data, ctx.workspace, () => void share()));
      else if (section.id === 'floors') root.render(floorsAbout(data, ctx.workspace, () => void publish()));
      else if (section.id === 'links') root.render(linksAbout());
    }
  };

  const draw = () => {
    ctx.frame.set({ title: title(), actions: actions(), width: route.kind === 'document' ? 'read' : 'wide' });
    ctx.frame.screen.render([screen(), dialogFor(dialog, levels(), dialogOn)]);
    about();
  };

  // Loading

  const loadLibrary = async () => {
    try {
      library = { kind: 'answered', value: await api.get<LibraryAnswer>('/library') };
      // The rail shows the collections under Library.
      ctx.frame.under(
        'library',
        library.value.collections.map((c) => ({ label: c.name, icon: 'library', path: `/folders/${c.id}` })),
      );
    } catch (err) {
      library = { kind: 'failed', why: whyOf(err) };
    }
  };

  const loadFolder = async (id: string, at: number) => {
    const q = new URLSearchParams({ sort: filter.sort, limit: '200' });
    if (filter.lifecycle.length) q.set('lifecycle', filter.lifecycle.join(','));
    try {
      const [answer, page] = await Promise.all([api.get<FolderAnswer>(`/folders/${encodeURIComponent(id)}`), api.get<DocumentPage>(`/folders/${encodeURIComponent(id)}/documents?${q}`)]);
      if (at !== turn) return;
      folder = { kind: 'answered', value: { folder: answer, page, levels: levels() } };
    } catch (err) {
      if (at !== turn) return;
      folder = { kind: 'failed', why: whyOf(err) };
    }
    draw();
  };

  const loadDocument = async (id: string, number: number | undefined, at: number) => {
    try {
      const answer = await api.get<DocumentAnswer>(`/documents/${encodeURIComponent(id)}`);
      const version = shownVersion(answer, number);
      if (!version) throw new Error(`This document has no version ${number}.`);
      const [reader, grants, placements] = await Promise.all([
        api.get<ReaderAnswer>(`/documents/${encodeURIComponent(id)}/versions/${version.number}/reader`),
        answer.rights.share ? api.get<{ grants: GrantView[] }>(`/grants?kind=document&record=${encodeURIComponent(id)}`).then((g) => g.grants) : Promise.resolve([]),
        api.get<PlacementsAnswer>(`/placements?kind=document&record=${encodeURIComponent(id)}`).catch(() => undefined),
      ]);
      if (at !== turn) return;
      doc = { kind: 'answered', value: { answer, version, reader, grants, ...(placements ? { placements } : {}) } };
      if (reader.state === 'queued' || reader.state === 'working') watchReader(id, version.number, at, 0);
    } catch (err) {
      if (at !== turn) return;
      doc = { kind: 'failed', why: whyOf(err) };
    }
    draw();
  };

  /** Asks after a copy still being made, until it's ready or the person leaves. */
  const watchReader = (id: string, number: number, at: number, n: number) => {
    if (n >= READER_POLLS) return;
    poll = setTimeout(async () => {
      if (at !== turn || doc.kind !== 'answered') return;
      try {
        const reader = await api.get<ReaderAnswer>(`/documents/${encodeURIComponent(id)}/versions/${number}/reader`);
        if (at !== turn || doc.kind !== 'answered') return;
        doc = { kind: 'answered', value: { ...doc.value, reader } };
        draw();
        if (reader.state === 'queued' || reader.state === 'working') watchReader(id, number, at, n + 1);
      } catch {
        watchReader(id, number, at, n + 1);
      }
    }, READER_POLL_MS);
  };

  /** Opens the screen for the route the host is at: everything it shows is asked for afresh. */
  const open = async () => {
    const at = ++turn;
    clearTimeout(poll);
    dialog = undefined;
    draw();
    switch (route.kind) {
      case 'home':
        homeAsked = { kind: 'asking' };
        try {
          homeAsked = { kind: 'answered', home: await api.get<Home>('/home') };
        } catch (err) {
          homeAsked = { kind: 'failed', why: whyOf(err) };
        }
        if (at === turn) draw();
        return;
      case 'library':
        library = { kind: 'asking' };
        draw();
        await loadLibrary();
        if (at === turn) draw();
        return;
      case 'folder':
        folder = { kind: 'asking' };
        draw();
        if (library.kind !== 'answered') await loadLibrary();
        return loadFolder(route.id, at);
      case 'document':
        doc = { kind: 'asking' };
        draw();
        if (library.kind !== 'answered') await loadLibrary();
        return loadDocument(route.id, route.version, at);
      case 'shared':
        shared = { kind: 'asking' };
        draw();
        try {
          shared = { kind: 'answered', value: (await api.get<{ items: SharedItem[] }>('/shared')).items };
        } catch (err) {
          shared = { kind: 'failed', why: whyOf(err) };
        }
        if (at === turn) draw();
        return;
      case 'below':
        below = { kind: 'asking' };
        draw();
        try {
          below = { kind: 'answered', value: await api.get<ReceivedAnswer>('/received') };
        } catch (err) {
          below = { kind: 'failed', why: whyOf(err) };
        }
        if (at === turn) draw();
        return;
      case 'received': {
        received = { kind: 'asking' };
        draw();
        if (library.kind !== 'answered') await loadLibrary();
        const q = route.folder ? `?folder=${encodeURIComponent(route.folder)}` : '';
        try {
          const value = await api.get<ReceivedFolderAnswer>(`/received/${encodeURIComponent(route.id)}${q}`);
          if (at === turn) received = { kind: 'answered', value };
        } catch (err) {
          if (at === turn) received = { kind: 'failed', why: whyOf(err) };
        }
        if (at === turn) draw();
        return;
      }
      default:
        draw();
    }
  };

  /** Draws the screen again from the service, keeping the route, after a change. */
  const refresh = () => {
    const at = ++turn;
    if (route.kind === 'folder') return loadFolder(route.id, at);
    if (route.kind === 'document') return loadDocument(route.id, route.version, at);
    return open();
  };

  // Doing

  const say = (title: string, body?: string) => ctx.notify({ title, ...(body ? { body } : {}) });

  /** A new folder in `parent` (the folder on screen when none is said), or a collection at the top with `top`. */
  const newFolder = async (parent?: string, top = false) => {
    const inFolder = top ? undefined : (parent ?? (route.kind === 'folder' && folder.kind === 'answered' ? folder.value.folder.folder.id : undefined));
    let holds: FolderLevel[] = ['collection'];
    if (inFolder) {
      try {
        const answer = folder.kind === 'answered' && folder.value.folder.folder.id === inFolder ? folder.value.folder : await api.get<FolderAnswer>(`/folders/${encodeURIComponent(inFolder)}`);
        if (!answer.rights.add) return say('You can’t add a folder here.', answer.rights.why);
        holds = answer.holds.filter((l): l is FolderLevel => l !== 'file');
      } catch (err) {
        return say('That folder couldn’t open.', whyOf(err));
      }
      if (!holds.length) return say('Nothing more goes inside this one.', 'It holds documents only.');
    } else if (library.kind === 'answered' && !library.value.rights.manage) return say('Only the floor’s leads make collections.');
    dialog = { kind: 'folder', ...(inFolder ? { parent: inFolder } : {}), levels: holds };
    draw();
  };

  const addFiles = () => {
    if (route.kind === 'folder' && folder.kind === 'answered') {
      const f = folder.value.folder;
      if (!f.rights.add) return say('You can’t add documents here.', f.rights.why);
      dialog = { kind: 'add', into: { folder: f.folder.id, name: f.folder.name } };
    } else if (route.kind === 'document' && doc.kind === 'answered') {
      const { answer } = doc.value;
      if (!answer.rights.add) return say('You can’t add a version to this.', answer.rights.why);
      dialog = { kind: 'add', into: { document: answer.document.id, title: answer.document.title } };
    } else return say('Open a folder first.', 'Documents are added into a folder in the library.');
    draw();
  };

  /** Files dropped on the pane, or chosen with the dialog's file button, go where the screen is. */
  const take = async (files: File[]) => {
    if (!files.length) return;
    const into = dialog?.kind === 'add' ? dialog.into : route.kind === 'folder' && folder.kind === 'answered' ? { folder: folder.value.folder.folder.id, name: folder.value.folder.folder.name } : route.kind === 'document' && doc.kind === 'answered' ? { document: doc.value.answer.document.id, title: doc.value.answer.document.title } : undefined;
    if (!into) return say('Open a folder to add files.', 'Documents are added into a folder in the library.');
    if ('document' in into && files.length > 1) return say('Add one file at a time as a new version.', 'To add several documents, drop them on a folder.');
    if (dialog?.kind === 'add') dialog = { ...dialog, busy: true };
    draw();
    const failed: string[] = [];
    for (const file of files) {
      try {
        if ('folder' in into) await api.upload(`/folders/${encodeURIComponent(into.folder)}/documents`, file);
        else await api.upload(`/documents/${encodeURIComponent(into.document)}/versions`, file);
      } catch (err) {
        failed.push(`${file.name}: ${whyOf(err)}`);
      }
    }
    dialog = undefined;
    if (failed.length) say(failed.length === files.length ? 'Nothing was added.' : `${files.length - failed.length} of ${files.length} were added.`, failed.join('\n'));
    else say(files.length === 1 ? `Added ${files[0]!.name}.` : `Added ${files.length} documents.`);
    if ('document' in into && route.kind === 'document') {
      // A new version shows as the newest.
      route = { kind: 'document', id: route.id };
      go(route);
    }
    await refresh();
  };

  /** The document a command is for: the radial menu's thing, else the one on screen. */
  const documentFor = async (detail: unknown): Promise<DocumentAnswer | undefined> => {
    const id = (detail as { thing?: { kind?: string; id?: string } } | undefined)?.thing?.id;
    if (doc.kind === 'answered' && (!id || id === doc.value.answer.document.id)) return doc.value.answer;
    if (!id) return void say('Open a document first.');
    try {
      return await api.get<DocumentAnswer>(`/documents/${encodeURIComponent(id)}`);
    } catch (err) {
      return void say('That document couldn’t open.', whyOf(err));
    }
  };

  const move = async (detail?: unknown, only?: string) => {
    const answer = await documentFor(detail);
    if (!answer) return;
    const newest = answer.versions[0]!;
    const options = only ? answer.next.filter((n) => n.to === only) : answer.next;
    if (only && !options[0]?.allowed) return say('It can’t go for review from here.', options[0]?.why ?? `It is ${newest.state}.`);
    dialog = { kind: 'move', document: answer.document.id, version: newest.number, options };
    draw();
  };

  const share = async (detail?: unknown) => {
    const answer = await documentFor(detail);
    if (!answer) return;
    if (!answer.rights.share) return say('You can’t share this.', answer.rights.why);
    const grants = doc.kind === 'answered' && doc.value.answer.document.id === answer.document.id ? doc.value.grants : (await api.get<{ grants: GrantView[] }>(`/grants?kind=document&record=${encodeURIComponent(answer.document.id)}`)).grants;
    dialog = { kind: 'share', document: answer.document.id, title: answer.document.title, grants, chosen: [] };
    draw();
  };

  const download = async (detail?: unknown) => {
    const answer = await documentFor(detail);
    if (!answer) return;
    const version = doc.kind === 'answered' && doc.value.answer.document.id === answer.document.id ? doc.value.version : shownVersion(answer);
    if (!version) return;
    await api.download(`/documents/${encodeURIComponent(answer.document.id)}/versions/${version.number}/file`).catch((err) => say('It couldn’t be downloaded.', whyOf(err)));
  };

  /** Opens something published up to this floor: a document as itself, a folder inside its window. */
  const openReceived = (item: ReceivedItem) => (item.placement.record.kind === 'document' ? go({ kind: 'document', id: item.placement.record.id }) : go({ kind: 'received', id: item.placement.id }));

  /** The record a publish command is for: the radial menu's thing, else what's on screen. */
  const recordFor = (detail: unknown): { kind: RecordKind; id: string; title: string } | undefined => {
    const thing = (detail as { thing?: { kind?: string; id?: string; label?: string } } | undefined)?.thing;
    if (thing?.id) return { kind: thing.kind === 'document' ? 'document' : 'folder', id: thing.id, title: thing.label ?? '' };
    if (route.kind === 'document' && doc.kind === 'answered') return { kind: 'document', id: doc.value.answer.document.id, title: doc.value.answer.document.title };
    if (route.kind === 'folder' && folder.kind === 'answered') return { kind: 'folder', id: folder.value.folder.folder.id, title: folder.value.folder.folder.name };
    return undefined;
  };

  /** The Publish up dialog: every floor above, why for any it can't go to, and what they'd see. */
  const publish = async (detail?: unknown) => {
    const record = recordFor(detail);
    if (!record) return say('Open a document or a folder first.');
    let answer: PlacementsAnswer;
    try {
      answer = await api.get<PlacementsAnswer>(`/placements?kind=${record.kind}&record=${encodeURIComponent(record.id)}`);
    } catch (err) {
      return say('Its floors couldn’t be asked for.', whyOf(err));
    }
    if (!answer.targets.length) return say('You can’t publish this up.', publishWhy(answer));
    const first = answer.targets.find((t) => !t.why);
    dialog = {
      kind: 'publish',
      record: { kind: record.kind, id: record.id },
      title: record.title || answer.record.name,
      answer,
      ...(first ? { target: targetKey(first) } : {}),
      filter: FIRST_FILTER.filter((st) => !first?.most || first.most.includes(st)),
    };
    draw();
  };

  /** Where a floor's leads put something published up to it. */
  const land = async (item: ReceivedItem) => {
    if (!item.placement.can.land) return say('Only the floor’s leads give it a place.');
    let places = below.kind === 'answered' ? below.value.places : [];
    if (!places.length) {
      try {
        places = (await api.get<ReceivedAnswer>('/received')).places;
      } catch (err) {
        return say('This floor’s library couldn’t be asked for.', whyOf(err));
      }
    }
    if (item.placement.record.level === 'collection') return say('A whole collection stays as it is under From below.', 'It can’t go inside another collection.');
    dialog = { kind: 'land', placement: item.placement.id, title: item.placement.record.name, places, ...(item.placement.landed ? { current: item.placement.landed.folder } : {}) };
    draw();
  };

  const readAgain = async () => {
    if (doc.kind !== 'answered') return;
    const { answer, version } = doc.value;
    try {
      await api.send('POST', `/documents/${encodeURIComponent(answer.document.id)}/versions/${version.number}/reader`);
    } catch (err) {
      return say('It couldn’t be asked for again.', whyOf(err));
    }
    await refresh();
  };

  /** Runs a dialog's work: closes it when done, or keeps it open saying why not. */
  const working = async (work: () => Promise<void>) => {
    try {
      await work();
      dialog = undefined;
      await refresh();
    } catch (err) {
      if (dialog) dialog = { ...dialog, error: err instanceof Refused || err instanceof Error ? err.message : String(err) };
      draw();
    }
  };

  const dialogOn = {
    close: () => {
      dialog = undefined;
      draw();
    },
    newFolder: (values: { name: string; level?: string; description?: string }) =>
      void working(async () => {
        if (dialog?.kind !== 'folder') return;
        const made = await api.send<{ id: string }>('POST', '/folders', { name: values.name.trim(), ...(dialog.parent ? { parent: dialog.parent } : {}), ...(values.level ? { level: values.level } : {}), ...(values.description ? { description: values.description } : {}) });
        if (!dialog.parent) await loadLibrary();
        say(`Made “${values.name.trim()}”.`);
        if (!dialog.parent) go({ kind: 'folder', id: made.id });
      }),
    move: (to: string, note?: string) =>
      void working(async () => {
        if (dialog?.kind !== 'move') return;
        await api.send('POST', `/documents/${encodeURIComponent(dialog.document)}/versions/${dialog.version}/state`, { to, ...(note ? { note } : {}) });
      }),
    share: (level: string) =>
      void working(async () => {
        if (dialog?.kind !== 'share') return;
        const { chosen } = dialog;
        if (!chosen.length) throw new Error('Choose someone to share it with.');
        for (const p of chosen) await api.send('PUT', '/grants', { kind: 'document', record: dialog.document, principal: `${p.kind}:${p.id}`, level });
        say(`Shared “${dialog.title}” with ${chosen.map((p) => p.name).join(', ')}.`);
      }),
    unshare: (principal: string) =>
      void (async () => {
        if (dialog?.kind !== 'share') return;
        const d = dialog;
        try {
          await api.send('DELETE', `/grants?kind=document&record=${encodeURIComponent(d.document)}&principal=${encodeURIComponent(principal)}`);
          dialog = { ...d, grants: d.grants.filter((g) => g.principal !== principal) };
        } catch (err) {
          dialog = { ...d, error: whyOf(err) };
        }
        draw();
      })(),
    query: (q: string) =>
      void (async () => {
        if (dialog?.kind !== 'share') return;
        let found: PeopleAnswer;
        try {
          found = await api.get<PeopleAnswer>(`/people?q=${encodeURIComponent(q)}`);
        } catch (err) {
          found = { query: q, items: [], error: whyOf(err) };
        }
        if (dialog?.kind === 'share') dialog = { ...dialog, found: { ...found, query: q } };
        draw();
      })(),
    choose: (chosen: Principal[]) => {
      if (dialog?.kind === 'share') dialog = { ...dialog, chosen };
    },
    publish: (note?: string) =>
      void working(async () => {
        if (dialog?.kind !== 'publish') return;
        const d = dialog;
        const target = d.answer.targets.find((t) => targetKey(t) === d.target);
        if (!target) throw new Error('Choose a floor to publish it up to.');
        if (target.why) throw new Error(target.why);
        if (!dialog.filter.length) throw new Error('Tick at least one state for them to see.');
        const placed = await api.send<PlacementView>('POST', '/placements', { record: dialog.record, to: target.to.id, filter: dialog.filter, ...(target.via ? { via: target.via } : {}), ...(note ? { note } : {}) });
        say(`Published “${dialog.title}” up to ${placed.to.name}.`, 'They see it under From below until their leads give it a place.');
      }),
    target: (key: string) => {
      if (dialog?.kind !== 'publish') return;
      const most = dialog.answer.targets.find((t) => targetKey(t) === key)?.most;
      dialog = { ...dialog, target: key, filter: most ? dialog.filter.filter((st) => most.includes(st)) : dialog.filter };
      draw();
    },
    filter: (states: ContentState[]) => {
      if (dialog?.kind === 'publish') dialog = { ...dialog, filter: states };
    },
    withdraw: (placement: string) =>
      void working(async () => {
        if (dialog?.kind !== 'publish') return;
        const { withdrawn } = await api.send<{ withdrawn: { name: string }[] }>('POST', `/placements/${encodeURIComponent(placement)}/withdraw`, {});
        say(`Took “${dialog.title}” back.`, withdrawn.length > 1 ? `It went from ${withdrawn.map((f) => f.name).join(', ')}.` : undefined);
      }),
    land: (folderId?: string) =>
      void working(async () => {
        if (dialog?.kind !== 'land') return;
        await api.send('PUT', `/placements/${encodeURIComponent(dialog.placement)}/landing`, folderId ? { folder: folderId } : {});
        const place = dialog.places.find((pl) => pl.id === folderId);
        say(place ? `“${dialog.title}” is in ${place.label} now.` : `“${dialog.title}” is back under From below.`);
      }),
  };

  // Wiring

  const commands: Record<string, (detail?: unknown) => unknown> = {
    'document.add': () => addFiles(),
    'document.open': (detail) => {
      const id = (detail as { thing?: { id?: string } } | undefined)?.thing?.id;
      if (id) go({ kind: 'document', id });
    },
    'document.review': (detail) => move(detail, 'in-review'),
    'document.move': (detail) => move(detail),
    'document.share': (detail) => share(detail),
    'document.download': (detail) => download(detail),
    'document.publish': (detail) => publish(detail),
    'folder.publish': (detail) => publish(detail),
    'document.about': () => say('Saying what a document is about comes in the next version of Artifacts.'),
    'folder.new': (detail) => newFolder((detail as { thing?: { id?: string } } | undefined)?.thing?.id),
    'collection.new': () => newFolder(undefined, true),
  };
  for (const [id, run] of Object.entries(commands)) ctx.frame.onCommand(id, (detail) => void run(detail));
  ctx.files.onDrop((files) => take(files));
  ctx.onNavigate((path) => {
    route = routeOf(path);
    void open();
  });
  void loadLibrary().then(() => route.kind === 'home' && draw());
  void open();
  return () => clearTimeout(poll);
};

export default defineApp((ctx) => {
  if (ctx.surface === 'card') {
    // Home runs the app only for its card: how many things need the person here, and how many are new.
    const api = apiFor(ctx);
    ctx.frame.card.render(card({ kind: 'asking' }));
    return void api
      .get<Home>('/home')
      .then((h) => ctx.frame.card.render(card({ kind: 'answered', home: h })))
      .catch((err) => ctx.frame.card.render(card({ kind: 'failed', why: whyOf(err) })));
  }
  return startArtifacts(ctx);
});
