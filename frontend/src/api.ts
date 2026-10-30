import type { MountContext } from '@augur/mfe-sdk';

export interface Library {
  id: string;
  workspace: string;
  /** Who its floor lets in: `person:<owner>`, `tree:<team>` or `org`. */
  floor: string;
  name: string;
  description: string;
  /** Anyone who may tag a document here may make new tags too. */
  freeTags: boolean;
  /** Open, closed (nothing new goes in) or archived. */
  state: ContainerState;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A tag: the org's when it has no library, else that library's own. */
export interface Tag {
  id: string;
  workspace: string;
  library?: string;
  name: string;
  createdBy: string;
  createdAt: string;
}

export type DocumentSort = 'title' | 'newest' | 'updated' | 'period';
export type Since = 'week' | 'month' | 'quarter' | 'year';

/** A document the picker found: with its library, and whether only the version published to the caller is theirs to pick. */
export type Findable = FolioDocument & { libraryName: string; audienceOnly: boolean };

/** A document as Home's card names it. */
export interface Brief {
  id: string;
  library: string;
  title: string;
  libraryName: string;
  /** When it was published, or for a draft last changed (ISO). */
  at: string;
}

/** What Home's card shows: what's new to the person since they last looked, and the floor's drafts for its leads. */
export interface HomeGlance {
  published: { new: number; since?: string; documents: Brief[] };
  drafts?: { total: number; documents: Brief[] };
}

/** Where a document is in being published: never yet, out now, or taken back. */
export type DocumentState = 'draft' | 'published' | 'withdrawn';

/** A set of filters, as a saved view keeps it. */
export interface ViewQuery {
  folder?: string;
  tags?: string[];
  types?: string[];
  authors?: string[];
  since?: Since;
  sort?: DocumentSort;
  states?: DocumentState[];
  /** Issues of this series. */
  series?: string;
}

export interface SavedView {
  id: string;
  library: string;
  name: string;
  query: ViewQuery;
  createdBy: string;
  createdAt: string;
}

export interface Person {
  id: string;
  name: string;
}

/** Which documents to list: a view's filters, whether to look in every folder below, and the page. */
export interface ListQuery extends ViewQuery {
  below?: boolean;
  limit?: number;
  offset?: number;
}

/** Where a version is in its lifecycle (`@augur/records`' content lifecycle). */
export type ContentState = 'in-progress' | 'in-review' | 'complete' | 'issued' | 'retired';
/** Where a collection or folder is in its lifecycle. */
export type ContainerState = 'open' | 'closed' | 'archived';

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

/** collection › subcollection › series › subseries › file. */
export type UnitLevel = 'collection' | 'subcollection' | 'series' | 'subseries' | 'file';
export type FolderLevel = 'subcollection' | 'series' | 'subseries';

/** A level, called what the org calls it, and what it may hold. */
export interface LevelInfo {
  id: UnitLevel;
  name: string;
  plural: string;
  holds: UnitLevel[];
}

export interface Folder {
  id: string;
  library: string;
  parent?: string;
  /** Which level of the library it is. */
  level: FolderLevel;
  name: string;
  description: string;
  state: ContainerState;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Its own tags: they count for everything inside it when filtering. */
  tags?: string[];
}

/** One move through a lifecycle, on the record. */
export interface StateMove {
  id: string;
  record: string;
  version?: number;
  from: string;
  to: string;
  by: string;
  note?: string;
  at: string;
}

/** A floor as publishing up names it: how high it sits, from the org (0) down. */
export interface FloorView {
  id: string;
  kind: 'personal' | 'team' | 'org';
  name: string;
  rank: number;
  path: string[];
}

/** A collection, folder or document, as a step up the floors shows it. */
export interface RecordView {
  kind: 'library' | 'folder' | 'document';
  id: string;
  level?: UnitLevel;
  name?: string;
  library?: string;
  libraryName?: string;
}

/** One step a record took up the floors: what it shows (the filter), from where, and where it landed. */
export interface Placement {
  id: string;
  library: string;
  record: RecordView;
  from: string;
  to: string;
  filter: ContentState[];
  via?: string;
  landed?: { library: string; folder?: string };
  note?: string;
  by: string;
  at: string;
  ended?: { as: string; by: string; at: string; reason?: string };
  fromFloor?: FloorView;
  toFloor?: FloorView;
  /** The highest floor it has reached: that floor decides about it now. */
  owner?: FloorView;
  /** From its own floor up to this step. */
  chain: { id: string; from?: FloorView; to?: FloorView; filter: ContentState[]; by: string; at: string }[];
  can?: { change: boolean; land: boolean };
  /** Received here: which floor shows each state to the caller (a lower one shows it only there). */
  states?: Record<string, FloorView | undefined>;
}

/** Where the caller could publish a record next; `why` says why not, when they can't. */
export interface PlacementTarget {
  from?: FloorView;
  to?: FloorView;
  via?: string;
  /** The most it can show: what reached the floor it goes on from. */
  most?: ContentState[];
  why?: string;
}

export interface Placements {
  placements: Placement[];
  owner?: FloorView;
  targets: PlacementTarget[];
}

/** A kind of link between records (`@augur/records`' relations), as the service lists them. */
export interface RelationKind {
  id: 'relates-to' | 'supersedes' | 'responds-to' | 'about' | 'serves';
  name: string;
  inverse: string;
}

/** The far end of a link from a record: in Artifacts (named for whoever asks), or in another app. */
export interface LinkEnd {
  app: string;
  kind: string;
  id: string;
  label?: string;
  library?: string;
  record?: string;
  unitKind?: RecordView['kind'];
  /** Why it can't be opened, when the caller can't. */
  unavailable?: string;
}

export interface RecordLink {
  id: string;
  relation: RelationKind['id'];
  /** The link in words, from the end being looked at: "Responds to", or "Answered by". */
  words: string;
  to?: LinkEnd;
  from?: { library: string; record: string; kind: RecordView['kind']; name: string } | { unavailable: string };
  by: string;
  at: string;
}

export interface RecordLinks {
  kinds: RelationKind[];
  links: RecordLink[];
  /** Links to this record from others. */
  back: RecordLink[];
  can: { change: boolean };
}

/** What's been published up to the caller's floor: here, and elsewhere (a higher floor shows it to them). */
export interface Received {
  here: Placement[];
  signposts: { placement: string; record: RecordView; to?: FloorView; reached: string }[];
}

/** Inside something received: its folders, and the documents where you are, each at the version the caller sees. */
export interface ReceivedPage {
  placement: Placement;
  folders: Folder[];
  folder: string | null;
  documents: (FolioDocument & { onlyVia?: FloorView })[];
  states: Record<string, FloorView | undefined>;
}

export interface LibraryRights {
  manage: boolean;
  addFolders: boolean;
  addDocuments: boolean;
  /** Make new tags: leads, or anyone when the library takes free tags. */
  addTags: boolean;
  /** Let people and teams in, or take them out. */
  share: boolean;
  /** Where the library's own lifecycle may go, for whoever manages it. */
  moves?: ContainerState[];
}

/** How far someone is let in: read; edit (add and change documents); manage (also share). */
export type Level = 'read' | 'edit' | 'manage';

/** Who may see something, as people see them. */
export interface Principal {
  /** `person:<id>`, `team:<id>` (that team), `tree:<id>` (that team and the teams below it) or `org`. */
  principal: string;
  kind: 'person' | 'team' | 'tree' | 'org';
  /** Missing when the directory no longer knows them. */
  name?: string;
  email?: string;
  /** For a team: the teams it sits in, from the top down. */
  within?: string[];
}

export interface Grant extends Principal {
  level: Level;
  createdBy: string;
  createdAt: string;
}

/** Who may see a library, or one of its documents. */
export interface Access {
  /** Everyone its floor lets in. */
  floor: Principal;
  /** Who has been let into this library, or into this document. */
  grants: Grant[];
  /** For a document or a folder: who has been let into its whole library. */
  library?: Grant[];
  /** For a document: who has been let into a folder it's inside, and so into it. */
  folders?: (Grant & { folder: string })[];
  can: { share: boolean };
}

/** Something in a library to share on its own: one document, or a folder and everything inside it. */
export type AccessTarget = { document: string; folder?: undefined } | { folder: string; document?: undefined };

/** People and teams found to share with. */
export interface Found {
  people: { id: string; name: string; email?: string }[];
  teams: { id: string; name: string; within: string[] }[];
}

/**
 * One version put out to an audience. On a document its audience is principals;
 * from the publishing calls it comes named.
 */
export interface Publication<A = string> {
  id: string;
  document: string;
  library: string;
  version: number;
  /** `team:<id>`, `tree:<id>` or `org`. */
  audience: A[];
  note?: string;
  publishedBy: string;
  publishedAt: string;
  ended?: { as: 'withdrawn' | 'replaced'; by: string; at: string; reason?: string };
}

/** Every time a document was published, newest first, and what the caller may do. */
export interface Publications {
  publications: Publication<Principal>[];
  /** `publishToOrg`: they have the publisher role, so the org and any team are open to them. */
  can: { publish: boolean; publishToOrg: boolean };
}

/** What's out to the caller now, from any floor. */
export interface PublishedPage {
  documents: (FolioDocument & { published: Publication; libraryName: string })[];
  total: number;
}

/** Shared with the caller from other floors. */
export interface Shared {
  libraries: (Library & { level: Level })[];
  documents: (FolioDocument & { level: Level; libraryName: string })[];
}

/** How a version's reader copy is coming along: the rendition worker makes it after upload. */
export interface ReaderState {
  state: 'queued' | 'running' | 'ready' | 'failed';
  /** Why it failed, in words a person can act on. */
  error?: string;
  /** How many pages the original has, when it has pages (PDF). */
  pages?: number;
  thumbnail: boolean;
  engine?: string;
}

export interface DocumentVersion {
  id: string;
  document: string;
  number: number;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  createdBy: string;
  createdAt: string;
  reader: ReaderState;
  state: ContentState;
}

/** How often a series comes out. An ad hoc one has issues but no periods. */
export type Cadence = 'weekly' | 'monthly' | 'quarterly' | 'adhoc';

/** One issue's place in its series: "Week 43, 2026", from the period's first day. */
export interface IssuePlace {
  number: number;
  periodStart: string;
  period: string;
}

/** A named run of documents in one library, such as a weekly report. */
export interface Series {
  id: string;
  workspace: string;
  library: string;
  name: string;
  description: string;
  cadence: Cadence;
  /** Who each issue is published to as it's added: principals, or named from the series' own call. */
  audience: string[];
  tags: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  issues: number;
  last?: IssuePlace & { document: string };
}

/** A series as the caller sees it: the issue it expects next, and what they may do. */
export interface SeriesView extends Series {
  libraryName: string;
  /** `dueBy` is the last day it's on time, once the series has had an issue. */
  next: IssuePlace & { dueAt?: string; dueBy?: string; overdue: boolean };
  following: boolean;
  can: { manage: boolean; addIssue: boolean; publish: boolean };
}

/** An issue either side of the one being read. */
export interface IssueLink {
  id: string;
  library: string;
  title: string;
  number: number;
  period: string;
}

export interface FolioDocument {
  id: string;
  workspace: string;
  library: string;
  folder?: string;
  title: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  latest: DocumentVersion;
  /** Tag ids: the org's or its library's. */
  tags: string[];
  state: DocumentState;
  /** The version out now, when it's published. */
  published?: Publication;
  /** Its place in its series, when it's an issue. */
  issue?: IssuePlace & { series: string };
  /** Why a new issue wasn't published as it was added. */
  draft?: string;
  /** Whether the caller may add versions, retag, retitle, move or delete it, share it, and publish it. */
  can: { change: boolean; share: boolean; publish?: boolean; moves?: ContentState[] };
}

export interface OpenDocument extends FolioDocument {
  /** Newest first. */
  versions: DocumentVersion[];
  /** The name of its library, which the caller may not otherwise see. */
  libraryName: string;
  /** The caller reaches it only as the audience it's published to: this version, and no other. */
  only?: number;
  /** For an issue: its series, the issues either side the caller may read, and whether they follow it. */
  run?: { id: string; name: string; cadence?: Cadence; previous?: IssueLink; next?: IssueLink; following: boolean };
}

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

export interface OpenLibrary extends Library {
  folders: Folder[];
  /** The org's tags and the library's own, by name. */
  tags: Tag[];
  /** Who added its documents. */
  authors: Person[];
  views: SavedView[];
  series: Series[];
  can: LibraryRights;
}

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

/** Folio's service said no; `message` is meant for people. */
export class FolioError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Folio's own API, through the gateway, always for the floor the app is on. */
export class FolioApi {
  constructor(private readonly fetchOnFloor: MountContext['fetch']) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.answer<T>(
      await this.fetchOnFloor(`/api/folio/v1${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      }),
    );
  }

  /** The answer's body, or a FolioError in words people can act on. */
  private async answer<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const problem = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      // The gateway stops a file past the app's limit before Folio sees it, in its own words.
      if (res.status === 413) throw new FolioError(problem.error === 'too-large' && problem.message ? problem.message : `A file can be ${MAX_UPLOAD_MB} MB at most.`, 413, 'too-large');
      throw new FolioError(res.status >= 500 || !problem.message ? 'Artifacts isn’t answering. Try again in a moment.' : problem.message, res.status, problem.error);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** Sends a file as it is, streamed, typed by its ending. */
  private async sendFile<T>(path: string, file: File, query: Record<string, string | undefined>, tags: readonly string[] = []): Promise<T> {
    const kind = fileTypeOf(file.name);
    if (!kind) throw new FolioError('Artifacts takes PDF, Word (.docx), HTML, Markdown and plain text files.', 415, 'unsupported-type');
    const params = new URLSearchParams(Object.entries({ filename: file.name, ...query }).filter((e): e is [string, string] => Boolean(e[1])));
    for (const t of tags) params.append('tag', t);
    return this.answer<T>(await this.fetchOnFloor(`/api/folio/v1${path}?${params}`, { method: 'POST', headers: { 'content-type': kind.type }, body: file }));
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
    const res = await this.fetchOnFloor(`${this.versionPath(library, document, number)}/reader`);
    if (!res.ok) await this.answer(res);
    return res.text();
  }

  /** A picture a version's reader copy shows, by its name there (`1.png`). */
  async readerImage(library: string, document: string, number: number, name: string): Promise<Blob> {
    const res = await this.fetchOnFloor(`${this.versionPath(library, document, number)}/reader/images/${encodeURIComponent(name)}`);
    if (!res.ok) await this.answer(res);
    return res.blob();
  }

  private versionPath(library: string, document: string, number: number) {
    return `/api/folio/v1/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(document)}/versions/${number}`;
  }

  /** A version's file exactly as it was uploaded. Each download goes in the audit log. */
  async original(library: string, document: string, number: number): Promise<Blob> {
    const res = await this.fetchOnFloor(`/api/folio/v1/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(document)}/versions/${number}/original`);
    if (!res.ok) await this.answer(res);
    return res.blob();
  }
}

/**
 * Where a path inside Folio points: `/libraries`, `/libraries/new`, `/libraries/<id>`,
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
}

export const placeFor = (path: string): Place => {
  const [first, second, third, fourth, fifth, sixth] = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (first === 'published') return { published: true, adding: false };
  if (first === 'received') return { received: second || true, adding: false };
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

export const pathFor = ({ library, folder, view, series, document, version, published, received }: Omit<Place, 'adding'>) => {
  if (published && !document) return '/published';
  if (received && !document) return received === true ? '/received' : `/received/${encodeURIComponent(received)}`;
  if (!library) return '/libraries';
  const at = `/libraries/${encodeURIComponent(library)}`;
  if (document) return `${at}/documents/${encodeURIComponent(document)}${version ? `/versions/${version}` : ''}`;
  if (series) return `${at}/series/${encodeURIComponent(series)}`;
  return view ? `${at}/views/${encodeURIComponent(view)}` : folder ? `${at}/${encodeURIComponent(folder)}` : at;
};
