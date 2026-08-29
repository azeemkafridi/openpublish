/**
 * Tests for the Google My Business (GMB) platform handler.
 *
 * Covers:
 *   - publishPost: standard, event, and offer post types
 *   - Media attachment
 *   - Call to action support
 *   - Event schedule (date/time parsing)
 *   - Offer details (coupon code, terms)
 *   - Location path resolution (full vs partial)
 *   - No access token error
 *   - refreshToken: success and failure
 */

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { GmbHandler } = await import('@/lib/platforms/gmb');
import type { PostData, ChannelData, MediaFileData } from '@/lib/platforms/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(overrides: Partial<ChannelData> = {}): ChannelData {
  return {
    id: 1,
    platform: 'gmb',
    accountId: 'accounts/123/locations/456',
    accountName: 'Test Business',
    accessToken: 'gmb-access-token',
    ...overrides,
  };
}

function makePost(overrides: Partial<PostData> = {}): PostData {
  return {
    content: 'Business update!',
    mediaUrls: [],
    mediaFiles: [],
    ...overrides,
  };
}

function makeImage(url = 'https://cdn.test/img.jpg'): MediaFileData {
  return { url, localPath: '/tmp/img.jpg', mimeType: 'image/jpeg', sizeBytes: 1000 };
}

function mockFetchJson(data: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(data),
    json: async () => data,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GmbHandler', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new GmbHandler();

  beforeAll(() => {
    process.env.GMB_CLIENT_ID = 'test-gmb-id';
    process.env.GMB_CLIENT_SECRET = 'test-gmb-secret';
  });

  describe('config', () => {
    it('has correct platform config', () => {
      expect(handler.config.name).toBe('gmb');
      expect(handler.config.displayName).toBe('Google Business');
      expect(handler.config.postTypes).toHaveLength(3);
    });
  });

  describe('publishPost', () => {
    it('returns error when no access token', async () => {
      const result = await handler.publishPost(makePost(), makeChannel({ accessToken: '' }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('No access token');
    });

    it('publishes standard post (full location path)', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ name: 'accounts/123/locations/456/localPosts/789' }),
      );

      const result = await handler.publishPost(makePost(), makeChannel());
      expect(result.success).toBe(true);
      expect(result.postId).toBe('accounts/123/locations/456/localPosts/789');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.topicType).toBe('STANDARD');
      expect(body.summary).toBe('Business update!');
    });

    it('resolves partial location path', async () => {
      // resolveLocationName: fetch accounts
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ accounts: [{ name: 'accounts/999' }] }),
      );
      // Create local post
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ name: 'accounts/999/locations/100/localPosts/200' }),
      );

      const result = await handler.publishPost(
        makePost(),
        makeChannel({ accountId: 'locations/100' }),
      );
      expect(result.success).toBe(true);
      // The post URL should contain the resolved full path
      expect(mockFetch.mock.calls[1][0]).toContain('accounts/999/locations/100');
    });

    it('publishes post with media', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ name: 'localPosts/media_post' }),
      );

      const post = makePost({ mediaFiles: [makeImage()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.media).toHaveLength(1);
      expect(body.media[0].mediaFormat).toBe('PHOTO');
      expect(body.media[0].sourceUrl).toBe('https://cdn.test/img.jpg');
    });

    it('publishes event post with schedule', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ name: 'localPosts/event_post' }),
      );

      const post = makePost({
        postType: 'event',
        platformSpecific: {
          eventTitle: 'Grand Opening',
          startDate: '2026-04-01',
          endDate: '2026-04-02',
          startTime: '09:00',
          endTime: '17:00',
        },
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.topicType).toBe('EVENT');
      expect(body.event.title).toBe('Grand Opening');
      expect(body.event.schedule.startDate).toEqual({ year: 2026, month: 4, day: 1 });
      expect(body.event.schedule.endDate).toEqual({ year: 2026, month: 4, day: 2 });
      expect(body.event.schedule.startTime).toEqual({ hours: 9, minutes: 0 });
      expect(body.event.schedule.endTime).toEqual({ hours: 17, minutes: 0 });
    });

    it('fails when Google returns state REJECTED on a 200', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ name: 'localPosts/rejected_post', state: 'REJECTED' }),
      );

      const result = await handler.publishPost(makePost(), makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/rejected/i);
    });

    it('fails when Google confirms nothing (200 with no localPost name)', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchJson({}));

      const result = await handler.publishPost(makePost(), makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/did not confirm/i);
    });

    it('publishes offer post with coupon and CTA', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ name: 'localPosts/offer_post' }),
      );

      const post = makePost({
        postType: 'offer',
        platformSpecific: {
          couponCode: 'SAVE20',
          redeemOnlineUrl: 'https://example.com/redeem',
          termsConditions: 'Valid until April 30',
          ctaType: 'SHOP',
          ctaUrl: 'https://example.com/shop',
        },
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.topicType).toBe('OFFER');
      expect(body.offer.couponCode).toBe('SAVE20');
      expect(body.offer.termsConditions).toBe('Valid until April 30');
      expect(body.callToAction.actionType).toBe('SHOP');
      expect(body.callToAction.url).toBe('https://example.com/shop');
    });

    it('sets CALL CTA without URL', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ name: 'localPosts/call_post' }),
      );

      const post = makePost({
        platformSpecific: { ctaType: 'CALL' },
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.callToAction.actionType).toBe('CALL');
      expect(body.callToAction.url).toBeUndefined();
    });

    it('handles API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ error: 'Permission denied' }),
      });

      const result = await handler.publishPost(makePost(), makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');
    });
  });

  describe('getAccountAnalytics', () => {
    it('returns location metrics successfully', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          multiDailyMetricTimeSeries: [
            { dailyMetricTimeSeries: { dailyMetric: 'WEBSITE_CLICKS', timeSeries: { datedValues: [{ value: '25' }] } } },
            { dailyMetricTimeSeries: { dailyMetric: 'CALL_CLICKS', timeSeries: { datedValues: [{ value: '10' }] } } },
            { dailyMetricTimeSeries: { dailyMetric: 'BUSINESS_DIRECTION_REQUESTS', timeSeries: { datedValues: [{ value: '5' }] } } },
            { dailyMetricTimeSeries: { dailyMetric: 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS', timeSeries: { datedValues: [{ value: '200' }] } } },
            { dailyMetricTimeSeries: { dailyMetric: 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', timeSeries: { datedValues: [{ value: '300' }] } } },
            { dailyMetricTimeSeries: { dailyMetric: 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', timeSeries: { datedValues: [{ value: '400' }] } } },
            { dailyMetricTimeSeries: { dailyMetric: 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH', timeSeries: { datedValues: [{ value: '600' }] } } },
          ],
        }),
      );

      const result = await handler.getAccountAnalytics(makeChannel());
      expect(result).not.toBeNull();
      expect(result!.websiteClicks).toBe(25);
      // Maps AND Search — summing only the Maps pair silently dropped the
      // (usually larger) Search share of impressions.
      expect(result!.impressions).toBe(1500);
      expect(result!.platformSpecific?.callClicks).toBe(10);
      expect(result!.platformSpecific?.directionRequests).toBe(5);
      expect(result!.platformSpecific?.desktopMapViews).toBe(200);
      expect(result!.platformSpecific?.mobileMapViews).toBe(300);
      expect(result!.platformSpecific?.desktopSearchViews).toBe(400);
      expect(result!.platformSpecific?.mobileSearchViews).toBe(600);
    });

    it('extracts locationId from full account path', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ multiDailyMetricTimeSeries: [] }),
      );

      await handler.getAccountAnalytics(makeChannel({ accountId: 'accounts/123/locations/456' }));

      const calledUrl = mockFetch.mock.calls[0][0];
      expect(calledUrl).toContain('locations/456');
      expect(calledUrl).not.toContain('accounts/');
    });

    it('extracts locationId from partial path', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ multiDailyMetricTimeSeries: [] }),
      );

      await handler.getAccountAnalytics(makeChannel({ accountId: 'locations/789' }));

      const calledUrl = mockFetch.mock.calls[0][0];
      expect(calledUrl).toContain('locations/789');
    });

    it('returns null when no access token', async () => {
      const result = await handler.getAccountAnalytics(makeChannel({ accessToken: '' }));
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns null on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ error: 'Permission denied' }),
      });

      const result = await handler.getAccountAnalytics(makeChannel());
      expect(result).toBeNull();
    });

    it('returns null when accountId has no location', async () => {
      const result = await handler.getAccountAnalytics(makeChannel({ accountId: 'accounts/123' }));
      expect(result).toBeNull();
    });

    it('handles empty metric response', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ multiDailyMetricTimeSeries: [] }),
      );

      const result = await handler.getAccountAnalytics(makeChannel());
      expect(result).not.toBeNull();
      expect(result!.impressions).toBe(0);
      expect(result!.websiteClicks).toBe(0);
    });
  });

  describe('refreshToken', () => {
    it('refreshes token successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: 'new_gmb_access',
            refresh_token: 'new_gmb_refresh',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
      });

      const result = await handler.refreshToken('old_refresh');
      expect(result).not.toBeNull();
      expect(result!.accessToken).toBe('new_gmb_access');
    });

    it('preserves original refresh token if not returned', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: 'new_access',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
      });

      const result = await handler.refreshToken('original');
      expect(result!.refreshToken).toBe('original');
    });

    it('returns null on failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'invalid_grant' }),
      });

      const result = await handler.refreshToken('bad');
      expect(result).toBeNull();
    });
  });
});
