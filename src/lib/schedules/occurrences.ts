import { tzToUTC } from './next-run';

/**
 * Project a recurring schedule's future run times into a date window.
 *
 * Recurring schedules materialise a post only AT fire time
 * (recurring.worker.ts), so the calendar has nothing to draw for the future
 * series unless it computes the occurrences itself. This walks forward from
 * the server's own `nextRunAt` — the authoritative anchor, already
 * timezone-resolved — stepping in the schedule's timezone-local terms so
 * "daily at 18:00 Karachi" stays 18:00 across DST boundaries, and converting
 * each step with the same tzToUTC the server uses.
 *
 * Because the anchor is `nextRunAt`, every projected time is in the future;
 * a fired occurrence already exists as a real post and never overlaps a
 * projection.
 */

/** The subset of a recurring_schedules row this projection needs. */
export interface ProjectableSchedule {
  frequency: string;
  dayOfMonth?: number | null;
  timeOfDay: string;
  timezone?: string | null;
  nextRunAt?: string | Date | null;
  isActive?: boolean | null;
}

/** Hard cap on projected occurrences per schedule — a 6-week month view needs at most 42 dailies. */
const MAX_OCCURRENCES = 62;

export function projectOccurrences(
  schedule: ProjectableSchedule,
  from: Date,
  to: Date,
): Date[] {
  if (schedule.isActive === false || !schedule.nextRunAt) return [];
  const anchor = new Date(schedule.nextRunAt);
  if (Number.isNaN(anchor.getTime()) || anchor.getTime() > to.getTime()) return [];

  const tz = schedule.timezone || 'UTC';
  const [hours, minutes] = schedule.timeOfDay.split(':').map(Number);

  // The anchor's calendar date IN THE SCHEDULE'S TIMEZONE — stepping the UTC
  // date instead would drift a day for schedules near midnight.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(anchor);
  const getNum = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  let y = getNum('year');
  let m = getNum('month') - 1; // 0-indexed
  let d = getNum('day');

  const out: Date[] = [];
  // First occurrence is the server's own value, not a recomputation.
  let occurrence = anchor;

  for (let i = 0; i < MAX_OCCURRENCES; i++) {
    const t = occurrence.getTime();
    if (t > to.getTime()) break;
    if (t >= from.getTime()) out.push(occurrence);

    // Advance the timezone-local date by one interval.
    switch (schedule.frequency) {
      case 'weekly': d += 7; break;
      case 'biweekly': d += 14; break;
      case 'monthly': {
        const targetDom = schedule.dayOfMonth ?? d;
        m += 1;
        if (m > 11) { m = 0; y += 1; }
        d = Math.min(targetDom, new Date(y, m + 1, 0).getDate());
        break;
      }
      default: d += 1; // daily (and unknown frequencies, matching calculateNextRunAt)
    }
    // Normalise day overflow (d can exceed the month after +7/+14).
    const rolled = new Date(Date.UTC(y, m, d));
    y = rolled.getUTCFullYear();
    m = rolled.getUTCMonth();
    d = rolled.getUTCDate();

    occurrence = tzToUTC(y, m, d, hours, minutes, tz);
  }

  return out;
}
