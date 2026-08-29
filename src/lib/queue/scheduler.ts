import { db } from '@lib/db';
import { posts } from '@lib/db/schema';
import { eq, and, gte, lte, inArray } from 'drizzle-orm';
import { getScheduledPerDayLimit } from '@lib/quotas/check';

/**
 * Queue scheduler — finds the next available posting slot.
 *
 * Rules:
 *   - Posting window: 9 AM – 8 PM (user's timezone)
 *   - Max 5 posts per day
 *   - Min 2-hour gap between posts
 *   - ±20 min random jitter
 *   - 7-day lookahead
 */

const WINDOW_START_HOUR = 9;  // 9 AM
const WINDOW_END_HOUR = 20;   // 8 PM
const DEFAULT_MAX_POSTS_PER_DAY = 5;
const MIN_GAP_MS = 2 * 60 * 60 * 1000; // 2 hours
const JITTER_MS = 20 * 60 * 1000;       // ±20 minutes
const LOOKAHEAD_DAYS = 7;
const MAX_LOOKAHEAD_DAYS = 60; // bulk "Add to queue" can spread further to fit large batches

function addJitter(): number {
  return Math.round((Math.random() * 2 - 1) * JITTER_MS);
}

/**
 * Convert a local hour to a UTC Date for a given day in a timezone.
 * Uses formatToParts for reliable cross-timezone conversion.
 */
