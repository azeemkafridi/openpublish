import { describe, it, expect } from 'vitest';
import { projectOccurrences } from '@/lib/schedules/occurrences';

export {};

/** Format a UTC instant as HH:MM in a timezone — for DST assertions. */
function localTime(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}

const base = {
  frequency: 'daily',
  dayOfMonth: null,
  timeOfDay: '13:00',
  timezone: 'UTC',
  nextRunAt: '2026-09-01T13:00:00.000Z',
  isActive: true,
};

describe('projectOccurrences', () => {
  it('projects a daily schedule across the window, starting at nextRunAt', () => {
    const out = projectOccurrences(
      base,
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-09-07T23:59:59Z'),
    );
    expect(out).toHaveLength(7);
    expect(out[0].toISOString()).toBe('2026-09-01T13:00:00.000Z');
    expect(out[6].toISOString()).toBe('2026-09-07T13:00:00.000Z');
  });

  it('starts strictly at nextRunAt — never back-fills fired occurrences', () => {
    // Window opens Aug 25 but the anchor is Sep 1: nothing before it.
    const out = projectOccurrences(
      base,
      new Date('2026-08-25T00:00:00Z'),
      new Date('2026-09-02T23:59:59Z'),
    );
    expect(out.map((d) => d.toISOString())).toEqual([
      '2026-09-01T13:00:00.000Z',
      '2026-09-02T13:00:00.000Z',
    ]);
  });

  it('steps weekly on the anchor weekday and biweekly by 14 days', () => {
    // 2026-09-05 is a Saturday.
    const weekly = projectOccurrences(
      { ...base, frequency: 'weekly', nextRunAt: '2026-09-05T13:00:00.000Z' },
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-09-30T23:59:59Z'),
    );
    expect(weekly.map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26',
    ]);

    const biweekly = projectOccurrences(
      { ...base, frequency: 'biweekly', nextRunAt: '2026-09-05T13:00:00.000Z' },
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-09-30T23:59:59Z'),
    );
    expect(biweekly.map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2026-09-05', '2026-09-19',
    ]);
  });

  it('clamps monthly day-of-month to short months without losing the target day', () => {
    const out = projectOccurrences(
      { ...base, frequency: 'monthly', dayOfMonth: 31, nextRunAt: '2027-01-31T13:00:00.000Z' },
      new Date('2027-01-01T00:00:00Z'),
      new Date('2027-04-30T23:59:59Z'),
    );
    expect(out.map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30',
    ]);
  });

  it('keeps the local time constant across a DST transition', () => {
    // US DST ends Sun 2026-11-01: 09:00 New York is 13:00Z before, 14:00Z after.
    const out = projectOccurrences(
      {
        frequency: 'daily', dayOfMonth: null, timeOfDay: '09:00',
        timezone: 'America/New_York',
        nextRunAt: '2026-10-30T13:00:00.000Z', isActive: true,
      },
      new Date('2026-10-30T00:00:00Z'),
      new Date('2026-11-03T23:59:59Z'),
    );
    expect(out).toHaveLength(5);
    for (const d of out) expect(localTime(d, 'America/New_York')).toBe('09:00');
    expect(out[0].toISOString()).toBe('2026-10-30T13:00:00.000Z');
    expect(out[4].toISOString()).toBe('2026-11-03T14:00:00.000Z');
  });

  it('returns nothing for paused schedules, missing anchors, or out-of-window anchors', () => {
    const win: [Date, Date] = [new Date('2026-09-01T00:00:00Z'), new Date('2026-09-30T23:59:59Z')];
    expect(projectOccurrences({ ...base, isActive: false }, ...win)).toEqual([]);
    expect(projectOccurrences({ ...base, nextRunAt: null }, ...win)).toEqual([]);
    expect(projectOccurrences({ ...base, nextRunAt: '2026-10-05T13:00:00.000Z' }, ...win)).toEqual([]);
  });
});
