import { AppError, createAppClient, type AppClient, type AppFetcher } from '@augur/app-kit';
import manifest from '../../manifest.json' with { type: 'json' };

import type {
  Access,
  AccessTarget,
  Brief,
  Cadence,
  ContainerState,
  ContentState,
  DocumentSort,
  DocumentState,
  DocumentVersion,
  Findable,
  FloorNamed,
  FloorView,
  Folder,
  FolderLevel,
  DocumentView as FolioDocument,
  Found,
  GrantView as Grant,
  HomeGlance,
  Issue,
  IssueLink,
  IssuePlace,
  Level,
  LevelInfo,
  Library,
  LibraryRights,
  LinkEnd,
  ListQuery,
  OpenDocument,
  OpenLibrary,
  Person,
  PlacementView as Placement,
  Placements,
  PlacementTarget,
  Principal,
  Problem,
  Publication,
  Publications,
  PublishedPage,
  ReaderState,
  Received,
  ReceivedPage,
  RecordLinkView as RecordLink,
  RecordLinks,
  RecordView,
  RelationKind,
  RenditionState,
  SavedView,
  Series,
  SeriesView,
  Shared,
  Since,
  StateMove,
  Tag,
  UnitLevel,
  ViewQuery,
} from '../../service/src/api-types.js';

// The wire types are written once, in the service's api-types.ts, and shared with it. Where the service keeps a
// record under the same name, the page's shape is a `...View` there; the pages know it by the shorter name here.
export type {
  Access,
  AccessTarget,
  Brief,
  Cadence,
  ContainerState,
  ContentState,
  DocumentSort,
  DocumentState,
  DocumentVersion,
  Findable,
  FloorNamed,
  FloorView,
  Folder,
  FolderLevel,
  FolioDocument,
  Found,
  Grant,
  HomeGlance,
  Issue,
  IssueLink,
  IssuePlace,
  Level,
  LevelInfo,
  Library,
  LibraryRights,
  LinkEnd,
  ListQuery,
  OpenDocument,
  OpenLibrary,
  Person,
  Placement,
  Placements,
  PlacementTarget,
  Principal,
  Problem,
  Publication,
  Publications,
  PublishedPage,
  ReaderState,
  Received,
  ReceivedPage,
  RecordLink,
  RecordLinks,
  RecordView,
  RelationKind,
  RenditionState,
  SavedView,
  Series,
  SeriesView,
  Shared,
  Since,
  StateMove,
  Tag,
  UnitLevel,
  ViewQuery,
};

/** The states in order, as people read them. */
export const CONTENT_STATES: { id: ContentState; name: string }[] = [
  { id: 'in-progress', name: 'In progress' },
  { id: 'in-review', name: 'In review' },
  { id: 'complete', name: 'Complete' },
  { id: 'issued', name: 'Issued' },
  { id: 'retired', name: 'Retired' },
];
export const CONTAINER_STATES: { id: ContainerState; name: string }[] = [
  { id: 'open', name: 'Open' },
  { id: 'closed', name: 'Closed' },
  { id: 'archived', name: 'Archived' },
];
export const stateName = (id: string) => [...CONTENT_STATES, ...CONTAINER_STATES].find((s) => s.id === id)?.name ?? id;

