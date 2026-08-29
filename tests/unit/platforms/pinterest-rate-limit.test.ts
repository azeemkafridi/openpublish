/**
 * Pinterest pin-analytics rate-limit behaviour.
 *
 * /pins/{id}/analytics is in Pinterest's `org_analytics` category: 60 requests
 * per minute per user per app (Standard access), or 1,000 per DAY per app on
 * Trial — where every connected account shares one budget.
 *
 * Since 2026-07-30 the batch endpoint (GET /pins/analytics, 100 ids per call)
 * is granted to our app and is the primary path, so these per-pin tests force
 * the fallback by making the batch call report the beta gate closed. The
 * behaviour still matters: the grant is per app, and any app without it — or a
 * future revocation — lands back on exactly this code path.
 *
 * The loop used to fire one request per pin with no delay, and tried a
 * video-inclusive metric set before falling back to the standard one — so an
 * image-only account with 148 pins burst up to 296 requests and 429'd partway
 * through, then ground on through every remaining pin burning 3 retries each.
 *
 * Pacing is disabled here via PINTEREST_ANALYTICS_MIN_INTERVAL_MS=0 so the
 * assertions are about request COUNT and early exit, not wall-clock timing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

process.env.PINTEREST_ANALYTICS_MIN_INTERVAL_MS = '0';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { PinterestHandler } = await import('@/lib/platforms/pinterest');
import type { ChannelData } from '@/lib/platforms/types';

export {};

const channel: ChannelData = {
  id: 1,
  platform: 'pinterest',
  accountId: 'pin_user',
  accountName: 'pinuser',
  accessToken: 'pin-token',
};

function ok(metrics: Record<string, number>) {
  const body = JSON.stringify({ all: { lifetime_metrics: metrics } });
  return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
}

function err(status: number, message: string) {
  const body = JSON.stringify({ message });
  // Retry-After keeps base.ts's real backoff sleeps at their 1s floor rather
  // than the 2s/4s escalation, so the 429 paths finish inside the timeout.
  const headers = new Headers(status === 429 ? { 'retry-after': '1' } : {});
  return { ok: false, status, headers, text: async () => body, json: async () => JSON.parse(body) };
}

// 429 paths sleep between retries; give them room over the 5s default.
const RETRY_TIMEOUT = 15_000;

/**
 * The beta gate's rejection: 401 code 3. getPostMetrics tries the batch
 * endpoint first, so queueing this as the next response sends it down the
 * per-pin path these tests are about.
 */
function batchRestricted() {
  return err(401, 'Your application does not have access to this restricted feature.');
}

/** True for a per-pin analytics call, i.e. not the batch endpoint. */
function isPerPinCall(url: unknown) {
  return !String(url).includes('/pins/analytics?');
}

