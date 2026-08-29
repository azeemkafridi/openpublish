/**
 * CRUD tests for the RSS Autopost feeds API.
 */

const selectResults: any[][] = [];
let insertResult: any[] = [];
let updateResult: any[] = [];

function makeSelectChain() {
  const rows = selectResults.length > 0 ? selectResults.shift()! : [];
  const chain: any = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(rows),
    then: (resolve: any) => resolve(rows),
  };
  return chain;
}

vi.mock('@/lib/db', () => ({
  db: {
    select: () => makeSelectChain(),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve(insertResult) }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve(updateResult) }) }) }),
    delete: () => ({ where: () => Promise.resolve() }),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  rssFeeds: {
    id: 'rss_feeds.id', organizationId: 'rss_feeds.organization_id', name: 'rss_feeds.name',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
}));

vi.mock('@/lib/activity/log', () => ({ logActivity: vi.fn() }));

const mockCheckRssQuota = vi.fn();
const mockGetOrgPlan = vi.fn();
const mockGetLimits = vi.fn();
vi.mock('@/lib/quotas/check', () => ({
  checkRssFeedQuota: (...a: any[]) => mockCheckRssQuota(...a),
  getOrgPlan: (...a: any[]) => mockGetOrgPlan(...a),
  getUserLimits: (...a: any[]) => mockGetLimits(...a),
}));

const mockValidateFeedUrl = vi.fn();
const mockValidateOwnedChannels = vi.fn();
vi.mock('@/lib/rss/validate', () => ({
  validateFeedUrl: (...a: any[]) => mockValidateFeedUrl(...a),
  validateOwnedChannels: (...a: any[]) => mockValidateOwnedChannels(...a),
}));

import { GET, POST } from '@/pages/api/rss-feeds/index';
import { PUT, DELETE } from '@/pages/api/rss-feeds/[id]';
import { createMockContext, parseResponse } from '../helpers/api-mock';
import { USER_A } from '../helpers/fixtures';

const SAMPLE_FEED = {
  id: 3, organizationId: 1, userId: 'user-1', name: 'Blog',
  feedUrl: 'https://ex.com/feed.xml', channelIds: [10], mode: 'draft', enabled: true,
};

function reset(...results: any[][]) {
  vi.clearAllMocks();
  selectResults.length = 0;
  selectResults.push(...results);
  insertResult = [SAMPLE_FEED];
  updateResult = [SAMPLE_FEED];
  mockValidateFeedUrl.mockResolvedValue('https://ex.com/feed.xml');
  mockValidateOwnedChannels.mockResolvedValue([10]);
  // Default: Business plan — feed quota available, auto-publish allowed.
  mockCheckRssQuota.mockResolvedValue({ allowed: true, current: 0, limit: 50, resource: 'rss_feeds' });
  mockGetOrgPlan.mockResolvedValue('business');
  mockGetLimits.mockReturnValue({ rssAutoPublish: true, rssFeeds: 50, rssPollIntervalMinutes: 15 });
}