function localHourToUtc(dateStr: string, hour: number, minute: number, tz: string): Date {
  const pad = (n: number) => String(n).padStart(2, '0');
  // Treat the local time as UTC to get a reference point
  const refUtc = new Date(`${dateStr}T${pad(hour)}:${pad(minute)}:00Z`);
  // See what this UTC instant looks like in the target timezone
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    // hourCycle only — adding hour12: false overrides it, and on Node 20's ICU that
    // resolves to h24, formatting midnight as "24" and shifting the day by -1.
    hourCycle: 'h23',
  }).formatToParts(refUtc);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const actualInTz = new Date(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:00Z`);
  const tzOffset = actualInTz.getTime() - refUtc.getTime();
  return new Date(refUtc.getTime() - tzOffset);
}

/**
 * Get YYYY-MM-DD in a specific timezone.
 */
function getDateStrInTz(date: Date, tz: string): string {
  return date.toLocaleDateString('en-CA', { timeZone: tz });
}

export interface QueueSlotResult {
  scheduledAt: string; // ISO string
  dayLabel: string;    // "Today", "Tomorrow", "Wed, Feb 14", etc.
}

/** Load existing scheduled/published posts, grouped by day (in tz) as sorted UTC timestamps. */
async function loadScheduledByDay(
  organizationId: number,
  now: Date,
  lookaheadDays: number,
  tz: string,
): Promise<Map<string, number[]>> {
  const endDate = new Date(now.getTime() + lookaheadDays * 24 * 60 * 60 * 1000);
  const existingPosts = await db
    .select({ scheduledAt: posts.scheduledAt })
    .from(posts)
    .where(
      and(
        eq(posts.organizationId, organizationId),
        gte(posts.scheduledAt, now),
        lte(posts.scheduledAt, endDate),
        // 'partial' counts as an occupied slot too — the post went out at that
        // time, it just didn't reach every channel. Omitting it let the queue
        // hand the same slot to another post.
        inArray(posts.status, ['scheduled', 'publishing', 'published', 'processing', 'partial']),
      ),
    );

  const scheduledByDay = new Map<string, number[]>(); // dateStr -> sorted UTC timestamps
  for (const p of existingPosts) {
    if (!p.scheduledAt) continue;
    const dayStr = getDateStrInTz(p.scheduledAt, tz);
    if (!scheduledByDay.has(dayStr)) scheduledByDay.set(dayStr, []);
    scheduledByDay.get(dayStr)!.push(p.scheduledAt.getTime());
  }
  for (const times of scheduledByDay.values()) times.sort((a, b) => a - b);
  return scheduledByDay;
}

/**
 * Find the first free slot within `lookaheadDays`, honoring the per-day cap, posting
 * window, 2-hour gap and ±20-min jitter. Returns null if nothing fits. Pure over
 * `scheduledByDay` so callers can book a returned slot and call again for the next.
 */
function pickSlot(
  scheduledByDay: Map<string, number[]>,
  maxPostsPerDay: number,
  now: Date,
  tz: string,
  todayStr: string,
  lookaheadDays: number,
): { ts: number; dayStr: string; dayLabel: string } | null {
  for (let d = 0; d < lookaheadDays; d++) {
    const day = new Date(now.getTime() + d * 24 * 60 * 60 * 1000);
    const dayStr = getDateStrInTz(day, tz);

    const dayTimes = scheduledByDay.get(dayStr) || [];
    if (dayTimes.length >= maxPostsPerDay) continue;

    const windowStart = localHourToUtc(dayStr, WINDOW_START_HOUR, 0, tz);
    const windowEnd = localHourToUtc(dayStr, WINDOW_END_HOUR, 0, tz);

    // Earliest possible slot: max of (window start, now + small buffer on day 0)
    let earliest = windowStart.getTime();
    if (d === 0) earliest = Math.max(earliest, now.getTime() + 5 * 60 * 1000);
    if (earliest >= windowEnd.getTime()) continue;

    // Walk forward until the candidate clears the 2-hour gap from every booked post.
    let candidate = earliest;
    let foundSlot = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (candidate >= windowEnd.getTime()) break;
      let tooClose = false;
      for (const existingTs of dayTimes) {
        if (Math.abs(candidate - existingTs) < MIN_GAP_MS) {
          candidate = existingTs + MIN_GAP_MS;
          tooClose = true;
          break;
        }
      }
      if (!tooClose && candidate < windowEnd.getTime()) {
        foundSlot = true;
        break;
      }
    }
    if (!foundSlot) continue;

    // Apply jitter, clamped to the window; revert if it reopens a gap conflict.
    // Floor at windowStart always (negative jitter must not push below 9 AM), plus
    // now+1min on day 0 so the first slot stays in the future.
    let jittered = candidate + addJitter();
    const floor = d === 0 ? Math.max(windowStart.getTime(), now.getTime() + 60_000) : windowStart.getTime();
    jittered = Math.max(jittered, floor);
    jittered = Math.min(jittered, windowEnd.getTime() - 5 * 60_000); // 5 min before window close
    for (const existingTs of dayTimes) {
      if (Math.abs(jittered - existingTs) < MIN_GAP_MS) {
        jittered = candidate;
        break;
      }
    }

    return { ts: jittered, dayStr, dayLabel: formatDayLabel(dayStr, todayStr, tz) };
  }
  return null;
}

export async function findNextQueueSlot(
  organizationId: number,
  tz: string,
): Promise<QueueSlotResult> {
  const maxPostsPerDay = (await getScheduledPerDayLimit(organizationId)) || DEFAULT_MAX_POSTS_PER_DAY;
  const now = new Date();
  const todayStr = getDateStrInTz(now, tz);
  const scheduledByDay = await loadScheduledByDay(organizationId, now, LOOKAHEAD_DAYS, tz);

  const slot = pickSlot(scheduledByDay, maxPostsPerDay, now, tz, todayStr, LOOKAHEAD_DAYS);
  if (!slot) throw new Error('No available queue slots in the next 7 days. All days are full.');
  return { scheduledAt: new Date(slot.ts).toISOString(), dayLabel: slot.dayLabel };
}

/**
 * Assign `count` distinct queue slots in one pass (Bulk Compose → "Add to queue").
 * Reads existing posts once, then books each returned slot in-memory so the next
 * pick honors the 2-hour gap and per-day cap. Extends the lookahead to fit the batch.
 */
export async function findNextQueueSlots(
  organizationId: number,
  tz: string,
  count: number,
): Promise<QueueSlotResult[]> {
  if (count <= 0) return [];
  const maxPostsPerDay = (await getScheduledPerDayLimit(organizationId)) || DEFAULT_MAX_POSTS_PER_DAY;
  const now = new Date();
  const todayStr = getDateStrInTz(now, tz);
  const lookaheadDays = Math.min(
    MAX_LOOKAHEAD_DAYS,
    Math.max(LOOKAHEAD_DAYS, Math.ceil(count / maxPostsPerDay) + 2),
  );
  const scheduledByDay = await loadScheduledByDay(organizationId, now, lookaheadDays, tz);

  const results: QueueSlotResult[] = [];
  for (let i = 0; i < count; i++) {
    const slot = pickSlot(scheduledByDay, maxPostsPerDay, now, tz, todayStr, lookaheadDays);
    if (!slot) {
      throw new Error(
        `Only ${results.length} open queue slot(s) in the next ${lookaheadDays} days — not enough for ${count} posts. Schedule some manually or free up days.`,
      );
    }
    results.push({ scheduledAt: new Date(slot.ts).toISOString(), dayLabel: slot.dayLabel });
    // Book it so the next pick treats this time as occupied.
    const arr = scheduledByDay.get(slot.dayStr) || [];
    arr.push(slot.ts);
    arr.sort((a, b) => a - b);
    scheduledByDay.set(slot.dayStr, arr);
  }
  return results;
}

function formatDayLabel(dayStr: string, todayStr: string, tz: string): string {
  const todayParts = todayStr.split('-').map(Number);
  const dayParts = dayStr.split('-').map(Number);

  const todayDate = new Date(todayParts[0], todayParts[1] - 1, todayParts[2]);
  const targetDate = new Date(dayParts[0], dayParts[1] - 1, dayParts[2]);
  const diffDays = Math.round((targetDate.getTime() - todayDate.getTime()) / (24 * 60 * 60 * 1000));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';

  return targetDate.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}
