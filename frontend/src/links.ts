import type { IconName, ListItem } from '@augur/app-kit';
import type { RecordLink, RelationKind } from './api.js';
import { agoWords } from './words.js';

/** A record in another app, as a link keeps it. */
export interface LinkRef {
  app: string;
  kind: string;
  id: string;
  label?: string;
}
/** Asks the person to pick a thing in Data Atlas, or an intent in Mandate, in that app: nothing when they close it. */
export type PickRef = (app: 'atlas' | 'mandate') => Promise<LinkRef | undefined>;
/** Opens a thing in Data Atlas, or an intent in Mandate, in that app. */
export type OpenRef = (ref: LinkRef) => Promise<void>;

/** The app a link's other end is in, by name. */
const APP_NAMES: Record<string, string> = { atlas: 'Data Atlas', mandate: 'Mandate' };

/** Where a relation's other end lives: Artifacts' own records, a thing in Data Atlas, or an intent in Mandate. */
export const relationTarget = (relation: RelationKind['id']) => (relation === 'about' ? 'atlas' : relation === 'serves' ? 'mandate' : 'folio');

/** A link as a row: what it says, what it's to, and whether it can be opened. */
export const linkRow = (l: RecordLink, change: boolean): ListItem => {
  const end = l.to ?? l.from;
  const unavailable = end && 'unavailable' in end ? end.unavailable : undefined;
  const name = l.to ? (l.to.label ?? l.to.id) : l.from && 'name' in l.from ? l.from.name : 'Something';
  const where = l.to && l.to.app !== 'folio' ? `In ${APP_NAMES[l.to.app] ?? l.to.app}` : '';
  return {
    id: l.id,
    title: unavailable ? `${l.words}: ${unavailable}` : `${l.words} ${name}`,
    detail: [where, `Linked ${agoWords(l.at)}`].filter(Boolean).join(' · '),
    icon: (l.to?.app === 'atlas' ? 'atlas' : l.to?.app === 'mandate' ? 'compass' : 'link') as IconName,
    ...(change && l.to ? { actions: [{ id: 'unlink', label: 'Unlink' }] } : {}),
  };
};
