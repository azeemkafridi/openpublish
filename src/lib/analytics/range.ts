/**
 * Analytics window enforcement.
 *
 * The YouTube API Services Developer Policies (III.E.4) prohibit displaying or storing
 * statistics retrieved as Authorized or Non-Authorized Data for more than 30 days; the
 * developer terms of Meta, X, TikTok, LinkedIn and Pinterest carry equivalent retention
 * limits. We therefore cap every analytics query to a rolling 30-day window and enforce
 * it on the server so it cannot be bypassed by hand-crafting a wider `?from=` value.
 */

/** Maximum age, in days, of any statistic we will return or display. */
export const MAX_STATS_WINDOW_DAYS = 30;

/** Earliest allowed `from` date (YYYY-MM-DD): today − MAX_STATS_WINDOW_DAYS. */
export function earliestAllowedFrom(now: Date = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() - MAX_STATS_WINDOW_DAYS);
  return d.toISOString().split('T')[0];
}

/**
 * Clamp a requested `from` date so the window never exceeds 30 days.
 * Returns the later of (requested from, today − 30d) as a YYYY-MM-DD string.
 * A blank/invalid input falls back to the 30-day floor.
 */
export function clampFrom(from: string | null | undefined, now: Date = new Date()): string {
  const floor = earliestAllowedFrom(now);
  if (!from) return floor;
  const fromDay = from.split('T')[0];
  return fromDay < floor ? floor : fromDay;
}
