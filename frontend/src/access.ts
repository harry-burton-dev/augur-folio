import manifest from '../../manifest.json' with { type: 'json' };
import { stateName, type Access, type ContentState, type Grant, type Level, type Principal } from './api.js';

/** Who can see something in Artifacts, in its words, and what it tells the app that explains access. */

export const LEVEL_WORDS: Record<Level, string> = { read: 'Can read', edit: 'Can edit', manage: 'Can manage' };

/** Asks another app to explain who can open something (`access.explain`), set by the entry. */
export type Explainer = (payload: ExplainPayload) => Promise<unknown>;

/** What's being shared: a whole library, a folder and everything inside it, or one document. */
export type Shareable = 'library' | 'folder' | 'document';

export interface ExplainPayload {
  thing: { app: 'folio'; appName: string; id: string; title: string; kind: Shareable };
  audience: { principal: string; name?: string; level?: Level; since?: string; via: string; chain?: string[]; shows?: string[] }[];
  change: { where: string; allowed: boolean };
}

/**
 * What Artifacts sends with `access.explain`: everyone who can see it, and how
 * each one reaches it: its floor, its library, a folder it's inside, or shared
 * with it alone.
 */
export const explainPayload = (access: Access, thing: { id: string; title: string; kind: Shareable }): ExplainPayload => {
  const shared = (g: Grant, via: string) => ({ principal: g.principal, ...(g.name ? { name: g.name } : {}), level: g.level, since: g.createdAt, via });
  const floor = access.floor;
  return {
    thing: { app: 'folio', appName: manifest.name, id: thing.id, title: thing.title, kind: thing.kind },
    audience: [
      { principal: floor.principal, ...(floor.name ? { name: floor.name } : {}), level: floor.kind === 'person' ? 'manage' : 'read', via: 'its floor' },
      ...(access.library ?? []).map((g) => shared(g, 'its collection')),
      ...(access.folders ?? []).map((g) => shared(g, 'a folder it’s in')),
      ...(access.placed ?? []).map((p) => ({
        principal: p.principal,
        ...(p.name ? { name: p.name } : {}),
        level: 'read' as const,
        since: p.at,
        via: p.record.id === thing.id ? 'published up to them' : 'published up inside something',
        chain: p.chain.map(inSentence),
        shows: p.filter.map(stateName),
      })),
      ...access.grants.map((g) => shared(g, `shared with this ${thing.kind}`)),
    ],
    change: { where: 'Share', allowed: access.can.share },
  };
};

/** A list in words: "Complete", "Complete and Issued", "In review, Complete and Issued". */
const listWords = (list: readonly string[]) => (list.length < 2 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);

/** A floor's name in the middle of a sentence: "your own floor" and "the org" aren't names. */
const inSentence = (floor: string) => (floor === 'Your own floor' || floor === 'The org' ? floor[0].toLowerCase() + floor.slice(1) : floor);

/** How a step up the floors reaches them: "Up from Payroll through Finance · Shows Complete and Issued". */
export const upLine = (p: { chain: readonly string[]; filter: readonly ContentState[] }) => {
  const [from, ...through] = p.chain.map(inSentence);
  return [from ? `Up from ${from}${through.length ? ` through ${listWords(through)}` : ''}` : '', `Shows ${listWords(p.filter.map(stateName))}`].filter(Boolean).join(' · ');
};

/** Who its floor lets in, as a sentence. */
export const floorWords = (floor: Principal, what: Shareable, me = '') => {
  const it = what === 'library' ? 'this collection' : `this ${what}’s collection`;
  if (floor.principal === `person:${me}`) return 'It’s on your own floor: only you can see it, and whoever you share it with.';
  if (floor.kind === 'person') return `It’s on ${floor.name ? `${floor.name}’s` : 'someone’s'} own floor: only they can see it, and whoever they share it with.`;
  if (floor.kind === 'org') return `It’s on the org’s floor, so everyone in the org can read it. The org’s leads manage ${it}.`;
  return `Everyone on ${floor.name ?? 'its team'}, and the teams below it, can read it and add to ${it} there. ${floor.name ?? 'The team'}’s leads manage it.`;
};