/** What Folio takes, by file ending, and the media type each is sent as. */
export const FILE_TYPES: Record<string, { type: string; word: string }> = {
  '.pdf': { type: 'application/pdf', word: 'PDF' },
  '.docx': { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', word: 'Word' },
  '.html': { type: 'text/html', word: 'HTML' },
  '.htm': { type: 'text/html', word: 'HTML' },
  '.md': { type: 'text/markdown', word: 'Markdown' },
  '.markdown': { type: 'text/markdown', word: 'Markdown' },
  '.txt': { type: 'text/plain', word: 'Text' },
};

/** File kinds as the list filters by them. */
export const KINDS: { value: string; label: string }[] = [
  { value: 'pdf', label: 'PDF' },
  { value: 'word', label: 'Word' },
  { value: 'html', label: 'HTML' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'text', label: 'Text' },
];

/** For a drop zone's or file input's `accept`. */
export const ACCEPT = Object.keys(FILE_TYPES).join(',');
export const MAX_UPLOAD_MB = 200;

const endingOf = (filename: string) => (filename.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase();
export const fileTypeOf = (filename: string) => FILE_TYPES[endingOf(filename)];

/** A size people read: "840 KB", "1.2 MB". */
export const sizeWords = (bytes: number) =>
  bytes < 1024 ? `${bytes} bytes` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/** The address a list of documents is asked for at: each value of a filter once. */
export const listParams = (q: ListQuery) => {
  const params = new URLSearchParams();
  if (q.folder) params.set('folder', q.folder);
  if (q.below) params.set('below', 'true');
  for (const t of q.tags ?? []) params.append('tag', t);
  for (const t of q.types ?? []) params.append('type', t);
  for (const a of q.authors ?? []) params.append('author', a);
  if (q.since) params.set('since', q.since);
  if (q.sort && q.sort !== 'title') params.set('sort', q.sort);
  for (const s of q.states ?? []) params.append('state', s);
  if (q.series) params.set('series', q.series);
  if (q.limit) params.set('limit', String(q.limit));
  if (q.offset) params.set('offset', String(q.offset));
  return params;
};

/** Where the gateway sends Artifacts' calls: its own service, at its manifest id. */
export const API = `/api/${manifest.id}/v1`;

/** What Artifacts is called, as its manifest names it: it is in "Artifacts isn't answering". */
export const APP_NAME = manifest.name;

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * An AppError in the service's own words. AUGUR's services put a code in a
 * problem's `reason` (`forbidden`) and the sentence in `detail`; Quill 0.7
 * shows `reason`, so a refusal is said with `detail` until a kit that reads it
 * is served.
 */
export const inWords = (err: unknown): unknown => {
  if (!(err instanceof AppError) || err.status < 400 || err.status >= 500) return err;
  const said = typeof err.problem.detail === 'string' && err.problem.detail.trim() ? err.problem.detail.trim() : typeof err.problem.message === 'string' && err.problem.message.trim() ? err.problem.message.trim() : undefined;
  return said && said !== err.message ? new AppError(said, err.status, err.problem, { cause: err }) : err;
};
/** The app client, called by path alone: the methods below name the path, its query and the answer's type. */
type Call = (path: string, options?: { body?: unknown }) => Promise<unknown>;

/**
 * Folio's own API, through the gateway (`ctx.fetch`), always for the floor the
 * app is on. Every failure is an AppError whose message people can act on.
 */
export class FolioApi {
  private readonly client: AppClient;

  constructor(private readonly ctx: AppFetcher) {
    this.client = createAppClient(ctx, { base: API, appName: APP_NAME });
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const send = this.client[method.toLowerCase() as Method] as unknown as Call;
    try {
      return (await send(path, body === undefined ? {} : { body })) as T;
    } catch (err) {
      throw inWords(err);
    }
  }

  /** Asks by the whole address, for what isn't JSON: a file, a reader copy, a picture. */
  private async raw(path: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.ctx.fetch(`${API}${path}`, init);
    } catch (err) {
      throw AppError.from(err, { appName: APP_NAME });
    }
    if (!res.ok) {
      const err = inWords(await AppError.fromResponse(res, { appName: APP_NAME })) as AppError;
      // The gateway stops a file past the app's limit before Folio sees it; say the limit when it gave no words.
      if (res.status === 413 && err.code !== 'too-large') throw new AppError(`A file can be ${MAX_UPLOAD_MB} MB at most.`, 413, { ...err.problem, code: 'too-large' });
      throw err;
    }
    return res;
  }

  /** Sends a file as it is, streamed, typed by its ending. */
  private async sendFile<T>(path: string, file: File, query: Record<string, string | undefined>, tags: readonly string[] = []): Promise<T> {
    const kind = fileTypeOf(file.name);
    if (!kind) throw new AppError(`${APP_NAME} takes PDF, Word (.docx), HTML, Markdown and plain text files.`, 415, { code: 'unsupported-type' });
    const params = new URLSearchParams(Object.entries({ filename: file.name, ...query }).filter((e): e is [string, string] => Boolean(e[1])));
    for (const t of tags) params.append('tag', t);
    const res = await this.raw(`${path}?${params}`, { method: 'POST', headers: { 'content-type': kind.type }, body: file });
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  libraries() {
    return this.call<{ libraries: Library[]; can: { create: boolean } }>('GET', '/libraries');
  }

  library(id: string) {
    return this.call<OpenLibrary>('GET', `/libraries/${encodeURIComponent(id)}`);
  }

  createLibrary(name: string, description?: string) {
    return this.call<Library>('POST', '/libraries', { name, ...(description ? { description } : {}) });
  }

  updateLibrary(id: string, change: { name?: string; description?: string; freeTags?: boolean }) {
    return this.call<Library>('PATCH', `/libraries/${encodeURIComponent(id)}`, change);
  }

  archiveLibrary(id: string) {
    return this.call<void>('POST', `/libraries/${encodeURIComponent(id)}/archive`);
  }

  createFolder(library: string, name: string, parent?: string, level?: FolderLevel, description?: string) {
    return this.call<Folder>('POST', `/libraries/${encodeURIComponent(library)}/folders`, { name, ...(parent ? { parent } : {}), ...(level ? { level } : {}), ...(description ? { description } : {}) });
  }

  /** Changes a folder's name or what it's for. */
  updateFolder(library: string, id: string, change: { name?: string; description?: string }) {
    return this.call<Folder>('PATCH', `/libraries/${encodeURIComponent(library)}/folders/${encodeURIComponent(id)}`, change);
  }

  /** The levels a library is built from, in the org's words, and whether the caller may rename them. */
  levels() {
    return this.call<{ levels: LevelInfo[]; top: UnitLevel[]; can: { rename: boolean } }>('GET', '/levels');
  }

  /** Renames a level for the whole org, or with `null` gives it its own name back. */
  nameLevel(level: UnitLevel, name: { name: string; plural: string } | null) {
    return name ? this.call<{ levels: LevelInfo[] }>('PUT', `/levels/${level}`, name) : this.call<{ levels: LevelInfo[] }>('DELETE', `/levels/${level}`);
  }

  /** Opens, closes or archives a library, or with `folder` one of its folders. */
  setState(library: string, state: ContainerState, folder?: string, note?: string) {
    const at = `/libraries/${encodeURIComponent(library)}${folder ? `/folders/${encodeURIComponent(folder)}` : ''}/state`;
    return this.call<Library | Folder>('PUT', at, { state, ...(note ? { note } : {}) });
  }

  /** Moves a version through its lifecycle. */
  setVersionState(library: string, document: string, version: number, state: ContentState, note?: string) {
    return this.call<DocumentVersion>('PUT', `/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(document)}/versions/${version}/state`, { state, ...(note ? { note } : {}) });
  }

  /** Every lifecycle move of a document's versions, or of a library or one of its folders, newest first. */
  moves(library: string, target: { document?: string; folder?: string } = {}) {
    const at = `/libraries/${encodeURIComponent(library)}`;
    return this.call<{ moves: StateMove[] }>('GET', target.document ? `${at}/documents/${encodeURIComponent(target.document)}/moves` : `${at}/moves${target.folder ? `?folder=${encodeURIComponent(target.folder)}` : ''}`);
  }

  /** A record's steps up the floors, who owns it, and where the caller could publish it next. */
  placements(library: string, record: string) {
    return this.call<Placements>('GET', `/placements?library=${encodeURIComponent(library)}&record=${encodeURIComponent(record)}`);
  }

  /** Publishes a record up to a floor above, showing the versions in `filter`'s states. */
  publishUp(step: { library: string; record: { kind: RecordView['kind']; id: string }; to: string; filter: ContentState[]; via?: string; landing?: { library: string; folder?: string }; note?: string }) {
    return this.call<Placement>('POST', '/placements', step);
  }

  /** Shows more or less through a step. */
  changePlacement(id: string, filter: ContentState[]) {
    return this.call<Placement>('PATCH', `/placements/${encodeURIComponent(id)}`, { filter });
  }

  /** Puts what was received in a place on this floor, or with `null` back under "From below". */
  land(id: string, landing: { library: string; folder?: string } | null) {
    const at = `/placements/${encodeURIComponent(id)}/landing`;
    return landing ? this.call<Placement>('PUT', at, landing) : this.call<Placement>('DELETE', at);
  }

  /** Takes a step back, and every step that went on up from it. */
  withdrawPlacement(id: string, reason?: string) {
    return this.call<Placement>('POST', `/placements/${encodeURIComponent(id)}/withdraw`, reason ? { reason } : {});
  }

  /** What's been published up to the caller's floor. */
  /** A record's links both ways: `record` is a folder's or document's id, or the library's own. */
  links(library: string, record: string) {
    return this.call<RecordLinks>('GET', `/libraries/${encodeURIComponent(library)}/links?record=${encodeURIComponent(record)}`);
  }

  link(library: string, record: string, relation: RelationKind['id'], to: { app: string; kind: string; id: string; label?: string }) {
    return this.call<RecordLink>('POST', `/libraries/${encodeURIComponent(library)}/links`, { record, relation, to });
  }

  unlink(library: string, record: string, link: string) {
    return this.call<void>('DELETE', `/libraries/${encodeURIComponent(library)}/links/${encodeURIComponent(link)}?record=${encodeURIComponent(record)}`);
  }

  received() {
    return this.call<Received>('GET', '/received');
  }

  /** Inside something received, at one of its folders or its top. */
  receivedPage(id: string, folder?: string) {
    return this.call<ReceivedPage>('GET', `/received/${encodeURIComponent(id)}${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`);
  }

  renameFolder(library: string, id: string, name: string) {
    return this.call<Folder>('PATCH', `/libraries/${encodeURIComponent(library)}/folders/${encodeURIComponent(id)}`, { name });
  }

  deleteFolder(library: string, id: string) {
    return this.call<void>('DELETE', `/libraries/${encodeURIComponent(library)}/folders/${encodeURIComponent(id)}`);
  }

  documents(library: string, query: ListQuery = {}) {
    const params = listParams(query).toString();
    return this.call<{ documents: FolioDocument[]; total: number }>('GET', `/libraries/${encodeURIComponent(library)}/documents${params ? `?${params}` : ''}`);
  }

  document(library: string, id: string) {
    return this.call<OpenDocument>('GET', `/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(id)}`);
  }

  upload(library: string, file: File, folder?: string, tags: readonly string[] = []) {
    return this.sendFile<FolioDocument>(`/libraries/${encodeURIComponent(library)}/documents`, file, { folder }, tags);
  }

  /** A series' next issue: the series names, tags and publishes it. */
  addIssue(library: string, series: string, file: File) {
    return this.sendFile<FolioDocument>(`/libraries/${encodeURIComponent(library)}/documents`, file, { series });
  }

  /** A series, with its audience named, wherever the caller reaches it from. */
  series(id: string) {
    return this.call<Omit<SeriesView, 'audience'> & { audience: Principal[] }>('GET', `/series/${encodeURIComponent(id)}`);
  }

  /** The issues of a series the caller may read, newest period first. */
  issues(series: string) {
    return this.call<{ documents: FolioDocument[]; total: number }>('GET', `/series/${encodeURIComponent(series)}/issues`);
  }

  createSeries(library: string, series: { name: string; description?: string; cadence: Cadence; audience?: string[]; tags?: string[] }) {
    return this.call<SeriesView>('POST', `/libraries/${encodeURIComponent(library)}/series`, series);
  }

  updateSeries(library: string, id: string, change: { name?: string; description?: string; cadence?: Cadence; audience?: string[]; tags?: string[] }) {
    return this.call<SeriesView>('PATCH', `/libraries/${encodeURIComponent(library)}/series/${encodeURIComponent(id)}`, change);
  }

  deleteSeries(library: string, id: string) {
    return this.call<void>('DELETE', `/libraries/${encodeURIComponent(library)}/series/${encodeURIComponent(id)}`);
  }

  /** Starts or stops being told of each new issue. */
  follow(series: string, following: boolean) {
    return this.call<{ following: boolean }>('PUT', `/series/${encodeURIComponent(series)}/follow`, { following });
  }

  setFolderTags(library: string, folder: string, tags: string[]) {
    return this.call<Folder>('PUT', `/libraries/${encodeURIComponent(library)}/folders/${encodeURIComponent(folder)}/tags`, { tags });
  }

  setTags(library: string, document: string, tags: string[]) {
    return this.call<FolioDocument>('PUT', `/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(document)}/tags`, { tags });
  }

  /** The org's tags, and whether the caller keeps them (a lead on the org's floor). */
  orgTags() {
    return this.call<{ tags: Tag[]; can: { manage: boolean } }>('GET', '/tags');
  }

  /** A tag for the library, or for the org when `library` is undefined. */
  createTag(library: string | undefined, name: string) {
    return this.call<Tag>('POST', library ? `/libraries/${encodeURIComponent(library)}/tags` : '/tags', { name });
  }

  renameTag(tag: Tag, name: string) {
    return this.call<Tag>('PATCH', `${tag.library ? `/libraries/${encodeURIComponent(tag.library)}` : ''}/tags/${encodeURIComponent(tag.id)}`, { name });
  }

  deleteTag(tag: Tag) {
    return this.call<void>('DELETE', `${tag.library ? `/libraries/${encodeURIComponent(tag.library)}` : ''}/tags/${encodeURIComponent(tag.id)}`);
  }

  createView(library: string, name: string, query: ViewQuery) {
    return this.call<SavedView>('POST', `/libraries/${encodeURIComponent(library)}/views`, { name, query });
  }

  updateView(library: string, id: string, change: { name?: string; query?: ViewQuery }) {
    return this.call<SavedView>('PATCH', `/libraries/${encodeURIComponent(library)}/views/${encodeURIComponent(id)}`, change);
  }

  deleteView(library: string, id: string) {
    return this.call<void>('DELETE', `/libraries/${encodeURIComponent(library)}/views/${encodeURIComponent(id)}`);
  }

  addVersion(library: string, document: string, file: File) {
    return this.sendFile<DocumentVersion>(`/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(document)}/versions`, file, {});
  }

  updateDocument(library: string, id: string, change: { title?: string; folder?: string | null }) {
    return this.call<FolioDocument>('PATCH', `/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(id)}`, change);
  }

  deleteDocument(library: string, id: string) {
    return this.call<void>('DELETE', `/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(id)}`);
  }

  /** Who may see a library, or one of its documents or folders. */
  access(library: string, on?: AccessTarget) {
    return this.call<Access>('GET', this.accessPath(library, on));
  }

  /** Lets someone in that far, or with `null` takes them out; answers who may see it now. */
  share(library: string, on: AccessTarget | undefined, principal: string, level: Level | null) {
    const path = `${this.accessPath(library, on)}/${encodeURIComponent(principal)}`;
    return level ? this.call<Access>('PUT', path, { level }) : this.call<Access>('DELETE', path);
  }

  private accessPath(library: string, on?: AccessTarget) {
    const within = on?.document ? `/documents/${encodeURIComponent(on.document)}` : on?.folder ? `/folders/${encodeURIComponent(on.folder)}` : '';
    return `/libraries/${encodeURIComponent(library)}${within}/access`;
  }

  /** People and teams whose names have `q` in them, to share with. */
  people(q: string) {
    return this.call<Found>('GET', `/people?q=${encodeURIComponent(q)}`);
  }

  /** Libraries and documents shared with the caller from other floors. */
  shared() {
    return this.call<Shared>('GET', '/shared');
  }

  /** Every time a document was published, with who it went to by name. */
  publications(library: string, document: string) {
    return this.call<Publications>('GET', `/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(document)}/publications`);
  }

  /** Puts a version out to an audience, replacing what was out. */
  publish(library: string, document: string, version: number, audience: string[], note?: string) {
    return this.call<Publication<Principal>>('POST', `/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(document)}/publish`, { version, audience, ...(note ? { note } : {}) });
  }

  /** Takes back what's out, saying why if there's a reason. */
  withdraw(library: string, document: string, reason?: string) {
    return this.call<Publication<Principal>>('POST', `/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(document)}/withdraw`, reason ? { reason } : {});
  }

  /** What's out to the caller now, newest first. */
  published() {
    return this.call<PublishedPage>('GET', '/published');
  }

  /** Notes that the caller has looked at what's published to them, so Home stops counting it as new. */
  looked() {
    return this.call<void>('PUT', '/published/looked');
  }

  /** Documents the caller may read, or has had published to them, matching every word of `q`: for the picker. */
  find(q: string) {
    return this.call<{ documents: Findable[] }>('GET', `/find?q=${encodeURIComponent(q)}`);
  }

  /** What Home's card shows on this floor. */
  home() {
    return this.call<HomeGlance>('GET', '/home');
  }

  /** Where a document is, from its id alone, as another app passes it. */
  locate(document: string) {
    return this.call<{ id: string; library: string; title: string; only?: number }>('GET', `/documents/${encodeURIComponent(document)}`);
  }

  /** Asks again for a reader copy that failed. */
  retryReader(library: string, document: string, number: number) {
    return this.call<ReaderState>('POST', `/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(document)}/versions/${number}/reader/retry`);
  }

  /** A version's reader copy, as Markdown. */
  async reader(library: string, document: string, number: number): Promise<string> {
    return (await this.raw(`${this.versionPath(library, document, number)}/reader`)).text();
  }

  /** A picture a version's reader copy shows, by its name there (`1.png`). */
  async readerImage(library: string, document: string, number: number, name: string): Promise<Blob> {
    return (await this.raw(`${this.versionPath(library, document, number)}/reader/images/${encodeURIComponent(name)}`)).blob();
  }

  private versionPath(library: string, document: string, number: number) {
    return `/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(document)}/versions/${number}`;
  }

  /** A version's file exactly as it was uploaded. Each download goes in the audit log. */
  async original(library: string, document: string, number: number): Promise<Blob> {
    return (await this.raw(`${this.versionPath(library, document, number)}/original`)).blob();
  }
}

/**
 * Where a path inside Folio points: `/libraries`, `/libraries/new`, `/libraries/<id>`, a document
 * by its id alone (`/documents/<id>`, as another app opens one),
 * `/libraries/<id>/<folder>`, a saved view, `/libraries/<id>/views/<view>`, or a
 * series, `/libraries/<id>/series/<series>`.
 */
export interface Place {
  library?: string;
  folder?: string;
  view?: string;
  series?: string;
  /** A document being read, and which version of it (the newest when there's none). */
  document?: string;
  version?: number;
  /** Open "New library" straight away (the menu's item). */
  adding: boolean;
  /** What's been published to the person (`/published`). */
  published?: boolean;
  /** Something published up to this floor (`/received/<placement>`), or with `true` the list of them (`/received`). */
  received?: string | true;
  /** What other floors have shared with the person (`/shared`). */
  shared?: boolean;
  /** The app's front page (`/`). */
  home?: boolean;
  /** The person's collections (`/libraries`). */
  collections?: boolean;
}

export const placeFor = (path: string): Place => {
  const [first, second, third, fourth, fifth, sixth] = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (first === 'published') return { published: true, adding: false };
  if (first === 'shared') return { shared: true, adding: false };
  if (first === 'received') return { received: second || true, adding: false };
  if (first === 'documents' && second) {
    const version = third === 'versions' && /^[1-9]\d*$/.test(fourth ?? '') ? Number(fourth) : undefined;
    return { document: second, ...(version ? { version } : {}), adding: false };
  }
  if (!first) return { home: true, adding: false };
  if (first === 'libraries' && !second) return { collections: true, adding: false };
  if (first !== 'libraries' || !second) return { adding: false };
  if (second === 'new') return { adding: true };
  if (third === 'documents' && fourth) {
    const version = fifth === 'versions' && /^[1-9]\d*$/.test(sixth ?? '') ? Number(sixth) : undefined;
    return { library: second, document: fourth, ...(version ? { version } : {}), adding: false };
  }
  if (third === 'views') return { library: second, ...(fourth ? { view: fourth } : {}), adding: false };
  if (third === 'series') return { library: second, ...(fourth ? { series: fourth } : {}), adding: false };
  return { library: second, ...(third ? { folder: third } : {}), adding: false };
};

export const pathFor = ({ library, folder, view, series, document, version, published, received, shared, home }: Omit<Place, 'adding'>) => {
  if (home && !document) return '/';
  if (published && !document) return '/published';
  if (shared && !document) return '/shared';
  if (received && !document) return received === true ? '/received' : `/received/${encodeURIComponent(received)}`;
  // A document another app named by its id alone: Artifacts finds its library.
  if (document && !library) return `/documents/${encodeURIComponent(document)}${version ? `/versions/${version}` : ''}`;
  if (!library) return '/libraries';
  const at = `/libraries/${encodeURIComponent(library)}`;
  if (document) return `${at}/documents/${encodeURIComponent(document)}${version ? `/versions/${version}` : ''}`;
  if (series) return `${at}/series/${encodeURIComponent(series)}`;
  return view ? `${at}/views/${encodeURIComponent(view)}` : folder ? `${at}/${encodeURIComponent(folder)}` : at;
};
