/**
 * Shared timezone-aware calculation of the next run time for recurring schedules.
 *
 * Used by:
 *  - POST /api/schedules (new schedule creation)
 *  - POST /api/posts (inline repeat schedule creation)
 *  - PUT /api/schedules/:id (schedule editing)
 *  - recurring.worker.ts (after a schedule fires)
 */

/**
 * Determine the next UTC run time for a recurring schedule.
 *
 * All time comparisons are done in the schedule's timezone so that
 * "daily at 18:15 PKT" always means 18:15 in Pakistan, regardless of
 * what timezone the server is running in.
 *
 * @param frequency  - 'daily' | 'weekly' | 'biweekly' | 'monthly'
 * @param dayOfWeek  - 0 (Sun) to 6 (Sat), used for weekly/biweekly
 * @param dayOfMonth - 1–31, used for monthly (clamped to actual month length)
 * @param timeOfDay  - 'HH:MM' in 24-hour format
 * @param timezone   - IANA timezone string (e.g. 'America/New_York', 'Asia/Karachi')
 */
export function calculateNextRunAt(
  frequency: string,
  dayOfWeek: number | null | undefined,
  dayOfMonth: number | null | undefined,
  timeOfDay: string,
  timezone: string,
): Date {
  const [hours, minutes] = timeOfDay.split(':').map(Number);

  // ── Get current date/time in the target timezone ──────────────────
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const getNum = (type: string) => {
    const val = parts.find((p) => p.type === type)?.value;
    return val ? Number(val) : 0;
  };
  const getStr = (type: string) =>
    parts.find((p) => p.type === type)?.value || '';

  const nowYear = getNum('year');
  const nowMonth = getNum('month') - 1; // 0-indexed for Date API
  const nowDay = getNum('day');
  let nowHour = getNum('hour');
  if (nowHour === 24) nowHour = 0; // Intl can return 24 for midnight
  const nowMinute = getNum('minute');

  // Timezone-aware day of week (not server-local)
  const WEEKDAY_MAP: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const nowWeekday = WEEKDAY_MAP[getStr('weekday')] ?? now.getUTCDay();

  const timePassed =
    nowHour > hours || (nowHour === hours && nowMinute >= minutes);

  // ── Compute target date in timezone-local terms ───────────────────
  let targetYear = nowYear;
  let targetMonth = nowMonth;
  let targetDay = nowDay;

  switch (frequency) {
    case 'daily': {
      if (timePassed) targetDay += 1;
      break;
    }

    case 'weekly':
    case 'biweekly': {
      const target = dayOfWeek ?? 1; // default Monday
      let daysUntil = (target - nowWeekday + 7) % 7;
      if (daysUntil === 0 && timePassed) {
        daysUntil = frequency === 'biweekly' ? 14 : 7;
      }
      targetDay += daysUntil;
      break;
    }

    case 'monthly': {
      const targetDom = dayOfMonth ?? 1;
      const daysThisMonth = lastDayOfMonth(targetYear, targetMonth);
      const clampedDay = Math.min(targetDom, daysThisMonth);

      if (
        nowDay > clampedDay ||
        (nowDay === clampedDay && timePassed)
      ) {
        // This month's date has passed — advance to next month
        targetMonth += 1;
        if (targetMonth > 11) {
          targetMonth = 0;
          targetYear += 1;
        }
        const daysNextMonth = lastDayOfMonth(targetYear, targetMonth);
        targetDay = Math.min(targetDom, daysNextMonth);
      } else {
        targetDay = clampedDay;
      }
      break;
    }

    default: {
      // Fallback: treat as daily
      if (timePassed) targetDay += 1;
    }
  }

  // ── Convert timezone-local date/time → UTC ────────────────────────
  return tzToUTC(targetYear, targetMonth, targetDay, hours, minutes, timezone);
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Convert a date/time expressed in a specific IANA timezone to a UTC Date.
 *
 * Uses Intl.DateTimeFormat to determine the offset, so the result is
 * independent of the server's own timezone setting.
 *
 * Day overflow (e.g. day=33 for a 31-day month) is handled by Date.UTC.
 *
 * Exported for occurrences.ts, which projects a schedule's future run times
 * onto the calendar with the same timezone/DST rules this file uses.
 */
export function tzToUTC(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  // Treat the components as if they were UTC to get a reference timestamp
  const asUTC = Date.UTC(year, month, day, hour, minute, 0, 0);

  // See what that UTC timestamp looks like in the target timezone
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = fmt.formatToParts(new Date(asUTC));
  const getNum = (type: string) => {
    const val = parts.find((p) => p.type === type)?.value;
    return val ? Number(val) : 0;
  };

  let tzHour = getNum('hour');
  if (tzHour === 24) tzHour = 0;

  // Build the timezone representation as a UTC-millis value for comparison
  const inTZ = Date.UTC(
    getNum('year'),
    getNum('month') - 1,
    getNum('day'),
    tzHour,
    getNum('minute'),
    0,
    0,
  );

  // offset = how far ahead the timezone is from UTC
  const offsetMs = inTZ - asUTC;

  // Subtract offset so the result, when displayed in the timezone, shows
  // the desired hour:minute
  const result = new Date(asUTC - offsetMs);

  // ── DST edge-case verification ──────────────────────────────────
  // If we landed on a DST boundary the offset may be wrong by up to 1h.
  // One extra check + adjustment handles it.
  const verify = fmt.formatToParts(result);
  const vHour = (() => {
    const val = verify.find((p) => p.type === 'hour')?.value;
    const n = val ? Number(val) : 0;
    return n === 24 ? 0 : n;
  })();
  const vMinute = (() => {
    const val = verify.find((p) => p.type === 'minute')?.value;
    return val ? Number(val) : 0;
  })();

  if (vHour !== hour || vMinute !== minute) {
    const diffMinutes = hour * 60 + minute - (vHour * 60 + vMinute);
    return new Date(result.getTime() + diffMinutes * 60_000);
  }

  return result;
}

/** Number of days in the given 0-indexed month. */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}
