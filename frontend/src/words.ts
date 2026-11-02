import type { Cadence, FolioDocument, LevelInfo, Principal, SeriesView, Tag, UnitLevel } from './api.js';

/**
 * Artifacts' words for its things, shared by every part of it and free of any
 * kit: who something goes to, how often a series comes out, what a name may be.
 */

/** Who a principal is, in a few words: "Kim Lee", "Payroll and the teams below it", "Everyone in the org". */
export const whoWords = (p: Principal) => {
  if (p.kind === 'org') return 'Everyone in the org';
  if (!p.name) return p.kind === 'person' ? 'Someone no longer here' : 'A team that’s gone';
  return p.kind === 'tree' ? `${p.name} and the teams below it` : p.kind === 'team' ? `${p.name} (just that team)` : p.name;
};

/** Who a version or a series' issues go to, in a sentence's words: "Finance and Payroll". */
export const audienceWords = (audience: readonly Principal[]) => {
  const words = audience.map(whoWords);
  return words.length <= 1 ? (words[0] ?? 'No one') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
};

/** How often a series comes out, in a few words. */
export const CADENCE_WORDS: Record<Cadence, string> = { weekly: 'Every week', monthly: 'Every month', quarterly: 'Every quarter', adhoc: 'Now and then' };

/** How often a series comes out, as its dialog offers it. */
export const CADENCE_OPTIONS: { value: Cadence; label: string; detail?: string }[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'adhoc', label: 'Now and then', detail: 'No due dates' },
];

const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

/** "Monday 2 November", from a day (`YYYY-MM-DD`). */
export const dayWords = (day: string) => DAY.format(new Date(`${day}T00:00:00Z`)).replace(',', '');

/** When the next issue is wanted, in a sentence: none for a series that comes out now and then, or before its first. */
export const nextWords = ({ next, cadence, issues }: Pick<SeriesView, 'next' | 'cadence' | 'issues'>) => {
  if (!issues) return `Its first issue will be ${cadence === 'adhoc' ? 'issue 1' : `for ${next.period}`}.`;
  if (!next.dueBy) return `The next is issue ${next.number}.`;
  return next.overdue ? `The issue for ${next.period} is late: it was due by ${dayWords(next.dueBy)}.` : `Next: ${next.period}, due by ${dayWords(next.dueBy)}.`;
};

/** An issue's row: where it comes in the run, and where it is in being published. */
export const issueDetail = (d: FolioDocument) =>
  [d.issue ? `Issue ${d.issue.number}` : '', d.issue && !d.issue.period.startsWith('Issue') ? d.issue.period : '', d.state === 'published' ? 'Published' : d.state === 'withdrawn' ? 'Withdrawn' : 'Draft']
    .filter(Boolean)
    .join(' · ');

/** Whether a name will do: there, not too long, no slash where it can't have one, and not one already taken beside it. */
export const nameCheck =
  (taken: readonly string[], what: string, slashes = true, most = 80) =>
  (value: string): { state: 'error'; message: string } | null => {
    const name = value.trim();
    if (!name) return { state: 'error', message: `Give the ${what} a name.` };
    if (name.length > most) return { state: 'error', message: `Keep it to ${most} characters.` };
    if (!slashes && /[/\\]/.test(name)) return { state: 'error', message: 'A folder’s name can’t have a slash in it.' };
    if (taken.some((t) => t.toLocaleLowerCase() === name.toLocaleLowerCase())) return { state: 'error', message: `There’s already a ${what} called ${name} here.` };
    return null;
  };

/** Tags as a picker offers them: the org's marked as such. */
export const tagOptions = (tags: readonly Tag[]): { value: string; label: string; detail?: string; icon?: 'org' }[] =>
  tags.map((t) => ({ value: t.id, label: t.name, ...(t.library ? {} : { detail: 'Org', icon: 'org' as const }) }));

/** The levels as Artifacts calls them before the org renames any. */
export const DEFAULT_LEVELS: LevelInfo[] = [
  { id: 'collection', name: 'Collection', plural: 'Collections', holds: ['subcollection', 'series', 'file'] },
  { id: 'subcollection', name: 'Subcollection', plural: 'Subcollections', holds: ['series', 'file'] },
  { id: 'series', name: 'Series', plural: 'Series', holds: ['subseries', 'file'] },
  { id: 'subseries', name: 'Subseries', plural: 'Subseries', holds: ['file'] },
  { id: 'file', name: 'File', plural: 'Files', holds: [] },
];

/** A level's own name, before the org renamed it. */
export const ownLevel = (id: UnitLevel) => DEFAULT_LEVELS.find((l) => l.id === id)!;
