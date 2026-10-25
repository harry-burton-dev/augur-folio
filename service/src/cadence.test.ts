import { describe, expect, it } from 'vitest';
import { following, nextIssue, periodLabel, periodStart } from './cadence.ts';

const at = (iso: string) => new Date(iso);

describe('cadence', () => {
  it('finds the period a day falls in, and the one after', () => {
    expect(periodStart('weekly', at('2026-10-25T12:00:00Z'))).toBe('2026-10-19');
    expect(periodStart('weekly', at('2026-10-26T00:00:00Z'))).toBe('2026-10-26');
    expect(periodStart('monthly', at('2026-10-25T12:00:00Z'))).toBe('2026-10-01');
    expect(periodStart('quarterly', at('2026-11-30T12:00:00Z'))).toBe('2026-10-01');
    expect(periodStart('adhoc', at('2026-10-25T12:00:00Z'))).toBe('2026-10-25');
    expect(following('weekly', '2026-12-28')).toBe('2027-01-04');
    expect(following('monthly', '2026-12-01')).toBe('2027-01-01');
    expect(following('quarterly', '2026-10-01')).toBe('2027-01-01');
    expect(following('adhoc', '2026-10-01')).toBeUndefined();
  });

  it('names periods as people do', () => {
    expect(periodLabel('weekly', '2026-10-19', 1)).toBe('Week 43, 2026');
    // ISO weeks: the first days of a January can be in the last week of the year before.
    expect(periodLabel('weekly', '2026-12-28', 1)).toBe('Week 53, 2026');
    expect(periodLabel('weekly', '2027-01-04', 1)).toBe('Week 1, 2027');
    expect(periodLabel('monthly', '2026-10-01', 1)).toBe('October 2026');
    expect(periodLabel('quarterly', '2026-10-01', 1)).toBe('Q4 2026');
    expect(periodLabel('adhoc', '2026-10-25', 7)).toBe('Issue 7');
  });

  it('expects the period after the last issue, never more than one period behind', () => {
    const now = at('2026-10-25T12:00:00Z');
    expect(nextIssue('weekly', undefined, now)).toEqual({ number: 1, periodStart: '2026-10-19', period: 'Week 43, 2026', overdue: false });
    // Last week's is out: this week's is due by Monday, the day after the week ends.
    expect(nextIssue('weekly', { number: 4, periodStart: '2026-10-12' }, now)).toEqual({
      number: 5,
      periodStart: '2026-10-19',
      period: 'Week 43, 2026',
      dueAt: '2026-10-27T00:00:00.000Z',
      dueBy: '2026-10-26',
      overdue: false,
    });
    // Back after a break: last week's, not the first one missed.
    expect(nextIssue('weekly', { number: 4, periodStart: '2026-09-07' }, now)).toMatchObject({ number: 5, periodStart: '2026-10-12', overdue: true });
    expect(nextIssue('monthly', { number: 9, periodStart: '2026-09-01' }, now)).toMatchObject({ periodStart: '2026-10-01', dueBy: '2026-11-03', overdue: false });
    expect(nextIssue('monthly', { number: 9, periodStart: '2026-09-01' }, at('2026-11-04T00:00:00Z'))).toMatchObject({ overdue: true });
    expect(nextIssue('quarterly', { number: 2, periodStart: '2026-07-01' }, now)).toMatchObject({ period: 'Q4 2026', dueBy: '2027-01-07' });
    expect(nextIssue('adhoc', { number: 2, periodStart: '2026-01-01' }, now)).toEqual({ number: 3, periodStart: '2026-10-25', period: 'Issue 3', overdue: false });
  });
});
