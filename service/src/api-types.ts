/**
 * Artifacts' wire types: what crosses between its frontend and this service, written once.
 *
 * The service owns the API, so the file lives here; the frontend imports it with `import type` by relative
 * path (`../../service/src/api-types`). Types only: nothing here runs, so neither build changes. It imports
 * nothing but types from `@augur/records`, which both sides depend on, so the frontend's typecheck never pulls
 * in the service's own modules.
 *
 * Where the service keeps a record under the same name as what the page is sent, the page's shape is a
 * `...View` here (`DocumentView`, `PlacementView`); the frontend's api.ts gives it the name the pages use.
 */

import type { ContainerState, ContentState, Level, StateChange } from '@augur/records';

export type { ContainerState, ContentState, Level };

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
/** "Changed in the past …": a saved view keeps meaning the past week, not one week. */
export type Since = 'week' | 'month' | 'quarter' | 'year';

/** A document the picker found: with its library, and whether only the version published to the caller is theirs to pick. */
export type Findable = DocumentView & { libraryName: string; audienceOnly: boolean };

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
  /** Changed at or after, or before, this time (ISO). */
  from?: string;
  to?: string;
  /** Issues of this series. */
  series?: string;
  /** Its newest version is in one of these lifecycle states. */
  lifecycle?: ContentState[];
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

/** A move from one lifecycle state to another, on the record: of a version, a folder or a library. */
export interface StateMove extends StateChange<string> {
  /** The library, folder or document it happened to. */
  record: string;
  /** For a document's version, its number. */
  version?: number;
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
  level: UnitLevel;
  name: string;
  library: string;
  libraryName: string;
}

/** One step a record took up the floors, as the caller sees it: what it shows (the filter), from where, and where it landed. */
export interface PlacementView {
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
  placements: PlacementView[];
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

/** A link from or to a record, as the caller sees it: in words, and named for them. */
export interface RecordLinkView {
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
  links: RecordLinkView[];
  /** Links to this record from others. */
  back: RecordLinkView[];
  can: { change: boolean };
}

/** What's been published up to the caller's floor: here, and elsewhere (a higher floor shows it to them). */
export interface Received {
  here: PlacementView[];
  signposts: { placement: string; record: RecordView; to?: FloorView; reached: string }[];
}

/** Inside something received: its folders, and the documents where you are, each at the version the caller sees. */
export interface ReceivedPage {
  placement: PlacementView;
  folders: Folder[];
  folder: string | null;
  documents: (DocumentView & { onlyVia?: FloorView })[];
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

/** Someone let in, as people see them. */
export interface GrantView extends Principal {
  level: Level;
  createdBy: string;
  createdAt: string;
}

/** Who may see a library, or one of its documents. */
export interface Access {
  /** Everyone its floor lets in. */
  floor: Principal;
  /** Who has been let into this library, or into this document. */
  grants: GrantView[];
  /** For a document or a folder: who has been let into its whole library. */
  library?: GrantView[];
  /** For a document: who has been let into a folder it's inside, and so into it. */
  folders?: (GrantView & { folder: string })[];
  /** Published up the floors (it, or what it's inside): who that floor lets in, what it shows there, and the floors it came up through. */
  placed?: (Principal & { filter: ContentState[]; at: string; record: { kind: RecordView['kind']; id: string }; chain: string[] })[];
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
  documents: (DocumentView & { published: Publication; libraryName: string })[];
  total: number;
}

/**
 * Whose floor something shared comes from, as the directory names it: a team's
 * name and the teams it sits in, or a person's name. The org's floor carries no
 * name here: the page names it from the floors the shell gives it.
 */
export interface FloorNamed {
  floorKind: 'person' | 'team' | 'org';
  /** Absent when the directory doesn't know it (gone, or not asked). */
  floorName?: string;
  /** For a team: the teams it sits in, from the top down. */
  within?: string[];
}

/** Shared with the caller from other floors. */
export interface Shared {
  libraries: (Library & FloorNamed & { level: Level })[];
  documents: (DocumentView & FloorNamed & { level: Level; libraryName: string })[];
  /** The directory couldn't be asked, so no floor is named. */
  namesUnavailable?: true;
}

/**
 * Where a version's reader copy is: queued for the rendition worker, being made,
 * ready to read, or failed (with why, after the worker gave up).
 */
export type RenditionState = 'queued' | 'running' | 'ready' | 'failed';

/** How a version's reader copy is coming along: the rendition worker makes it after upload. */
export interface ReaderState {
  state: RenditionState;
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
  /** The series in the library its issues go in: a folder at the series level. */
  folder: string;
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

/** A document's place in its series. */
export interface Issue extends IssuePlace {
  series: string;
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
  issue?: Issue;
}

/** A document as the caller sees it: what they may do with it. */
export type DocumentView = FolioDocument & {
  /** Why a new issue wasn't published as it was added. */
  draft?: string;
  /** Whether the caller may add versions, retag, retitle, move or delete it, share it, and publish it. */
  can: { change: boolean; share: boolean; publish?: boolean; moves?: ContentState[] };
};

export type OpenDocument = DocumentView & {
  /** Newest first. */
  versions: DocumentVersion[];
  /** The name of its library, which the caller may not otherwise see. */
  libraryName: string;
  /** The caller reaches it only as the audience it's published to: this version, and no other. */
  only?: number;
  /** For an issue: its series, the issues either side the caller may read, and whether they follow it. */
  run?: { id: string; name: string; cadence?: Cadence; previous?: IssueLink; next?: IssueLink; following: boolean };
};

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

/** What the service sends when it refuses: a code and words people can act on. */
export interface Problem {
  error: string;
  message: string;
}
