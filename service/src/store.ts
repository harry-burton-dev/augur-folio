import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { CONTAINER_LIFECYCLE, CONTENT_LIFECYCLE, furthest, levelFrom, reaches, type ContainerState, type ContentState, type Level, type LevelName, type StateChange } from '@augur/records';
import { nextIssue, type Cadence, type IssuePlace } from './cadence.ts';
import { UNIT_LEVELS, nextLevel, type FolderLevel, type UnitLevel } from './units.ts';

export { furthest, levelFrom, reaches, type Level };

/** A library: a shelf of documents that belongs to one floor (someone's own, a team's, or the org's). */
export interface Library {
  id: string;
  workspace: string;
  /**
   * Who its floor lets in, as a principal: `person:<owner>` on someone's own
   * floor, `tree:<team>` on a team's (its members and those of the teams below
   * it), `org` on the org's.
   */
  floor: string;
  name: string;
  description: string;
  /** Anyone who may tag a document here may also make new tags, not only pick the library's. */
  freeTags: boolean;
  /** Open to more, closed to more, or archived (off its floor's list). */
  state: ContainerState;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A folder in a library: a subcollection, a series or a subseries, by `level`.
 * Top-level folders have no parent. Which level may sit in which is UNIT_LEVELS'.
 */
export interface Folder {
  id: string;
  library: string;
  parent?: string;
  level: FolderLevel;
  name: string;
  description: string;
  state: ContainerState;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A move from one lifecycle state to another, on the record: of a version, a folder or a library. */
export interface StateMove extends StateChange<string> {
  /** The library, folder or document it happened to. */
  record: string;
  /** For a document's version, its number. */
  version?: number;
}

/** What an org calls a level instead of Folio's own name. */
export type LevelNames = Partial<Record<UnitLevel, LevelName>>;

/** What can be published up the floors: a whole collection, a folder in one, or one document. */
export interface RecordRefIn {
  kind: 'library' | 'folder' | 'document';
  id: string;
}

/**
 * One step of publishing up the floors (docs/app-patterns.md): a record put on
 * a floor above, through a filter of lifecycle states. A live window, never a
 * copy. `from` and `to` are floors: a team's id, someone's own floor's id, or
 * `org`. Steps are kept for good; taking one back ends it.
 */
export interface Placement {
  id: string;
  /** The library the record is in, on its own floor. */
  library: string;
  /** The record's own floor. */
  workspace: string;
  record: RecordRefIn;
  from: string;
  to: string;
  /** Who the floor it went to lets in: `tree:<team>` or `org`. */
  toPrincipal: string;
  filter: ContentState[];
  /** The step it came up through, when a floor that received it published it on. */
  via?: string;
  /** Where it sits in the receiving floor's library; nowhere yet is "From below". */
  landed?: { library: string; folder?: string };
  note?: string;
  by: string;
  at: string;
  ended?: { by: string; at: string; reason?: string };
}

/** What a new step is. */
export type NewPlacement = Omit<Placement, 'id' | 'at' | 'ended' | 'workspace'>;

/** The record is already on that floor. */
export class PlacedError extends Error {}

/** One file as it was uploaded. A document's versions are numbered from 1 and never change. */
export interface DocumentVersion {
  id: string;
  document: string;
  number: number;
  /** The name it had on the uploader's computer. */
  filename: string;
  mediaType: string;
  /** In bytes. */
  size: number;
  /** Hex SHA-256 of the file, so a copy can be shown to be the one that was uploaded. */
  sha256: string;
  createdBy: string;
  createdAt: string;
  /** Where it is in its life: in progress, in review, complete, issued or retired. */
  state: ContentState;
  /** How its reader copy is coming along. */
  reader: ReaderState;
}

/**
 * Where a version's reader copy is: queued for the rendition worker, being made,
 * ready to read, or failed (with why, after the worker gave up).
 */
export type RenditionState = 'queued' | 'running' | 'ready' | 'failed';
export const RENDITION_STATES: readonly RenditionState[] = ['queued', 'running', 'ready', 'failed'];

/** A version's reader copy, as a document's versions show it. */
export interface ReaderState {
  state: RenditionState;
  /** Why it failed, in words a person can act on. */
  error?: string;
  /** How many pages the original has, when it has pages (PDF). */
  pages?: number;
  /** There's a picture of its first page. */
  thumbnail: boolean;
  /** What made it, such as "docling 2.14". */
  engine?: string;
}

/**
 * A version's renditions as the worker left them: its reader copy (Markdown) and
 * the pictures it shows, a thumbnail, and its words as plain text for search.
 * The files are in the bucket under `renditions/<version>/`.
 */
export interface Rendition extends ReaderState {
  version: string;
  attempts: number;
  readerKey?: string;
  thumbnailKey?: string;
  /** The pictures the reader copy shows, by file name (`1.png`), under `images/`. */
  images: string[];
  text?: string;
  updatedAt: string;
}

/** What a rendition came to: what the worker made, or why it couldn't. */
export type RenditionResult =
  | { state: 'ready'; engine: string; engineVersion: string; readerKey: string; thumbnailKey?: string; images: string[]; pages?: number; text: string }
  | { state: 'failed'; error: string };

/** A version's renditions, under its own prefix in the bucket. */
export const renditionPrefix = (version: string) => `renditions/${version}/`;

/** Every file a version left in the bucket: the original, and its reader copy, thumbnail and pictures. */
const keysOfVersion = (v: { id: string; objectKey: string; readerKey?: string | null; thumbnailKey?: string | null; images?: string[] | null }) => [
  v.objectKey,
  ...(v.readerKey ? [v.readerKey] : []),
  ...(v.thumbnailKey ? [v.thumbnailKey] : []),
  ...(v.images ?? []).map((name) => `${renditionPrefix(v.id)}images/${name}`),
];

/** A deleted document past its retention period, with every file of it still in the bucket. */
export interface PurgeableDocument {
  id: string;
  workspace: string;
  library: string;
  title: string;
  deletedAt: string;
  keys: string[];
}

/** A version as the store keeps it: with where its file is in the bucket. */
export interface StoredVersion extends DocumentVersion {
  objectKey: string;
}

/** A document: a title over a run of versions, in a library and perhaps a folder. */
export interface FolioDocument {
  id: string;
  workspace: string;
  library: string;
  folder?: string;
  title: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** The newest version. */
  latest: DocumentVersion;
  /** Its tags, by id: the org's or its library's. */
  tags: string[];
  /** Where it is in being published. */
  state: DocumentState;
  /** The version out now, when it's published. */
  published?: Publication;
  /** Where it comes in its series, when it's an issue of one. */
  issue?: Issue;
}

/**
 * A named run of documents in one library that comes out on a cadence, such
 * as a weekly report. Each issue is a document with a number and a period;
 * the series gives the next one its title, tags and audience.
 */
export interface Series {
  id: string;
  workspace: string;
  library: string;
  name: string;
  description: string;
  cadence: Cadence;
  /** Who each issue is published to when it's added, if anyone: as a publication's audience. */
  audience: string[];
  /** The tags each issue starts with, by id. */
  tags: string[];
  /** The series in the library its issues go in: a folder at the series level. */
  folder: string;
  /** Its owner, who is reminded when an issue is late. */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** How many issues it has. */
  issues: number;
  /** Its newest issue. */
  last?: IssuePlace & { document: string };
}

/** A document's place in its series. */
export interface Issue extends IssuePlace {
  series: string;
}

/** An issue as the reader's previous and next show it. */
export interface IssueLink {
  id: string;
  library: string;
  title: string;
  number: number;
  period: string;
}

/** Where a document is in being published: never yet, out to an audience now, or taken back. */
export type DocumentState = 'draft' | 'published' | 'withdrawn';
export const DOCUMENT_STATES: readonly DocumentState[] = ['draft', 'published', 'withdrawn'];

/**
 * One version put out to an audience, who may then read that version (and only
 * that one) from wherever they are, and are told it's there. Publishing a
 * document again ends the publication before it; so does withdrawing it.
 */
export interface Publication {
  id: string;
  document: string;
  library: string;
  /** The version's number. */
  version: number;
  /** Who it went to: `team:<id>`, `tree:<id>` or `org`. */
  audience: string[];
  /** What the publisher said about it, shown with it. */
  note?: string;
  publishedBy: string;
  publishedAt: string;
  /** How it ended, if it has: withdrawn, or replaced by a later publication. */
  ended?: { as: 'withdrawn' | 'replaced'; by: string; at: string; reason?: string };
}

/** Who a version can be published to: teams, a team and those below it, or the org. People are let in by sharing. */
export const AUDIENCE = /^(?:(?:team|tree):[A-Za-z0-9._@-]{1,100}|org)$/;

/**
 * What Folio tells other apps has happened, through the platform's events
 * (docs/domain-events.md). Payloads carry ids, never titles or text: a
 * follower that needs more asks Folio's API, as someone who may see it.
 */
export const TOPICS = {
  versionCreated: 'folio.document.version.created',
  published: 'folio.document.published',
  withdrawn: 'folio.document.withdrawn',
  deleted: 'folio.document.deleted',
  readersChanged: 'folio.document.readers.changed',
} as const;

/** An event waiting in the outbox. */
export interface OutboxEvent {
  topic: string;
  workspace: string;
  payload: Record<string, unknown>;
}

/**
 * A word to find documents by. The org's tags (no library) are shared by every
 * library; a library's own are its managers' to keep.
 */
export interface Tag {
  id: string;
  workspace: string;
  /** Whose tag it is; none for the org's. */
  library?: string;
  name: string;
  createdBy: string;
  createdAt: string;
}

/** How a list of documents is ordered. */
export type DocumentSort = 'title' | 'newest' | 'updated' | 'period';
export const DOCUMENT_SORTS: readonly DocumentSort[] = ['title', 'newest', 'updated', 'period'];

/** "Changed in the past …", in days, so a saved view keeps meaning the past week, not one week. */
export const SINCE = { week: 7, month: 31, quarter: 92, year: 366 } as const;
export type Since = keyof typeof SINCE;

/** Which documents to list, as the store asks for them. */
export interface DocumentQuery {
  /** The folder; the top of the library when there's none. */
  folder?: string;
  /** Everything inside `folder` too, however deep: the whole library when there's no folder. */
  below?: boolean;
  /** Has every one of these tags. */
  tags?: string[];
  /** Its newest version is one of these. */
  mediaTypes?: string[];
  /** Added by one of these people. */
  authors?: string[];
  /** Changed at or after this time (ISO). */
  from?: string;
  /** Changed before this time (ISO). */
  to?: string;
  sort?: DocumentSort;
  /** Is in one of these states. */
  states?: DocumentState[];
  /** Is an issue of this series. */
  series?: string;
  /** Its newest version is in one of these lifecycle states. */
  lifecycle?: ContentState[];
  limit?: number;
  offset?: number;
  /** Only documents someone who stands for these principals may read. */
  readers?: readonly string[];
  /** With `readers`: also those published to them. */
  audience?: boolean;
}

/** A page of documents, and how many there are in all. */
export interface DocumentPage {
  documents: FolioDocument[];
  total: number;
}

/** A set of filters as people choose them, kept so a saved view means the same tomorrow. */
export interface ViewQuery {
  folder?: string;
  tags?: string[];
  /** File kinds: pdf, word, html, markdown, text. */
  types?: string[];
  authors?: string[];
  since?: Since;
  from?: string;
  to?: string;
  sort?: DocumentSort;
  states?: DocumentState[];
  series?: string;
  lifecycle?: ContentState[];
}

/** A filter set saved in a library, for everyone there, in its side rail. */
export interface SavedView {
  id: string;
  library: string;
  name: string;
  query: ViewQuery;
  createdBy: string;
  createdAt: string;
}

/** Someone who added documents, by the name they last had in Folio. */
export interface Person {
  id: string;
  name: string;
}

/**
 * Who may see something: `person:<id>`, `team:<id>` (that team's members),
 * `tree:<id>` (that team and every team below it), or `org`.
 */
export const PRINCIPAL = /^(?:(?:person|team|tree):[A-Za-z0-9._@-]{1,100}|org)$/;

/** Someone let into a library, or into one document of it. */
export interface Grant {
  library: string;
  /** Just this document; the whole library when there's none. */
  document?: string;
  principal: string;
  level: Level;
  createdBy: string;
  createdAt: string;
}

/** What has been shared with someone from libraries they can't otherwise reach. */
export interface Shared {
  libraries: (Library & { level: Level })[];
  documents: (FolioDocument & { level: Level })[];
}

/** The most documents in one page of a list. */
export const MAX_PAGE = 200;

/** A file that has reached the bucket, ready to be recorded as a version. */
export interface NewVersion {
  id: string;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  objectKey: string;
  createdBy: string;
}

/** Where a version's file goes in Folio's bucket: by document, so moving a document moves nothing. */
export const objectKeyFor = (document: string, version: string) => `documents/${document}/${version}`;


/** Another library on the floor, or another folder beside it, already has the name. */
export class NameTakenError extends Error {}
/** The parent folder isn't in this library, or the new one would go too deep. */
export class BadParentError extends Error {}
/** The folder still has something in it. */
export class NotEmptyError extends Error {}
/** A tag that isn't the org's or this library's. */
export class BadTagError extends Error {}
/** Something new can't go in a closed library or folder. */
export class ClosedError extends Error {}

export interface FolioStore {
  /** The floor's libraries, by name, leaving out archived ones unless asked. */
  libraries(workspace: string, options?: { archived?: boolean }): Promise<Library[]>;
  /** A library, unless it is archived and that wasn't asked for. */
  library(id: string, options?: { archived?: boolean }): Promise<Library | undefined>;
  createLibrary(input: { workspace: string; floor: string; name: string; description?: string; createdBy: string }): Promise<Library>;
  updateLibrary(id: string, change: { name?: string; description?: string; freeTags?: boolean }): Promise<Library | undefined>;
  /** Takes a library off its floor's list, keeping everything in it. */
  archiveLibrary(id: string, by: string): Promise<boolean>;
  /** Moves a library to another state of its lifecycle, on the record; archived takes it off its floor's list. */
  setLibraryState(id: string, to: ContainerState, by: string, note?: string): Promise<Library | undefined>;
  /** A library's folders, by name. */
  folders(library: string): Promise<Folder[]>;
  /**
   * A subcollection, series or subseries: at `level`, or the next level down from
   * its parent. Refused where that level can't go, or where its parent isn't open.
   */
  createFolder(input: { library: string; parent?: string; level?: FolderLevel; name: string; description?: string; createdBy: string }): Promise<Folder>;
  renameFolder(library: string, id: string, name: string): Promise<Folder | undefined>;
  updateFolder(library: string, id: string, change: { name?: string; description?: string }): Promise<Folder | undefined>;
  /** Moves a folder to another state of its lifecycle, on the record. */
  setFolderState(library: string, id: string, to: ContainerState, by: string, note?: string): Promise<Folder | undefined>;
  /** Moves one version of a document to another lifecycle state, on the record. */
  setVersionState(document: string, number: number, to: ContentState, by: string, note?: string): Promise<DocumentVersion | undefined>;
  /** Every lifecycle move of a library, folder or document (its versions'), newest first. */
  stateMoves(record: string): Promise<StateMove[]>;
  /** What the org calls each level, where it has renamed them. */
  levelNames(): Promise<LevelNames>;
  /** Renames a level for the whole org, or with `null` gives it back its own name. */
  setLevelName(level: UnitLevel, name: LevelName | null, by: string): Promise<LevelNames>;
  /** Publishes a record up to a floor. PlacedError when it's already there. */
  place(input: NewPlacement): Promise<Placement>;
  placement(id: string): Promise<Placement | undefined>;
  /** Every step a record has been published by, taken back or not, oldest first. */
  placementsOf(record: string): Promise<Placement[]>;
  /** What's on a floor now, from below, oldest first. */
  placementsOn(floor: string): Promise<Placement[]>;
  /** The steps that show a document now: of it, of a folder it's in, or of its library. */
  covering(document: string): Promise<Placement[]>;
  /**
   * Changes what a step lets through; every step above it that would show more
   * is narrowed to match, and one left showing nothing is taken back.
   */
  setPlacementFilter(id: string, filter: ContentState[], by: string): Promise<Placement | undefined>;
  /** Puts a step somewhere in the receiving floor's library, or with `null` back in "From below". */
  landPlacement(id: string, landed: { library: string; folder?: string } | null): Promise<Placement | undefined>;
  /** Takes these steps back. */
  endPlacements(ids: readonly string[], by: string, reason?: string): Promise<Placement[]>;
  /** Removes an empty folder; false when there was no such folder. */
  deleteFolder(library: string, id: string): Promise<boolean>;
  /** The documents that match, by title unless asked otherwise. */
  documents(library: string, query?: DocumentQuery): Promise<DocumentPage>;
  /** A document, unless it was deleted. */
  document(id: string): Promise<FolioDocument | undefined>;
  /** A document's versions, newest first. */
  versions(document: string): Promise<DocumentVersion[]>;
  version(document: string, number: number): Promise<StoredVersion | undefined>;
  /**
   * A new document with its first version. The folder must be in the library.
   * With `series` (one of the library's) it is that series' next issue.
   */
  createDocument(input: NewDocument, first: NewVersion): Promise<FolioDocument>;
  /** The next version of a document, or undefined when there is no such document. */
  addVersion(document: string, version: NewVersion): Promise<DocumentVersion | undefined>;
  /** Retitles a document, or moves it: `folder: null` moves it to the top of its library. */
  updateDocument(id: string, change: { title?: string; folder?: string | null }): Promise<FolioDocument | undefined>;
  /** Takes a document out of its library, keeping its files and versions. */
  deleteDocument(id: string, by: string): Promise<boolean>;
  /** Deleted documents, oldest deletion first, deleted before `before` and not yet cleared away. */
  purgeable(before: string, limit: number): Promise<PurgeableDocument[]>;
  /**
   * Records that a deleted document's files are gone, and forgets its text. Its record stays, for
   * the audit log to name. False when it was already cleared (another instance got there first).
   */
  markPurged(id: string): Promise<boolean>;
  /** Gives a document exactly these tags. Each must be the org's or its library's. */
  setDocumentTags(id: string, tags: string[]): Promise<FolioDocument | undefined>;
  /** The tags a library's documents can have: the org's and its own, by name. */
  tags(library: string): Promise<Tag[]>;
  /** The org's tags, by name. */
  orgTags(): Promise<Tag[]>;
  tag(id: string): Promise<Tag | undefined>;
  /**
   * A new tag for a library, or for the org when there's no library. A library's
   * tag can't have an org tag's name; a new org tag takes in the libraries' tags
   * of its name, so documents tagged with them carry the org's.
   */
  createTag(input: { workspace: string; library?: string; name: string; createdBy: string }): Promise<Tag>;
  renameTag(id: string, name: string): Promise<Tag | undefined>;
  /** Removes a tag from every document and saved view that had it. */
  deleteTag(id: string): Promise<boolean>;
  /** Who added the library's documents, by name. */
  authors(library: string): Promise<Person[]>;
  /** Remembers the name someone has now, to show them by. */
  notePerson(person: Person): Promise<void>;
  /** The people Folio has seen, by name or by id: who to share with when identity can't say. */
  people(query: { q?: string; ids?: readonly string[] }): Promise<Person[]>;
  views(library: string): Promise<SavedView[]>;
  view(id: string): Promise<SavedView | undefined>;
  createView(input: { library: string; name: string; query: ViewQuery; createdBy: string }): Promise<SavedView>;
  updateView(id: string, change: { name?: string; query?: ViewQuery }): Promise<SavedView | undefined>;
  deleteView(id: string): Promise<boolean>;
  /** A version's renditions, by the version's id. */
  rendition(version: string): Promise<Rendition | undefined>;
  /** Queues a failed rendition again, from its first attempt; false unless it had failed. */
  retryRendition(version: string): Promise<boolean>;
  /** Records what a rendition came to. The worker does this itself; here for tests and `pnpm dev:app`. */
  finishRendition(version: string, result: RenditionResult): Promise<void>;
  /** Who has been let into a library (no document), or into one of its documents. */
  grants(library: string, document?: string): Promise<Grant[]>;
  /** Lets a principal in that far, or with `level: null` takes them out. Each document's readers follow. */
  setGrant(input: { library: string; document?: string; principal: string; level: Level | null; by: string }): Promise<Grant | undefined>;
  /** Everyone who may read a document: its library's floor, and whoever has been let into the library or the document. */
  readers(document: string): Promise<string[]>;
  /** What has been shared with these principals, in libraries on floors other than `except`. */
  shared(principals: readonly string[], except: string): Promise<Shared>;
  /** Publishes a version to an audience, ending the publication before it. Undefined when there's no such document or version. */
  publish(input: { document: string; version: number; audience: string[]; note?: string; by: string }): Promise<Publication | undefined>;
  /** Ends the document's publication; undefined when nothing was out. */
  withdraw(input: { document: string; by: string; reason?: string }): Promise<Publication | undefined>;
  /** A document's publications, newest first. */
  publications(document: string): Promise<Publication[]>;
  /** What is out now to anyone who stands for these principals, newest first, with each one's library's name. */
  publishedTo(principals: readonly string[], page?: { limit?: number; offset?: number; since?: string }): Promise<PublishedPage>;
  /** When someone last looked at what's published to them (ISO), if they ever have. */
  lookedAt(person: string): Promise<string | undefined>;
  /** Notes that someone has just looked at what's published to them. */
  markLooked(person: string, at?: string): Promise<void>;
  /** Drafts in the floor's libraries in use, the most recently changed first, with each one's library's name. */
  draftsOn(workspace: string, page?: { limit?: number }): Promise<{ documents: (FolioDocument & { libraryName: string })[]; total: number }>;
  /** Documents someone who stands for these principals may read, or has had published to them, matching every word of `q` (by title, tag or text), best first. */
  search(principals: readonly string[], q: string, limit?: number): Promise<SearchHit[]>;
  /** A library's series, by name. */
  seriesIn(library: string): Promise<Series[]>;
  series(id: string): Promise<Series | undefined>;
  /**
   * A series with a schedule. Each tag must be the org's or the library's. With
   * `folder` (a series in the library without one) it gives that series its
   * schedule; otherwise it makes the series, in `parent` or at the top.
   */
  createSeries(input: { library: string; folder?: string; parent?: string; name: string; description?: string; cadence: Cadence; audience?: string[]; tags?: string[]; createdBy: string }): Promise<Series>;
  updateSeries(id: string, change: { name?: string; description?: string; cadence?: Cadence; audience?: string[]; tags?: string[] }): Promise<Series | undefined>;
  /** Removes a series that has no issues; false when there was no such series. */
  deleteSeries(id: string): Promise<boolean>;
  /** The issues either side of one, among those someone who stands for these principals may read or has been published. */
  neighbours(document: string, principals: readonly string[]): Promise<{ previous?: IssueLink; next?: IssueLink }>;
  /** Starts or stops telling someone of each new issue. */
  follow(series: string, person: string, on: boolean): Promise<void>;
  /** Everyone following a series. */
  followers(series: string): Promise<string[]>;
  /** Every series that isn't ad hoc and has had an issue: the ones that can be late. */
  timedSeries(): Promise<Series[]>;
  /** Notes that the owner was told the issue for `periodStart` is late; false if someone already noted it. */
  markReminded(series: string, periodStart: string): Promise<boolean>;
}

/** What a new document is. */
export interface NewDocument {
  id: string;
  library: string;
  folder?: string;
  title: string;
  createdBy: string;
  tags?: string[];
  /** Makes it this series' next issue. */
  series?: string;
}

/** A document Find turned up: its library, and whether the person reaches it only as the audience it's published to. */
export interface SearchHit {
  document: FolioDocument;
  libraryName: string;
  /** Read only as its audience: Find matched the version published to them, not the newest. */
  audienceOnly: boolean;
}

/** The most words Find looks for at once. */
const MAX_SEARCH_WORDS = 8;

/** What someone typed, as the words Find looks for: lower case, letters and digits, each the start of a word. */
export const searchWords = (q: string) => [...new Set((q.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => w.slice(0, 64)))].slice(0, MAX_SEARCH_WORDS);

/** The words as a Postgres text-search query: every one, each as a prefix. */
const tsQueryOf = (words: readonly string[]) => words.map((w) => `${w}:*`).join(' & ');

/** Documents published to someone, newest first, and how many there are in all. */
export interface PublishedPage {
  documents: (FolioDocument & { published: Publication; libraryName: string })[];
  total: number;
}

const sameName = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();
const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/**
 * Checks a folder can go in `parent` (the top of the library when there's none)
 * at `level`, or at the next level down when it doesn't say, and gives the level.
 */
export const checkPlace = (folders: readonly Pick<Folder, 'id' | 'level'>[], parent: string | undefined, level?: FolderLevel, levels = UNIT_LEVELS): FolderLevel => {
  const above = parent ? folders.find((f) => f.id === parent) : undefined;
  if (parent && !above) throw new BadParentError('That folder isn’t in this library.');
  const parentLevel: UnitLevel = above?.level ?? 'collection';
  const wanted = level ?? nextLevel(parentLevel) ?? 'subseries';
  const refusal = levels.refusal(parentLevel, wanted);
  if (refusal) throw new BadParentError(refusal);
  return wanted;
};

/** The folders from the top of the library down to `folder`, itself included. */
const folderPath = <F extends Pick<Folder, 'id' | 'parent'>>(folders: readonly F[], folder: string | undefined) => {
  const path: F[] = [];
  for (let at = folder ? folders.find((f) => f.id === folder) : undefined; at && !path.includes(at); at = at.parent ? folders.find((f) => f.id === at!.parent) : undefined) path.unshift(at);
  return path;
};

/** Refuses something new in `folder` (or at the top of the library) when it, or anything it's in, isn't open. */
export const checkOpen = (library: Pick<Library, 'name' | 'state'>, folders: readonly Pick<Folder, 'id' | 'parent' | 'name' | 'state'>[], folder: string | undefined) => {
  const shut = [library, ...folderPath(folders, folder)].find((u) => u.state !== 'open');
  if (shut) throw new ClosedError(`${shut.name} is ${CONTAINER_LIFECYCLE.get(shut.state).name.toLowerCase()}: nothing new can go in it. Whoever manages it can open it again.`);
};

const byTitle = (a: FolioDocument, b: FolioDocument) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
const newestFirst = (key: 'createdAt' | 'updatedAt') => (a: FolioDocument, b: FolioDocument) => b[key].localeCompare(a[key]) || b.id.localeCompare(a.id);
/** Issues by period, newest first, then everything else newest first. */
const byPeriod = (a: FolioDocument, b: FolioDocument) =>
  (b.issue?.periodStart ?? '').localeCompare(a.issue?.periodStart ?? '') || (b.issue?.number ?? 0) - (a.issue?.number ?? 0) || newestFirst('createdAt')(a, b);
const ORDER: Record<DocumentSort, (a: FolioDocument, b: FolioDocument) => number> = { title: byTitle, newest: newestFirst('createdAt'), updated: newestFirst('updatedAt'), period: byPeriod };
const publicVersion = ({ objectKey: _, ...version }: StoredVersion): DocumentVersion => version;
const copyPublication = (p: Publication): Publication => ({ ...p, audience: [...p.audience], ...(p.ended ? { ended: { ...p.ended } } : {}) });
/** A document's state, from its newest publication. A replaced one always has a newer one. */
const stateOf = (last: Publication | undefined): DocumentState => (!last ? 'draft' : last.ended ? 'withdrawn' : 'published');

/** What a document's versions show of a rendition. */
const readerOf = (r: Pick<Rendition, 'state' | 'error' | 'pages' | 'thumbnailKey' | 'engine'>): ReaderState => ({
  state: r.state,
  ...(r.error ? { error: r.error } : {}),
  ...(r.pages ? { pages: r.pages } : {}),
  thumbnail: Boolean(r.thumbnailKey),
  ...(r.engine ? { engine: r.engine } : {}),
});

const QUEUED: ReaderState = { state: 'queued', thumbnail: false };

/** `folder` and every folder inside it. */
const subtree = (folders: readonly Folder[], folder: string) => {
  const ids = new Set<string | undefined>([folder]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of folders)
      if (f.parent && ids.has(f.parent) && !ids.has(f.id)) {
        ids.add(f.id);
        grew = true;
      }
  }
  return ids;
};

/** Tags with `from` swapped for `to`, or dropped when there's no `to`. */
const retagged = (tags: readonly string[], from: ReadonlySet<string>, to?: string) =>
  [...new Set(tags.map((t) => (from.has(t) ? to : t)).filter((t): t is string => Boolean(t)))];

/** A view's tags with `from` swapped for `to`, or dropped when there's no `to`. */
const retag = (query: ViewQuery, from: ReadonlySet<string>, to?: string): ViewQuery => {
  if (!query.tags?.some((t) => from.has(t))) return query;
  return { ...query, tags: retagged(query.tags, from, to) };
};

/** Just the place of an issue, from what the series expects next. */
const pickPlace = ({ number, periodStart, period }: IssuePlace): IssuePlace => ({ number, periodStart, period });

/** An issue as previous and next show it. */
const linkTo = (d: Pick<FolioDocument, 'id' | 'library' | 'title' | 'issue'>): IssueLink => ({ id: d.id, library: d.library, title: d.title, number: d.issue!.number, period: d.issue!.period });

const pageOf = (query: DocumentQuery) => ({ limit: Math.min(query.limit ?? MAX_PAGE, MAX_PAGE), offset: query.offset ?? 0 });

/** Keeps everything in memory: for tests and `pnpm dev:app`. */
export class MemoryFolioStore implements FolioStore {
  private readonly shelves = new Map<string, Library & { archivedAt?: string }>();
  private readonly folderList: Folder[] = [];
  private readonly docs = new Map<string, Omit<FolioDocument, 'latest' | 'tags' | 'state' | 'published'> & { deletedAt?: string; purgedAt?: string }>();
  private readonly versionList: Omit<StoredVersion, 'reader'>[] = [];
  private readonly renditions = new Map<string, Rendition>();
  private readonly tagList: Tag[] = [];
  private readonly docTags = new Map<string, Set<string>>();
  private readonly viewList: SavedView[] = [];
  private readonly seen = new Map<string, string>();
  private readonly grantList: Grant[] = [];
  private readonly pubs: Publication[] = [];
  private readonly seriesList: (Omit<Series, 'issues' | 'last'> & { remindedFor?: string })[] = [];
  private readonly following = new Map<string, Set<string>>();
  private readonly looked = new Map<string, string>();
  private readonly moves: StateMove[] = [];
  private names: LevelNames = {};
  private readonly placementList: Placement[] = [];
  /** What Folio would have told other apps, oldest first: there's no relay without Postgres. */
  readonly outbox: OutboxEvent[] = [];
  /** Hears of each version as its rendition is queued: a stand-in for the worker under `pnpm dev:app`. */
  onQueued?: (version: StoredVersion) => Promise<void>;