describe('GET /api/rss-feeds', () => {
  it('401s unauthenticated', async () => {
    reset();
    const res = await GET(createMockContext({ user: null }) as any);
    expect((await parseResponse(res)).status).toBe(401);
  });

  it('lists org feeds', async () => {
    reset([SAMPLE_FEED]);
    const res = await GET(createMockContext({ user: USER_A }) as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toHaveLength(1);
  });
});

describe('POST /api/rss-feeds', () => {
  const ctx = (body: any) => createMockContext({ user: USER_A, method: 'POST', body });

  it('creates a feed', async () => {
    reset([]); // existing feeds count
    const res = await POST(ctx({ name: 'Blog', feedUrl: 'https://ex.com/feed.xml', channelIds: [10] }) as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(201);
    expect(data.name).toBe('Blog');
  });

  it('rejects creating a feed over the plan feed limit (403)', async () => {
    reset([]);
    mockGetOrgPlan.mockResolvedValue('free');
    mockCheckRssQuota.mockResolvedValue({ allowed: false, current: 1, limit: 1, resource: 'rss_feeds' });
    const res = await POST(ctx({ name: 'Blog', feedUrl: 'https://ex.com/f', channelIds: [10] }) as any);
    expect((await parseResponse(res)).status).toBe(403);
  });

  it('rejects auto-publish mode when the plan is draft-only (403)', async () => {
    reset([]);
    mockGetOrgPlan.mockResolvedValue('free');
    mockGetLimits.mockReturnValue({ rssAutoPublish: false, rssFeeds: 1, rssPollIntervalMinutes: 60 });
    const res = await POST(ctx({ name: 'Blog', feedUrl: 'https://ex.com/f', channelIds: [10], mode: 'publish' }) as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(403);
    expect(data.error.resource).toBe('rss_auto_publish');
  });

  it('allows draft mode on a draft-only plan (201)', async () => {
    reset([]);
    mockGetOrgPlan.mockResolvedValue('free');
    mockGetLimits.mockReturnValue({ rssAutoPublish: false, rssFeeds: 1, rssPollIntervalMinutes: 60 });
    const res = await POST(ctx({ name: 'Blog', feedUrl: 'https://ex.com/f', channelIds: [10], mode: 'draft' }) as any);
    expect((await parseResponse(res)).status).toBe(201);
  });

  it('allows auto-publish mode when the plan permits (201)', async () => {
    reset([]);
    const res = await POST(ctx({ name: 'Blog', feedUrl: 'https://ex.com/f', channelIds: [10], mode: 'publish' }) as any);
    expect((await parseResponse(res)).status).toBe(201);
  });

  it('rejects an SSRF-failing feed URL', async () => {
    reset();
    mockValidateFeedUrl.mockResolvedValue(null);
    const res = await POST(ctx({ name: 'Bad', feedUrl: 'http://169.254.169.254/', channelIds: [10] }) as any);
    expect((await parseResponse(res)).status).toBe(400);
  });

  it('rejects unowned channels', async () => {
    reset();
    mockValidateOwnedChannels.mockResolvedValue(null);
    const res = await POST(ctx({ name: 'Bad', feedUrl: 'https://ex.com/f', channelIds: [999] }) as any);
    expect((await parseResponse(res)).status).toBe(400);
  });

  it('rejects a missing name', async () => {
    reset();
    const res = await POST(ctx({ feedUrl: 'https://ex.com/f', channelIds: [10] }) as any);
    expect((await parseResponse(res)).status).toBe(400);
  });

  it('rejects an invalid fieldMapping', async () => {
    reset([]);
    const res = await POST(ctx({ name: 'Blog', feedUrl: 'https://ex.com/f', channelIds: [10], fieldMapping: { template: '' } }) as any);
    expect((await parseResponse(res)).status).toBe(400);
  });

  it('accepts a valid fieldMapping', async () => {
    reset([]);
    const res = await POST(ctx({
      name: 'Blog', feedUrl: 'https://ex.com/f', channelIds: [10],
      fieldMapping: { template: '{title} {link}', mediaField: 'auto', hashtags: '#a', channelOverrides: { '10': { template: 'X {title}' } } },
    }) as any);
    expect((await parseResponse(res)).status).toBe(201);
  });
});

describe('PUT /api/rss-feeds/[id]', () => {
  const ctx = (id: string, body: any) => createMockContext({ user: USER_A, params: { id }, method: 'PUT', body });

  it('toggles enabled', async () => {
    reset([SAMPLE_FEED]);
    updateResult = [{ ...SAMPLE_FEED, enabled: false }];
    const res = await PUT(ctx('3', { enabled: false }) as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.enabled).toBe(false);
  });

  it('404s outside the org', async () => {
    reset([]);
    const res = await PUT(ctx('9', { enabled: false }) as any);
    expect((await parseResponse(res)).status).toBe(404);
  });

  it('rejects an invalid mode', async () => {
    reset([SAMPLE_FEED]);
    const res = await PUT(ctx('3', { mode: 'yolo' }) as any);
    expect((await parseResponse(res)).status).toBe(400);
  });

  it('rejects switching to auto-publish on a draft-only plan (403)', async () => {
    reset([SAMPLE_FEED]);
    mockGetOrgPlan.mockResolvedValue('free');
    mockGetLimits.mockReturnValue({ rssAutoPublish: false, rssFeeds: 1, rssPollIntervalMinutes: 60 });
    const res = await PUT(ctx('3', { mode: 'publish' }) as any);
    expect((await parseResponse(res)).status).toBe(403);
  });

  it('allows switching to auto-publish when the plan permits (200)', async () => {
    reset([SAMPLE_FEED]);
    const res = await PUT(ctx('3', { mode: 'publish' }) as any);
    expect((await parseResponse(res)).status).toBe(200);
  });

  it('rejects an invalid fieldMapping and accepts null (clear)', async () => {
    reset([SAMPLE_FEED]);
    const bad = await PUT(ctx('3', { fieldMapping: 'nope' }) as any);
    expect((await parseResponse(bad)).status).toBe(400);

    reset([SAMPLE_FEED]);
    const cleared = await PUT(ctx('3', { fieldMapping: null }) as any);
    expect((await parseResponse(cleared)).status).toBe(200);
  });

  it('saves a valid fieldMapping', async () => {
    reset([SAMPLE_FEED]);
    const res = await PUT(ctx('3', { fieldMapping: { template: '{title}', truncate: 'skip' } }) as any);
    expect((await parseResponse(res)).status).toBe(200);
  });
});

describe('DELETE /api/rss-feeds/[id]', () => {
  it('deletes an owned feed', async () => {
    reset([SAMPLE_FEED]);
    const res = await DELETE(createMockContext({ user: USER_A, params: { id: '3' } }) as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
  });

  it('404s for an unknown feed', async () => {
    reset([]);
    const res = await DELETE(createMockContext({ user: USER_A, params: { id: '9' } }) as any);
    expect((await parseResponse(res)).status).toBe(404);
  });
});

export {};
