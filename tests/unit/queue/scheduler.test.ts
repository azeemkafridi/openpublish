/**
 * Unit tests for the queue slot scheduler.
 *
 *   findNextQueueSlot  — single next open slot
 *   findNextQueueSlots — N distinct slots in one pass (Bulk Compose → Add to queue)
 *
 * The DB is mocked to report no existing scheduled posts, so the assertions cover
 * structural guarantees (count, distinctness, ordering, posting window, 2-hour gap)
 * rather than exact wall-clock times, which depend on "now".
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ existing: [] as { scheduledAt: Date }[], perDay: 5 }));

vi.mock('@lib/db', () => ({
  db: {
    select: () => {
      const c: any = {};
      c.from = () => c;
      c.where = () => c;
      c.then = (resolve: any) => resolve(h.existing);
      return c;
    },
  },
}));
vi.mock('@lib/db/schema', () => ({ posts: { scheduledAt: 'p.s', organizationId: 'p.o', status: 'p.st' } }));
vi.mock('drizzle-orm', () => ({
  eq: (...a: any[]) => ({ a }),
  and: (...a: any[]) => ({ a }),
  gte: (...a: any[]) => ({ a }),
  lte: (...a: any[]) => ({ a }),
  inArray: (...a: any[]) => ({ a }),
}));
vi.mock('@lib/quotas/check', () => ({ getScheduledPerDayLimit: () => Promise.resolve(h.perDay) }));

import { findNextQueueSlot, findNextQueueSlots } from '@lib/queue/scheduler';

const TWO_HOURS = 2 * 60 * 60 * 1000;

describe('findNextQueueSlots', () => {
  beforeEach(() => {
    h.existing = [];
    h.perDay = 5;
  });

  it('returns an empty array for a count of 0', async () => {
    expect(await findNextQueueSlots(1, 'UTC', 0)).toEqual([]);
  });

  it('returns the requested number of distinct, future, ascending slots', async () => {
    const now = Date.now();
    const slots = await findNextQueueSlots(1, 'UTC', 4);
    expect(slots).toHaveLength(4);

    const times = slots.map((s) => new Date(s.scheduledAt).getTime());
    // All in the future.
    expect(times.every((t) => t > now)).toBe(true);
    // Distinct.
    expect(new Set(times).size).toBe(4);
    // Strictly ascending.
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
  });

  it('keeps every slot inside the 9 AM–8 PM posting window (UTC)', async () => {
    const slots = await findNextQueueSlots(1, 'UTC', 5);
    for (const s of slots) {
      const hour = new Date(s.scheduledAt).getUTCHours();
      expect(hour).toBeGreaterThanOrEqual(9);
      expect(hour).toBeLessThan(20);
    }
  });

  it('floors the first slot at the window start even when "now" is before 9 AM (regression)', async () => {
    // Regression: the −20 min jitter used to push the first day-0 slot below the 9 AM
    // window start (e.g. 08:40) because the floor was now+60s rather than windowStart.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-01T07:00:00Z')); // 07:00 UTC — before the window opens
    try {
      const slots = await findNextQueueSlots(1, 'UTC', 3);
      expect(slots.length).toBeGreaterThan(0);
      for (const s of slots) {
        expect(new Date(s.scheduledAt).getUTCHours()).toBeGreaterThanOrEqual(9);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('spaces consecutive slots at least ~2 hours apart', async () => {
    const times = (await findNextQueueSlots(1, 'UTC', 4)).map((s) => new Date(s.scheduledAt).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(TWO_HOURS - 60_000);
    }
  });

  it('throws when the lookahead cannot fit the whole batch', async () => {
    h.perDay = 1; // 1/day over the capped lookahead is far fewer than 100
    await expect(findNextQueueSlots(1, 'UTC', 100)).rejects.toThrow(/not enough/i);
  });
});

describe('findNextQueueSlot', () => {
  beforeEach(() => {
    h.existing = [];
    h.perDay = 5;
  });

  it('returns a single slot with an ISO time and a day label', async () => {
    const slot = await findNextQueueSlot(1, 'UTC');
    expect(typeof slot.scheduledAt).toBe('string');
    expect(Number.isNaN(new Date(slot.scheduledAt).getTime())).toBe(false);
    expect(typeof slot.dayLabel).toBe('string');
  });
});

export {};
