import { PlatformHandler } from './base';
import type {
  TokenData,
  AccountInfo,
  PublishResult,
  PostData,
  ChannelData,
  PlatformConfig,
  EngagementData,
} from './types';

const API_BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const POST_API_BASE = 'https://mybusiness.googleapis.com/v4';
const ACCOUNTS_API = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const config: PlatformConfig = {
  name: 'gmb',
  displayName: 'Google Business',
  icon: 'google',
  color: '#4285F4',
  authType: 'oauth',
  postTypes: [
    {
      value: 'standard',
      label: 'Update',
      description: 'Standard business update post',
      maxMedia: 1,
      allowedMediaTypes: ['image'],
    },
    {
      value: 'event',
      label: 'Event',
      description: 'Event post with date, time, and details',
      maxMedia: 1,
      allowedMediaTypes: ['image'],
    },
    {
      value: 'offer',
      label: 'Offer',
      description: 'Promotional offer post',
      maxMedia: 1,
      allowedMediaTypes: ['image'],
    },
  ],
  mediaRules: {
    image: {
      maxSizeMB: 5,
      formats: ['jpg', 'jpeg', 'png'],
      maxCount: 1,
    },
  },
};

interface GmbDateObject {
  year: number;
  month: number;
  day: number;
}

interface GmbTimeObject {
  hours: number;
  minutes: number;
}

/** Parse "YYYY-MM-DD" → GmbDateObject */
function parseDateString(dateStr: string): GmbDateObject {
  const [year, month, day] = dateStr.split('-').map(Number);
  return { year, month, day };
}

/** Parse "HH:MM" → GmbTimeObject */
function parseTimeString(timeStr: string): GmbTimeObject {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return { hours, minutes };
}

export class GmbHandler extends PlatformHandler {
  constructor() {
    super(config);
  }

  private getClientId(): string {
    const clientId = process.env.GMB_CLIENT_ID;
    if (!clientId) throw new Error('GMB_CLIENT_ID not configured');
    return clientId;
  }

  private getClientSecret(): string {
    const clientSecret = process.env.GMB_CLIENT_SECRET;
    if (!clientSecret) throw new Error('GMB_CLIENT_SECRET not configured');
    return clientSecret;
  }

