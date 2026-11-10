// Artifacts' wire types, written once. The service answers with them, its OpenAPI document (openapi.ts)
// describes them and the frontend reads them (frontend/src imports this file), so none of the three
// can drift from the others (AUGUR's ADR 0055). Types only, and the schemas made from them.

export type FloorKind = 'personal' | 'team' | 'org';
/** collection › subcollection › series › subseries › file. */
export type UnitLevel = 'collection' | 'subcollection' | 'series' | 'subseries' | 'file';
export type FolderLevel = Exclude<UnitLevel, 'file'>;
export type ContainerState = 'open' | 'closed' | 'archived';
export type ContentState = 'in-progress' | 'in-review' | 'complete' | 'issued' | 'retired';
export type Level = 'read' | 'edit' | 'manage';
export type GrantKind = 'library' | 'folder' | 'document';
/** Where a version's reader copy is: waiting, being made, made, given up on, or not one this kind of file has. */
export type ReaderState = 'queued' | 'working' | 'ready' | 'failed' | 'none';

/** What the caller may do with a thing, so the screen offers only what will work, and says why not. */
export interface Rights {
  /** How far they are let in. */
  level: Level;
  /** Add documents, versions and folders below it. */
  add: boolean;
  /** Tag it, and make new tags while doing so when the floor lets people. */
  tag: boolean;
  /** Issue, retire, close, archive, delete. */
  manage: boolean;
  /** Let people and teams in. */
  share: boolean;
  /** Why the ones that are false are false, in a sentence for the screen. */
  why?: string;
}

/** A level, called what the org calls it, and what it may hold. */
export interface LevelInfo {
  id: UnitLevel;
  name: string;
  plural: string;
  holds: UnitLevel[];
}

