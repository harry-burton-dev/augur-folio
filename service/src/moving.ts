import type { DirectorySearch, DirectoryTeam } from '@augur/service-kit';
import type { Audit } from './audit.ts';
import { idOf } from './people.ts';
import { floorKeyOf, principalOfFloor } from './placements.ts';
import { PlacedError, reaches, type FolioStore, type Publication } from './store.ts';

/** Why a publication ended when it was moved onto publishing up: shown in its history. */
export const MOVED_REASON = 'Moved onto publishing up the floors.';
/** How many publications are moved at a time. */
const BATCH = 50;

export interface MoveOptions {
  store: FolioStore;
  directory: DirectorySearch;
  audit: Audit;
  log: { error(obj: object, msg: string): void };
}

/** What one publication becomes: floors above to publish it up to, and principals to share it with. */
export interface Moved {
  up: string[];
  share: string[];
}

/**
 * Where a document published to an audience goes now. Its own floor, and the
 * teams below it, see it already. A floor above (a team its floor sits in, or
 * the org) gets it published up, showing what's Issued, as the version that
 * was out is. Anyone else it went to (a team beside it, one person's own floor's
 * audience) keeps it by a share, so nobody loses what they could read.
 */
export const moveOf = (home: string, personal: boolean, audience: readonly string[], teams: ReadonlyMap<string, DirectoryTeam>): Moved => {
  const up = new Set<string>();
  const share = new Set<string>();
  const homePath = teams.get(home)?.path ?? [home];
  for (const a of audience) {
    if (a === 'org') {
      if (home !== 'org') up.add('org');
      continue;
    }
    const team = idOf(a);
    if (home === 'org') continue;
    if (personal) {
      share.add(a);
      continue;
    }
    if (team === home || teams.get(team)?.path?.includes(home)) continue;
    if (homePath.includes(team)) up.add(team);
    else share.add(a);
  }
  return { up: [...up], share: [...share] };
};

/**
 * Moves what's published the old way (a version of a document out to an
 * audience) onto publishing up the floors, then ends the old publication. A
 * series' issues stay as they are: a series still sends each issue to its
 * audience. Safe to run again: once moved, a publication isn't out any more.
 * Returns how many were moved.
 */
export const movePublications = async ({ store, directory, audit, log }: MoveOptions) => {
  let moved = 0;
  for (;;) {
    const due = await store.publicationsToMove(BATCH);
    if (!due.length) return moved;
    const ids = [...new Set(due.flatMap((p) => p.audience.filter((a) => a !== 'org').map(idOf)))];
    const libraries = new Map<string, Awaited<ReturnType<FolioStore['library']>>>();
    for (const p of due) if (!libraries.has(p.library)) libraries.set(p.library, await store.library(p.library, { archived: true }));
    const homes = [...libraries.values()].flatMap((l) => (l && l.floor.startsWith('tree:') ? [l.workspace] : []));
    const all = [...new Set([...ids, ...homes])];
    const teams = new Map((all.length ? (await directory({ ids: all })).teams : []).map((t) => [t.id, t]));
    for (const p of due) {
      const library = libraries.get(p.library);
      if (!library) continue;
      try {
        await moveOne(store, audit, p, library, teams);
        moved++;
      } catch (err) {
        log.error({ err: (err as Error).message, publication: p.id }, 'could not move a publication onto publishing up');
        return moved;
      }
    }
  }
};

const moveOne = async (store: FolioStore, audit: Audit, p: Publication, library: NonNullable<Awaited<ReturnType<FolioStore['library']>>>, teams: ReadonlyMap<string, DirectoryTeam>) => {
  const home = floorKeyOf(library);
  const { up, share } = moveOf(home, library.floor.startsWith('person:'), p.audience, teams);
  for (const to of up) {
    try {
      await store.place({
        library: library.id,
        record: { kind: 'document', id: p.document },
        from: home,
        to,
        toPrincipal: principalOfFloor(to),
        filter: ['issued'],
        ...(p.note ? { note: p.note } : {}),
        by: p.publishedBy,
      });
    } catch (err) {
      if (!(err instanceof PlacedError)) throw err;
    }
  }
  const held = await store.grants(library.id, p.document);
  for (const principal of share) {
    if (held.some((g) => g.principal === principal && g.document === p.document && reaches(g.level, 'read'))) continue;
    await store.setGrant({ library: library.id, document: p.document, principal, level: 'read', by: p.publishedBy });
  }
  // The new ones first, so whoever could read it never stops being able to.
  await store.withdraw({ document: p.document, by: 'folio', reason: MOVED_REASON });
  await audit({
    actor: 'folio',
    actorKind: 'service',
    action: 'document.moved-up',
    target: p.document,
    workspace: library.workspace,
    detail: { library: library.id, publication: p.id, version: p.version, up, shared: share },
  });
};
