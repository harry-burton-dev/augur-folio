import { defineLevels, type ContainerState, type ContentState } from '@augur/records';

/**
 * The form a floor's library takes: collection › subcollection › series ›
 * subseries › file. A collection is what Folio's store calls a library; the
 * three levels between it and the files are what it calls folders. Each level
 * can be skipped but never turned round (docs/app-patterns.md).
 */
export const UNIT_LEVELS = defineLevels<UnitLevel>(
  [
    { id: 'collection', name: 'Collection', plural: 'Collections', holds: ['subcollection', 'series', 'file'] },
    { id: 'subcollection', name: 'Subcollection', plural: 'Subcollections', holds: ['series', 'file'] },
    { id: 'series', name: 'Series', plural: 'Series', holds: ['subseries', 'file'] },
    { id: 'subseries', name: 'Subseries', plural: 'Subseries', holds: ['file'] },
    { id: 'file', name: 'File', plural: 'Files', holds: [] },
  ],
  ['collection'],
);

export type UnitLevel = 'collection' | 'subcollection' | 'series' | 'subseries' | 'file';
/** The levels between a collection and its files: what the store keeps as folders. */
export type FolderLevel = 'subcollection' | 'series' | 'subseries';
export const FOLDER_LEVELS: readonly FolderLevel[] = ['subcollection', 'series', 'subseries'];

/** The first level a new folder in `parent` can be, when nobody says: the next one down. */
export const nextLevel = (parent: UnitLevel): FolderLevel | undefined => UNIT_LEVELS.get(parent).holds.find((l): l is FolderLevel => l !== 'file');

export type { ContainerState, ContentState };
