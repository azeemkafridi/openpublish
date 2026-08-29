/**
 * Tests for POST /api/rss-feeds/preview — renders a feed's newest item per
 * channel with an unsaved field mapping. Read-only.
 */

const selectResults: any[][] = [];

function makeSelectChain() {
  const rows = selectResults.length > 0 ? selectResults.shift()! : [];
  const chain: any = {
    from: () => chain,
    where: () => chain,
    then: (resolve: any) => resolve(rows),
  };
  return chain;
}

vi.mock('@/lib/db', () => ({ db: { select: () => makeSelectChain() } }));

vi.mock('@/lib/db/schema', () => ({
  channels: { id: 'channels.id', platform: 'channels.platform', accountName: 'channels.account_name', organizationId: 'channels.org' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  inArray: vi.fn(() => ({})),
}));

const mockValidateFeedUrl = vi.fn();
const mockValidateOwnedChannels = vi.fn();
vi.mock('@/lib/rss/validate', () => ({
  validateFeedUrl: (...a: any[]) => mockValidateFeedUrl(...a),
  validateOwnedChannels: (...a: any[]) => mockValidateOwnedChannels(...a),
}));

const mockFetchFeedXml = vi.fn();
vi.mock('@/lib/rss/fetch', () => ({
  fetchFeedXml: (...a: any[]) => mockFetchFeedXml(...a),
}));

// Keep the preview hermetic: don't unfurl the item link over the network.
const mockUnfurl = vi.fn();
vi.mock('@/lib/link-preview', () => ({
  fetchLinkPreviewCached: (...a: any[]) => mockUnfurl(...a),
}));

const mockRateLimit = vi.fn();
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...a: any[]) => mockRateLimit(...a),
}));

import { POST } from '@/pages/api/rss-feeds/preview';
import { createMockContext, parseResponse } from '../helpers/api-mock';
import { USER_A } from '../helpers/fixtures';

const XML = `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>
  <item><title>Old</title><link>https://ex.com/old</link><pubDate>Wed, 01 Jul 2026 10:00:00 GMT</pubDate></item>
  <item><title>New</title><link>https://ex.com/new</link><pubDate>Thu, 02 Jul 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;

const ctx = (body: any) => createMockContext({ user: USER_A, method: 'POST', body });

beforeEach(() => {
  vi.clearAllMocks();
  selectResults.length = 0;
  mockValidateFeedUrl.mockResolvedValue('https://ex.com/feed.xml');
  mockValidateOwnedChannels.mockResolvedValue([10, 30]);
  mockFetchFeedXml.mockResolvedValue(XML);
  mockUnfurl.mockResolvedValue(null); // no OG unfurl by default
  mockRateLimit.mockResolvedValue({ allowed: true, remaining: 9 });
});

describe('POST /api/rss-feeds/preview', () => {
  it('401s unauthenticated', async () => {
    const res = await POST(createMockContext({ user: null, method: 'POST', body: {} }) as any);
    expect((await parseResponse(res)).status).toBe(401);
  });

  it('renders the newest item for each channel, flagging skipped ones', async () => {
    selectResults.push([
      { id: 10, platform: 'x', accountName: 'My X' },
      { id: 30, platform: 'instagram', accountName: 'My IG' },
    ]);
    const res = await POST(ctx({
      feedUrl: 'https://ex.com/feed.xml',
      channelIds: [10, 30],
      fieldMapping: { template: '{title}\n\n{link}', hashtags: '#a' },
    }) as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.item.title).toBe('New'); // newest, not first
    const x = data.previews.find((p: any) => p.channelId === 10);
    expect(x.skipped).toBe(false);
    expect(x.text).toBe('New\n\nhttps://ex.com/new\n\n#a');
    expect(x.charLimit).toBe(280);
    const ig = data.previews.find((p: any) => p.channelId === 30);
    expect(ig.skipped).toBe(true);
    expect(ig.skipReason).toMatch(/media/);
  });

  it('returns a link card unfurled from the item link (OG data wins)', async () => {
    mockUnfurl.mockResolvedValue({
      url: 'https://ex.com/new', title: 'OG Title', description: 'OG Desc',
      image: 'https://ex.com/og.jpg', siteName: 'Ex', domain: 'ex.com',
    });
    selectResults.push([{ id: 10, platform: 'x', accountName: 'My X' }]);
    const res = await POST(ctx({ feedUrl: 'https://ex.com/feed.xml', channelIds: [10], fieldMapping: { template: '{title}\n\n{link}' } }) as any);
    const { data } = await parseResponse(res);
    expect(mockUnfurl).toHaveBeenCalledWith('https://ex.com/new');
    expect(data.linkPreview).toMatchObject({ title: 'OG Title', image: 'https://ex.com/og.jpg', domain: 'ex.com' });
  });

  it('422s when the feed cannot be fetched', async () => {
    mockFetchFeedXml.mockRejectedValue(new Error('Feed returned HTTP 404'));
    const res = await POST(ctx({ feedUrl: 'https://ex.com/feed.xml', channelIds: [10] }) as any);
    expect((await parseResponse(res)).status).toBe(422);
  });

  it('422s for an empty feed', async () => {
    mockFetchFeedXml.mockResolvedValue('<?xml version="1.0"?><rss version="2.0"><channel><title>t</title></channel></rss>');
    const res = await POST(ctx({ feedUrl: 'https://ex.com/feed.xml', channelIds: [10] }) as any);
    expect((await parseResponse(res)).status).toBe(422);
  });

  it('400s on unowned channels', async () => {
    mockValidateOwnedChannels.mockResolvedValue(null);
    const res = await POST(ctx({ feedUrl: 'https://ex.com/feed.xml', channelIds: [999] }) as any);
    expect((await parseResponse(res)).status).toBe(400);
  });

  it('429s when the per-user rate limit is hit, before any outbound fetch', async () => {
    mockRateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfter: 30 });
    const res = await POST(ctx({ feedUrl: 'https://ex.com/feed.xml', channelIds: [10] }) as any);
    expect((await parseResponse(res)).status).toBe(429);
    expect(mockFetchFeedXml).not.toHaveBeenCalled();
  });
});

export {};