export interface FolderView {
  id: string;
  parent?: string;
  level: FolderLevel;
  name: string;
  description: string;
  state: ContainerState;
  tags: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A step of the path from the floor's library down to a thing. */
export interface PathStep {
  id: string;
  name: string;
  level: FolderLevel;
}

export interface VersionView {
  number: number;
  filename: string;
  mediaType: string;
  size: number;
  state: ContentState;
  createdBy: string;
  createdByName?: string;
  createdAt: string;
  /** Where its reader copy is. */
  reader?: ReaderState;
  /** Whether it has a picture of its first page (`…/thumbnail`). */
  thumbnail: boolean;
}

/**
 * `GET /v1/documents/:id/versions/:number/reader`: the version's reader copy, as Markdown for the kit's
 * reader. Its pictures are paths under the app's own API, which the host fetches. Without one, `why`
 * says why and what can be done.
 */
export interface ReaderAnswer {
  state: ReaderState;
  markdown?: string;
  pages?: number;
  why?: string;
  /** Whether the caller can ask for it again (it failed, and they can change the document). */
  retry: boolean;
}

export interface DocumentView {
  id: string;
  folder: string;
  title: string;
  tags: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  latest: VersionView;
  /** The newest Issued version, which is what readers get, when there is one. */
  issued?: VersionView;
  /** Where the caller's one place for it is, when that is a floor above this one: a signpost there. */
  placed?: Signpost;
}

/** A move from one lifecycle state to another, on the record. */
export interface MoveView {
  version?: number;
  from?: string;
  to: string;
  by: string;
  byName?: string;
  at: string;
  note?: string;
}

/** `GET /v1/library`: the floor's library, its collections and the levels. */
export interface LibraryAnswer {
  floor: { id: string; kind: FloorKind };
  freeTags: boolean;
  rights: Rights;
  levels: LevelInfo[];
  collections: FolderView[];
}

/** `GET /v1/folders/:id`: a folder, the path down to it, and the folders in it. */
export interface FolderAnswer {
  folder: FolderView;
  path: PathStep[];
  folders: FolderView[];
  rights: Rights;
  /** What a folder made in it would be, and what else it may be. */
  holds: UnitLevel[];
  /** What floors below published up here that the floor's leads put in this folder. */
  received: ReceivedItem[];
  /** Where the caller's one place for this folder is, when that is a floor above. */
  placed?: Signpost;
  /** For a series: whether the caller follows it, and how many do. */
  follow?: { following: boolean; followers: number };
}

/** `GET /v1/folders/:id/documents`: a page of what's in it. */
export interface DocumentPage {
  documents: DocumentView[];
  total: number;
}

/** `GET /v1/documents/:id`: everything About shows. */
export interface DocumentAnswer {
  /** The floor it is kept on, which is another floor's when it was shared with the caller. */
  floor: { id: string; kind: FloorKind };
  document: DocumentView;
  path: PathStep[];
  versions: VersionView[];
  moves: MoveView[];
  rights: Rights;
  /** For each version's state, where it can go from there, and why not when it can't. */
  next: { to: ContentState; allowed: boolean; why?: string }[];
  /** When the caller reads it only because it was published up to a floor of theirs: which, and the one version that lets them see. */
  reached?: { placement: string; floor: FloorView; version: number };
}

/** A floor as publishing up names it: a team's or someone's own floor by its id, the org as `org`. */
export interface FloorView {
  id: string;
  kind: FloorKind;
  name: string;
  /** How high it sits: the org 0, a team how deep it is, someone's own floor lowest. */
  rank: number;
}

export type RecordKind = 'folder' | 'document';

/** What a placement shows: a folder (and all in it) or a document. */
export interface RecordRef {
  kind: RecordKind;
  id: string;
  name: string;
  level: UnitLevel;
}

/** A record published up to a floor, through a filter of lifecycle states. */
export interface PlacementView {
  id: string;
  record: RecordRef;
  from: FloorView;
  to: FloorView;
  filter: ContentState[];
  /** The placement it came up through, when a floor that received it published it on. */
  via?: string;
  /** Where the receiving floor put it in its library; none while it waits under From below. */
  landed?: { folder: string; name: string };
  note?: string;
  by: string;
  byName?: string;
  at: string;
  ended?: { at: string; by: string; reason?: string };
  /** What the caller may do with it, and why not. */
  can: { withdraw: boolean; land: boolean; why?: string };
}

/** A floor a record could be published up to, or why not. */
export interface PublishTarget {
  from: FloorView;
  to: FloorView;
  /** Publishing on from a floor that received it: that placement, and the most it may show. */
  via?: string;
  most?: ContentState[];
  why?: string;
}

/** `GET /v1/placements?record=`: where a record is, who owns it, every step up, and where it could go next. */
export interface PlacementsAnswer {
  record: RecordRef;
  /** The floor it is kept on. */
  own: FloorView;
  /** The highest floor it has reached, or its own. */
  owner: FloorView;
  placements: PlacementView[];
  targets: PublishTarget[];
}

/** A pointer from a floor below to where something's one place is. */
export interface Signpost {
  placement: string;
  to: FloorView;
  /** Where it sits there, when its leads gave it a place. */
  landed?: string;
}

/** Something published up to this floor, as From below and a folder that holds it show it. */
export interface ReceivedItem {
  placement: PlacementView;
  /** The states the caller sees of it here, with every floor of theirs counted. */
  states: ContentState[];
  /** For a document, the version the caller sees, when one passes. */
  version?: VersionView;
}

/** A folder on this floor a received record may be put in. */
export interface LandingPlace {
  id: string;
  /** Its path, `Procedures › Berths`. */
  label: string;
  level: FolderLevel;
}

/** `GET /v1/received`: what floors below published up to this one. */
export interface ReceivedAnswer {
  /** Waiting for a place here, or put somewhere on this floor. */
  here: ReceivedItem[];
  /** Ones whose place for the caller is a floor higher up. */
  signposts: (Signpost & { record: RecordRef })[];
  /** Where the floor's leads may put things; empty for anyone else. */
  places: LandingPlace[];
}

/** `GET /v1/received/:id?folder=`: inside a folder published up here. */
export interface ReceivedFolderAnswer {
  placement: PlacementView;
  folder: { id: string; name: string; level: FolderLevel };
  /** From the published folder down to this one. */
  path: PathStep[];
  folders: FolderView[];
  documents: (DocumentView & { version: VersionView })[];
  states: ContentState[];
}

/** A kind of link, read from the document it starts at and back from the other end, and whether it can be made here. */
export interface LinkKind {
  id: string;
  name: string;
  inverse: string;
  available: boolean;
  why?: string;
}

/** The other end of a link: a document here, or a thing another app keeps. */
export interface LinkEnd {
  app: string;
  kind: string;
  id: string;
  label: string;
  /** Why the caller can't open it, when they can't. It stays listed. */
  unavailable?: string;
}

export interface LinkView {
  id: string;
  relation: string;
  /** The link in words, read from this document: "Supersedes", or back, "Superseded by". */
  words: string;
  /** Where it goes: for a link from this document. */
  to?: LinkEnd;
  /** Where it comes from: for a link back to it. */
  from?: LinkEnd;
  by: string;
  byName?: string;
  at: string;
}

/** `GET /v1/documents/:id/links`: its links, the links back to it, and whether the caller may change them. */
export interface LinksAnswer {
  kinds: LinkKind[];
  links: LinkView[];
  back: LinkView[];
  can: { change: boolean; why?: string };
}

export interface TagView {
  id: string;
  name: string;
  /** One of the org's tags, rather than this floor's. */
  org: boolean;
}

export interface GrantView {
  kind: GrantKind;
  record: string;
  principal: string;
  /** The person's or team's name, when known. */
  name?: string;
  level: Level;
  createdBy: string;
  createdAt: string;
}

/** Something shared with the caller from another floor. */
export interface SharedItem {
  kind: GrantKind;
  id: string;
  title: string;
  floor: string;
  level: Level;
  path: string;
}

/** One thing on Home: a document or a piece of work, and where in the app it opens. */
export interface HomeItem {
  id: string;
  title: string;
  /** One line under it: why it is here ("Waiting for your review since Monday"). */
  detail?: string;
  /** Where it opens, below the app's address. */
  path: string;
}

/** `GET /v1/home`: what needs the person on this floor first, then what's new since they looked. */
export interface Home {
  floor: { id: string; kind: FloorKind };
  needsYou: HomeItem[];
  latest: HomeItem[];
  /** When they last looked, if ever. */
  since?: string;
}

/** `GET /v1/people?q=`: people and teams to share with, as the people picker shows them. */
export interface PeopleAnswer {
  query: string;
  items: { kind: 'person' | 'team'; id: string; name: string; detail?: string }[];
  error?: string;
}

const homeItemSchema = {
  type: 'object',
  required: ['id', 'title', 'path'],
  additionalProperties: false,
  properties: { id: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' }, path: { type: 'string' } },
} as const;

/** `Home` as JSON Schema: the route's response schema and the OpenAPI document's. */
export const homeSchema = {
  type: 'object',
  required: ['floor', 'needsYou', 'latest'],
  additionalProperties: false,
  properties: {
    floor: {
      type: 'object',
      required: ['id', 'kind'],
      additionalProperties: false,
      properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['personal', 'team', 'org'] } },
    },
    needsYou: { type: 'array', items: homeItemSchema },
    latest: { type: 'array', items: homeItemSchema },
    since: { type: 'string' },
  },
} as const;