describe('Pinterest pin analytics rate limiting', () => {
  let handler: InstanceType<typeof PinterestHandler>;

  beforeEach(() => {
    mockFetch.mockReset();
    handler = new PinterestHandler();
    // Consumed by the batch attempt at the start of every getPostMetrics call
    // here; the queued *Once responses in each test then serve the per-pin
    // requests.
    mockFetch.mockResolvedValueOnce(batchRestricted());
  });

  it('stops the channel early once rate limited instead of grinding through every pin', async () => {
    // First pin succeeds, second is rate limited. base.ts retries a 429 up to
    // 3 times, then throws; the loop must then stop rather than attempt pins
    // 3..50 and burn 3 more attempts on each.
    mockFetch
      .mockResolvedValueOnce(ok({ IMPRESSION: 10 }))
      .mockResolvedValue(err(429, 'You have exceeded your rate limit. Try again later.'));

    const pinIds = Array.from({ length: 50 }, (_, i) => `pin${i}`);
    const results = await handler.getPostMetrics(channel, pinIds);

    expect(results.size).toBe(1);
    expect(results.get('pin0')).toMatchObject({ impressions: 10 });
    // 1 batch probe + 1 success + at most the retry budget for the single
    // 429'd pin. The important part is that it is nowhere near 50.
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(6);
  }, RETRY_TIMEOUT);

  it('keeps whatever it collected before the limit was hit', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ IMPRESSION: 1 }))
      .mockResolvedValueOnce(ok({ IMPRESSION: 2 }))
      .mockResolvedValue(err(429, 'rate limit'));

    const results = await handler.getPostMetrics(channel, ['a', 'b', 'c', 'd', 'e']);

    expect(results.size).toBe(2);
    expect([...results.keys()]).toEqual(['a', 'b']);
  }, RETRY_TIMEOUT);

  it('stops re-probing the video metric set after it fails once', async () => {
    // Image-only account: the video-inclusive set 400s. Previously every pin
    // paid that failure, doubling rate-limit spend.
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('VIDEO_MRC_VIEW')) return err(400, 'invalid metric_types');
      return ok({ IMPRESSION: 5 });
    });

    const results = await handler.getPostMetrics(channel, ['p1', 'p2', 'p3', 'p4']);

    expect(results.size).toBe(4);
    // 1 batch probe, then pin 1 costs 2 (video attempt + standard) and pins
    // 2-4 cost 1 each.
    expect(mockFetch).toHaveBeenCalledTimes(6);
    const videoAttempts = mockFetch.mock.calls.filter(
      (c) => isPerPinCall(c[0]) && String(c[0]).includes('VIDEO_MRC_VIEW'),
    );
    expect(videoAttempts).toHaveLength(1);
  });

  it('does not spend a second request on the fallback set when the failure was a 429', async () => {
    // A 429 says "slow down", not "wrong metric set" — falling through would
    // spend another request against an already-exhausted budget.
    mockFetch.mockResolvedValue(err(429, 'rate limit'));

    await handler.getPostMetrics(channel, ['only']);

    const standardOnly = mockFetch.mock.calls.filter(
      (c) => isPerPinCall(c[0]) && !String(c[0]).includes('VIDEO_MRC_VIEW'),
    );
    expect(standardOnly).toHaveLength(0);
  }, RETRY_TIMEOUT);

  it('still returns metrics normally when nothing is rate limited', async () => {
    mockFetch.mockResolvedValue(ok({ IMPRESSION: 7, TOTAL_REACTIONS: 2, TOTAL_COMMENTS: 1, SAVE: 3 }));

    const results = await handler.getPostMetrics(channel, ['x', 'y']);

    expect(results.size).toBe(2);
    expect(results.get('x')).toMatchObject({
      impressions: 7,
      likes: 2,
      comments: 1,
      saves: 3,
    });
  });
});

describe('Pinterest summary vs lifetime metric objects', () => {
  let handler: InstanceType<typeof PinterestHandler>;

  beforeEach(() => {
    mockFetch.mockReset();
    handler = new PinterestHandler();
  });

  // Batch-endpoint shape: the same per-pin object, keyed by pin id. Verified
  // against the live API on 2026-07-30 — the batch response nests identically
  // to the per-pin one, so a single parser serves both.
  function batch(all: Record<string, unknown>) {
    const body = JSON.stringify({ p: { all } });
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
  }

  function split(summary: Record<string, number>, lifetime: Record<string, number>) {
    return batch({ summary_metrics: summary, lifetime_metrics: lifetime });
  }

  it('merges both objects instead of picking one', async () => {
    // Exactly what the live API returned on 2026-07-29: engagement counts live
    // ONLY in lifetime_metrics, reach/click counts ONLY in summary_metrics.
    // Reading `lifetime ?? summary` zeroed impressions/clicks/saves for every
    // pin — 732 all-zero rows in production.
    mockFetch.mockResolvedValue(
      split(
        { IMPRESSION: 255, PIN_CLICK: 3, SAVE: 4, OUTBOUND_CLICK: 1 },
        { TOTAL_REACTIONS: 7, TOTAL_COMMENTS: 2 },
      ),
    );

    const results = await handler.getPostMetrics(channel, ['p']);

    expect(results.get('p')).toMatchObject({
      impressions: 255,
      clicks: 3,
      saves: 4,
      likes: 7,
      comments: 2,
    });
  });

  it('lets an all-time lifetime figure win over the windowed one', async () => {
    mockFetch.mockResolvedValue(
      split({ IMPRESSION: 10 }, { IMPRESSION: 999, TOTAL_REACTIONS: 1 }),
    );

    const results = await handler.getPostMetrics(channel, ['p']);
    expect(results.get('p')).toMatchObject({ impressions: 999, likes: 1 });
  });

  it('works when only summary_metrics is present', async () => {
    mockFetch.mockResolvedValue(batch({ summary_metrics: { IMPRESSION: 42 } }));

    const results = await handler.getPostMetrics(channel, ['p']);
    expect(results.get('p')).toMatchObject({ impressions: 42 });
  });

  it('works when only lifetime_metrics is present', async () => {
    mockFetch.mockResolvedValue(batch({ lifetime_metrics: { TOTAL_REACTIONS: 5 } }));

    const results = await handler.getPostMetrics(channel, ['p']);
    expect(results.get('p')).toMatchObject({ likes: 5, impressions: 0 });
  });
});
