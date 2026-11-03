import type { PathStep } from '@augur/app-kit';
import { CONTENT_STATES, type ContentState, type FloorView, type Placement } from './api.js';

/** A record's steps up the floors, in words and as a path. */

/** "Complete and Issued": what a step lets through, in words. */
export const filterWords = (filter: readonly string[]) => {
  const names = CONTENT_STATES.filter((s) => filter.includes(s.id)).map((s) => s.name);
  return names.length <= 1 ? (names[0] ?? 'nothing') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
};

/** A floor's name as a sentence says it: "the org", "Finance", "your own floor". */
export const floorWords = (floor: FloorView | undefined) => (!floor ? 'a floor that’s gone' : floor.kind === 'org' ? 'the org' : floor.kind === 'personal' ? 'your own floor' : floor.name);

/**
 * The floors a record sits on, from its own floor to the top, as a path: the
 * one that owns it marked, the one you're standing on ringed.
 */
export const chainSteps = (own: FloorView | undefined, live: readonly Placement[], owner: FloorView | undefined, here?: string): PathStep[] => {
  const floors = new Map<string, { floor: FloorView; filter?: ContentState[] }>();
  if (own) floors.set(own.id, { floor: own });
  for (const p of live) if (p.toFloor) floors.set(p.toFloor.id, { floor: p.toFloor, filter: p.filter });
  return [...floors.values()]
    .sort((a, b) => a.floor.rank - b.floor.rank)
    .map(({ floor, filter }) => ({
      id: floor.id,
      floor: floor.kind,
      title: floor.kind === 'org' ? 'The org' : floor.name,
      line: filter ? `Shows ${filterWords(filter).toLowerCase()}` : 'Where it’s kept',
      ...(owner?.id === floor.id ? { mark: 'Owns it' } : {}),
      ...(here === floor.id ? { here: true } : {}),
    }));
};