  async libraries(workspace: string, { archived = false }: { archived?: boolean } = {}) {
    return [...this.shelves.values()].filter((l) => l.workspace === workspace && (archived || !l.archivedAt)).map(({ archivedAt: _, ...l }) => ({ ...l })).sort(byName);
  }

  async library(id: string, { archived = false }: { archived?: boolean } = {}) {
    const found = this.shelves.get(id);
    if (!found || (found.archivedAt && !archived)) return undefined;
    const { archivedAt: _, ...library } = found;
    return { ...library };
  }

  async createLibrary({ workspace, floor, name, description = '', createdBy }: { workspace: string; floor: string; name: string; description?: string; createdBy: string }) {
    if ((await this.libraries(workspace)).some((l) => sameName(l.name, name))) throw new NameTakenError(`There’s already a library called ${name} here.`);
    const now = new Date().toISOString();
    const library: Library = { id: randomUUID(), workspace, floor, name, description, freeTags: false, state: 'open', createdBy, createdAt: now, updatedAt: now };
    this.shelves.set(library.id, { ...library });
    return library;
  }

  async updateLibrary(id: string, change: { name?: string; description?: string; freeTags?: boolean }) {
    const library = await this.library(id);
    if (!library) return undefined;
    if (change.name !== undefined && (await this.libraries(library.workspace)).some((l) => l.id !== id && sameName(l.name, change.name!)))
      throw new NameTakenError(`There’s already a library called ${change.name} here.`);
    const defined = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined));
    const next = { ...library, ...defined, updatedAt: new Date().toISOString() };
    this.shelves.set(id, next);
    return next;
  }

  async archiveLibrary(id: string, by: string) {
    return Boolean(await this.setLibraryState(id, 'archived', by));
  }

  async setLibraryState(id: string, to: ContainerState, by: string, note?: string) {
    const found = this.shelves.get(id);
    if (!found || found.state === to) return undefined;
    const at = new Date().toISOString();
    this.moves.push({ record: id, from: found.state, to, by, at, ...(note ? { note } : {}) });
    found.state = to;
    found.updatedAt = at;
    if (to === 'archived') found.archivedAt = at;
    else delete found.archivedAt;
    const { archivedAt: _, ...library } = found;
    return { ...library };
  }

  async folders(library: string) {
    return this.folderList.filter((f) => f.library === library).map((f) => ({ ...f })).sort(byName);
  }

  async createFolder({ library, parent, level, name, description = '', createdBy }: { library: string; parent?: string; level?: FolderLevel; name: string; description?: string; createdBy: string }) {
    const shelf = await this.library(library);
    if (!shelf) throw new BadParentError('There’s no such library.');
    const folders = await this.folders(library);
    const placed = checkPlace(folders, parent, level);
    checkOpen(shelf, folders, parent);
    if (folders.some((f) => f.parent === parent && sameName(f.name, name))) throw new NameTakenError(`There’s already something called ${name} there.`);
    const now = new Date().toISOString();
    const folder: Folder = { id: randomUUID(), library, ...(parent ? { parent } : {}), level: placed, name, description, state: 'open', createdBy, createdAt: now, updatedAt: now };
    this.folderList.push(folder);
    return { ...folder };
  }

  async renameFolder(library: string, id: string, name: string) {
    return this.updateFolder(library, id, { name });
  }

  async updateFolder(library: string, id: string, change: { name?: string; description?: string }) {
    const folder = this.folderList.find((f) => f.library === library && f.id === id);
    if (!folder) return undefined;
    if (change.name !== undefined && this.folderList.some((f) => f.library === library && f.id !== id && f.parent === folder.parent && sameName(f.name, change.name!)))
      throw new NameTakenError(`There’s already something called ${change.name} there.`);
    if (change.name !== undefined) {
      folder.name = change.name;
      for (const run of this.seriesList) if (run.folder === id) run.name = change.name;
    }
    if (change.description !== undefined) folder.description = change.description;
    folder.updatedAt = new Date().toISOString();
    return { ...folder };
  }

  async setFolderState(library: string, id: string, to: ContainerState, by: string, note?: string) {
    const folder = this.folderList.find((f) => f.library === library && f.id === id);
    if (!folder || folder.state === to) return undefined;
    const at = new Date().toISOString();
    this.moves.push({ record: id, from: folder.state, to, by, at, ...(note ? { note } : {}) });
    folder.state = to;
    folder.updatedAt = at;
    return { ...folder };
  }

  async setVersionState(document: string, number: number, to: ContentState, by: string, note?: string) {
    const doc = this.docs.get(document);
    const version = this.versionList.find((v) => v.document === document && v.number === number);
    if (!doc || doc.deletedAt || !version || version.state === to) return undefined;
    const at = new Date().toISOString();
    this.moves.push({ record: document, version: number, from: version.state, to, by, at, ...(note ? { note } : {}) });
    version.state = to;
    doc.updatedAt = at;
    return publicVersion(this.withReader(version));
  }

  async stateMoves(record: string) {
    return this.moves.filter((m) => m.record === record).reverse().map((m) => ({ ...m }));
  }

  async levelNames() {
    return structuredClone(this.names);
  }

  async setLevelName(level: UnitLevel, name: LevelName | null) {
    if (name) this.names[level] = { ...name };
    else delete this.names[level];
    return this.levelNames();
  }

  async place(input: NewPlacement) {
    const shelf = this.shelves.get(input.library);
    if (!shelf) throw new BadParentError('There’s no such library.');
    if (this.placementList.some((p) => !p.ended && p.record.id === input.record.id && p.to === input.to)) throw new PlacedError('It’s already on that floor.');
    const placed: Placement = { ...structuredClone(input), id: randomUUID(), workspace: shelf.workspace, filter: CONTENT_LIFECYCLE.tidy(input.filter), at: new Date().toISOString() };
    this.placementList.push(placed);
    return structuredClone(placed);
  }

  async placement(id: string) {
    const found = this.placementList.find((p) => p.id === id);
    return found && structuredClone(found);
  }

  async placementsOf(record: string) {
    return structuredClone(this.placementList.filter((p) => p.record.id === record));
  }

  async placementsOn(floor: string) {
    return structuredClone(this.placementList.filter((p) => !p.ended && p.to === floor));
  }

  async covering(document: string) {
    const doc = this.docs.get(document);
    if (!doc || doc.deletedAt) return [];
    const around = new Set([document, doc.library, ...folderPath(this.folderList, doc.folder).map((f) => f.id)]);
    return structuredClone(this.placementList.filter((p) => !p.ended && around.has(p.record.id)));
  }

  async setPlacementFilter(id: string, filter: ContentState[], by: string) {
    const found = this.placementList.find((p) => p.id === id && !p.ended);
    if (!found) return undefined;
    found.filter = CONTENT_LIFECYCLE.tidy(filter);
    // Nothing above can show more than it now does; what's left showing nothing is taken back.
    const at = new Date().toISOString();
    for (let grew = true, narrowed = new Set([id]); grew; ) {
      grew = false;
      for (const p of this.placementList)
        if (!p.ended && p.via && narrowed.has(p.via) && !narrowed.has(p.id)) {
          const below = this.placementList.find((b) => b.id === p.via)!;
          const kept = p.filter.filter((s) => below.filter.includes(s));
          if (kept.length) p.filter = kept;
          else p.ended = { by, at, reason: 'It no longer showed anything.' };
          narrowed.add(p.id);
          grew = true;
        }
    }
    return structuredClone(found);
  }

  async landPlacement(id: string, landed: { library: string; folder?: string } | null) {
    const found = this.placementList.find((p) => p.id === id && !p.ended);
    if (!found) return undefined;
    if (landed) found.landed = { ...landed };
    else delete found.landed;
    return structuredClone(found);
  }

  async endPlacements(ids: readonly string[], by: string, reason?: string) {
    const at = new Date().toISOString();
    const ended = this.placementList.filter((p) => ids.includes(p.id) && !p.ended);
    for (const p of ended) p.ended = { by, at, ...(reason ? { reason } : {}) };
    return structuredClone(ended);
  }

  async deleteFolder(library: string, id: string) {
    const folders = await this.folders(library);
    if (!folders.some((f) => f.id === id)) return false;
    if (folders.some((f) => f.parent === id)) throw new NotEmptyError('Empty the folder first: it has folders in it.');
    if ([...this.docs.values()].some((d) => d.folder === id && !d.deletedAt)) throw new NotEmptyError('Empty the folder first: it has documents in it.');
    this.folderList.splice(this.folderList.findIndex((f) => f.id === id), 1);
    // An empty series takes its schedule with it, and what had landed in it goes back to "From below".
    for (const run of this.seriesList.filter((r) => r.folder === id)) await this.deleteSeries(run.id);
    for (const p of this.placementList) if (p.landed?.folder === id) delete p.landed;
    return true;
  }

  private withLatest(doc: Omit<FolioDocument, 'latest' | 'tags' | 'state' | 'published'> & { deletedAt?: string }): FolioDocument {
    const { deletedAt: _, ...rest } = doc;
    const latest = this.versionList.filter((v) => v.document === doc.id).reduce((a, b) => (b.number > a.number ? b : a));
    const [last] = this.publicationsOf(doc.id);
    const published = last && !last.ended ? { published: copyPublication(last) } : {};
    return { ...rest, latest: publicVersion(this.withReader(latest)), tags: [...(this.docTags.get(doc.id) ?? [])].sort(), state: stateOf(last), ...published };
  }

  /** A document's publications, newest first, as kept. */
  private publicationsOf(document: string) {
    return this.pubs.filter((p) => p.document === document).reverse();
  }

  private tell(topic: string, workspace: string, payload: Record<string, unknown>) {
    this.outbox.push({ topic, workspace, payload });
  }

  private withReader(version: Omit<StoredVersion, 'reader'>): StoredVersion {
    const rendition = this.renditions.get(version.id);
    return { ...version, reader: rendition ? readerOf(rendition) : QUEUED };
  }

  /** A new version's rendition, queued for the worker. */
  private queue(version: string, at: string) {
    this.renditions.set(version, { version, state: 'queued', attempts: 0, thumbnail: false, images: [], updatedAt: at });
    const stored = this.versionList.find((v) => v.id === version);
    const hear = this.onQueued;
    if (stored && hear) setImmediate(() => void hear(this.withReader(stored)).catch(() => undefined));
  }

  private async checkFolder(library: string, folder: string | undefined) {
    if (folder && !(await this.folders(library)).some((f) => f.id === folder)) throw new BadParentError('That folder isn’t in this library.');
  }

  private checkTags(library: string, tags: readonly string[]) {
    for (const id of tags) {
      const tag = this.tagList.find((t) => t.id === id);
      if (!tag || (tag.library && tag.library !== library)) throw new BadTagError('That tag isn’t the org’s or this library’s.');
    }
  }

  /** Whether someone who stands for `principals` may read the document, or (with `audience`) has had it published to them. */
  private visibleTo(d: { id: string; library: string }, principals: readonly string[], audience: boolean) {
    if (this.readersOf(d.library, d.id).some((p) => principals.includes(p))) return true;
    const [last] = this.publicationsOf(d.id);
    return audience && Boolean(last && !last.ended && last.audience.some((a) => principals.includes(a)));
  }

  async documents(library: string, query: DocumentQuery = {}) {
    const places: ReadonlySet<string | undefined> | undefined = query.below ? (query.folder ? subtree(await this.folders(library), query.folder) : undefined) : new Set([query.folder]);
    const matching = [...this.docs.values()]
      .filter((d) => d.library === library && !d.deletedAt && (!places || places.has(d.folder)))
      .filter((d) => !query.series || d.issue?.series === query.series)
      .filter((d) => !query.readers || this.visibleTo(d, query.readers, Boolean(query.audience)))
      .map((d) => this.withLatest(d))
      .filter(
        (d) =>
          (!query.tags?.length || query.tags.every((t) => d.tags.includes(t))) &&
          (!query.mediaTypes?.length || query.mediaTypes.includes(d.latest.mediaType)) &&
          (!query.authors?.length || query.authors.includes(d.createdBy)) &&
          (!query.from || d.updatedAt >= new Date(query.from).toISOString()) &&
          (!query.to || d.updatedAt < new Date(query.to).toISOString()) &&
          (!query.states?.length || query.states.includes(d.state)) &&
          (!query.lifecycle?.length || query.lifecycle.includes(d.latest.state)),
      )
      .sort(ORDER[query.sort ?? 'title']);
    const { limit, offset } = pageOf(query);
    return { documents: matching.slice(offset, offset + limit), total: matching.length };
  }

  async document(id: string) {
    const doc = this.docs.get(id);
    return doc && !doc.deletedAt ? this.withLatest(doc) : undefined;
  }

  async versions(document: string) {
    return this.versionList
      .filter((v) => v.document === document)
      .sort((a, b) => b.number - a.number)
      .map((v) => publicVersion(this.withReader(v)));
  }

  async version(document: string, number: number) {
    const found = this.versionList.find((v) => v.document === document && v.number === number);
    return found && this.withReader(found);
  }

  async createDocument({ id, library, folder: asked, title, createdBy, tags = [], series }: NewDocument, first: NewVersion) {
    const shelf = await this.library(library);
    if (!shelf) throw new BadParentError('There’s no such library.');
    const run = series ? await this.series(series) : undefined;
    if (series && run?.library !== library) throw new BadParentError('That series isn’t in this library.');
    // An issue goes in its series, wherever it was dropped.
    const folder = run?.folder ?? asked;
    await this.checkFolder(library, folder);
    checkOpen(shelf, await this.folders(library), folder);
    this.checkTags(library, tags);
    const issue = run && { series: run.id, ...pickPlace(nextIssue(run.cadence, run.last)) };
    const now = new Date().toISOString();
    this.docs.set(id, { id, workspace: shelf.workspace, library, ...(folder ? { folder } : {}), title, createdBy, createdAt: now, updatedAt: now, ...(issue ? { issue } : {}) });
    this.versionList.push({ ...first, document: id, number: 1, state: CONTENT_LIFECYCLE.initial, createdAt: now });
    this.queue(first.id, now);
    if (tags.length) this.docTags.set(id, new Set(tags));
    this.tell(TOPICS.versionCreated, shelf.workspace, { document: id, library, version: 1 });
    return this.withLatest(this.docs.get(id)!);
  }

  async addVersion(document: string, version: NewVersion) {
    const doc = this.docs.get(document);
    if (!doc || doc.deletedAt) return undefined;
    const number = Math.max(...this.versionList.filter((v) => v.document === document).map((v) => v.number)) + 1;
    const stored = { ...version, document, number, state: CONTENT_LIFECYCLE.initial, createdAt: new Date().toISOString() };
    this.versionList.push(stored);
    this.queue(stored.id, stored.createdAt);
    doc.updatedAt = stored.createdAt;
    this.tell(TOPICS.versionCreated, doc.workspace, { document, library: doc.library, version: number });
    return publicVersion(this.withReader(stored));
  }

  async updateDocument(id: string, change: { title?: string; folder?: string | null }) {
    const doc = this.docs.get(id);
    if (!doc || doc.deletedAt) return undefined;
    if (change.folder) await this.checkFolder(doc.library, change.folder);
    if (change.title !== undefined) doc.title = change.title;
    if (change.folder !== undefined) {
      if (change.folder) doc.folder = change.folder;
      else delete doc.folder;
    }
    doc.updatedAt = new Date().toISOString();
    return this.withLatest(doc);
  }

  async purgeable(before: string, limit: number) {
    return [...this.docs.values()]
      .filter((d) => d.deletedAt && !d.purgedAt && d.deletedAt < before)
      .sort((a, b) => a.deletedAt!.localeCompare(b.deletedAt!))
      .slice(0, limit)
      .map((d) => ({
        id: d.id,
        workspace: d.workspace,
        library: d.library,
        title: d.title,
        deletedAt: d.deletedAt!,
        keys: this.versionList.filter((v) => v.document === d.id).flatMap((v) => keysOfVersion({ ...v, ...this.renditions.get(v.id) })),
      }));
  }

  async markPurged(id: string) {
    const doc = this.docs.get(id);
    if (!doc?.deletedAt || doc.purgedAt) return false;
    doc.purgedAt = new Date().toISOString();
    for (const v of this.versionList.filter((v) => v.document === id)) {
      const r = this.renditions.get(v.id);
      if (r) delete r.text;
    }
    return true;
  }

  async deleteDocument(id: string) {
    const doc = this.docs.get(id);
    if (!doc || doc.deletedAt) return false;
    doc.deletedAt = new Date().toISOString();
    this.tell(TOPICS.deleted, doc.workspace, { document: id, library: doc.library });
    return true;
  }

  async setDocumentTags(id: string, tags: string[]) {
    const doc = this.docs.get(id);
    if (!doc || doc.deletedAt) return undefined;
    this.checkTags(doc.library, tags);
    this.docTags.set(id, new Set(tags));
    return this.withLatest(doc);
  }

  async tags(library: string) {
    return this.tagList.filter((t) => !t.library || t.library === library).map((t) => ({ ...t })).sort(byName);
  }

  async orgTags() {
    return this.tagList.filter((t) => !t.library).map((t) => ({ ...t })).sort(byName);
  }

  async tag(id: string) {
    const tag = this.tagList.find((t) => t.id === id);
    return tag && { ...tag };
  }

  /** Before `tag` takes `name`: refuses a clash, and for an org tag takes in the libraries' tags of that name. */
  private claim(tag: Pick<Tag, 'id' | 'library'>, name: string) {
    const clash = this.tagList.find((t) => t.id !== tag.id && sameName(t.name, name) && (!t.library || t.library === tag.library));
    if (clash) throw new NameTakenError(clash.library || !tag.library ? `There’s already a tag called ${name}.` : `${clash.name} is already one of the org’s tags.`);
    if (tag.library) return;
    const absorbed = new Set(this.tagList.filter((t) => t.library && sameName(t.name, name)).map((t) => t.id));
    if (!absorbed.size) return;
    for (const set of this.docTags.values()) {
      if (![...set].some((t) => absorbed.has(t))) continue;
      for (const t of absorbed) set.delete(t);
      set.add(tag.id);
    }
    for (const view of this.viewList) view.query = retag(view.query, absorbed, tag.id);
    for (const run of this.seriesList) run.tags = retagged(run.tags, absorbed, tag.id).sort();
    for (let i = this.tagList.length - 1; i >= 0; i--) if (absorbed.has(this.tagList[i].id)) this.tagList.splice(i, 1);
  }

  async createTag({ workspace, library, name, createdBy }: { workspace: string; library?: string; name: string; createdBy: string }) {
    const tag: Tag = { id: randomUUID(), workspace, ...(library ? { library } : {}), name, createdBy, createdAt: new Date().toISOString() };
    this.claim(tag, name);
    this.tagList.push(tag);
    return { ...tag };
  }

  async renameTag(id: string, name: string) {
    const tag = this.tagList.find((t) => t.id === id);
    if (!tag) return undefined;
    this.claim(tag, name);
    tag.name = name;
    return { ...tag };
  }

  async deleteTag(id: string) {
    const at = this.tagList.findIndex((t) => t.id === id);
    if (at < 0) return false;
    this.tagList.splice(at, 1);
    for (const set of this.docTags.values()) set.delete(id);
    for (const view of this.viewList) view.query = retag(view.query, new Set([id]));
    for (const run of this.seriesList) run.tags = retagged(run.tags, new Set([id])).sort();
    return true;
  }

  async authors(library: string) {
    const ids = new Set([...this.docs.values()].filter((d) => d.library === library && !d.deletedAt).map((d) => d.createdBy));
    return [...ids].map((id) => ({ id, name: this.seen.get(id) ?? '' })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async notePerson({ id, name }: Person) {
    this.seen.set(id, name);
  }

  async people({ q, ids }: { q?: string; ids?: readonly string[] }) {
    const word = q?.trim().toLocaleLowerCase();
    return [...this.seen]
      .filter(([id, name]) => (ids ? ids.includes(id) : !word || name.toLocaleLowerCase().includes(word)))
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async views(library: string) {
    return this.viewList.filter((v) => v.library === library).map((v) => ({ ...v })).sort(byName);
  }

  async view(id: string) {
    const view = this.viewList.find((v) => v.id === id);
    return view && { ...view };
  }

  async createView({ library, name, query, createdBy }: { library: string; name: string; query: ViewQuery; createdBy: string }) {
    if (this.viewList.some((v) => v.library === library && sameName(v.name, name))) throw new NameTakenError(`There’s already a view called ${name} here.`);
    const view: SavedView = { id: randomUUID(), library, name, query, createdBy, createdAt: new Date().toISOString() };
    this.viewList.push(view);
    return { ...view };
  }

  async updateView(id: string, change: { name?: string; query?: ViewQuery }) {
    const view = this.viewList.find((v) => v.id === id);
    if (!view) return undefined;
    if (change.name !== undefined && this.viewList.some((v) => v.id !== id && v.library === view.library && sameName(v.name, change.name!)))
      throw new NameTakenError(`There’s already a view called ${change.name} here.`);
    if (change.name !== undefined) view.name = change.name;
    if (change.query) view.query = change.query;
    return { ...view };
  }

  async deleteView(id: string) {
    const at = this.viewList.findIndex((v) => v.id === id);
    if (at < 0) return false;
    this.viewList.splice(at, 1);
    return true;
  }

  async rendition(version: string) {
    const found = this.renditions.get(version);
    return found && { ...found, images: [...found.images] };
  }

  async retryRendition(version: string) {
    const found = this.renditions.get(version);
    if (found?.state !== 'failed') return false;
    this.queue(version, new Date().toISOString());
    return true;
  }

  async finishRendition(version: string, result: RenditionResult) {
    const found = this.renditions.get(version);
    if (!found) return;
    const updatedAt = new Date().toISOString();
    if (result.state === 'failed') this.renditions.set(version, { ...found, state: 'failed', attempts: found.attempts + 1, error: result.error, updatedAt });
    else {
      const { state, engine, engineVersion, ...made } = result;
      this.renditions.set(version, { version, state, attempts: found.attempts + 1, engine: `${engine} ${engineVersion}`, thumbnail: Boolean(made.thumbnailKey), ...made, updatedAt });
    }
  }

  private readersOf(library: string, document: string) {
    const floor = this.shelves.get(library)?.floor;
    const granted = this.grantList.filter((g) => g.library === library && (!g.document || g.document === document)).map((g) => g.principal);
    return [...new Set([...(floor ? [floor] : []), ...granted])].sort();
  }

  async grants(library: string, document?: string) {
    return this.grantList.filter((g) => g.library === library && g.document === document).map((g) => ({ ...g })).sort((a, b) => a.principal.localeCompare(b.principal));
  }

  async setGrant({ library, document, principal, level, by }: { library: string; document?: string; principal: string; level: Level | null; by: string }) {
    const shelf = await this.library(library);
    if (level && (!shelf || (document && this.docs.get(document)?.library !== library))) throw new BadParentError('There’s no such library or document.');
    const at = this.grantList.findIndex((g) => g.library === library && g.document === document && g.principal === principal);
    if (at >= 0) this.grantList.splice(at, 1);
    if (shelf) this.tell(TOPICS.readersChanged, shelf.workspace, { library, ...(document ? { document } : {}) });
    if (!level) return undefined;
    const grant: Grant = { library, ...(document ? { document } : {}), principal, level, createdBy: by, createdAt: new Date().toISOString() };
    this.grantList.push(grant);
    return { ...grant };
  }

  async readers(document: string) {
    const doc = this.docs.get(document);
    return doc && !doc.deletedAt ? this.readersOf(doc.library, doc.id) : [];
  }

  async shared(principals: readonly string[], except: string): Promise<Shared> {
    const mine = this.grantList.filter((g) => principals.includes(g.principal));
    const libraries = [...this.shelves.values()]
      .filter((l) => !l.archivedAt && l.workspace !== except)
      .flatMap(({ archivedAt: _, ...l }) => {
        const level = levelFrom(mine.filter((g) => g.library === l.id && !g.document), principals);
        return level ? [{ ...l, level }] : [];
      })
      .sort(byName);
    const reached = new Set(libraries.map((l) => l.id));
    const documents = [...this.docs.values()]
      .filter((d) => !d.deletedAt && d.workspace !== except && !reached.has(d.library) && !this.shelves.get(d.library)?.archivedAt)
      .flatMap((d) => {
        const level = levelFrom(mine.filter((g) => g.document === d.id), principals);
        return level ? [{ ...this.withLatest(d), level }] : [];
      })
      .sort(byTitle);
    return { libraries, documents };
  }

  async publish({ document, version, audience, note, by }: { document: string; version: number; audience: string[]; note?: string; by: string }) {
    const doc = this.docs.get(document);
    if (!doc || doc.deletedAt || !this.versionList.some((v) => v.document === document && v.number === version)) return undefined;
    const at = new Date().toISOString();
    const [last] = this.publicationsOf(document);
    if (last && !last.ended) last.ended = { as: 'replaced', by, at };
    const publication: Publication = { id: randomUUID(), document, library: doc.library, version, audience: [...new Set(audience)].sort(), ...(note ? { note } : {}), publishedBy: by, publishedAt: at };
    this.pubs.push(publication);
    this.tell(TOPICS.published, doc.workspace, { document, library: doc.library, version, publication: publication.id, audience: publication.audience });
    this.tell(TOPICS.readersChanged, doc.workspace, { library: doc.library, document });
    return copyPublication(publication);
  }

  async withdraw({ document, by, reason }: { document: string; by: string; reason?: string }) {
    const doc = this.docs.get(document);
    const [last] = this.publicationsOf(document);
    if (!doc || doc.deletedAt || !last || last.ended) return undefined;
    last.ended = { as: 'withdrawn', by, at: new Date().toISOString(), ...(reason ? { reason } : {}) };
    this.tell(TOPICS.withdrawn, doc.workspace, { document, library: doc.library, version: last.version, publication: last.id });
    this.tell(TOPICS.readersChanged, doc.workspace, { library: doc.library, document });
    return copyPublication(last);
  }

  async publications(document: string) {
    return this.publicationsOf(document).map(copyPublication);
  }

  async publishedTo(principals: readonly string[], page: { limit?: number; offset?: number; since?: string } = {}): Promise<PublishedPage> {
    const live = this.pubs
      .filter((p) => !p.ended && p.audience.some((a) => principals.includes(a)) && (!page.since || p.publishedAt > page.since))
      .flatMap((p) => {
        const doc = this.docs.get(p.document);
        const shelf = this.shelves.get(p.library);
        return doc && !doc.deletedAt && shelf && !shelf.archivedAt ? [{ ...this.withLatest(doc), published: copyPublication(p), libraryName: shelf.name }] : [];
      })
      .sort((a, b) => b.published.publishedAt.localeCompare(a.published.publishedAt) || b.id.localeCompare(a.id));
    const { limit, offset } = pageOf(page);
    return { documents: live.slice(offset, offset + limit), total: live.length };
  }

  private issuesOf(series: string) {
    return [...this.docs.values()].filter((d) => !d.deletedAt && d.issue?.series === series).sort((a, b) => a.issue!.number - b.issue!.number);
  }

  private withIssues({ remindedFor: _, ...run }: Omit<Series, 'issues' | 'last'> & { remindedFor?: string }): Series {
    const issues = this.issuesOf(run.id);
    const last = issues.at(-1);
    return { ...run, audience: [...run.audience], tags: [...run.tags], issues: issues.length, ...(last ? { last: { document: last.id, ...pickPlace(last.issue!) } } : {}) };
  }

  async seriesIn(library: string) {
    return this.seriesList.filter((s) => s.library === library).map((s) => this.withIssues(s)).sort(byName);
  }

  async series(id: string) {
    const found = this.seriesList.find((s) => s.id === id);
    return found && this.withIssues(found);
  }

  async createSeries({ library, folder, parent, name, description = '', cadence, audience = [], tags = [], createdBy }: { library: string; folder?: string; parent?: string; name: string; description?: string; cadence: Cadence; audience?: string[]; tags?: string[]; createdBy: string }) {
    const shelf = await this.library(library);
    if (!shelf) throw new BadParentError('There’s no such library.');
    if (this.seriesList.some((s) => s.library === library && sameName(s.name, name))) throw new NameTakenError(`There’s already a series called ${name} here.`);
    this.checkTags(library, tags);
    const existing = folder ? this.folderList.find((f) => f.library === library && f.id === folder) : undefined;
    if (folder && existing?.level !== 'series') throw new BadParentError('Only a series can have a schedule.');
    if (existing && this.seriesList.some((s) => s.folder === existing.id)) throw new NameTakenError('That series already has a schedule.');
    const home = existing ?? (await this.createFolder({ library, parent, level: 'series', name, description, createdBy }));
    const now = new Date().toISOString();
    const run = { id: randomUUID(), workspace: shelf.workspace, library, folder: home.id, name: home.name, description, cadence, audience: [...new Set(audience)].sort(), tags: [...new Set(tags)].sort(), createdBy, createdAt: now, updatedAt: now };
    this.seriesList.push(run);
    return this.withIssues(run);
  }

  async updateSeries(id: string, change: { name?: string; description?: string; cadence?: Cadence; audience?: string[]; tags?: string[] }) {
    const run = this.seriesList.find((s) => s.id === id);
    if (!run) return undefined;
    if (change.name !== undefined && this.seriesList.some((s) => s.id !== id && s.library === run.library && sameName(s.name, change.name!)))
      throw new NameTakenError(`There’s already a series called ${change.name} here.`);
    if (change.tags) this.checkTags(run.library, change.tags);
    if (change.name !== undefined) await this.updateFolder(run.library, run.folder, { name: change.name });
    if (change.description !== undefined) run.description = change.description;
    if (change.cadence) run.cadence = change.cadence;
    if (change.audience) run.audience = [...new Set(change.audience)].sort();
    if (change.tags) run.tags = [...new Set(change.tags)].sort();
    run.updatedAt = new Date().toISOString();
    return this.withIssues(run);
  }

  async deleteSeries(id: string) {
    const at = this.seriesList.findIndex((s) => s.id === id);
    if (at < 0) return false;
    if ([...this.docs.values()].some((d) => d.issue?.series === id)) throw new NotEmptyError('A series with issues stays, so its issues keep their place.');
    const [run] = this.seriesList.splice(at, 1);
    this.following.delete(id);
    // Its series goes too, unless something else has been put in it.
    const folder = this.folderList.findIndex((f) => f.id === run.folder);
    if (folder >= 0 && !this.folderList.some((f) => f.parent === run.folder) && ![...this.docs.values()].some((d) => d.folder === run.folder && !d.deletedAt)) this.folderList.splice(folder, 1);
    return true;
  }

  async neighbours(document: string, principals: readonly string[]) {
    const doc = this.docs.get(document);
    if (!doc?.issue) return {};
    const seen = this.issuesOf(doc.issue.series).filter((d) => this.visibleTo(d, principals, true));
    const previous = seen.filter((d) => d.issue!.number < doc.issue!.number).at(-1);
    const next = seen.find((d) => d.issue!.number > doc.issue!.number);
    return { ...(previous ? { previous: linkTo(previous) } : {}), ...(next ? { next: linkTo(next) } : {}) };
  }

  async follow(series: string, person: string, on: boolean) {
    const people = this.following.get(series) ?? new Set<string>();
    if (on) people.add(person);
    else people.delete(person);
    this.following.set(series, people);
  }

  async followers(series: string) {
    return [...(this.following.get(series) ?? [])].sort();
  }

  async timedSeries() {
    return this.seriesList
      .filter((s) => s.cadence !== 'adhoc' && !this.shelves.get(s.library)?.archivedAt)
      .map((s) => this.withIssues(s))
      .filter((s) => s.last);
  }

  async markReminded(series: string, periodStart: string) {
    const run = this.seriesList.find((s) => s.id === series);
    if (!run || run.remindedFor === periodStart) return false;
    run.remindedFor = periodStart;
    return true;
  }

  async lookedAt(person: string) {
    return this.looked.get(person);
  }

  async markLooked(person: string, at = new Date().toISOString()) {
    const before = this.looked.get(person);
    if (!before || at > before) this.looked.set(person, at);
  }

  async draftsOn(workspace: string, page: { limit?: number } = {}) {
    const drafts = [...this.docs.values()]
      .filter((d) => d.workspace === workspace && !d.deletedAt && !this.shelves.get(d.library)?.archivedAt)
      .map((d) => this.withLatest(d))
      .filter((d) => d.state === 'draft')
      .sort(newestFirst('updatedAt'));
    const { limit } = pageOf(page);
    return { documents: drafts.slice(0, limit).map((d) => ({ ...d, libraryName: this.shelves.get(d.library)!.name })), total: drafts.length };
  }

  async search(principals: readonly string[], q: string, limit = 10) {
    const words = searchWords(q);
    if (!words.length) return [];
    const wordsOf = (text = '') => text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const has = (text: string | undefined, w: string) => wordsOf(text).some((t) => t.startsWith(w));
    const hits: (SearchHit & { score: number })[] = [];
    for (const d of this.docs.values()) {
      const shelf = this.shelves.get(d.library);
      if (d.deletedAt || !shelf || shelf.archivedAt) continue;
      const reader = this.readersOf(d.library, d.id).some((p) => principals.includes(p));
      const [last] = this.publicationsOf(d.id);
      const live = last && !last.ended && last.audience.some((a) => principals.includes(a)) ? last : undefined;
      if (!reader && !live) continue;
      // Its readers search its newest version; its audience only the version published to them.
      const versions = this.versionList.filter((v) => v.document === d.id);
      const version = reader ? versions.reduce((a, b) => (b.number > a.number ? b : a)) : versions.find((v) => v.number === live!.version);
      const text = version && this.renditions.get(version.id)?.text;
      const tags = [...(this.docTags.get(d.id) ?? [])].map((id) => this.tagList.find((t) => t.id === id)?.name).join(' ');
      let score = 0;
      for (const w of words) {
        const found = (has(d.title, w) ? 4 : 0) + (has(tags, w) ? 2 : 0) + (has(text, w) ? 1 : 0);
        if (!found) {
          score = 0;
          break;
        }
        score += found;
      }
      if (score) hits.push({ document: this.withLatest(d), libraryName: shelf.name, audienceOnly: !reader, score });
    }
    return hits
      .sort((a, b) => b.score - a.score || b.document.updatedAt.localeCompare(a.document.updatedAt))
      .slice(0, limit)
      .map(({ score: _, ...hit }) => hit);
  }
}

/**
 * Schema changes, applied in order and recorded so each runs once. Folio owns the `folio`
 * schema, made for its own database login by the platform (docs/app-storage.md).
 * Every table carries the floor it belongs to, so every query can keep to one floor.
 */
export const migrations: { id: string; sql: string }[] = [
  {
    id: '001_libraries',
    sql: `
      create table folio.libraries (
        id text primary key,
        workspace_id text not null,
        name text not null,
        description text not null default '',
        created_by text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        archived_by text,
        archived_at timestamptz
      );
      -- One name per floor among the libraries in use; an archived one gives its name up.
      create unique index libraries_name on folio.libraries (workspace_id, lower(name)) where archived_at is null;
      create table folio.folders (
        id text primary key,
        workspace_id text not null,
        library_id text not null references folio.libraries (id),
        parent_id text references folio.folders (id),
        name text not null,
        created_by text not null,
        created_at timestamptz not null default now()
      );
      -- One name per place: top-level folders compare with each other, others with their siblings.
      create unique index folders_name on folio.folders (library_id, coalesce(parent_id, ''), lower(name));
      create index folders_parent on folio.folders (parent_id);`,
  },
  {
    id: '002_documents',
    sql: `
      create table folio.documents (
        id text primary key,
        workspace_id text not null,
        library_id text not null references folio.libraries (id),
        folder_id text references folio.folders (id),
        title text not null,
        created_by text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_by text,
        deleted_at timestamptz
      );
      create index documents_place on folio.documents (library_id, folder_id) where deleted_at is null;
      -- Every file as it was uploaded; a version is never changed, only followed by the next.
      create table folio.document_versions (
        id text primary key,
        workspace_id text not null,
        document_id text not null references folio.documents (id),
        number integer not null,
        filename text not null,
        media_type text not null,
        size_bytes bigint not null,
        sha256 text not null,
        object_key text not null,
        created_by text not null,
        created_at timestamptz not null default now(),
        unique (document_id, number)
      );`,
  },
  {
    id: '003_tags_views',
    sql: `
      alter table folio.libraries add column free_tags boolean not null default false;
      -- The org's tags have no library; a library's tags are its own. One of each name in each.
      create table folio.tags (
        id text primary key,
        workspace_id text not null,
        library_id text references folio.libraries (id),
        name text not null,
        created_by text not null,
        created_at timestamptz not null default now()
      );
      create unique index tags_name on folio.tags (coalesce(library_id, ''), lower(name));
      create table folio.document_tags (
        document_id text not null references folio.documents (id),
        tag_id text not null references folio.tags (id),
        workspace_id text not null,
        primary key (document_id, tag_id)
      );
      create index document_tags_tag on folio.document_tags (tag_id);
      create table folio.views (
        id text primary key,
        workspace_id text not null,
        library_id text not null references folio.libraries (id),
        name text not null,
        query jsonb not null,
        created_by text not null,
        created_at timestamptz not null default now()
      );
      create unique index views_name on folio.views (library_id, lower(name));
      -- The name each person had when they last added something, to show them by.
      create table folio.people (
        id text primary key,
        name text not null,
        seen_at timestamptz not null default now()
      );
      create index documents_updated on folio.documents (library_id, updated_at desc) where deleted_at is null;`,
  },
  {
    id: '004_renditions',
    sql: `
      -- A version's reader copy, thumbnail and text, as the rendition worker (apps/folio/worker) makes them.
      -- The table is the worker's queue too: a row waits as queued until a worker leases it.
      create table folio.renditions (
        version_id text primary key references folio.document_versions (id),
        workspace_id text not null,
        state text not null default 'queued' check (state in ('queued', 'running', 'ready', 'failed')),
        attempts integer not null default 0,
        run_after timestamptz not null default now(),
        locked_until timestamptz,
        error text,
        engine text,
        engine_version text,
        reader_key text,
        thumbnail_key text,
        images jsonb not null default '[]',
        pages integer,
        text text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index renditions_queue on folio.renditions (run_after) where state in ('queued', 'running');
      -- Every version uploaded before there was a worker waits for one.
      insert into folio.renditions (version_id, workspace_id) select id, workspace_id from folio.document_versions;`,
  },
  {
    id: '005_access',
    sql: `
      -- Who a library's floor lets in. Folio hadn't shipped before this, so a library made
      -- before it (or by a release before it) is taken to be a team's.
      alter table folio.libraries add column floor_principal text;
      update folio.libraries set floor_principal = 'tree:' || workspace_id;
      -- People and teams let into a library, or into one document of it.
      create table folio.grants (
        workspace_id text not null,
        library_id text not null references folio.libraries (id),
        document_id text references folio.documents (id),
        principal text not null check (principal ~ '^((person|team|tree):.+|org)$'),
        level text not null check (level in ('read', 'edit', 'manage')),
        created_by text not null,
        created_at timestamptz not null default now()
      );
      create unique index grants_one on folio.grants (library_id, coalesce(document_id, ''), principal);
      create index grants_principal on folio.grants (principal);
      -- Everyone who may read each document, written down once so every list can filter by it.
      create table folio.readers (
        document_id text primary key references folio.documents (id),
        workspace_id text not null,
        library_id text not null references folio.libraries (id),
        principals text[] not null
      );
      create index readers_principals on folio.readers using gin (principals);
      create index readers_library on folio.readers (library_id);
      insert into folio.readers (document_id, workspace_id, library_id, principals)
        select d.id, d.workspace_id, d.library_id, array[l.floor_principal] from folio.documents d join folio.libraries l on l.id = d.library_id;`,
  },
  {
    id: '006_publishing',
    sql: `
      -- A version put out to an audience. At most one is out at a time for each document;
      -- publishing again ends it as replaced, withdrawing ends it as withdrawn. Rows are never removed.
      create table folio.publications (
        id text primary key,
        seq bigint generated always as identity,
        workspace_id text not null,
        library_id text not null references folio.libraries (id),
        document_id text not null references folio.documents (id),
        version_id text not null references folio.document_versions (id),
        version_number integer not null,
        audience text[] not null check (cardinality(audience) > 0),
        note text,
        published_by text not null,
        published_at timestamptz not null default now(),
        ended_as text check (ended_as in ('withdrawn', 'replaced')),
        ended_by text,
        ended_at timestamptz,
        end_reason text
      );
      create unique index publications_live on folio.publications (document_id) where ended_at is null;
      create index publications_audience on folio.publications using gin (audience) where ended_at is null;
      create index publications_document on folio.publications (document_id, seq desc);
      -- What Folio tells other apps, sent by the outbox relay once the change commits (docs/domain-events.md).
      create table folio.outbox (
        id bigint generated always as identity primary key,
        event_id text not null unique default gen_random_uuid()::text,
        topic text not null,
        workspace_id text,
        payload jsonb not null,
        created_at timestamptz not null default now(),
        sent_at timestamptz
      );
      create index outbox_unsent on folio.outbox (id) where sent_at is null;`,
  },
  {
    id: '007_series',
    sql: `
      -- A named run of documents in one library, on a cadence. Its audience and tags are what each new issue starts with.
      create table folio.series (
        id text primary key,
        workspace_id text not null,
        library_id text not null references folio.libraries (id),
        name text not null,
        description text not null default '',
        cadence text not null check (cadence in ('weekly', 'monthly', 'quarterly', 'adhoc')),
        audience text[] not null default '{}',
        tags text[] not null default '{}',
        created_by text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        -- The period whose late issue the owner was last told of, so they're told once.
        reminded_for date
      );
      create unique index series_name on folio.series (library_id, lower(name));
      -- An issue is a document with a place in its series. The period's name is kept as it was, whatever the cadence becomes.
      alter table folio.documents add column series_id text references folio.series (id),
        add column issue_number integer,
        add column period_start date,
        add column period text;
      create unique index documents_issue on folio.documents (series_id, issue_number) where series_id is not null and deleted_at is null;
      create table folio.series_followers (
        series_id text not null references folio.series (id),
        person_id text not null,
        workspace_id text not null,
        created_at timestamptz not null default now(),
        primary key (series_id, person_id)
      );`,
  },
  {
    id: '008_search',
    sql: `
      -- Find matches every word as the start of one in a document's title, its tags or its version's text.
      alter table folio.documents add column title_words tsvector generated always as (to_tsvector('english', title)) stored;
      create index documents_title_words on folio.documents using gin (title_words);
      -- A version's words, from the start of its text: a tsvector holds at most 1 MB.
      alter table folio.renditions add column words tsvector generated always as (to_tsvector('english', left(coalesce(text, ''), 400000))) stored;
      create index renditions_words on folio.renditions using gin (words);
      -- When each person last looked at what's published to them, so Home can say what's new since.
      create table folio.looked (
        person_id text primary key,
        published_at timestamptz not null
      );`,
  },
  {
    id: '009_retention',
    sql: `
      -- When a deleted document's files were cleared from the bucket and its text forgotten, past the retention period.
      alter table folio.documents add column purged_at timestamptz;
      create index documents_purgeable on folio.documents (deleted_at) where deleted_at is not null and purged_at is null;`,
  },
  {
    id: '010_units',
    sql: `
      -- The form a library takes (src/units.ts): a library is a collection, and each folder is a
      -- subcollection, a series or a subseries in it. Every one of them has a lifecycle state.
      alter table folio.libraries add column state text not null default 'open' check (state in ('open', 'closed', 'archived'));
      update folio.libraries set state = 'archived' where archived_at is not null;
      alter table folio.folders add column level text not null default 'subcollection' check (level in ('subcollection', 'series', 'subseries')),
        add column description text not null default '',
        add column state text not null default 'open' check (state in ('open', 'closed', 'archived')),
        add column updated_at timestamptz not null default now();
      -- Folders went six deep; subcollections sit straight in a collection. A deeper folder becomes a
      -- subcollection of its own at the top, named for where it was ("Policies › HR › Leave").
      with recursive tree (id, path, depth) as (
        select id, name, 1 from folio.folders where parent_id is null
        union all select f.id, t.path || ' › ' || f.name, t.depth + 1 from folio.folders f join tree t on f.parent_id = t.id)
      update folio.folders f set name = t.path, parent_id = null from tree t where t.id = f.id and t.depth > 1;
      -- Each series with a schedule gets its own series in the library, and its issues go in it.
      alter table folio.series add column folder_id text references folio.folders (id);
      insert into folio.folders (id, workspace_id, library_id, parent_id, level, name, description, created_by, created_at)
        select 'series-' || s.id, s.workspace_id, s.library_id, null, 'series',
            case when exists (select 1 from folio.folders f where f.library_id = s.library_id and f.parent_id is null and lower(f.name) = lower(s.name))
              then s.name || ' (series)' else s.name end,
            s.description, s.created_by, s.created_at
          from folio.series s;
      update folio.series set folder_id = 'series-' || id;
      update folio.series s set name = f.name from folio.folders f where f.id = s.folder_id;
      -- folder_id stays nullable so the release before this one can still make a series (docs/versioning.md): Folio always sets it.
      create unique index series_folder on folio.series (folder_id);
      update folio.documents d set folder_id = s.folder_id from folio.series s where d.series_id = s.id;
      -- A version's place in its life. One out to an audience now was put out as final.
      alter table folio.document_versions add column state text not null default 'in-progress'
        check (state in ('in-progress', 'in-review', 'complete', 'issued', 'retired'));
      update folio.document_versions v set state = 'issued' from folio.publications p where p.version_id = v.id and p.ended_at is null;
      -- Every lifecycle move, of a library, a folder or a document's version, kept for good.
      create table folio.state_moves (
        id bigint generated always as identity primary key,
        workspace_id text not null,
        record_id text not null,
        version_number integer,
        from_state text,
        to_state text not null,
        moved_by text not null,
        moved_at timestamptz not null default now(),
        note text
      );
      create index state_moves_record on folio.state_moves (record_id, id desc);
      -- What the org calls a level instead of Folio's own name.
      create table folio.level_names (
        level text primary key check (level in ('collection', 'subcollection', 'series', 'subseries', 'file')),
        name text not null,
        plural text not null,
        updated_by text not null,
        updated_at timestamptz not null default now()
      );`,
  },
  {
    id: '011_placements',
    sql: `
      -- Publishing up the floors: each step puts a record (a library, a folder, a document) on a floor
      -- above, through a filter of lifecycle states. A live window onto it, kept for good once taken back.
      -- Floors are a team's id, someone's own floor's id, or 'org'.
      create table folio.placements (
        id text primary key,
        seq bigint generated always as identity,
        workspace_id text not null,
        library_id text not null references folio.libraries (id),
        record_kind text not null check (record_kind in ('library', 'folder', 'document')),
        record_id text not null,
        from_floor text not null,
        to_floor text not null,
        to_principal text not null,
        filter text[] not null check (cardinality(filter) > 0),
        via text references folio.placements (id),
        landed_library text references folio.libraries (id),
        landed_folder text references folio.folders (id),
        note text,
        placed_by text not null,
        placed_at timestamptz not null default now(),
        ended_by text,
        ended_at timestamptz,
        end_reason text
      );
      create unique index placements_live on folio.placements (record_id, to_floor) where ended_at is null;
      create index placements_to on folio.placements (to_floor) where ended_at is null;
      create index placements_principal on folio.placements (to_principal) where ended_at is null;
      create index placements_library on folio.placements (library_id) where ended_at is null;`,
  },
];

type LibraryRow = { id: string; workspace_id: string; floor_principal: string | null; name: string; description: string; free_tags: boolean; state: ContainerState; created_by: string; created_at: Date; updated_at: Date };
type FolderRow = { id: string; library_id: string; parent_id: string | null; level: FolderLevel; name: string; description: string; state: ContainerState; created_by: string; created_at: Date; updated_at: Date };

const fromLibraryRow = (r: LibraryRow): Library => ({
  id: r.id,
  workspace: r.workspace_id,
  floor: r.floor_principal ?? `tree:${r.workspace_id}`,
  name: r.name,
  description: r.description,
  freeTags: r.free_tags,
  state: r.state,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

type VersionRow = {
  id: string;
  document_id: string;
  number: number;
  filename: string;
  media_type: string;
  size_bytes: string;
  sha256: string;
  object_key: string;
  created_by: string;
  created_at: Date;
  state: ContentState;
  reader_state: RenditionState | null;
  reader_error: string | null;
  reader_pages: number | null;
  reader_thumbnail: boolean | null;
  reader_engine: string | null;
};
type RenditionRow = {
  version_id: string;
  state: RenditionState;
  attempts: number;
  error: string | null;
  engine: string | null;
  engine_version: string | null;
  reader_key: string | null;
  thumbnail_key: string | null;
  images: string[];
  pages: number | null;
  text: string | null;
  updated_at: Date;
};
type DocumentRow = {
  id: string;
  workspace_id: string;
  library_id: string;
  folder_id: string | null;
  title: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  latest: Omit<VersionRow, 'created_at' | 'size_bytes'> & { created_at: string; size_bytes: number };
  tags: string[];
  /** Its newest publication, as JSON. */
  publication: PublicationRow | null;
  series_id: string | null;
  issue_number: number | null;
  period_start: string | null;
  period: string | null;
  total?: string;
};
type PublicationRow = {
  id: string;
  library_id: string;
  document_id: string;
  version_number: number;
  audience: string[];
  note: string | null;
  published_by: string;
  published_at: Date | string;
  ended_as: 'withdrawn' | 'replaced' | null;
  ended_by: string | null;
  ended_at: Date | string | null;
  end_reason: string | null;
};
const PUBLICATION_COLUMNS = 'id, library_id, document_id, version_number, audience, note, published_by, published_at, ended_as, ended_by, ended_at, end_reason';
const isoOf = (t: Date | string) => new Date(t).toISOString();
const fromPublicationRow = (r: PublicationRow): Publication => ({
  id: r.id,
  document: r.document_id,
  library: r.library_id,
  version: r.version_number,
  audience: r.audience,
  ...(r.note ? { note: r.note } : {}),
  publishedBy: r.published_by,
  publishedAt: isoOf(r.published_at),
  ...(r.ended_as && r.ended_at ? { ended: { as: r.ended_as, by: r.ended_by ?? '', at: isoOf(r.ended_at), ...(r.end_reason ? { reason: r.end_reason } : {}) } } : {}),
});
type TagRow = { id: string; workspace_id: string; library_id: string | null; name: string; created_by: string; created_at: Date };
type ViewRow = { id: string; library_id: string; name: string; query: ViewQuery; created_by: string; created_at: Date };

const fromTagRow = (r: TagRow): Tag => ({
  id: r.id,
  workspace: r.workspace_id,
  ...(r.library_id ? { library: r.library_id } : {}),
  name: r.name,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
});

const fromViewRow = (r: ViewRow): SavedView => ({ id: r.id, library: r.library_id, name: r.name, query: r.query, createdBy: r.created_by, createdAt: r.created_at.toISOString() });
const TAG_COLUMNS = 'id, workspace_id, library_id, name, created_by, created_at';
const VIEW_COLUMNS = 'id, library_id, name, query, created_by, created_at';

const fromVersionRow = (r: VersionRow): StoredVersion => ({
  id: r.id,
  document: r.document_id,
  number: r.number,
  filename: r.filename,
  mediaType: r.media_type,
  size: Number(r.size_bytes),
  sha256: r.sha256,
  objectKey: r.object_key,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  state: r.state,
  // A version always has a rendition row; one made before 004 is backfilled as queued.
  reader: {
    state: r.reader_state ?? 'queued',
    ...(r.reader_error ? { error: r.reader_error } : {}),
    ...(r.reader_pages ? { pages: r.reader_pages } : {}),
    thumbnail: Boolean(r.reader_thumbnail),
    ...(r.reader_engine ? { engine: r.reader_engine } : {}),
  },
});

const engineOf = (r: Pick<RenditionRow, 'engine' | 'engine_version'>) => (r.engine ? [r.engine, r.engine_version].filter(Boolean).join(' ') : null);

const fromRenditionRow = (r: RenditionRow): Rendition => ({
  version: r.version_id,
  attempts: r.attempts,
  ...readerOf({ state: r.state, error: r.error ?? undefined, pages: r.pages ?? undefined, thumbnailKey: r.thumbnail_key ?? undefined, engine: engineOf(r) ?? undefined }),
  ...(r.reader_key ? { readerKey: r.reader_key } : {}),
  ...(r.thumbnail_key ? { thumbnailKey: r.thumbnail_key } : {}),
  images: r.images,
  ...(r.text !== null ? { text: r.text } : {}),
  updatedAt: r.updated_at.toISOString(),
});

const fromDocumentRow = (r: DocumentRow): FolioDocument => ({
  id: r.id,
  workspace: r.workspace_id,
  library: r.library_id,
  ...(r.folder_id ? { folder: r.folder_id } : {}),
  title: r.title,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  latest: publicVersion(fromVersionRow({ ...r.latest, size_bytes: String(r.latest.size_bytes), created_at: new Date(r.latest.created_at) })),
  tags: r.tags,
  ...publishing(r.publication ? fromPublicationRow(r.publication) : undefined),
  ...(r.series_id ? { issue: { series: r.series_id, number: r.issue_number!, periodStart: r.period_start!, period: r.period! } } : {}),
});

/** A document's state and, while it's out, the publication, from its newest one. */
const publishing = (last: Publication | undefined) => ({ state: stateOf(last), ...(last && !last.ended ? { published: last } : {}) });

/** What a version shows of its rendition (`r`). */
const READER_COLUMNS = `r.state as reader_state, r.error as reader_error, r.pages as reader_pages, r.thumbnail_key is not null as reader_thumbnail,
  case when r.engine is null then null else concat_ws(' ', r.engine, r.engine_version) end as reader_engine`;

/** A document with its newest version (`v`) and its tags, as one row, with how many rows match in all. */
const DOCUMENT_SELECT = `
  select d.id, d.workspace_id, d.library_id, d.folder_id, d.title, d.created_by, d.created_at, d.updated_at,
    d.series_id, d.issue_number, to_char(d.period_start, 'YYYY-MM-DD') as period_start, d.period,
    to_jsonb(v) - 'workspace_id' as latest,
    array(select dt.tag_id from folio.document_tags dt where dt.document_id = d.id order by dt.tag_id) as tags,
    (select to_jsonb(p) from folio.publications p where p.document_id = d.id order by p.seq desc limit 1) as publication,
    count(*) over () as total
  from folio.documents d
  cross join lateral (
    select dv.*, ${READER_COLUMNS} from folio.document_versions dv left join folio.renditions r on r.version_id = dv.id
    where dv.document_id = d.id order by dv.number desc limit 1
  ) v`;
const VERSION_COLUMNS = 'id, document_id, number, filename, media_type, size_bytes, sha256, object_key, created_by, created_at, state';
/** Versions with how their reader copies are coming along. */
const VERSION_SELECT = `select ${VERSION_COLUMNS.split(', ').map((c) => `dv.${c}`).join(', ')}, ${READER_COLUMNS}
  from folio.document_versions dv left join folio.renditions r on r.version_id = dv.id`;
const RENDITION_COLUMNS = 'version_id, state, attempts, error, engine, engine_version, reader_key, thumbnail_key, images, pages, text, updated_at';

const fromFolderRow = (r: FolderRow): Folder => ({
  id: r.id,
  library: r.library_id,
  ...(r.parent_id ? { parent: r.parent_id } : {}),
  level: r.level,
  name: r.name,
  description: r.description,
  state: r.state,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

/** Postgres says a unique index refused the row. */
const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === '23505';

/** The state of document `d`, in SQL, as stateOf works it out. */
const STATE_OF_D = `coalesce((select case when p.ended_at is null then 'published' else 'withdrawn' end from folio.publications p where p.document_id = d.id order by p.seq desc limit 1), 'draft')`;

/** Adds an event to Folio's outbox, inside the transaction that makes the change it tells of. */
const tell = (client: pg.PoolClient, topic: string, workspace: string, payload: Record<string, unknown>) =>
  client.query('insert into folio.outbox (topic, workspace_id, payload) values ($1, $2, $3)', [topic, workspace, JSON.stringify(payload)]);

const LIBRARY_COLUMNS = 'id, workspace_id, floor_principal, name, description, free_tags, state, created_by, created_at, updated_at';
const DOCUMENT_ORDER: Record<DocumentSort, string> = {
  title: 'lower(d.title), d.id',
  newest: 'd.created_at desc, d.id desc',
  updated: 'd.updated_at desc, d.id desc',
  period: 'd.period_start desc nulls last, d.issue_number desc nulls last, d.created_at desc, d.id desc',
};

/** Someone who stands for the principals in `$p` may read document `d`, or (with `audience`) has had it published to them. */
const visibleSql = (p: string, audience: boolean) =>
  `(exists (select 1 from folio.readers r where r.document_id = d.id and r.principals && ${p}::text[])${
    audience ? ` or exists (select 1 from folio.publications vp where vp.document_id = d.id and vp.ended_at is null and vp.audience && ${p}::text[])` : ''
  })`;

type SeriesRow = {
  id: string;
  workspace_id: string;
  library_id: string;
  folder_id: string;
  name: string;
  description: string;
  cadence: Cadence;
  audience: string[];
  tags: string[];
  created_by: string;
  created_at: Date;
  updated_at: Date;
  issues: string;
  last: { document: string; number: number; periodStart: string; period: string } | null;
};
const SERIES_SELECT = `
  select s.id, s.workspace_id, s.library_id, s.folder_id, f.name, s.description, s.cadence, s.audience, s.tags, s.created_by, s.created_at, s.updated_at,
    (select count(*) from folio.documents d where d.series_id = s.id and d.deleted_at is null) as issues,
    (select jsonb_build_object('document', d.id, 'number', d.issue_number, 'periodStart', to_char(d.period_start, 'YYYY-MM-DD'), 'period', d.period)
      from folio.documents d where d.series_id = s.id and d.deleted_at is null order by d.issue_number desc limit 1) as last
  from folio.series s join folio.folders f on f.id = s.folder_id`;
const fromSeriesRow = (r: SeriesRow): Series => ({
  id: r.id,
  workspace: r.workspace_id,
  library: r.library_id,
  folder: r.folder_id,
  name: r.name,
  description: r.description,
  cadence: r.cadence,
  audience: r.audience,
  tags: r.tags,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  issues: Number(r.issues),
  ...(r.last ? { last: r.last } : {}),
});
const FOLDER_COLUMNS = 'id, library_id, parent_id, level, name, description, state, created_by, created_at, updated_at';
type PlacementRow = {
  id: string;
  workspace_id: string;
  library_id: string;
  record_kind: RecordRefIn['kind'];
  record_id: string;
  from_floor: string;
  to_floor: string;
  to_principal: string;
  filter: ContentState[];
  via: string | null;
  landed_library: string | null;
  landed_folder: string | null;
  note: string | null;
  placed_by: string;
  placed_at: Date;
  ended_by: string | null;
  ended_at: Date | null;
  end_reason: string | null;
};
const PLACEMENT_COLUMNS =
  'id, workspace_id, library_id, record_kind, record_id, from_floor, to_floor, to_principal, filter, via, landed_library, landed_folder, note, placed_by, placed_at, ended_by, ended_at, end_reason';
const fromPlacementRow = (r: PlacementRow): Placement => ({
  id: r.id,
  library: r.library_id,
  workspace: r.workspace_id,
  record: { kind: r.record_kind, id: r.record_id },
  from: r.from_floor,
  to: r.to_floor,
  toPrincipal: r.to_principal,
  filter: r.filter,
  ...(r.via ? { via: r.via } : {}),
  ...(r.landed_library ? { landed: { library: r.landed_library, ...(r.landed_folder ? { folder: r.landed_folder } : {}) } } : {}),
  ...(r.note ? { note: r.note } : {}),
  by: r.placed_by,
  at: r.placed_at.toISOString(),
  ...(r.ended_at ? { ended: { by: r.ended_by ?? '', at: r.ended_at.toISOString(), ...(r.end_reason ? { reason: r.end_reason } : {}) } } : {}),
});
type MoveRow = { record_id: string; version_number: number | null; from_state: string | null; to_state: string; moved_by: string; moved_at: Date; note: string | null };
const fromMoveRow = (r: MoveRow): StateMove => ({
  record: r.record_id,
  ...(r.version_number ? { version: r.version_number } : {}),
  ...(r.from_state ? { from: r.from_state } : {}),
  to: r.to_state,
  by: r.moved_by,
  at: r.moved_at.toISOString(),
  ...(r.note ? { note: r.note } : {}),
});

export class PgFolioStore implements FolioStore {
  // A plain field, not a parameter property: `pnpm dev:app` runs this file with Node's type stripping.
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  static async connect(connectionString: string) {
    const store = new PgFolioStore(new pg.Pool({ connectionString }));
    await store.migrate();
    return store;
  }

  /** Brings the schema up to date. Safe to run from several instances at once. */
  async migrate() {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query("select pg_advisory_xact_lock(hashtext('folio.migrate'))");
      // On a server the platform makes the schema for Folio's login, which may not create schemas
      // itself: Postgres checks that right even for "if not exists", so only ask when there is none.
      const { rowCount } = await client.query("select 1 from pg_namespace where nspname = 'folio'");
      if (!rowCount) await client.query('create schema folio');
      await client.query('create table if not exists folio.migrations (id text primary key, applied_at timestamptz not null default now())');
      const { rows } = await client.query<{ id: string }>('select id from folio.migrations');
      const applied = new Set(rows.map((r) => r.id));
      for (const m of migrations.filter((m) => !applied.has(m.id))) {
        await client.query(m.sql);
        await client.query('insert into folio.migrations (id) values ($1)', [m.id]);
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }

  async libraries(workspace: string, { archived = false }: { archived?: boolean } = {}) {
    const { rows } = await this.pool.query<LibraryRow>(
      `select ${LIBRARY_COLUMNS} from folio.libraries where workspace_id = $1 and ($2 or archived_at is null) order by lower(name), id`,
      [workspace, archived],
    );
    return rows.map(fromLibraryRow);
  }

  async library(id: string, { archived = false }: { archived?: boolean } = {}) {
    const { rows } = await this.pool.query<LibraryRow>(`select ${LIBRARY_COLUMNS} from folio.libraries where id = $1 and ($2 or archived_at is null)`, [id, archived]);
    return rows[0] && fromLibraryRow(rows[0]);
  }

  async createLibrary({ workspace, floor, name, description = '', createdBy }: { workspace: string; floor: string; name: string; description?: string; createdBy: string }) {
    try {
      const { rows } = await this.pool.query<LibraryRow>(
        `insert into folio.libraries (id, workspace_id, floor_principal, name, description, created_by) values ($1, $2, $3, $4, $5, $6) returning ${LIBRARY_COLUMNS}`,
        [randomUUID(), workspace, floor, name, description, createdBy],
      );
      return fromLibraryRow(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError(`There’s already a library called ${name} here.`);
      throw err;
    }
  }

  async updateLibrary(id: string, change: { name?: string; description?: string; freeTags?: boolean }) {
    try {
      const { rows } = await this.pool.query<LibraryRow>(
        `update folio.libraries set name = coalesce($2, name), description = coalesce($3, description), free_tags = coalesce($4, free_tags), updated_at = now()
          where id = $1 and archived_at is null returning ${LIBRARY_COLUMNS}`,
        [id, change.name ?? null, change.description ?? null, change.freeTags ?? null],
      );
      return rows[0] && fromLibraryRow(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError(`There’s already a library called ${change.name} here.`);
      throw err;
    }
  }

  async archiveLibrary(id: string, by: string) {
    return Boolean(await this.setLibraryState(id, 'archived', by));
  }

  /** Keeps a lifecycle move on the record, in the transaction that makes it. */
  private async noteMove(client: pg.PoolClient, move: { workspace: string; record: string; version?: number; from?: string; to: string; by: string; note?: string }) {
    await client.query('insert into folio.state_moves (workspace_id, record_id, version_number, from_state, to_state, moved_by, note) values ($1, $2, $3, $4, $5, $6, $7)', [
      move.workspace,
      move.record,
      move.version ?? null,
      move.from ?? null,
      move.to,
      move.by,
      move.note ?? null,
    ]);
  }

  async setLibraryState(id: string, to: ContainerState, by: string, note?: string) {
    return this.inTransaction(async (client) => {
      const { rows: was } = await client.query<{ state: ContainerState; workspace_id: string }>('select state, workspace_id from folio.libraries where id = $1 for update', [id]);
      if (!was[0] || was[0].state === to) return undefined;
      const { rows } = await client.query<LibraryRow>(
        `update folio.libraries set state = $2, updated_at = now(),
            archived_at = case when $2 = 'archived' then now() end, archived_by = case when $2 = 'archived' then $3 end
          where id = $1 returning ${LIBRARY_COLUMNS}`,
        [id, to, by],
      );
      await this.noteMove(client, { workspace: was[0].workspace_id, record: id, from: was[0].state, to, by, note });
      return fromLibraryRow(rows[0]);
    });
  }

  async folders(library: string) {
    const { rows } = await this.pool.query<FolderRow>(`select ${FOLDER_COLUMNS} from folio.folders where library_id = $1 order by lower(name), id`, [library]);
    return rows.map(fromFolderRow);
  }

  async createFolder({ library, parent, level, name, description = '', createdBy }: { library: string; parent?: string; level?: FolderLevel; name: string; description?: string; createdBy: string }) {
    return this.inTransaction((client) => this.insertFolder(client, { library, parent, level, name, description, createdBy }));
  }

  private async insertFolder(client: pg.PoolClient, { library, parent, level, name, description = '', createdBy }: { library: string; parent?: string; level?: FolderLevel; name: string; description?: string; createdBy: string }) {
    const shelf = await this.library(library);
    if (!shelf) throw new BadParentError('There’s no such library.');
    const folders = await this.folders(library);
    const placed = checkPlace(folders, parent, level);
    checkOpen(shelf, folders, parent);
    try {
      await client.query('savepoint folder');
      const { rows } = await client.query<FolderRow>(
        `insert into folio.folders (id, workspace_id, library_id, parent_id, level, name, description, created_by)
          values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${FOLDER_COLUMNS}`,
        [randomUUID(), shelf.workspace, library, parent ?? null, placed, name, description, createdBy],
      );
      return fromFolderRow(rows[0]);
    } catch (err) {
      await client.query('rollback to savepoint folder');
      if (isUniqueViolation(err)) throw new NameTakenError(`There’s already something called ${name} there.`);
      throw err;
    }
  }

  async renameFolder(library: string, id: string, name: string) {
    return this.updateFolder(library, id, { name });
  }

  async updateFolder(library: string, id: string, change: { name?: string; description?: string }) {
    try {
      return await this.inTransaction(async (client) => {
        const { rows } = await client.query<FolderRow>(
          `update folio.folders set name = coalesce($3, name), description = coalesce($4, description), updated_at = now()
            where id = $2 and library_id = $1 returning ${FOLDER_COLUMNS}`,
          [library, id, change.name ?? null, change.description ?? null],
        );
        // A series' schedule goes by its series' name.
        if (rows[0] && change.name !== undefined) await client.query('update folio.series set name = $2, updated_at = now() where folder_id = $1', [id, change.name]);
        return rows[0] && fromFolderRow(rows[0]);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError(`There’s already something called ${change.name} there.`);
      throw err;
    }
  }

  async setFolderState(library: string, id: string, to: ContainerState, by: string, note?: string) {
    return this.inTransaction(async (client) => {
      const { rows: was } = await client.query<{ state: ContainerState; workspace_id: string }>('select state, workspace_id from folio.folders where id = $1 and library_id = $2 for update', [id, library]);
      if (!was[0] || was[0].state === to) return undefined;
      const { rows } = await client.query<FolderRow>(`update folio.folders set state = $2, updated_at = now() where id = $1 returning ${FOLDER_COLUMNS}`, [id, to]);
      await this.noteMove(client, { workspace: was[0].workspace_id, record: id, from: was[0].state, to, by, note });
      return fromFolderRow(rows[0]);
    });
  }

  async setVersionState(document: string, number: number, to: ContentState, by: string, note?: string) {
    return this.inTransaction(async (client) => {
      const { rows: was } = await client.query<{ state: ContentState; workspace_id: string }>(
        `select v.state, v.workspace_id from folio.document_versions v join folio.documents d on d.id = v.document_id
          where v.document_id = $1 and v.number = $2 and d.deleted_at is null for update of v`,
        [document, number],
      );
      if (!was[0] || was[0].state === to) return undefined;
      await client.query('update folio.document_versions set state = $3 where document_id = $1 and number = $2', [document, number, to]);
      await client.query('update folio.documents set updated_at = now() where id = $1', [document]);
      await this.noteMove(client, { workspace: was[0].workspace_id, record: document, version: number, from: was[0].state, to, by, note });
      const { rows } = await client.query<VersionRow>(`${VERSION_SELECT} where dv.document_id = $1 and dv.number = $2`, [document, number]);
      return publicVersion(fromVersionRow(rows[0]));
    });
  }

  async stateMoves(record: string) {
    const { rows } = await this.pool.query<MoveRow>('select record_id, version_number, from_state, to_state, moved_by, moved_at, note from folio.state_moves where record_id = $1 order by id desc', [record]);
    return rows.map(fromMoveRow);
  }

  async levelNames() {
    const { rows } = await this.pool.query<{ level: UnitLevel; name: string; plural: string }>('select level, name, plural from folio.level_names order by level');
    return Object.fromEntries(rows.map((r) => [r.level, { name: r.name, plural: r.plural }])) as LevelNames;
  }

  async setLevelName(level: UnitLevel, name: LevelName | null, by: string) {
    if (name)
      await this.pool.query(
        `insert into folio.level_names (level, name, plural, updated_by) values ($1, $2, $3, $4)
          on conflict (level) do update set name = excluded.name, plural = excluded.plural, updated_by = excluded.updated_by, updated_at = now()`,
        [level, name.name, name.plural, by],
      );
    else await this.pool.query('delete from folio.level_names where level = $1', [level]);
    return this.levelNames();
  }

  async place(input: NewPlacement) {
    try {
      const { rows } = await this.pool.query<PlacementRow>(
        `insert into folio.placements (id, workspace_id, library_id, record_kind, record_id, from_floor, to_floor, to_principal, filter, via, landed_library, landed_folder, note, placed_by)
          select $1, workspace_id, id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13 from folio.libraries where id = $2
          returning ${PLACEMENT_COLUMNS}`,
        [
          randomUUID(),
          input.library,
          input.record.kind,
          input.record.id,
          input.from,
          input.to,
          input.toPrincipal,
          CONTENT_LIFECYCLE.tidy(input.filter),
          input.via ?? null,
          input.landed?.library ?? null,
          input.landed?.folder ?? null,
          input.note ?? null,
          input.by,
        ],
      );
      if (!rows[0]) throw new BadParentError('There’s no such library.');
      return fromPlacementRow(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new PlacedError('It’s already on that floor.');
      throw err;
    }
  }

  async placement(id: string) {
    const { rows } = await this.pool.query<PlacementRow>(`select ${PLACEMENT_COLUMNS} from folio.placements where id = $1`, [id]);
    return rows[0] && fromPlacementRow(rows[0]);
  }

  async placementsOf(record: string) {
    const { rows } = await this.pool.query<PlacementRow>(`select ${PLACEMENT_COLUMNS} from folio.placements where record_id = $1 order by seq`, [record]);
    return rows.map(fromPlacementRow);
  }

  async placementsOn(floor: string) {
    const { rows } = await this.pool.query<PlacementRow>(`select ${PLACEMENT_COLUMNS} from folio.placements where to_floor = $1 and ended_at is null order by seq`, [floor]);
    return rows.map(fromPlacementRow);
  }

  async covering(document: string) {
    const { rows } = await this.pool.query<PlacementRow>(
      `with recursive doc as (select id, library_id, folder_id from folio.documents where id = $1 and deleted_at is null),
        above (id, parent_id) as (
          select f.id, f.parent_id from folio.folders f join doc on f.id = doc.folder_id
          union all select f.id, f.parent_id from folio.folders f join above on f.id = above.parent_id)
      select ${PLACEMENT_COLUMNS} from folio.placements p
        where p.ended_at is null and (p.record_id in (select id from doc) or p.record_id in (select library_id from doc) or p.record_id in (select id from above))
        order by p.seq`,
      [document],
    );
    return rows.map(fromPlacementRow);
  }

  async setPlacementFilter(id: string, filter: ContentState[], by: string) {
    return this.inTransaction(async (client) => {
      const { rows } = await client.query<PlacementRow>(`update folio.placements set filter = $2 where id = $1 and ended_at is null returning ${PLACEMENT_COLUMNS}`, [id, CONTENT_LIFECYCLE.tidy(filter)]);
      if (!rows[0]) return undefined;
      // Nothing above can show more than it now does; what's left showing nothing is taken back
      // (keeping the filter it had, so the record says what it showed).
      await client.query(
        `with recursive up (id, filter) as (
            select p.id, (select array(select s from unnest(p.filter) s where s = any(b.filter))) from folio.placements p join folio.placements b on b.id = p.via
              where p.via = $1 and p.ended_at is null
            union all select p.id, (select array(select s from unnest(p.filter) s where s = any(up.filter))) from folio.placements p join up on p.via = up.id
              where p.ended_at is null)
          update folio.placements p
            set filter = case when cardinality(up.filter) > 0 then up.filter else p.filter end,
                ended_at = case when cardinality(up.filter) > 0 then null else now() end,
                ended_by = case when cardinality(up.filter) > 0 then null else $2 end,
                end_reason = case when cardinality(up.filter) > 0 then null else 'It no longer showed anything.' end
            from up where p.id = up.id`,
        [id, by],
      );
      return fromPlacementRow(rows[0]);
    });
  }

  async landPlacement(id: string, landed: { library: string; folder?: string } | null) {
    const { rows } = await this.pool.query<PlacementRow>(
      `update folio.placements set landed_library = $2, landed_folder = $3 where id = $1 and ended_at is null returning ${PLACEMENT_COLUMNS}`,
      [id, landed?.library ?? null, landed?.folder ?? null],
    );
    return rows[0] && fromPlacementRow(rows[0]);
  }

  async endPlacements(ids: readonly string[], by: string, reason?: string) {
    const { rows } = await this.pool.query<PlacementRow>(
      `update folio.placements set ended_by = $2, ended_at = now(), end_reason = $3 where id = any($1::text[]) and ended_at is null returning ${PLACEMENT_COLUMNS}`,
      [[...ids], by, reason ?? null],
    );
    return rows.map(fromPlacementRow);
  }

  async deleteFolder(library: string, id: string) {
    const { rows } = await this.pool.query<{ found: boolean; children: boolean; documents: boolean }>(
      `select exists (select 1 from folio.folders where id = $2 and library_id = $1) as found,
              exists (select 1 from folio.folders where parent_id = $2) as children,
              exists (select 1 from folio.documents where folder_id = $2 and deleted_at is null) as documents`,
      [library, id],
    );
    if (!rows[0].found) return false;
    if (rows[0].children) throw new NotEmptyError('Empty the folder first: it has folders in it.');
    if (rows[0].documents) throw new NotEmptyError('Empty the folder first: it has documents in it.');
    try {
      return await this.inTransaction(async (client) => {
        // An empty series takes its schedule with it, and what had landed in it goes back to "From below".
        await client.query('update folio.placements set landed_library = null, landed_folder = null where landed_folder = $1', [id]);
        await client.query('delete from folio.series_followers where series_id in (select id from folio.series where folder_id = $1)', [id]);
        await client.query('delete from folio.series where folder_id = $1', [id]);
        const { rowCount } = await client.query('delete from folio.folders where id = $2 and library_id = $1', [library, id]);
        return rowCount === 1;
      });
    } catch (err) {
      // A folder made inside it in the meantime.
      if ((err as { code?: string }).code === '23503') throw new NotEmptyError('Empty the folder first: it has folders in it.');
      throw err;
    }
  }
  async documents(library: string, query: DocumentQuery = {}): Promise<DocumentPage> {
    const params: unknown[] = [library];
    const param = (value: unknown) => `$${params.push(value)}`;
    const where = ['d.library_id = $1', 'd.deleted_at is null'];
    let place = '';
    if (!query.below) where.push(`d.folder_id is not distinct from ${param(query.folder ?? null)}::text`);
    else if (query.folder) {
      place = `with recursive place (id) as (
          select id from folio.folders where id = ${param(query.folder)} and library_id = $1
          union all select f.id from folio.folders f join place on f.parent_id = place.id)`;
      where.push('d.folder_id in (select id from place)');
    }
    const tags = [...new Set(query.tags ?? [])];
    if (tags.length) where.push(`(select count(*) from folio.document_tags dt where dt.document_id = d.id and dt.tag_id = any(${param(tags)}::text[])) = ${param(tags.length)}`);
    if (query.mediaTypes?.length) where.push(`v.media_type = any(${param(query.mediaTypes)}::text[])`);
    if (query.authors?.length) where.push(`d.created_by = any(${param(query.authors)}::text[])`);
    if (query.from) where.push(`d.updated_at >= ${param(query.from)}::timestamptz`);
    if (query.to) where.push(`d.updated_at < ${param(query.to)}::timestamptz`);
    if (query.states?.length) where.push(`${STATE_OF_D} = any(${param(query.states)}::text[])`);
    if (query.series) where.push(`d.series_id = ${param(query.series)}`);
    if (query.lifecycle?.length) where.push(`v.state = any(${param(query.lifecycle)}::text[])`);
    if (query.readers) where.push(visibleSql(param(query.readers), Boolean(query.audience)));
    const { limit, offset } = pageOf(query);
    const { rows } = await this.pool.query<DocumentRow>(
      `${place} ${DOCUMENT_SELECT} where ${where.join(' and ')} order by ${DOCUMENT_ORDER[query.sort ?? 'title']} limit ${param(limit)} offset ${param(offset)}`,
      params,
    );
    // Past the last page there are no rows to carry the count, so count again.
    const total: number = rows[0] ? Number(rows[0].total) : offset ? (await this.documents(library, { ...query, offset: 0, limit: 1 })).total : 0;
    return { documents: rows.map(fromDocumentRow), total };
  }

  async document(id: string) {
    const { rows } = await this.pool.query<DocumentRow>(`${DOCUMENT_SELECT} where d.id = $1 and d.deleted_at is null`, [id]);
    return rows[0] && fromDocumentRow(rows[0]);
  }

  async versions(document: string) {
    const { rows } = await this.pool.query<VersionRow>(`${VERSION_SELECT} where dv.document_id = $1 order by dv.number desc`, [document]);
    return rows.map((r) => publicVersion(fromVersionRow(r)));
  }

  async version(document: string, number: number) {
    const { rows } = await this.pool.query<VersionRow>(`${VERSION_SELECT} where dv.document_id = $1 and dv.number = $2`, [document, number]);
    return rows[0] && fromVersionRow(rows[0]);
  }

  private async insertVersion(client: pg.PoolClient, document: string, number: number, v: NewVersion) {
    const { rows } = await client.query<VersionRow>(
      `insert into folio.document_versions (id, workspace_id, document_id, number, filename, media_type, size_bytes, sha256, object_key, created_by)
        select $1, workspace_id, id, $3, $4, $5, $6, $7, $8, $9 from folio.documents where id = $2 returning ${VERSION_COLUMNS}`,
      [v.id, document, number, v.filename, v.mediaType, v.size, v.sha256, v.objectKey, v.createdBy],
    );
    // Its rendition waits for the worker, which hears of it as soon as this commits.
    await client.query('insert into folio.renditions (version_id, workspace_id) select id, workspace_id from folio.document_versions where id = $1', [v.id]);
    await client.query("select pg_notify('folio_renditions', $1)", [v.id]);
    const { rows: doc } = await client.query<{ workspace_id: string; library_id: string }>('select workspace_id, library_id from folio.documents where id = $1', [document]);
    await tell(client, TOPICS.versionCreated, doc[0].workspace_id, { document, library: doc[0].library_id, version: number });
    return fromVersionRow(rows[0]);
  }

  /** Writes down who may read each of a library's documents (or just `document`): its floor, and whoever has been let in. */
  private async writeReaders(client: pg.PoolClient, library: string, document?: string) {
    await client.query(
      `insert into folio.readers (document_id, workspace_id, library_id, principals)
        select d.id, d.workspace_id, d.library_id, array(
            select distinct p from (
              select coalesce(l.floor_principal, 'tree:' || l.workspace_id) as p
              union all select g.principal from folio.grants g where g.library_id = d.library_id and (g.document_id is null or g.document_id = d.id)
            ) x order by p)
          from folio.documents d join folio.libraries l on l.id = d.library_id
          where d.library_id = $1 and ($2::text is null or d.id = $2)
        on conflict (document_id) do update set principals = excluded.principals`,
      [library, document ?? null],
    );
  }

  /** Runs `work` in one transaction. */
  private async inTransaction<T>(work: (client: pg.PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  async createDocument({ id, library, folder: asked, title, createdBy, tags = [], series }: NewDocument, first: NewVersion) {
    await this.inTransaction(async (client) => {
      let issue: IssuePlace | undefined;
      let folder = asked;
      if (series) {
        // The series' row is locked first, so two issues added at once get the next two numbers.
        const { rows } = await client.query<{ cadence: Cadence; folder_id: string }>('select cadence, folder_id from folio.series where id = $1 and library_id = $2 for update', [series, library]);
        if (!rows[0]) throw new BadParentError('That series isn’t in this library.');
        // An issue goes in its series, wherever it was dropped.
        folder = rows[0].folder_id;
        const { rows: last } = await client.query<{ number: number; period_start: string }>(
          "select issue_number as number, to_char(period_start, 'YYYY-MM-DD') as period_start from folio.documents where series_id = $1 and deleted_at is null order by issue_number desc limit 1",
          [series],
        );
        issue = pickPlace(nextIssue(rows[0].cadence, last[0] && { number: last[0].number, periodStart: last[0].period_start }));
      }
      const shelf = await this.library(library);
      if (shelf) checkOpen(shelf, await this.folders(library), folder);
      const { rowCount } = await client.query(
        `insert into folio.documents (id, workspace_id, library_id, folder_id, title, created_by, series_id, issue_number, period_start, period)
          select $1, l.workspace_id, l.id, $3, $4, $5, $6, $7, $8, $9 from folio.libraries l
          where l.id = $2 and l.archived_at is null and ($3::text is null or exists (select 1 from folio.folders f where f.id = $3 and f.library_id = l.id))`,
        [id, library, folder ?? null, title, createdBy, series ?? null, issue?.number ?? null, issue?.periodStart ?? null, issue?.period ?? null],
      );
      if (!rowCount) throw new BadParentError(folder ? 'That folder isn’t in this library.' : 'There’s no such library.');
      await this.insertVersion(client, id, 1, first);
      await this.writeTags(client, id, tags);
      await this.writeReaders(client, library, id);
    });
    return (await this.document(id))!;
  }

  async addVersion(document: string, version: NewVersion) {
    return this.inTransaction(async (client) => {
      // Lock the document's row first, then count, so two uploads at once get the next two numbers.
      const { rowCount } = await client.query('select 1 from folio.documents where id = $1 and deleted_at is null for update', [document]);
      if (!rowCount) return undefined;
      const { rows } = await client.query<{ next: number }>('select coalesce(max(number), 0) + 1 as next from folio.document_versions where document_id = $1', [document]);
      const added = await this.insertVersion(client, document, rows[0].next, version);
      await client.query('update folio.documents set updated_at = now() where id = $1', [document]);
      return publicVersion(added);
    });
  }

  async updateDocument(id: string, change: { title?: string; folder?: string | null }) {
    const { rowCount } = await this.pool.query(
      `update folio.documents d set
          title = coalesce($2, d.title),
          folder_id = case when $3 then $4 else d.folder_id end,
          updated_at = now()
        where d.id = $1 and d.deleted_at is null
          and ($4::text is null or exists (select 1 from folio.folders f where f.id = $4 and f.library_id = d.library_id))`,
      [id, change.title ?? null, change.folder !== undefined, change.folder ?? null],
    );
    if (!rowCount) {
      if (change.folder && (await this.document(id))) throw new BadParentError('That folder isn’t in this library.');
      return undefined;
    }
    return this.document(id);
  }

  async purgeable(before: string, limit: number) {
    const { rows } = await this.pool.query<{
      id: string;
      workspace_id: string;
      library_id: string;
      title: string;
      deleted_at: Date;
      versions: { id: string; objectKey: string; readerKey: string | null; thumbnailKey: string | null; images: string[] | null }[];
    }>(
      `select d.id, d.workspace_id, d.library_id, d.title, d.deleted_at,
              coalesce(json_agg(json_build_object('id', v.id, 'objectKey', v.object_key, 'readerKey', r.reader_key, 'thumbnailKey', r.thumbnail_key, 'images', r.images))
                filter (where v.id is not null), '[]') as versions
         from folio.documents d
         left join folio.document_versions v on v.document_id = d.id
         left join folio.renditions r on r.version_id = v.id
        where d.deleted_at < $1 and d.purged_at is null
        group by d.id
        order by d.deleted_at
        limit $2`,
      [before, limit],
    );
    return rows.map((r) => ({ id: r.id, workspace: r.workspace_id, library: r.library_id, title: r.title, deletedAt: r.deleted_at.toISOString(), keys: r.versions.flatMap(keysOfVersion) }));
  }

  async markPurged(id: string) {
    return this.inTransaction(async (client) => {
      const { rowCount } = await client.query('update folio.documents set purged_at = now() where id = $1 and deleted_at is not null and purged_at is null', [id]);
      if (!rowCount) return false;
      await client.query('update folio.renditions set text = null where version_id in (select id from folio.document_versions where document_id = $1)', [id]);
      return true;
    });
  }

  async deleteDocument(id: string, by: string) {
    return this.inTransaction(async (client) => {
      const { rows } = await client.query<{ workspace_id: string; library_id: string }>(
        'update folio.documents set deleted_by = $2, deleted_at = now() where id = $1 and deleted_at is null returning workspace_id, library_id',
        [id, by],
      );
      if (rows[0]) await tell(client, TOPICS.deleted, rows[0].workspace_id, { document: id, library: rows[0].library_id });
      return Boolean(rows[0]);
    });
  }
  /** Replaces a document's tags inside `client`'s transaction; BadTagError for one that isn't the org's or its library's. */
  private async writeTags(client: pg.PoolClient, document: string, tags: readonly string[]) {
    const wanted = [...new Set(tags)];
    await client.query('delete from folio.document_tags where document_id = $1', [document]);
    if (!wanted.length) return;
    const { rowCount } = await client.query(
      `insert into folio.document_tags (document_id, tag_id, workspace_id)
        select d.id, t.id, d.workspace_id from folio.documents d join folio.tags t on t.library_id is null or t.library_id = d.library_id
        where d.id = $1 and t.id = any($2::text[])`,
      [document, wanted],
    );
    if (rowCount !== wanted.length) throw new BadTagError('That tag isn’t the org’s or this library’s.');
  }

  async setDocumentTags(id: string, tags: string[]) {
    const found = await this.inTransaction(async (client) => {
      const { rowCount } = await client.query('select 1 from folio.documents where id = $1 and deleted_at is null for update', [id]);
      if (!rowCount) return false;
      await this.writeTags(client, id, tags);
      return true;
    });
    return found ? this.document(id) : undefined;
  }

  async tags(library: string) {
    const { rows } = await this.pool.query<TagRow>(`select ${TAG_COLUMNS} from folio.tags where library_id is null or library_id = $1 order by lower(name), id`, [library]);
    return rows.map(fromTagRow);
  }

  async orgTags() {
    const { rows } = await this.pool.query<TagRow>(`select ${TAG_COLUMNS} from folio.tags where library_id is null order by lower(name), id`);
    return rows.map(fromTagRow);
  }

  async tag(id: string) {
    const { rows } = await this.pool.query<TagRow>(`select ${TAG_COLUMNS} from folio.tags where id = $1`, [id]);
    return rows[0] && fromTagRow(rows[0]);
  }

  /**
   * Before a tag takes `name`, inside the transaction: refuses a clash, and for an org
   * tag says which libraries' tags of that name it takes in.
   */
  private async claim(client: pg.PoolClient, tag: { id: string; library?: string }, name: string) {
    // One name changes hands at a time, so two leads can't each half-merge it.
    await client.query("select pg_advisory_xact_lock(hashtext('folio.tags'), hashtext(lower($1)))", [name]);
    const { rows: clash } = await client.query<{ name: string; library_id: string | null }>(
      'select name, library_id from folio.tags where id <> $1 and lower(name) = lower($2) and (library_id is null or library_id is not distinct from $3)',
      [tag.id, name, tag.library ?? null],
    );
    if (clash[0]) throw new NameTakenError(clash[0].library_id || !tag.library ? `There’s already a tag called ${name}.` : `${clash[0].name} is already one of the org’s tags.`);
    if (tag.library) return [];
    const { rows } = await client.query<{ id: string }>('select id from folio.tags where library_id is not null and lower(name) = lower($1)', [name]);
    return rows.map((r) => r.id);
  }

  /** After an org tag is in: documents and views with the tags it took in now carry it, and those tags go. */
  private async absorb(client: pg.PoolClient, into: string, absorbed: readonly string[]) {
    if (!absorbed.length) return;
    await client.query(
      `insert into folio.document_tags (document_id, tag_id, workspace_id)
        select document_id, $1, workspace_id from folio.document_tags where tag_id = any($2::text[]) on conflict do nothing`,
      [into, absorbed],
    );
    await this.untagViews(client, absorbed, into);
    await this.untagSeries(client, absorbed, into);
    await client.query('delete from folio.document_tags where tag_id = any($1::text[])', [absorbed]);
    await client.query('delete from folio.tags where id = any($1::text[])', [absorbed]);
  }

  private async untagSeries(client: pg.PoolClient, tags: readonly string[], to?: string) {
    const { rows } = await client.query<{ id: string; tags: string[] }>('select id, tags from folio.series where tags && $1::text[] for update', [tags]);
    const from = new Set(tags);
    for (const run of rows) await client.query('update folio.series set tags = $2 where id = $1', [run.id, retagged(run.tags, from, to).sort()]);
  }

  private async untagViews(client: pg.PoolClient, tags: readonly string[], to?: string) {
    const { rows } = await client.query<{ id: string; query: ViewQuery }>("select id, query from folio.views where query -> 'tags' ?| $1::text[] for update", [tags]);
    const from = new Set(tags);
    for (const view of rows) await client.query('update folio.views set query = $2 where id = $1', [view.id, JSON.stringify(retag(view.query, from, to))]);
  }

  async createTag({ workspace, library, name, createdBy }: { workspace: string; library?: string; name: string; createdBy: string }) {
    const id = randomUUID();
    try {
      return await this.inTransaction(async (client) => {
        const absorbed = await this.claim(client, { id, library }, name);
        const { rows } = await client.query<TagRow>(
          `insert into folio.tags (id, workspace_id, library_id, name, created_by) values ($1, $2, $3, $4, $5) returning ${TAG_COLUMNS}`,
          [id, workspace, library ?? null, name, createdBy],
        );
        await this.absorb(client, id, absorbed);
        return fromTagRow(rows[0]);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError(`There’s already a tag called ${name}.`);
      throw err;
    }
  }

  async renameTag(id: string, name: string) {
    try {
      return await this.inTransaction(async (client) => {
        const { rows: found } = await client.query<TagRow>(`select ${TAG_COLUMNS} from folio.tags where id = $1 for update`, [id]);
        if (!found[0]) return undefined;
        const tag = fromTagRow(found[0]);
        const absorbed = await this.claim(client, tag, name);
        await this.absorb(client, id, absorbed);
        const { rows } = await client.query<TagRow>(`update folio.tags set name = $2 where id = $1 returning ${TAG_COLUMNS}`, [id, name]);
        return fromTagRow(rows[0]);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError(`There’s already a tag called ${name}.`);
      throw err;
    }
  }

  async deleteTag(id: string) {
    return this.inTransaction(async (client) => {
      await this.untagViews(client, [id]);
      await this.untagSeries(client, [id]);
      await client.query('delete from folio.document_tags where tag_id = $1', [id]);
      const { rowCount } = await client.query('delete from folio.tags where id = $1', [id]);
      return rowCount === 1;
    });
  }

  async authors(library: string) {
    const { rows } = await this.pool.query<Person>(
      `select a.created_by as id, coalesce(p.name, '') as name
        from (select distinct created_by from folio.documents where library_id = $1 and deleted_at is null) a
        left join folio.people p on p.id = a.created_by
        order by coalesce(p.name, ''), a.created_by`,
      [library],
    );
    return rows;
  }

  async notePerson({ id, name }: Person) {
    await this.pool.query('insert into folio.people (id, name) values ($1, $2) on conflict (id) do update set name = excluded.name, seen_at = now()', [id, name]);
  }

  async people({ q, ids }: { q?: string; ids?: readonly string[] }) {
    const { rows } = ids
      ? await this.pool.query<Person>('select id, name from folio.people where id = any($1::text[]) order by name, id', [ids])
      : await this.pool.query<Person>("select id, name from folio.people where $1::text is null or name ilike '%' || $1 || '%' order by name, id limit 50", [q?.trim().replace(/[\\%_]/g, '\\$&') || null]);
    return rows;
  }

  async views(library: string) {
    const { rows } = await this.pool.query<ViewRow>(`select ${VIEW_COLUMNS} from folio.views where library_id = $1 order by lower(name), id`, [library]);
    return rows.map(fromViewRow);
  }

  async view(id: string) {
    const { rows } = await this.pool.query<ViewRow>(`select ${VIEW_COLUMNS} from folio.views where id = $1`, [id]);
    return rows[0] && fromViewRow(rows[0]);
  }

  async createView({ library, name, query, createdBy }: { library: string; name: string; query: ViewQuery; createdBy: string }) {
    try {
      const { rows } = await this.pool.query<ViewRow>(
        `insert into folio.views (id, workspace_id, library_id, name, query, created_by)
          select $1, workspace_id, id, $3, $4, $5 from folio.libraries where id = $2 returning ${VIEW_COLUMNS}`,
        [randomUUID(), library, name, JSON.stringify(query), createdBy],
      );
      if (!rows[0]) throw new BadParentError('There’s no such library.');
      return fromViewRow(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError(`There’s already a view called ${name} here.`);
      throw err;
    }
  }

  async updateView(id: string, change: { name?: string; query?: ViewQuery }) {
    try {
      const { rows } = await this.pool.query<ViewRow>(
        `update folio.views set name = coalesce($2, name), query = coalesce($3::jsonb, query) where id = $1 returning ${VIEW_COLUMNS}`,
        [id, change.name ?? null, change.query ? JSON.stringify(change.query) : null],
      );
      return rows[0] && fromViewRow(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError(`There’s already a view called ${change.name} here.`);
      throw err;
    }
  }

  async deleteView(id: string) {
    const { rowCount } = await this.pool.query('delete from folio.views where id = $1', [id]);
    return rowCount === 1;
  }

  async rendition(version: string) {
    const { rows } = await this.pool.query<RenditionRow>(`select ${RENDITION_COLUMNS} from folio.renditions where version_id = $1`, [version]);
    return rows[0] && fromRenditionRow(rows[0]);
  }

  async retryRendition(version: string) {
    const { rowCount } = await this.pool.query(
      `update folio.renditions set state = 'queued', attempts = 0, error = null, run_after = now(), locked_until = null, updated_at = now()
        where version_id = $1 and state = 'failed'`,
      [version],
    );
    if (rowCount) await this.pool.query("select pg_notify('folio_renditions', $1)", [version]);
    return rowCount === 1;
  }

  async finishRendition(version: string, result: RenditionResult) {
    if (result.state === 'failed') {
      await this.pool.query(
        `update folio.renditions set state = 'failed', attempts = attempts + 1, error = $2, locked_until = null, updated_at = now() where version_id = $1`,
        [version, result.error],
      );
      return;
    }
    await this.pool.query(
      `update folio.renditions set state = 'ready', attempts = attempts + 1, error = null, locked_until = null, updated_at = now(),
          engine = $2, engine_version = $3, reader_key = $4, thumbnail_key = $5, images = $6, pages = $7, text = $8
        where version_id = $1`,
      [version, result.engine, result.engineVersion, result.readerKey, result.thumbnailKey ?? null, JSON.stringify(result.images), result.pages ?? null, result.text],
    );
  }

  async grants(library: string, document?: string) {
    const { rows } = await this.pool.query<GrantRow>(
      `select ${GRANT_COLUMNS} from folio.grants where library_id = $1 and document_id is not distinct from $2::text order by principal`,
      [library, document ?? null],
    );
    return rows.map(fromGrantRow);
  }

  async setGrant({ library, document, principal, level, by }: { library: string; document?: string; principal: string; level: Level | null; by: string }) {
    return this.inTransaction(async (client) => {
      // One change to a library's grants at a time, so its readers are written from the grants as they end up.
      await client.query("select pg_advisory_xact_lock(hashtext('folio.grants'), hashtext($1))", [library]);
      await client.query('delete from folio.grants where library_id = $1 and document_id is not distinct from $2::text and principal = $3', [library, document ?? null, principal]);
      let grant: Grant | undefined;
      if (level) {
        const { rows } = await client.query<GrantRow>(
          `insert into folio.grants (workspace_id, library_id, document_id, principal, level, created_by)
            select l.workspace_id, l.id, $2, $3, $4, $5 from folio.libraries l
            where l.id = $1 and l.archived_at is null
              and ($2::text is null or exists (select 1 from folio.documents d where d.id = $2 and d.library_id = l.id and d.deleted_at is null))
            returning ${GRANT_COLUMNS}`,
          [library, document ?? null, principal, level, by],
        );
        if (!rows[0]) throw new BadParentError('There’s no such library or document.');
        grant = fromGrantRow(rows[0]);
      }
      await this.writeReaders(client, library, document);
      const { rows: shelf } = await client.query<{ workspace_id: string }>('select workspace_id from folio.libraries where id = $1', [library]);
      if (shelf[0]) await tell(client, TOPICS.readersChanged, shelf[0].workspace_id, { library, ...(document ? { document } : {}) });
      return grant;
    });
  }

  async readers(document: string) {
    const { rows } = await this.pool.query<{ principals: string[] }>(
      'select r.principals from folio.readers r join folio.documents d on d.id = r.document_id where r.document_id = $1 and d.deleted_at is null',
      [document],
    );
    return rows[0]?.principals ?? [];
  }

  async shared(principals: readonly string[], except: string): Promise<Shared> {
    const { rows: libraries } = await this.pool.query<LibraryRow & { level: Level }>(
      `select ${LIBRARY_COLUMNS.split(', ').map((c) => `l.${c}`).join(', ')}, g.level from folio.libraries l
        cross join lateral (
          select level from folio.grants g where g.library_id = l.id and g.document_id is null and g.principal = any($1::text[])
          order by array_position(array['read', 'edit', 'manage'], level) desc limit 1
        ) g
        where l.archived_at is null and l.workspace_id <> $2
        order by lower(l.name), l.id`,
      [principals, except],
    );
    const { rows: documents } = await this.pool.query<DocumentRow & { level: Level }>(
      `${DOCUMENT_SELECT}
        join folio.libraries l on l.id = d.library_id and l.archived_at is null
        cross join lateral (
          select level from folio.grants g where g.document_id = d.id and g.principal = any($1::text[])
          order by array_position(array['read', 'edit', 'manage'], level) desc limit 1
        ) g
        where d.deleted_at is null and d.workspace_id <> $2
          and not exists (select 1 from folio.grants lg where lg.library_id = d.library_id and lg.document_id is null and lg.principal = any($1::text[]))
        order by lower(d.title), d.id`.replace('count(*) over () as total', 'count(*) over () as total, g.level'),
      [principals, except],
    );
    return { libraries: libraries.map((r) => ({ ...fromLibraryRow(r), level: r.level })), documents: documents.map((r) => ({ ...fromDocumentRow(r), level: r.level })) };
  }

  async publish({ document, version, audience, note, by }: { document: string; version: number; audience: string[]; note?: string; by: string }) {
    return this.inTransaction(async (client) => {
      // The document's row is locked first, so two publishes at once end one another in turn.
      const { rows: found } = await client.query<{ version_id: string; workspace_id: string; library_id: string }>(
        `select dv.id as version_id, d.workspace_id, d.library_id from folio.documents d
          join folio.document_versions dv on dv.document_id = d.id and dv.number = $2
          where d.id = $1 and d.deleted_at is null for update of d`,
        [document, version],
      );
      const doc = found[0];
      if (!doc) return undefined;
      await client.query("update folio.publications set ended_as = 'replaced', ended_by = $2, ended_at = now() where document_id = $1 and ended_at is null", [document, by]);
      const { rows } = await client.query<PublicationRow>(
        `insert into folio.publications (id, workspace_id, library_id, document_id, version_id, version_number, audience, note, published_by)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning ${PUBLICATION_COLUMNS}`,
        [randomUUID(), doc.workspace_id, doc.library_id, document, doc.version_id, version, [...new Set(audience)].sort(), note ?? null, by],
      );
      const publication = fromPublicationRow(rows[0]);
      await tell(client, TOPICS.published, doc.workspace_id, { document, library: doc.library_id, version, publication: publication.id, audience: publication.audience });
      await tell(client, TOPICS.readersChanged, doc.workspace_id, { library: doc.library_id, document });
      return publication;
    });
  }

  async withdraw({ document, by, reason }: { document: string; by: string; reason?: string }) {
    return this.inTransaction(async (client) => {
      const { rows } = await client.query<PublicationRow & { workspace_id: string }>(
        `update folio.publications p set ended_as = 'withdrawn', ended_by = $2, ended_at = now(), end_reason = $3
          from folio.documents d where d.id = p.document_id and d.deleted_at is null and p.document_id = $1 and p.ended_at is null
          returning ${PUBLICATION_COLUMNS.split(', ').map((c) => `p.${c}`).join(', ')}, p.workspace_id`,
        [document, by, reason ?? null],
      );
      if (!rows[0]) return undefined;
      const publication = fromPublicationRow(rows[0]);
      await tell(client, TOPICS.withdrawn, rows[0].workspace_id, { document, library: publication.library, version: publication.version, publication: publication.id });
      await tell(client, TOPICS.readersChanged, rows[0].workspace_id, { library: publication.library, document });
      return publication;
    });
  }

  async publications(document: string) {
    const { rows } = await this.pool.query<PublicationRow>(`select ${PUBLICATION_COLUMNS} from folio.publications where document_id = $1 order by seq desc`, [document]);
    return rows.map(fromPublicationRow);
  }

  async publishedTo(principals: readonly string[], page: { limit?: number; offset?: number; since?: string } = {}): Promise<PublishedPage> {
    const { limit, offset } = pageOf(page);
    const { rows } = await this.pool.query<DocumentRow & { library_name: string }>(
      `${DOCUMENT_SELECT.replace('count(*) over () as total', 'count(*) over () as total, l.name as library_name')}
        join folio.libraries l on l.id = d.library_id and l.archived_at is null
        join folio.publications live on live.document_id = d.id and live.ended_at is null and live.audience && $1::text[]
        where d.deleted_at is null and ($4::timestamptz is null or live.published_at > $4)
        order by live.published_at desc, d.id desc limit $2 offset $3`,
      [principals, limit, offset, page.since ?? null],
    );
    const total = rows[0] ? Number(rows[0].total) : offset ? (await this.publishedTo(principals, { limit: 1, since: page.since })).total : 0;
    return { documents: rows.map((r) => ({ ...(fromDocumentRow(r) as FolioDocument & { published: Publication }), libraryName: r.library_name })), total };
  }

  async seriesIn(library: string) {
    const { rows } = await this.pool.query<SeriesRow>(`${SERIES_SELECT} where s.library_id = $1 order by lower(f.name), s.id`, [library]);
    return rows.map(fromSeriesRow);
  }

  async series(id: string) {
    const { rows } = await this.pool.query<SeriesRow>(`${SERIES_SELECT} where s.id = $1`, [id]);
    return rows[0] && fromSeriesRow(rows[0]);
  }

  /** BadTagError unless each tag is the org's or the library's. */
  private async checkSeriesTags(library: string, tags: readonly string[]) {
    if (!tags.length) return;
    const { rows } = await this.pool.query<{ n: string }>('select count(*) as n from folio.tags where id = any($1::text[]) and (library_id is null or library_id = $2)', [[...new Set(tags)], library]);
    if (Number(rows[0].n) !== new Set(tags).size) throw new BadTagError('That tag isn’t the org’s or this library’s.');
  }

  async createSeries({ library, folder, parent, name, description = '', cadence, audience = [], tags = [], createdBy }: { library: string; folder?: string; parent?: string; name: string; description?: string; cadence: Cadence; audience?: string[]; tags?: string[]; createdBy: string }) {
    await this.checkSeriesTags(library, tags);
    const id = randomUUID();
    await this.inTransaction(async (client) => {
      let home: { id: string; name: string };
      if (folder) {
        const { rows } = await client.query<{ level: FolderLevel; name: string; scheduled: boolean }>(
          'select level, name, exists (select 1 from folio.series s where s.folder_id = f.id) as scheduled from folio.folders f where f.id = $1 and f.library_id = $2',
          [folder, library],
        );
        if (rows[0]?.level !== 'series') throw new BadParentError('Only a series can have a schedule.');
        if (rows[0].scheduled) throw new NameTakenError('That series already has a schedule.');
        home = { id: folder, name: rows[0].name };
      } else home = await this.insertFolder(client, { library, parent, level: 'series', name, description, createdBy });
      try {
        await client.query('savepoint series');
        const { rowCount } = await client.query(
          `insert into folio.series (id, workspace_id, library_id, folder_id, name, description, cadence, audience, tags, created_by)
            select $1, workspace_id, id, $3, $4, $5, $6, $7, $8, $9 from folio.libraries where id = $2 and archived_at is null`,
          [id, library, home.id, home.name, description, cadence, [...new Set(audience)].sort(), [...new Set(tags)].sort(), createdBy],
        );
        if (!rowCount) throw new BadParentError('There’s no such library.');
      } catch (err) {
        if (isUniqueViolation(err)) throw new NameTakenError(`There’s already a series called ${home.name} here.`);
        throw err;
      }
    });
    return (await this.series(id))!;
  }

  async updateSeries(id: string, change: { name?: string; description?: string; cadence?: Cadence; audience?: string[]; tags?: string[] }) {
    const found = await this.series(id);
    if (!found) return undefined;
    if (change.tags) await this.checkSeriesTags(found.library, change.tags);
    try {
      if (change.name !== undefined) await this.updateFolder(found.library, found.folder, { name: change.name });
      await this.pool.query(
        `update folio.series set description = coalesce($2, description), cadence = coalesce($3, cadence),
            audience = coalesce($4, audience), tags = coalesce($5, tags), updated_at = now()
          where id = $1`,
        [id, change.description ?? null, change.cadence ?? null, change.audience ? [...new Set(change.audience)].sort() : null, change.tags ? [...new Set(change.tags)].sort() : null],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError(`There’s already a series called ${change.name} here.`);
      throw err;
    }
    return this.series(id);
  }

  async deleteSeries(id: string) {
    return this.inTransaction(async (client) => {
      const { rowCount } = await client.query('select 1 from folio.series where id = $1 for update', [id]);
      if (!rowCount) return false;
      // Deleted issues keep their place too: they can be brought back.
      const { rowCount: issues } = await client.query('select 1 from folio.documents where series_id = $1 limit 1', [id]);
      if (issues) throw new NotEmptyError('A series with issues stays, so its issues keep their place.');
      await client.query('delete from folio.series_followers where series_id = $1', [id]);
      const { rows } = await client.query<{ folder_id: string }>('delete from folio.series where id = $1 returning folder_id', [id]);
      // Its series goes too, unless something else has been put in it.
      await client.query(
        `delete from folio.folders f where f.id = $1 and not exists (select 1 from folio.folders c where c.parent_id = f.id)
          and not exists (select 1 from folio.documents d where d.folder_id = f.id)`,
        [rows[0].folder_id],
      );
      return true;
    });
  }

  async neighbours(document: string, principals: readonly string[]) {
    const { rows } = await this.pool.query<{ side: 'previous' | 'next'; id: string; library_id: string; title: string; issue_number: number; period: string }>(
      `with me as (select series_id, issue_number from folio.documents where id = $1 and series_id is not null)
        (select 'previous' as side, d.id, d.library_id, d.title, d.issue_number, d.period from folio.documents d, me
          where d.series_id = me.series_id and d.deleted_at is null and d.issue_number < me.issue_number and ${visibleSql('$2', true)}
          order by d.issue_number desc limit 1)
        union all
        (select 'next' as side, d.id, d.library_id, d.title, d.issue_number, d.period from folio.documents d, me
          where d.series_id = me.series_id and d.deleted_at is null and d.issue_number > me.issue_number and ${visibleSql('$2', true)}
          order by d.issue_number limit 1)`,
      [document, principals],
    );
    return Object.fromEntries(rows.map((r) => [r.side, { id: r.id, library: r.library_id, title: r.title, number: r.issue_number, period: r.period }]));
  }

  async follow(series: string, person: string, on: boolean) {
    if (on)
      await this.pool.query(
        'insert into folio.series_followers (series_id, person_id, workspace_id) select id, $2, workspace_id from folio.series where id = $1 on conflict do nothing',
        [series, person],
      );
    else await this.pool.query('delete from folio.series_followers where series_id = $1 and person_id = $2', [series, person]);
  }

  async followers(series: string) {
    const { rows } = await this.pool.query<{ person_id: string }>('select person_id from folio.series_followers where series_id = $1 order by person_id', [series]);
    return rows.map((r) => r.person_id);
  }

  async timedSeries() {
    const { rows } = await this.pool.query<SeriesRow>(
      `${SERIES_SELECT} join folio.libraries l on l.id = s.library_id and l.archived_at is null
        where s.cadence <> 'adhoc' and exists (select 1 from folio.documents d where d.series_id = s.id and d.deleted_at is null)`,
    );
    return rows.map(fromSeriesRow);
  }

  async markReminded(series: string, periodStart: string) {
    const { rowCount } = await this.pool.query('update folio.series set reminded_for = $2 where id = $1 and reminded_for is distinct from $2::date', [series, periodStart]);
    return rowCount === 1;
  }

  async lookedAt(person: string) {
    const { rows } = await this.pool.query<{ published_at: Date }>('select published_at from folio.looked where person_id = $1', [person]);
    return rows[0]?.published_at.toISOString();
  }

  async markLooked(person: string, at = new Date().toISOString()) {
    await this.pool.query(
      `insert into folio.looked (person_id, published_at) values ($1, $2)
        on conflict (person_id) do update set published_at = greatest(folio.looked.published_at, excluded.published_at)`,
      [person, at],
    );
  }

  async draftsOn(workspace: string, page: { limit?: number } = {}) {
    const { limit } = pageOf(page);
    const { rows } = await this.pool.query<DocumentRow & { library_name: string }>(
      `${DOCUMENT_SELECT.replace('count(*) over () as total', 'count(*) over () as total, l.name as library_name')}
        join folio.libraries l on l.id = d.library_id and l.archived_at is null
        where d.workspace_id = $1 and d.deleted_at is null and not exists (select 1 from folio.publications p where p.document_id = d.id)
        order by d.updated_at desc, d.id desc limit $2`,
      [workspace, limit],
    );
    return { documents: rows.map((r) => ({ ...fromDocumentRow(r), libraryName: r.library_name })), total: rows[0] ? Number(rows[0].total) : 0 };
  }

  async search(principals: readonly string[], q: string, limit = 10) {
    const words = searchWords(q);
    if (!words.length) return [];
    // Its readers search its newest version (v); its audience only the version published to them.
    const { rows } = await this.pool.query<DocumentRow & { library_name: string; audience_only: boolean }>(
      `${DOCUMENT_SELECT.replace('count(*) over () as total', 'count(*) over () as total, l.name as library_name, rd.document_id is null as audience_only')}
        join folio.libraries l on l.id = d.library_id and l.archived_at is null
        cross join (select to_tsquery('english', $2) as q) s
        left join folio.readers rd on rd.document_id = d.id and rd.principals && $1::text[]
        left join folio.publications live on live.document_id = d.id and live.ended_at is null and live.audience && $1::text[]
        left join folio.renditions rt on rt.version_id = case when rd.document_id is not null then v.id else live.version_id end
        cross join lateral (
          select to_tsvector('english', coalesce(string_agg(t.name, ' '), '')) as words
          from folio.document_tags dt join folio.tags t on t.id = dt.tag_id where dt.document_id = d.id
        ) tg
        where d.deleted_at is null and (rd.document_id is not null or live.id is not null)
          and (d.title_words || tg.words || coalesce(rt.words, ''::tsvector)) @@ s.q
        order by ts_rank(d.title_words, s.q) * 4 + ts_rank(tg.words, s.q) * 2 + coalesce(ts_rank(rt.words, s.q), 0) desc, d.updated_at desc, d.id
        limit $3`,
      [principals, tsQueryOf(words), Math.min(limit, MAX_PAGE)],
    );
    return rows.map((r) => ({ document: fromDocumentRow(r), libraryName: r.library_name, audienceOnly: r.audience_only }));
  }

  /** A connection pool whose search path is Folio's schema, for the outbox relay, which names its table plainly. */
  static outboxPool(connectionString: string) {
    return new pg.Pool({ connectionString, max: 2, options: '-c search_path=folio' });
  }
}

type GrantRow = { library_id: string; document_id: string | null; principal: string; level: Level; created_by: string; created_at: Date };
const GRANT_COLUMNS = 'library_id, document_id, principal, level, created_by, created_at';
const fromGrantRow = (r: GrantRow): Grant => ({
  library: r.library_id,
  ...(r.document_id ? { document: r.document_id } : {}),
  principal: r.principal,
  level: r.level,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
});
