/**
 * Tests for the RSS autopost worker's pollFeed:
 *   - first poll baselines the backlog without creating posts
 *   - later polls turn fresh items into draft or scheduled posts
 *   - per-cycle cap, quota gating, and channel targeting
 */

const selectResults: any[][] = [];
const insertedValues: Array<{ table: string; values: any }> = [];

function makeSelectChain() {
  const rows = selectResults.length > 0 ? selectResults.shift()! : [];
  const chain: any = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
    then: (resolve: any) => resolve(rows),
  };
  return chain;
}

const tableNames = new Map<any, string>();

vi.mock('@/lib/db', () => ({
  db: {
    select: () => makeSelectChain(),
    insert: (table: any) => ({
      values: (values: any) => {
        insertedValues.push({ table: tableNames.get(table) ?? 'unknown', values });
        const returned = [{ id: 42, ...((Array.isArray(values) ? values[0] : values) || {}) }];
        return {
          returning: () => Promise.resolve(returned),
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve(returned), // claim succeeds (no conflict)
            then: (resolve: any) => resolve(undefined),
          }),
        };
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  },
}));

vi.mock('@/lib/db/schema', () => {
  const posts = { name: 'posts' };
  const postPlatforms = { name: 'post_platforms' };
  const rssFeeds = { id: 'rss_feeds.id', enabled: 'rss_feeds.enabled' };
  const rssFeedItems = { feedId: 'rss_feed_items.feed_id', guid: 'rss_feed_items.guid' };
  const channels = { id: 'channels.id', isActive: 'channels.is_active', organizationId: 'channels.org' };
  return { posts, postPlatforms, rssFeeds, rssFeedItems, channels };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  inArray: vi.fn(() => ({})),
}));

