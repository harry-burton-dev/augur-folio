import { CONTAINER_LIFECYCLE, CONTENT_LIFECYCLE, defineLevels, furthest, reaches, type Level } from '@augur/records';
import type { OnFloor } from '@augur/service-kit';
import type { ContentState, FolderLevel, LevelInfo, PathStep, Rights, UnitLevel } from './api-types.ts';
import type { FolderRecord, GrantRecord } from './store.ts';

/**
 * Who may do what in a floor's library. Standing on the floor gives a level by role: its leads manage it,
 * an editor edits, anyone else reads. Off the floor, only a grant lets someone in: on the library, a
 * folder above, or the document itself, whichever reaches furthest. A grant to a team reaches its members
 * (identity's principals: `person:`, `team:`, `tree:` and `org`).
 */

/** The form a library takes. A level can be skipped but never turned round (App patterns). */
const LEVEL_DEFS = [
  { id: 'collection', name: 'Collection', plural: 'Collections', holds: ['subcollection', 'series', 'file'] },
  { id: 'subcollection', name: 'Subcollection', plural: 'Subcollections', holds: ['series', 'file'] },
  { id: 'series', name: 'Series', plural: 'Series', holds: ['subseries', 'file'] },
  { id: 'subseries', name: 'Subseries', plural: 'Subseries', holds: ['file'] },
  { id: 'file', name: 'File', plural: 'Files', holds: [] },
] as const satisfies readonly { id: UnitLevel; name: string; plural: string; holds: readonly UnitLevel[] }[];
export const UNIT_LEVELS = defineLevels<UnitLevel>(LEVEL_DEFS, ['collection']);

/** What a level holds. */
export const holdsOf = (level: UnitLevel): UnitLevel[] => [...UNIT_LEVELS.get(level).holds];

/** The levels, called what the org calls them. */
export const levelInfo = (names: Partial<Record<UnitLevel, { name: string; plural: string }>>): LevelInfo[] =>
  LEVEL_DEFS.map((l) => ({ id: l.id, name: names[l.id]?.name ?? l.name, plural: names[l.id]?.plural ?? l.plural, holds: [...l.holds] }));

/** The level a folder made in `parent` is, when nobody says: the next one down that holds things. */
export const nextLevel = (parent: FolderLevel): FolderLevel | undefined => UNIT_LEVELS.get(parent).holds.find((l): l is FolderLevel => l !== 'file');

/** The level someone standing on the floor has there. */
export const floorLevel = (caller: OnFloor): Level => (caller.workspace.role === 'lead' ? 'manage' : caller.roles.includes('editor') ? 'edit' : 'read');

/** A folder and the ones above it, from the top. */
export const pathTo = (folders: ReadonlyMap<string, FolderRecord>, id: string): FolderRecord[] => {
  const out: FolderRecord[] = [];
  const seen = new Set<string>();
  for (let at = folders.get(id); at && !seen.has(at.id); at = at.parent ? folders.get(at.parent) : undefined) {
    seen.add(at.id);
    out.unshift(at);
  }
  return out;
};

export const stepsOf = (path: readonly FolderRecord[]): PathStep[] => path.map((f) => ({ id: f.id, name: f.name, level: f.level }));

/** Everything a floor's access is worked out from, loaded once for a request. */
export interface FloorAccess {
  workspace: string;
  folders: ReadonlyMap<string, FolderRecord>;
  grants: readonly GrantRecord[];
  /** What the caller stands for. */
  principals: readonly string[];
  /** Their level from standing on the floor; undefined off it. */
  standing?: Level;
}

const granted = (access: FloorAccess, record: string) => furthest(...access.grants.filter((g) => g.record === record && access.principals.includes(g.principal)).map((g) => g.level));

/** How far the caller reaches into the library itself. */
export const libraryLevel = (access: FloorAccess) => furthest(access.standing, granted(access, access.workspace));

/** How far the caller reaches into a folder: the furthest of the library's and every folder's above it. */
export const folderLevel = (access: FloorAccess, folder: string) => furthest(libraryLevel(access), ...pathTo(access.folders, folder).map((f) => granted(access, f.id)));

export const documentLevel = (access: FloorAccess, document: { id: string; folder: string }) => furthest(folderLevel(access, document.folder), granted(access, document.id));

/** Whether anything in the folder is closed to new things: it, or one above it. */
export const closedAbove = (access: FloorAccess, folder: string) => pathTo(access.folders, folder).find((f) => f.state !== 'open');

/** What a level lets the caller do, with the reason for what it doesn't, for the screen. */
export const rightsFor = (level: Level, { freeTags = false, closed }: { freeTags?: boolean; closed?: Pick<FolderRecord, 'name' | 'state'> } = {}): Rights => {
  const edit = reaches(level, 'edit');
  const manage = reaches(level, 'manage');
  const add = edit && !closed;
  const why = closed
    ? `“${closed.name}” is ${closed.state}, so nothing new goes in. Whoever manages it can open it again.`
    : !edit
      ? 'You can read here. The floor’s leads, or whoever shared it with you, can let you change it.'
      : !manage
        ? 'Issuing, retiring and sharing are for whoever manages this: the floor’s leads, or someone they let manage it.'
        : undefined;
  return { level, add, tag: edit && (manage || freeTags), manage, share: manage, ...(why ? { why } : {}) };
};

/** Where a version can go from the state it is in, and why not for the moves this level can't make. */
export const nextStates = (from: ContentState, level: Level) =>
  CONTENT_LIFECYCLE.states
    .map((s) => ({ to: s.id, needs: CONTENT_LIFECYCLE.needs(from, s.id) }))
    .filter((m): m is { to: ContentState; needs: Level } => Boolean(m.needs))
    .map((m) => ({
      to: m.to,
      allowed: reaches(level, m.needs),
      ...(reaches(level, m.needs) ? {} : { why: m.needs === 'manage' ? 'Only whoever manages it can do that: the floor’s leads, or someone they let manage it.' : 'Only someone who can edit it can do that.' }),
    }));

export { CONTAINER_LIFECYCLE, CONTENT_LIFECYCLE, reaches, furthest, type Level };
