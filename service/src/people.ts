import { appCredentialsFromEnv, identityDirectory, identityPrincipals, type DirectoryResult, type DirectorySearch } from '@augur/service-kit';
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

/**
 * Asks identity, as Folio (the `people:read` scope), or, with no IDENTITY_URL
 * or sign-in as under `pnpm dev:app`, makes do with the floor and the people
 * Folio has seen.
 */
export const peopleFromEnv = (store: FolioStore, env = process.env): { principals: CallerPrincipals; directory: DirectorySearch } => {
  const credentials = appCredentialsFromEnv('folio', env);
  const identityUrl = env.IDENTITY_URL;
  if (!identityUrl || !credentials) return { principals: floorPrincipals, directory: seenPeople(store) };
  const lookup = identityPrincipals({ identityUrl, credentials });
  return { principals: (caller) => lookup(caller.id), directory: identityDirectory({ identityUrl, credentials }) };
};

/** A floor's principal: who a library made on it lets in. */
export const floorPrincipalOf = (caller: OnFloor) =>
  caller.workspace.kind === 'personal' ? `person:${caller.id}` : caller.workspace.kind === 'org' ? 'org' : `tree:${caller.workspace.id}`;