vi.mock('bullmq', () => ({ Worker: vi.fn() }));
vi.mock('@/lib/jobs/queue', () => ({ getRedisConnection: () => ({}), QUEUE_NAMES: { RSS: 'rss' } }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/lib/activity/log', () => ({ logActivity: vi.fn() }));

const mockCheckQuotas = vi.fn();
const mockStorageQuota = vi.fn();
const mockGetOrgPlan = vi.fn();
vi.mock('@/lib/quotas/check', () => ({
  checkPostQuotasBatch: (...a: any[]) => mockCheckQuotas(...a),
  checkMediaStorageQuota: (...a: any[]) => mockStorageQuota(...a),
  getOrgPlan: (...a: any[]) => mockGetOrgPlan(...a),
  // getUserLimits is a pure plan→limits map; use the real one.
  getUserLimits: (plan: string) => ({
    business: { rssAutoPublish: true, rssPollIntervalMinutes: 15 },
    pro: { rssAutoPublish: true, rssPollIntervalMinutes: 30 },
    free: { rssAutoPublish: false, rssPollIntervalMinutes: 60 },
  } as any)[plan],
}));

const mockRehost = vi.fn();
vi.mock('@/lib/media/remote', () => ({
  rehostUrlToMedia: (...a: any[]) => mockRehost(...a),
}));

const mockValidateHostname = vi.fn();
const mockFetch = vi.fn();
vi.mock('@/lib/security/url-guard', () => ({
  ssrfSafeDispatcher: {},
  validateHostname: (...a: any[]) => mockValidateHostname(...a),
  ssrfSafeFetch: (...a: any[]) => mockFetch(...a),
}));

import { pollFeed, backoffDelayMs, baselineSentinel, clearFeedFetchCache } from '@/lib/jobs/rss.worker';
import * as schema from '@/lib/db/schema';

tableNames.set(schema.posts, 'posts');
tableNames.set(schema.postPlatforms, 'post_platforms');
tableNames.set(schema.rssFeedItems, 'rss_feed_items');

const RSS_XML = (n: number) => `<?xml version="1.0"?><rss version="2.0"><channel><title>B</title>
  ${Array.from({ length: n }, (_, i) => `<item><title>Item ${i}</title><link>https://ex.com/${i}</link><pubDate>Wed, 0${(i % 7) + 1} Jul 2026 10:00:00 GMT</pubDate></item>`).join('')}
</channel></rss>`;

const FEED = {
  id: 7,
  userId: 'user-1',
  organizationId: 1,
  name: 'Blog',
  feedUrl: 'https://ex.com/feed.xml',
  channelIds: [10],
  mode: 'draft',
  enabled: true,
  lastCheckedAt: new Date('2026-07-16T00:00:00Z'),
  lastSuccessAt: new Date('2026-07-16T00:00:00Z'),
  consecutiveFailures: 0,
} as any;

const CHANNEL = { id: 10, platform: 'x', isActive: true };

function feedResponse(xml: string) {
  const bytes = new TextEncoder().encode(xml);
  return {
    ok: true,
    headers: { get: () => null },
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () =>
            sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes }),
          cancel: async () => {},
        };
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearFeedFetchCache();
  selectResults.length = 0;
  insertedValues.length = 0;
  mockValidateHostname.mockResolvedValue(true);
  mockCheckQuotas.mockResolvedValue({ daily: { allowed: true }, monthly: { allowed: true } });
  mockStorageQuota.mockResolvedValue({ allowed: true, current: 0, limit: 500 });
  mockGetOrgPlan.mockResolvedValue('business');
  mockRehost.mockResolvedValue({ id: 77 });
});

describe('pollFeed', () => {
  it('baselines the backlog on first poll without creating posts', async () => {
    mockFetch.mockResolvedValue(feedResponse(RSS_XML(3)));
    selectResults.push([]); // no seen guids
    await pollFeed({ ...FEED, lastCheckedAt: null, lastSuccessAt: null });

    const postInserts = insertedValues.filter((i) => i.table === 'posts');
    expect(postInserts).toHaveLength(0);
    const itemInserts = insertedValues.filter((i) => i.table === 'rss_feed_items');
    expect(itemInserts).toHaveLength(1); // one bulk baseline insert
    expect(itemInserts[0].values).toHaveLength(3);
  });

  it('creates a draft post per fresh item on later polls', async () => {
    mockFetch.mockResolvedValue(feedResponse(RSS_XML(2)));
    selectResults.push([{ guid: 'https://ex.com/0' }]); // item 0 already seen
    selectResults.push([CHANNEL]);                       // active channels
    await pollFeed(FEED);

    const postInserts = insertedValues.filter((i) => i.table === 'posts');
    expect(postInserts).toHaveLength(1);
    expect(postInserts[0].values.status).toBe('draft');
    expect(postInserts[0].values.content).toContain('Item 1');
    expect(postInserts[0].values.content).toContain('https://ex.com/1');

    // Bulk insert: one call with an array of per-channel rows
    const ppInserts = insertedValues.filter((i) => i.table === 'post_platforms');
    expect(ppInserts).toHaveLength(1);
    expect(ppInserts[0].values).toHaveLength(1);
    expect(ppInserts[0].values[0].channelId).toBe(10);
  });

  it('auto-publishes when mode=publish (scheduled now)', async () => {
    mockFetch.mockResolvedValue(feedResponse(RSS_XML(1)));
    selectResults.push([]);        // nothing seen
    selectResults.push([CHANNEL]); // channels
    await pollFeed({ ...FEED, mode: 'publish' });

    const postInserts = insertedValues.filter((i) => i.table === 'posts');
    expect(postInserts).toHaveLength(1);
    expect(postInserts[0].values.status).toBe('scheduled');
    expect(postInserts[0].values.scheduledAt).toBeInstanceOf(Date);
  });

  it('caps items per cycle at 5', async () => {
    mockFetch.mockResolvedValue(feedResponse(RSS_XML(8)));
    selectResults.push([]);        // nothing seen
    selectResults.push([CHANNEL]); // channels
    await pollFeed(FEED);

    expect(insertedValues.filter((i) => i.table === 'posts')).toHaveLength(5);
  });

  it('stops creating posts when quota is exceeded', async () => {
    mockFetch.mockResolvedValue(feedResponse(RSS_XML(3)));
    selectResults.push([]);
    selectResults.push([CHANNEL]);
    mockCheckQuotas.mockResolvedValue({ daily: { allowed: false }, monthly: { allowed: true } });
    await pollFeed(FEED);

    expect(insertedValues.filter((i) => i.table === 'posts')).toHaveLength(0);
  });

  it('throws when the feed host fails SSRF validation', async () => {
    mockValidateHostname.mockResolvedValue(false);
    await expect(pollFeed(FEED)).rejects.toThrow(/not allowed/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws when no active channels remain', async () => {
    mockFetch.mockResolvedValue(feedResponse(RSS_XML(1)));
    selectResults.push([]); // nothing seen
    selectResults.push([]); // no channels
    await expect(pollFeed(FEED)).rejects.toThrow(/No active channels/);
  });
});


describe('pollFeed with a field mapping', () => {
  const MAPPED_FEED = {
    ...FEED,
    channelIds: [10, 20],
    fieldMapping: {
      template: '{title}\n\n{link}',
      mediaField: 'none',
      stripHtml: true,
      truncate: 'smart',
      hashtags: '#blog',
      channelOverrides: { '20': { template: 'LI: {title}', hashtags: '' } },
    },
  } as any;
  const LINKEDIN = { id: 20, platform: 'linkedin', isActive: true };

  it('renders per-channel text and writes overrides into platformContent', async () => {
    mockFetch.mockResolvedValue(feedResponse(RSS_XML(1)));
    selectResults.push([]);                  // nothing seen
    selectResults.push([CHANNEL, LINKEDIN]); // active channels
    await pollFeed(MAPPED_FEED);

    const post = insertedValues.find((i) => i.table === 'posts')!.values;
    expect(post.content).toBe('Item 0\n\nhttps://ex.com/0\n\n#blog');
    expect(post.platformContent).toEqual({ linkedin: 'LI: Item 0' });

    const pp = insertedValues.find((i) => i.table === 'post_platforms')!.values;
    expect(pp.map((r: any) => r.channelId).sort()).toEqual([10, 20]);
  });

  it('rehosts the selected item image and attaches it to the post', async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>B</title>
      <item><title>Pic</title><link>https://ex.com/p</link>
        <enclosure url="https://ex.com/p.jpg" type="image/jpeg" />
      </item></channel></rss>`;
    mockFetch.mockResolvedValue(feedResponse(xml));
    selectResults.push([]);
    selectResults.push([CHANNEL]);
    await pollFeed({ ...MAPPED_FEED, channelIds: [10], fieldMapping: { ...MAPPED_FEED.fieldMapping, mediaField: 'image', channelOverrides: undefined } });

    expect(mockRehost).toHaveBeenCalledWith('https://ex.com/p.jpg', 'user-1', 1, { maxBytes: 25 * 1024 * 1024 });
    const post = insertedValues.find((i) => i.table === 'posts')!.values;
    expect(post.mediaFiles).toEqual([77]);
  });

  it('continues without media when rehosting fails, skipping media-required channels', async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>B</title>
      <item><title>Pic</title><link>https://ex.com/p</link>
        <enclosure url="https://ex.com/p.jpg" type="image/jpeg" />
      </item></channel></rss>`;
    mockFetch.mockResolvedValue(feedResponse(xml));
    mockRehost.mockRejectedValue(new Error('fetch failed'));
    const IG = { id: 30, platform: 'instagram', isActive: true };
    selectResults.push([]);
    selectResults.push([CHANNEL, IG]);
    await pollFeed({ ...MAPPED_FEED, channelIds: [10, 30], fieldMapping: { ...MAPPED_FEED.fieldMapping, mediaField: 'image', channelOverrides: undefined } });

    const post = insertedValues.find((i) => i.table === 'posts')!.values;
    expect(post.mediaFiles).toEqual([]);
    const pp = insertedValues.find((i) => i.table === 'post_platforms')!.values;
    expect(pp.map((r: any) => r.channelId)).toEqual([10]); // Instagram skipped
  });

  it('creates no post when every channel is skipped (media required, none available)', async () => {
    mockFetch.mockResolvedValue(feedResponse(RSS_XML(1)));
    const IG = { id: 30, platform: 'instagram', isActive: true };
    selectResults.push([]);
    selectResults.push([IG]);
    await pollFeed({ ...MAPPED_FEED, channelIds: [30], fieldMapping: { ...MAPPED_FEED.fieldMapping, channelOverrides: undefined } });

    expect(insertedValues.filter((i) => i.table === 'posts')).toHaveLength(0);
    // The item is still claimed so it is not retried forever.
    expect(insertedValues.filter((i) => i.table === 'rss_feed_items')).toHaveLength(1);
  });
});

describe('baseline sentinel (F12)', () => {
  it('re-baselines when lastSuccessAt is null even though a failed poll stamped lastCheckedAt', async () => {
    mockFetch.mockResolvedValue(feedResponse(RSS_XML(4)));
    selectResults.push([]); // nothing seen
    // Old bug: lastCheckedAt set by the failed first poll used to consume the
    // sentinel, flooding the backlog. With failures recorded, we must baseline.
    await pollFeed({ ...FEED, lastSuccessAt: null, lastCheckedAt: new Date(), consecutiveFailures: 3 });

    expect(insertedValues.filter((i) => i.table === 'posts')).toHaveLength(0);
    const itemInserts = insertedValues.filter((i) => i.table === 'rss_feed_items');
    expect(itemInserts).toHaveLength(1);
    expect(itemInserts[0].values).toHaveLength(4);
  });

  it('baselineSentinel falls back to lastCheckedAt only for clean pre-migration rows', () => {
    const ok = new Date();
    // pre-migration row that had polled successfully → keep it baselined
    expect(baselineSentinel({ lastSuccessAt: null, lastCheckedAt: ok, consecutiveFailures: 0 })).toBe(ok);
    // failed-only feed → sentinel stays null
    expect(baselineSentinel({ lastSuccessAt: null, lastCheckedAt: ok, consecutiveFailures: 2 })).toBeNull();
    // new-code success wins regardless
    expect(baselineSentinel({ lastSuccessAt: ok, lastCheckedAt: null, consecutiveFailures: 5 })).toBe(ok);
    expect(baselineSentinel({ lastSuccessAt: null, lastCheckedAt: null, consecutiveFailures: 0 })).toBeNull();
  });
});

describe('error backoff (F3)', () => {
  it('doubles from one cycle up to the 24h cap', () => {
    expect(backoffDelayMs(1)).toBe(15 * 60 * 1000);
    expect(backoffDelayMs(2)).toBe(30 * 60 * 1000);
    expect(backoffDelayMs(3)).toBe(60 * 60 * 1000);
    expect(backoffDelayMs(8)).toBe(24 * 60 * 60 * 1000); // capped (32h → 24h)
    expect(backoffDelayMs(20)).toBe(24 * 60 * 60 * 1000);
  });
});

describe('storage quota gate (F7)', () => {
  it('skips the rehost and continues without media when storage quota is reached', async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>B</title>
      <item><title>Pic</title><link>https://ex.com/p</link>
        <enclosure url="https://ex.com/p.jpg" type="image/jpeg" />
      </item></channel></rss>`;
    mockFetch.mockResolvedValue(feedResponse(xml));
    mockStorageQuota.mockResolvedValue({ allowed: false, current: 500, limit: 500 });
    selectResults.push([]);
    selectResults.push([CHANNEL]);
    await pollFeed({ ...FEED, fieldMapping: { template: '{title}\n\n{link}', mediaField: 'image', stripHtml: true, truncate: 'smart', hashtags: '' } });

    expect(mockRehost).not.toHaveBeenCalled();
    const post = insertedValues.find((i) => i.table === 'posts')!.values;
    expect(post.mediaFiles).toEqual([]);
  });
});