  async getOAuthUrl(redirectUri: string, state: string): Promise<string> {
    const clientId = this.getClientId();

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/business.manage',
      access_type: 'offline',
      prompt: 'consent',
      state: state,
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchangeCodeForToken(
    code: string,
    redirectUri: string,
  ): Promise<TokenData> {
    const params = new URLSearchParams({
      code: code,
      client_id: this.getClientId(),
      client_secret: this.getClientSecret(),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const tokenData = await this.fetchJson<{
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type: string;
    }>(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    return {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresIn: tokenData.expires_in,
    };
  }

  async getAccountInfo(accessToken: string): Promise<AccountInfo> {
    // List all GMB accounts
    const accountsData = await this.fetchJson<{
      accounts: Array<{ name: string; accountName: string; type: string }>;
    }>(`${ACCOUNTS_API}/accounts`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!accountsData.accounts || accountsData.accounts.length === 0) {
      throw new Error(
        'No Google Business Profile accounts found. Please create a business profile first.',
      );
    }

    const account = accountsData.accounts[0];
    const accountId = account.name; // e.g. "accounts/123456"

    // List locations for this account
    const locationsData = await this.fetchJson<{
      locations: Array<{
        name: string;
        title: string;
        storefrontAddress?: { locality?: string };
      }>;
    }>(`${API_BASE}/${accountId}/locations?readMask=name,title,storefrontAddress`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!locationsData.locations || locationsData.locations.length === 0) {
      throw new Error(
        'No locations found for this Google Business Profile. Please add a location first.',
      );
    }

    const location = locationsData.locations[0];

    // Business Information API v1 returns "locations/{id}" — prepend account for v4 API compatibility
    const locationName = location.name.startsWith('accounts/')
      ? location.name
      : `${accountId}/${location.name}`;

    return {
      id: locationName, // e.g. "accounts/123/locations/456"
      name: location.title || account.accountName,
      accountType: account.type,
    };
  }

  /**
   * Resolves a full `accounts/{id}/locations/{id}` resource name.
   * Existing channels may store just `locations/{id}` from before the fix.
   */
  private async resolveLocationName(
    storedId: string,
    accessToken: string,
  ): Promise<string> {
    // Already has full path
    if (storedId.startsWith('accounts/')) {
      return storedId;
    }

    // Need to look up the account to build the full path
    this.logger.info(
      { storedId },
      'Resolving full location path from partial ID',
    );

    const accountsData = await this.fetchJson<{
      accounts: Array<{ name: string }>;
    }>(`${ACCOUNTS_API}/accounts`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!accountsData.accounts || accountsData.accounts.length === 0) {
      throw new Error('No Google Business accounts found while resolving location path');
    }

    const accountName = accountsData.accounts[0].name; // e.g. "accounts/123"
    const fullPath = `${accountName}/${storedId}`; // e.g. "accounts/123/locations/456"
    this.logger.info({ fullPath }, 'Resolved full location path');
    return fullPath;
  }

  async publishPost(
    post: PostData,
    channel: ChannelData,
  ): Promise<PublishResult> {
    this.logger.info(
      {
        accountId: channel.accountId,
        hasMedia: post.mediaFiles.length > 0,
        mediaCount: post.mediaFiles.length,
        postType: post.postType,
      },
      'GMB publish started',
    );

    if (!channel.accessToken) {
      return { success: false, error: 'No access token for Google Business account' };
    }

    // Resolve full path — handles existing channels that stored "locations/{id}" without account prefix
    const locationName = await this.resolveLocationName(channel.accountId, channel.accessToken);

    // Determine topic type
    let topicType = 'STANDARD';
    if (post.postType === 'event') {
      topicType = 'EVENT';
    } else if (post.postType === 'offer') {
      topicType = 'OFFER';
    }

    // Build the local post object
    const localPost: Record<string, unknown> = {
      languageCode: 'en',
      summary: post.content,
      topicType: topicType,
    };

    // Add media if present
    if (post.mediaFiles.length > 0) {
      const mediaItems = post.mediaFiles.map((file) => {
        const isVideo = file.mimeType.startsWith('video/');
        return {
          mediaFormat: isVideo ? 'VIDEO' : 'PHOTO',
          sourceUrl: file.url,
        };
      });

      // Also include any mediaUrls that don't have corresponding mediaFiles
      for (const url of post.mediaUrls) {
        const hasFile = post.mediaFiles.some((f) => f.url === url);
        if (!hasFile) {
          mediaItems.push({
            mediaFormat: 'PHOTO',
            sourceUrl: url,
          });
        }
      }

      localPost.media = mediaItems;
    }

    // Add call to action if provided
    const platformSpecific = post.platformSpecific || {};
    const ctaType = (platformSpecific.ctaType) as string | undefined;
    const ctaUrl = (platformSpecific.ctaUrl) as string | undefined;

    if (ctaType) {
      const validCtaTypes = ['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL'];
      if (validCtaTypes.includes(ctaType)) {
        if (ctaType === 'CALL') {
          // CALL uses the business phone number from the listing — no URL needed
          localPost.callToAction = { actionType: 'CALL' };
        } else if (ctaUrl) {
          localPost.callToAction = { actionType: ctaType, url: ctaUrl };
        }
      }
    }

    // Add event details for EVENT and OFFER types (both require event object)
    if (topicType === 'EVENT' || topicType === 'OFFER') {
      const eventTitle = platformSpecific.eventTitle as string | undefined;
      const startDateStr = platformSpecific.startDate as string | undefined;
      const endDateStr = platformSpecific.endDate as string | undefined;
      const startTimeStr = platformSpecific.startTime as string | undefined;
      const endTimeStr = platformSpecific.endTime as string | undefined;

      const event: Record<string, unknown> = {};

      if (eventTitle) {
        event.title = eventTitle;
      }

      const schedule: Record<string, unknown> = {};
      if (startDateStr) {
        schedule.startDate = parseDateString(startDateStr);
      }
      if (endDateStr) {
        schedule.endDate = parseDateString(endDateStr);
      }
      if (startTimeStr) {
        schedule.startTime = parseTimeString(startTimeStr);
      }
      if (endTimeStr) {
        schedule.endTime = parseTimeString(endTimeStr);
      }

      if (Object.keys(schedule).length > 0) {
        event.schedule = schedule;
      }

      if (Object.keys(event).length > 0) {
        localPost.event = event;
      }
    }

    // Add offer details if offer type
    if (topicType === 'OFFER') {
      const offer: Record<string, string> = {};
      const couponCode = platformSpecific.couponCode as string | undefined;
      const redeemOnlineUrl = platformSpecific.redeemOnlineUrl as string | undefined;
      const termsConditions = platformSpecific.termsConditions as string | undefined;

      if (couponCode) offer.couponCode = couponCode;
      if (redeemOnlineUrl) offer.redeemOnlineUrl = redeemOnlineUrl;
      if (termsConditions) offer.termsConditions = termsConditions;

      if (Object.keys(offer).length > 0) {
        localPost.offer = offer;
      }
    }

    const postUrl = `${POST_API_BASE}/${locationName}/localPosts`;
    this.logger.info({ postUrl, locationName }, 'GMB posting to URL');

    try {
      const result = await this.fetchJson<{
        name: string;
        state?: string;
      }>(postUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${channel.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(localPost),
      });

      // Google returns HTTP 200 even for posts it refuses: a content-policy
      // rejection arrives as state=REJECTED, and an empty/unconfirmed body has
      // no resource name. Both must fail the post, not seal a false "published".
      if (result.state === 'REJECTED') {
        this.logger.warn({ topicType }, 'GMB rejected the post (content policy)');
        return {
          success: false,
          error:
            'Google rejected this post (state REJECTED) because it violates Google Business Profile content policy. Edit the content and try again.',
        };
      }

      const postId = result.name; // resource name of the post
      if (!postId) {
        this.logger.warn({ topicType }, 'GMB create returned no localPost name');
        return {
          success: false,
          error:
            'Google did not confirm the post was created (no localPost name in the response). Check the Business Profile before retrying.',
        };
      }

      this.logger.info(
        { postId, topicType },
        'GMB post published successfully',
      );

      return {
        success: true,
        postId: postId,
        // GMB posts don't have a reliable direct URL
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: message }, 'Failed to publish GMB post');
      return { success: false, error: message };
    }
  }

  async refreshToken(refreshTokenValue: string): Promise<TokenData | null> {
    try {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshTokenValue,
        client_id: this.getClientId(),
        client_secret: this.getClientSecret(),
      });

      const tokenData = await this.fetchJson<{
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        token_type: string;
      }>(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      return {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || refreshTokenValue,
        expiresIn: tokenData.expires_in,
      };
    } catch (error) {
      this.logger.error({ error }, 'Failed to refresh GMB token');
      return null;
    }
  }

  async getAccountAnalytics(
    channel: ChannelData,
  ): Promise<{ followers?: number; following?: number; impressions?: number; reach?: number; profileViews?: number; websiteClicks?: number; platformSpecific?: Record<string, number> } | null> {
    if (!channel.accessToken) return null;

    try {
      // Extract locationId — channel.accountId can be "accounts/X/locations/Y" or "locations/Y"
      const parts = channel.accountId.split('/');
      const locIdx = parts.indexOf('locations');
      if (locIdx === -1 || !parts[locIdx + 1]) {
        this.logger.warn({ accountId: channel.accountId }, 'Cannot extract locationId from accountId');
        return null;
      }
      const locationResource = `locations/${parts[locIdx + 1]}`;

      // Fetch daily metrics for yesterday (today's data may be incomplete)
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const y = yesterday.getFullYear();
      const m = yesterday.getMonth() + 1;
      const d = yesterday.getDate();

      const metrics = [
        'WEBSITE_CLICKS',
        'CALL_CLICKS',
        'BUSINESS_DIRECTION_REQUESTS',
        'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
        'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
        // Search impressions are separate enum members from the Maps ones and
        // are usually the majority — summing only Maps silently under-counted.
        'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
        'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
      ];

      const params = new URLSearchParams({
        'dailyRange.startDate.year': String(y),
        'dailyRange.startDate.month': String(m),
        'dailyRange.startDate.day': String(d),
        'dailyRange.endDate.year': String(y),
        'dailyRange.endDate.month': String(m),
        'dailyRange.endDate.day': String(d),
      });
      for (const metric of metrics) {
        params.append('dailyMetrics', metric);
      }

      const PERF_API = 'https://businessprofileperformance.googleapis.com/v1';
      const data = await this.fetchJson<{
        multiDailyMetricTimeSeries?: Array<{
          dailyMetricTimeSeries?: {
            dailyMetric?: string;
            timeSeries?: {
              datedValues?: Array<{ date?: { year: number; month: number; day: number }; value?: string }>;
            };
          };
        }>;
      }>(
        `${PERF_API}/${locationResource}:fetchMultiDailyMetricsTimeSeries?${params}`,
        { headers: { Authorization: `Bearer ${channel.accessToken}` } },
      );

      const metricValues: Record<string, number> = {};
      for (const entry of data.multiDailyMetricTimeSeries ?? []) {
        const name = entry.dailyMetricTimeSeries?.dailyMetric;
        const values = entry.dailyMetricTimeSeries?.timeSeries?.datedValues ?? [];
        if (name && values.length > 0) {
          metricValues[name] = parseInt(values[0].value ?? '0', 10) || 0;
        }
      }

      const desktopViews = metricValues['BUSINESS_IMPRESSIONS_DESKTOP_MAPS'] ?? 0;
      const mobileViews = metricValues['BUSINESS_IMPRESSIONS_MOBILE_MAPS'] ?? 0;
      const desktopSearchViews = metricValues['BUSINESS_IMPRESSIONS_DESKTOP_SEARCH'] ?? 0;
      const mobileSearchViews = metricValues['BUSINESS_IMPRESSIONS_MOBILE_SEARCH'] ?? 0;

      return {
        impressions: desktopViews + mobileViews + desktopSearchViews + mobileSearchViews,
        websiteClicks: metricValues['WEBSITE_CLICKS'] ?? 0,
        platformSpecific: {
          callClicks: metricValues['CALL_CLICKS'] ?? 0,
          directionRequests: metricValues['BUSINESS_DIRECTION_REQUESTS'] ?? 0,
          desktopMapViews: desktopViews,
          mobileMapViews: mobileViews,
          desktopSearchViews,
          mobileSearchViews,
        },
      };
    } catch (error) {
      this.logger.warn({ error }, 'Failed to fetch GMB account analytics');
      return null;
    }
  }

  /**
   * Fetches all locations for the authenticated Google Business Profile account.
   */
  async getLocations(
    accessToken: string,
  ): Promise<Array<{ name: string; title: string; address?: string }>> {
    // First get the accounts
    const accountsData = await this.fetchJson<{
      accounts: Array<{ name: string; accountName: string }>;
    }>(`${ACCOUNTS_API}/accounts`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!accountsData.accounts || accountsData.accounts.length === 0) {
      return [];
    }

    const locations: Array<{ name: string; title: string; address?: string }> = [];

    for (const account of accountsData.accounts) {
      try {
        const locationsData = await this.fetchJson<{
          locations: Array<{
            name: string;
            title: string;
            storefrontAddress?: {
              addressLines?: string[];
              locality?: string;
              administrativeArea?: string;
            };
          }>;
        }>(`${API_BASE}/${account.name}/locations?readMask=name,title,storefrontAddress`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        if (locationsData.locations) {
          for (const loc of locationsData.locations) {
            const addrParts: string[] = [];
            if (loc.storefrontAddress?.addressLines) {
              addrParts.push(...loc.storefrontAddress.addressLines);
            }
            if (loc.storefrontAddress?.locality) {
              addrParts.push(loc.storefrontAddress.locality);
            }
            if (loc.storefrontAddress?.administrativeArea) {
              addrParts.push(loc.storefrontAddress.administrativeArea);
            }

            locations.push({
              name: loc.name,
              title: loc.title,
              address: addrParts.length > 0 ? addrParts.join(', ') : undefined,
            });
          }
        }
      } catch (error) {
        this.logger.warn(
          { account: account.name, error },
          'Failed to fetch locations for account',
        );
      }
    }

    return locations;
  }

  /**
   * Google Business Profile local posts have no comment surface at all — the
   * reviews API is attached to the LOCATION, not to a post, so surfacing it
   * here would attribute unrelated reviews to whichever post was selected.
   */
  async getPostEngagement(): Promise<EngagementData> {
    // `unsupported` keeps the UI from rendering an empty panel for it.
    return { comments: [], reactions: [], unsupported: true, notice: 'Google Business posts have no comments.' };
  }
}
