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
}

/** `GET /v1/folders/:id/documents`: a page of what's in it. */
export interface DocumentPage {
  documents: DocumentView[];
  total: number;
}

/** `GET /v1/documents/:id`: everything About shows. */
export interface DocumentAnswer {
  document: DocumentView;
  path: PathStep[];
  versions: VersionView[];
  moves: MoveView[];
  rights: Rights;
  /** For each version's state, where it can go from there, and why not when it can't. */
  next: { to: ContentState; allowed: boolean; why?: string }[];
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