describe('conditional GET + shared-URL cache (Phase 3)', () => {
  it('returns kept validators and does nothing else on 304', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 304, headers: { get: () => null } });
    const result = await pollFeed({ ...FEED, etag: '"v1"', lastModified: 'Wed, 16 Jul 2026 00:00:00 GMT' });
    expect(result).toEqual({ etag: '"v1"', lastModified: 'Wed, 16 Jul 2026 00:00:00 GMT' });
    expect(insertedValues).toHaveLength(0);
  });

  it('sends stored validators as conditional headers', async () => {
    mockFetch.mockResolvedValue(feedResponse(RSS_XML(1)));
    selectResults.push([]);
    selectResults.push([CHANNEL]);
    await pollFeed({ ...FEED, etag: '"v1"', lastModified: 'Wed, 16 Jul 2026 00:00:00 GMT' });
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['If-None-Match']).toBe('"v1"');
    expect(headers['If-Modified-Since']).toBe('Wed, 16 Jul 2026 00:00:00 GMT');
  });

  it('returns the response validators for persistence', async () => {
    const withHeaders = {
      ...feedResponse(RSS_XML(1)),
      headers: { get: (h: string) => ({ etag: '"v2"', 'last-modified': 'Fri, 18 Jul 2026 00:00:00 GMT' } as any)[h.toLowerCase()] ?? null },
    };
    mockFetch.mockResolvedValue(withHeaders);
    selectResults.push([]);
    selectResults.push([CHANNEL]);
    const result = await pollFeed(FEED);
    expect(result).toEqual({ etag: '"v2"', lastModified: 'Fri, 18 Jul 2026 00:00:00 GMT' });
  });

  it('fetches a shared URL once per cycle and fans the content out to both feeds', async () => {
    mockFetch.mockResolvedValue(feedResponse(RSS_XML(1)));
    // feed A: seen select + channels select; feed B: same again
    selectResults.push([], [CHANNEL], [], [CHANNEL]);
    await pollFeed(FEED);
    await pollFeed({ ...FEED, id: 8, organizationId: 2 });

    expect(mockFetch).toHaveBeenCalledTimes(1); // cache hit for feed B
    expect(insertedValues.filter((i) => i.table === 'posts')).toHaveLength(2); // both feeds still post
  });
});

