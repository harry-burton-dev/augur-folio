/** How often a series comes out. An ad hoc one has issues but no periods, so none is ever late. */
export type Cadence = 'weekly' | 'monthly' | 'quarterly' | 'adhoc';
export const CADENCES: readonly Cadence[] = ['weekly', 'monthly', 'quarterly', 'adhoc'];

/** How long after its period ends an issue may still come before it's overdue, in days. */
const GRACE: Record<Exclude<Cadence, 'adhoc'>, number> = { weekly: 1, monthly: 3, quarterly: 7 };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY = 24 * 60 * 60 * 1000;

/** A day as `YYYY-MM-DD`, in UTC: periods are the org's, not anyone's own time zone. */
const dayOf = (at: Date) => at.toISOString().slice(0, 10);
const dateOf = (day: string) => new Date(`${day}T00:00:00Z`);
const addMonths = (day: string, months: number) => {
  const at = dateOf(day);
  return dayOf(new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + months, 1)));
};

/** The first day of the period `at` falls in: its week's Monday, its month's or its quarter's first day. */
export const periodStart = (cadence: Cadence, at: Date): string => {
  const day = dayOf(at);
  if (cadence === 'weekly') return dayOf(new Date(dateOf(day).getTime() - ((dateOf(day).getUTCDay() + 6) % 7) * DAY));
  if (cadence === 'monthly') return `${day.slice(0, 7)}-01`;
  if (cadence === 'quarterly') return addMonths(`${day.slice(0, 4)}-01-01`, Math.floor(at.getUTCMonth() / 3) * 3);
  return day;
};

/** The first day of the period after the one starting `start`; none for an ad hoc series. */
export const following = (cadence: Cadence, start: string): string | undefined => {
  if (cadence === 'weekly') return dayOf(new Date(dateOf(start).getTime() + 7 * DAY));
  if (cadence === 'monthly') return addMonths(start, 1);
  if (cadence === 'quarterly') return addMonths(start, 3);
  return undefined;
};

/** The period before the one starting `start`. */
const preceding = (cadence: Exclude<Cadence, 'adhoc'>, start: string) =>
  cadence === 'weekly' ? dayOf(new Date(dateOf(start).getTime() - 7 * DAY)) : addMonths(start, cadence === 'monthly' ? -1 : -3);

/** The ISO week a Monday is in, and the year that week belongs to. */
const isoWeek = (monday: string) => {
  const thursday = new Date(dateOf(monday).getTime() + 3 * DAY);
  const year = thursday.getUTCFullYear();
  return { year, week: 1 + Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY)) };
};

/** What people call a period: "Week 43, 2026", "October 2026", "Q4 2026", or for an ad hoc series "Issue 7". */
export const periodLabel = (cadence: Cadence, start: string, number: number) => {
  const at = dateOf(start);
  if (cadence === 'weekly') {
    const { year, week } = isoWeek(start);
    return `Week ${week}, ${year}`;
  }
  if (cadence === 'monthly') return `${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
  if (cadence === 'quarterly') return `Q${Math.floor(at.getUTCMonth() / 3) + 1} ${at.getUTCFullYear()}`;
  return `Issue ${number}`;
};

/** One issue's place in its series. */
export interface IssuePlace {
  number: number;
  /** The first day of its period (`YYYY-MM-DD`); for an ad hoc series, the day it was added. */
  periodStart: string;
  /** "Week 43, 2026". */
  period: string;
}

/** The issue a series expects next, and, once it has had one, when that one is overdue. */
export interface NextIssue extends IssuePlace {
  /** When it becomes overdue (ISO). None for an ad hoc series, or before its first issue. */
  dueAt?: string;
  /** The last day it's on time (`YYYY-MM-DD`), with `dueAt`. */
  dueBy?: string;
  overdue: boolean;
}

/**
 * The issue after `last`: the period after it, though never more than one
 * period behind now, so a series picked up again after a break goes on from
 * last period rather than filling in every week it missed. Its first issue is
 * for the period it's in now.
 */
export const nextIssue = (cadence: Cadence, last: Pick<IssuePlace, 'number' | 'periodStart'> | undefined, now = new Date()): NextIssue => {
  const number = (last?.number ?? 0) + 1;
  if (cadence === 'adhoc') {
    const start = dayOf(now);
    return { number, periodStart: start, period: periodLabel(cadence, start, number), overdue: false };
  }
  const current = periodStart(cadence, now);
  const after = last && following(cadence, last.periodStart)!;
  const floor = preceding(cadence, current);
  const start = !after ? current : after > floor ? after : floor;
  const due = last && new Date(dateOf(following(cadence, start)!).getTime() + GRACE[cadence] * DAY);
  const dueAt = due?.toISOString();
  return {
    number,
    periodStart: start,
    period: periodLabel(cadence, start, number),
    ...(due ? { dueAt, dueBy: dayOf(new Date(due.getTime() - DAY)) } : {}),
    overdue: Boolean(dueAt && now.toISOString() >= dueAt),
  };
};
