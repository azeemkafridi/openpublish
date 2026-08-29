/**
 * Viewer-local calendar-day helpers for analytics date windows.
 *
 * The old pattern — `new Date().toISOString().split('T')[0]` — produced the
 * UTC day, so "today" was wrong for anyone east of UTC in the evening or west
 * of it in the morning. These format the LOCAL day, and `browserTz()` supplies
 * the IANA zone the server needs to bucket by the same calendar.
 */

/** YYYY-MM-DD of the given instant in the viewer's local timezone. */
export function localDateStr(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** YYYY-MM-DD of n days ago, local. */
export function localDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDateStr(d);
}

/** The viewer's IANA timezone, e.g. "Asia/Karachi". Falls back to UTC. */
export function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Start of the viewer-local day containing `d`, as an ISO instant. */
export function localDayStartISO(d: Date = new Date()): string {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  return s.toISOString();
}

/** End of the viewer-local day containing `d`, as an ISO instant. */
export function localDayEndISO(d: Date = new Date()): string {
  const e = new Date(d);
  e.setHours(23, 59, 59, 999);
  return e.toISOString();
}