describe('plan-gated auto-publish (force draft)', () => {
  it('forces draft when the plan disallows auto-publish even if mode=publish', async () => {
    mockFetch.mockResolvedValue(feedResponse(RSS_XML(1)));
    selectResults.push([]);        // nothing seen
    selectResults.push([CHANNEL]); // channels
    await pollFeed({ ...FEED, mode: 'publish' }, { rssAutoPublish: false });

    const post = insertedValues.find((i) => i.table === 'posts')!.values;
    expect(post.status).toBe('draft');
    expect(post.scheduledAt).toBeNull();
  });

  it('publishes when the plan allows auto-publish', async () => {
    mockFetch.mockResolvedValue(feedResponse(RSS_XML(1)));
    selectResults.push([]);
    selectResults.push([CHANNEL]);
    await pollFeed({ ...FEED, mode: 'publish' }, { rssAutoPublish: true });

    const post = insertedValues.find((i) => i.table === 'posts')!.values;
    expect(post.status).toBe('scheduled');
  });
});

describe('approval gating (team roles Phase 2)', () => {
  it('parks auto-published items as pending when the feed requires approval', async () => {
    mockFetch.mockResolvedValue(feedResponse(RSS_XML(1)));
    selectResults.push([]);        // nothing seen
    selectResults.push([CHANNEL]); // channels
    await pollFeed({ ...FEED, mode: 'publish', requireApproval: true }, { rssAutoPublish: true });

    const post = insertedValues.find((i) => i.table === 'posts')!.values;
    expect(post.status).toBe('scheduled');
    expect(post.approvalStatus).toBe('pending');
  });

  it('leaves auto-published items ungated when the feed does not require approval', async () => {
    mockFetch.mockResolvedValue(feedResponse(RSS_XML(1)));
    selectResults.push([]);
    selectResults.push([CHANNEL]);
    await pollFeed({ ...FEED, mode: 'publish', requireApproval: false }, { rssAutoPublish: true });

    const post = insertedValues.find((i) => i.table === 'posts')!.values;
    expect(post.approvalStatus).toBe('none');
  });

  it('does not gate draft-mode items (a draft never publishes on its own)', async () => {
    mockFetch.mockResolvedValue(feedResponse(RSS_XML(1)));
    selectResults.push([]);
    selectResults.push([CHANNEL]);
    await pollFeed({ ...FEED, mode: 'draft', requireApproval: true }, { rssAutoPublish: true });

    const post = insertedValues.find((i) => i.table === 'posts')!.values;
    expect(post.status).toBe('draft');
    expect(post.approvalStatus).toBe('none');
  });

  it('does not gate items force-demoted to draft by the plan gate', async () => {
    mockFetch.mockResolvedValue(feedResponse(RSS_XML(1)));
    selectResults.push([]);
    selectResults.push([CHANNEL]);
    await pollFeed({ ...FEED, mode: 'publish', requireApproval: true }, { rssAutoPublish: false });

    const post = insertedValues.find((i) => i.table === 'posts')!.values;
    expect(post.status).toBe('draft');
    expect(post.approvalStatus).toBe('none');
  });
});

export {};
