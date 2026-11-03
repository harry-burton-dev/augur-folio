import { peopleFor, type AudienceLookup, type DirectoryResult, type DirectorySearch } from '@augur/service-kit';
import { manifest } from './manifest.ts';
import type { OnFloor } from './app.ts';
import type { FolioStore } from './store.ts';

/** Who the caller stands for: the principals Folio matches against who may see a library or document. */
export type CallerPrincipals = (caller: OnFloor) => Promise<string[]>;

/**
 * Without identity, as under `pnpm dev:app`: the caller, the floor they're on
 * when it's a team (as its member), and the org. Enough to try sharing with.
 */
export const floorPrincipals: CallerPrincipals = async (caller) => [
  `person:${caller.id}`,
  ...(caller.workspace.kind === 'team' ? [`team:${caller.workspace.id}`, `tree:${caller.workspace.id}`] : []),
  'org',
];

/** Without identity: the people Folio has seen, by name. Teams can't be found. */
export const seenPeople =
  (store: FolioStore): DirectorySearch =>
  async ({ q, ids, limit = 20 }) => {
    const people = await store.people({ q, ids });
    return { people: people.slice(0, ids ? undefined : limit), teams: [] } satisfies DirectoryResult;
  };

/** Without identity, no one can be worked out from an audience, so no one is told. */
const noAudience: AudienceLookup = async () => [];

/**
 * Asks identity, as Folio (the `people:read` scope), or, with no IDENTITY_URL
 * or sign-in as under `pnpm dev:app`, makes do with the floor and the people
 * Folio has seen.
 */
export const peopleFromEnv = (store: FolioStore, env = process.env): { principals: CallerPrincipals; directory: DirectorySearch; audience: AudienceLookup } => {
  const fallback = { principals: async () => [], directory: seenPeople(store), audience: noAudience };
  const people = peopleFor(manifest.id, { fallback, env });
  if (people === fallback) return { principals: floorPrincipals, directory: fallback.directory, audience: noAudience };
  return { principals: (caller) => people.principals(caller.id, caller.workspace), directory: people.directory, audience: people.audience };
};

/** A floor's principal: who a library made on it lets in. */
export const floorPrincipalOf = (caller: OnFloor) =>
  caller.workspace.kind === 'personal' ? `person:${caller.id}` : caller.workspace.kind === 'org' ? 'org' : `tree:${caller.workspace.id}`;

/** A principal as people see it: what kind it is and who, by name, when the directory knows them. */
export interface Described {
  principal: string;
  kind: 'person' | 'team' | 'tree' | 'org';
  name?: string;
  email?: string;
  /** For a team: the teams it sits in, from the top down. */
  within?: string[];
}

const kindOf = (principal: string) => (principal === 'org' ? 'org' : (principal.split(':')[0] as Described['kind']));
export const idOf = (principal: string) => principal.slice(principal.indexOf(':') + 1);

/** Names principals, as far as the directory knows them. */
export const describePrincipals =
  (directory: DirectorySearch) =>
  async (principals: readonly string[]): Promise<Described[]> => {
    const ids = [...new Set(principals.filter((p) => p !== 'org').map(idOf))];
    const found = ids.length ? await directory({ ids }) : { people: [], teams: [] };
    const people = new Map(found.people.map((p) => [p.id, p]));
    const teams = new Map(found.teams.map((t) => [t.id, t]));
    return principals.map((principal) => {
      const kind = kindOf(principal);
      if (kind === 'org') return { principal, kind };
      if (kind === 'person') {
        const person = people.get(idOf(principal));
        return { principal, kind, ...(person ? { name: person.name, ...(person.email ? { email: person.email } : {}) } : {}) };
      }
      const team = teams.get(idOf(principal));
      return { principal, kind, ...(team ? { name: team.name, within: team.within } : {}) };
    });
  };
