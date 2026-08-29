import fs from 'fs';
import sharp from 'sharp';
import { ssrfSafeFetch, validateHostname } from '../security/url-guard';
import imageToPDF from 'image-to-pdf';
import { PlatformHandler } from './base';
import type {
  TokenData,
  AccountInfo,
  PublishResult,
  PostData,
  ChannelData,
  PlatformConfig,
  MetricsData,
  EngagementData,
  EngagementActor,
} from './types';

const OAUTH_BASE = 'https://www.linkedin.com/oauth/v2';
const API_BASE = 'https://api.linkedin.com';

// LinkedIn Marketing versions are dated YYYYMM and supported for a MINIMUM of
// one year, after which requests carrying them are rejected outright ("version
// header is deprecated"). 202601 is therefore good until roughly 2027-01 —
// bump it before then or every LinkedIn call in this file starts failing at
// once. Latest available at the time of writing: 202607.
const LINKEDIN_VERSION = '202601';
const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB per chunk for video uploads

// Scopes for the personal "Share on LinkedIn" + "Sign In with OpenID Connect" app (App A).
const PERSONAL_SCOPES = 'openid profile email w_member_social';

// Scopes for the separate Community Management API app (App B). LinkedIn forces the
// Community Management product to be the ONLY product on its application, so org posting
// uses its own client credentials and its own OAuth round-trip — see getPageOAuthUrl.
const PAGE_SCOPES = 'r_organization_social w_organization_social rw_organization_admin';

const config: PlatformConfig = {
  name: 'linkedin',
  displayName: 'LinkedIn',
  icon: 'linkedin',
  color: '#0A66C2',
  authType: 'oauth',
  postTypes: [
    {
      value: 'post',
      label: 'Post',
      description: 'Text, image, or video post',
    },
    {
      value: 'multi_image',
      label: 'Gallery',
      description: 'Multi-image post (up to 20 images)',
      mediaRequired: true,
      minMedia: 2,
      maxMedia: 20,
      allowedMediaTypes: ['image'],
    },
    {
      value: 'pdf_carousel',
      label: 'PDF Carousel',
      description: 'Swipeable carousel from images (converted to PDF)',
      mediaRequired: true,
      minMedia: 2,
      maxMedia: 20,
      allowedMediaTypes: ['image'],
    },
    {
      value: 'article',
      label: 'Article',
      description: 'Share a link with preview',
    },
  ],
  mediaRules: {
    image: {
      maxSizeMB: 10,
      formats: ['jpg', 'jpeg', 'png', 'gif'],
      maxCount: 20,
    },
    video: {
      maxSizeMB: 500,
      formats: ['mp4'],
      maxCount: 1,
      minDurationSec: 3,
      maxDurationSec: 1800,
    },
  },
};

/** Standard headers required by LinkedIn REST API */
function restHeaders(accessToken: string, contentType = 'application/json'): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': contentType,
    'X-Restli-Protocol-Version': '2.0.0',
    'LinkedIn-Version': LINKEDIN_VERSION,
  };
}

export class LinkedInHandler extends PlatformHandler {
  constructor() {
    super(config);
  }

  private getClientId(): string {
    const v = process.env.LINKEDIN_CLIENT_ID;
    if (!v) throw new Error('LINKEDIN_CLIENT_ID not configured');
    return v;
  }

  private getClientSecret(): string {
    const v = process.env.LINKEDIN_CLIENT_SECRET;
    if (!v) throw new Error('LINKEDIN_CLIENT_SECRET not configured');
    return v;
  }

  /** Credentials for the Community Management API app (App B) used for company pages. */
  private getPagesClientId(): string {
    const v = process.env.LINKEDIN_PAGES_CLIENT_ID;
    if (!v) throw new Error('LINKEDIN_PAGES_CLIENT_ID not configured');
    return v;
  }

  private getPagesClientSecret(): string {
    const v = process.env.LINKEDIN_PAGES_CLIENT_SECRET;
    if (!v) throw new Error('LINKEDIN_PAGES_CLIENT_SECRET not configured');
    return v;
  }

  /* ------------------------------------------------------------------ */
  /*  OAuth                                                              */
  /* ------------------------------------------------------------------ */

  async getOAuthUrl(redirectUri: string, state: string): Promise<string> {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.getClientId(),
      redirect_uri: redirectUri,
      state,
      scope: PERSONAL_SCOPES,
    });
    return `${OAUTH_BASE}/authorization?${params.toString()}`;
  }

  /**
   * OAuth URL for connecting a company page. Uses the Community Management API app
   * (App B) credentials and organization scopes — a fully separate consent flow from
   * the personal one because LinkedIn keeps the two products on different applications.
   */
  async getPageOAuthUrl(redirectUri: string, state: string): Promise<string> {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.getPagesClientId(),
      redirect_uri: redirectUri,
      state,
      scope: PAGE_SCOPES,
    });
    return `${OAUTH_BASE}/authorization?${params.toString()}`;
  }

  async exchangeCodeForToken(code: string, redirectUri: string): Promise<TokenData> {
    return this.exchangeCode(code, redirectUri, this.getClientId(), this.getClientSecret());
  }

  /** Exchange the page OAuth code using the Community Management app (App B) credentials. */
  async exchangePageCodeForToken(code: string, redirectUri: string): Promise<TokenData> {
    return this.exchangeCode(code, redirectUri, this.getPagesClientId(), this.getPagesClientSecret());
  }

  private async exchangeCode(
    code: string,
    redirectUri: string,
    clientId: string,
    clientSecret: string,
  ): Promise<TokenData> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    });

    const data = await this.fetchJson<{
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      refresh_token_expires_in?: number;
    }>(`${OAUTH_BASE}/accessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }

  /**
   * Refresh a LinkedIn token. Organization channels were issued by the Community
   * Management app (App B), so they must refresh against App B's credentials;
   * personal channels use App A. The refresh token is only valid for the app that
   * issued it, so using the wrong client_id/secret silently fails.
   */
  async refreshToken(refreshTokenValue: string, accountType?: string): Promise<TokenData | null> {
    const isOrg = accountType === 'organization';
    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshTokenValue,
        client_id: isOrg ? this.getPagesClientId() : this.getClientId(),
        client_secret: isOrg ? this.getPagesClientSecret() : this.getClientSecret(),
      });

      const data = await this.fetchJson<{
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
      }>(`${OAUTH_BASE}/accessToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshTokenValue,
        expiresIn: data.expires_in,
      };
    } catch (error) {
      this.logger.error({ error, isOrg }, 'Failed to refresh LinkedIn token');
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Account info                                                       */
  /* ------------------------------------------------------------------ */

  async getAccountInfo(accessToken: string): Promise<AccountInfo> {
    const data = await this.fetchJson<{
      sub: string;
      name?: string;
      given_name?: string;
      family_name?: string;
      picture?: string;
    }>(`${API_BASE}/v2/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const name = data.name || [data.given_name, data.family_name].filter(Boolean).join(' ') || 'LinkedIn User';

    return {
      id: data.sub,
      name,
      profileImage: data.picture,
      accountType: 'personal',
    };
  }

  /**
   * List LinkedIn organizations the user is an admin of.
   * Called from /api/platforms/linkedin/organizations endpoint.
   */
  async getAdminOrganizations(
    accessToken: string,
  ): Promise<Array<{ id: string; name: string; logoUrl?: string }>> {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': LINKEDIN_VERSION,
    };

    // Step 1: list the org URNs the member administers. We deliberately do NOT
    // request projection decoration here: it's best-effort and LinkedIn drops it
    // under repeated/rapid calls, which previously caused the whole list to come
    // back empty (every element was filtered out for lacking the `~` expansion).
    // The `organizationalTarget` URN is part of the core element, so it's reliable.
    //
    // No `role=` filter: LinkedIn grants posting rights to CONTENT_ADMINISTRATOR
    // as well as ADMINISTRATOR, and a role query param can only name one. Filter
    // client-side on both, and only APPROVED grants (pending/revoked ACLs also
    // come back without a state filter).
    const POSTING_ROLES = new Set(['ADMINISTRATOR', 'CONTENT_ADMINISTRATOR']);
    const aclData = await this.fetchJson<{
      elements?: Array<{ organizationalTarget?: string; role?: string; state?: string }>;
    }>(
      `${API_BASE}/v2/organizationalEntityAcls?q=roleAssignee&state=APPROVED&count=100`,
      { headers },
    );

    const ids = (aclData.elements || [])
      .filter((e) => !e.role || POSTING_ROLES.has(e.role))
      .filter((e) => !e.state || e.state === 'APPROVED')
      .map((e) => e.organizationalTarget?.split(':').pop())
      .filter((x): x is string => !!x);

    this.logger.info(
      { aclElements: aclData.elements?.length ?? 0, orgIds: ids.length },
      'LinkedIn admin organizations',
    );

    if (ids.length === 0) return [];

    // Step 2: enrich with name + logo via a batch GET. Best-effort — if it fails
    // or omits some orgs, those still appear (with a fallback name) because we map
    // over the reliable id list from step 1.
    let results: Record<string, {
      localizedName?: string;
      logoV2?: { 'original~'?: { elements?: Array<{ identifiers?: Array<{ identifier: string }> }> } };
    }> = {};
    try {
      // Rest.li batch keys must use RAW commas inside List(...). URL-encoding them
      // (%2C) makes LinkedIn parse the whole string as one key → 400
      // "NumberFormatException". Org IDs are numeric, so the raw URL is safe.
      const idsList = `List(${ids.join(',')})`;
      const orgsData = await this.fetchJson<{
        results?: typeof results;
      }>(
        `${API_BASE}/v2/organizations?ids=${idsList}&projection=(results*(localizedName,vanityName,logoV2(original~:playableStreams)))`,
        { headers },
      );
      results = orgsData.results || {};
    } catch (error) {
      this.logger.warn({ error }, 'LinkedIn org detail fetch failed; returning ids with fallback names');
    }

    return ids.map((id) => {
      const org = results[id] || {};
      const logo =
        org.logoV2?.['original~']?.elements?.[0]?.identifiers?.[0]?.identifier;
      return {
        id,
        name: org.localizedName || `Organization ${id}`,
        logoUrl: logo,
      };
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Metrics                                                            */
  /* ------------------------------------------------------------------ */

  async getPostMetrics(
    channel: ChannelData,
    platformPostIds: string[],
  ): Promise<Map<string, MetricsData>> {
    const results = new Map<string, MetricsData>();
    if (!channel.accessToken || platformPostIds.length === 0) return results;

    // Share statistics are only available for ORGANIZATION posts — this finder
    // 400s for personal member shares. (Personal post analytics DO exist since
    // mid-2025 via the Member Post Analytics API — memberCreatorPostAnalytics,
    // scope r_member_postAnalytics — but it is approval-gated and reads one
    // metric per call; we don't hold the scope, so personal channels stay
    // unmeasured for now. See metrics-support.ts.) Skip personal channels cleanly.
    if (channel.accountType !== 'organization') return results;

    const orgUrn = `urn:li:organization:${channel.accountId}`;
    const encodedOrg = encodeURIComponent(orgUrn);

    // The finder requires the organizationalEntity (org URN) AND a filter list of
    // the posts to report on. Posts created via /rest/posts are urn:li:share:…;
    // older/reshared content can be urn:li:ugcPost:… — each goes in its own param.
    const shareUrns = platformPostIds.filter((u) => u.includes(':share:'));
    const ugcUrns = platformPostIds.filter((u) => u.includes(':ugcPost:'));

    type ShareStat = {
      share?: string;
      ugcPost?: string;
      totalShareStatistics?: {
        impressionCount?: number;
        uniqueImpressionsCount?: number;
        clickCount?: number;
        likeCount?: number;
        commentCount?: number;
        shareCount?: number;
        engagement?: number;
      };
    };

    const ingest = (el: ShareStat) => {
      const urn = el.share || el.ugcPost;
      const s = el.totalShareStatistics;
      if (!urn || !s) return;
      const totalEngagements = (s.likeCount ?? 0) + (s.commentCount ?? 0) + (s.shareCount ?? 0) + (s.clickCount ?? 0);
      const engagementRate = s.impressionCount && s.impressionCount > 0
        ? Math.round((totalEngagements / s.impressionCount) * 10000)
        : 0;
      results.set(urn, {
        impressions: s.impressionCount ?? 0,
        reach: s.uniqueImpressionsCount ?? 0,
        clicks: s.clickCount ?? 0,
        likes: s.likeCount ?? 0,
        comments: s.commentCount ?? 0,
        shares: s.shareCount ?? 0,
        extra: {
          uniqueImpressions: s.uniqueImpressionsCount ?? 0,
          engagementRate,
        },
      });
    };

    // LinkedIn caps the List() filter, so chunk to be safe. One call per type.
    const fetchBatch = async (urns: string[], param: 'shares' | 'ugcPosts') => {
      for (let i = 0; i < urns.length; i += 20) {
        const chunk = urns.slice(i, i + 20);
        // LinkedIn's own docs are inconsistent about how a multi-value filter is
        // encoded here: `shares` is shown as Restli-2.0 `List(...)`, but the
        // `ugcPosts` example uses indexed `ugcPosts[0]=…&ugcPosts[1]=…` while
        // still sending the 2.0 header. A wrong encoding is a 400, and this call
        // is already wrapped in a catch — i.e. it would fail silently and older
        // reshared content would just never report. Try List() first, then fall
        // back to the indexed form rather than assuming either is correct.
        const listForm = `${param}=List(${chunk.map((u) => encodeURIComponent(u)).join(',')})`;
        const indexedForm = chunk
          .map((u, idx) => `${param}[${idx}]=${encodeURIComponent(u)}`)
          .join('&');
        const forms = param === 'ugcPosts' ? [listForm, indexedForm] : [listForm];

        try {
          let data: { elements?: ShareStat[]; totalShareStatistics?: ShareStat['totalShareStatistics'] } | null = null;
          let lastError: unknown = null;
          for (const form of forms) {
            try {
              data = await this.fetchJson<{ elements?: ShareStat[]; totalShareStatistics?: ShareStat['totalShareStatistics'] }>(
                `${API_BASE}/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodedOrg}&${form}`,
                { headers: restHeaders(channel.accessToken) },
                // Only the last form's failure is worth surfacing.
                { quiet: form !== forms[forms.length - 1] },
              );
              break;
            } catch (e) {
              lastError = e;
            }
          }
          if (!data) throw lastError;
          // Per-post filter responses come back under elements[]; each carries its
          // own share/ugcPost URN so we can map it back to the right post.
          if (Array.isArray(data.elements)) {
            for (const el of data.elements) ingest(el);
          }
        } catch (error) {
          this.logger.warn({ error, param, chunk }, 'Failed to fetch LinkedIn metrics batch');
        }
      }
    };

    if (shareUrns.length) await fetchBatch(shareUrns, 'shares');
    if (ugcUrns.length) await fetchBatch(ugcUrns, 'ugcPosts');

    return results;
  }

  /* ------------------------------------------------------------------ */
  /*  Account analytics                                                  */
  /* ------------------------------------------------------------------ */

  async getAccountAnalytics(
    channel: ChannelData,
  ): Promise<{ followers?: number; following?: number; impressions?: number; reach?: number; profileViews?: number; websiteClicks?: number; platformSpecific?: Record<string, number> } | null> {
    if (!channel.accessToken) return null;

    // Only organization accounts have follower statistics via the REST API
    if (channel.accountType !== 'organization') return null;

    try {
      const orgUrn = `urn:li:organization:${channel.accountId}`;
      const encodedUrn = encodeURIComponent(orgUrn);

      const data = await this.fetchJson<{
        elements?: Array<{
          followerCounts?: {
            organicFollowerCount?: number;
            paidFollowerCount?: number;
          };
        }>;
      }>(
        `${API_BASE}/rest/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${encodedUrn}`,
        { headers: restHeaders(channel.accessToken) },
      );

      const el = data.elements?.[0];
      if (!el?.followerCounts) return null;

      const organic = el.followerCounts.organicFollowerCount ?? 0;
      const paid = el.followerCounts.paidFollowerCount ?? 0;

      return {
        followers: organic + paid,
        platformSpecific: {
          organicFollowers: organic,
          paidFollowers: paid,
        },
      };
    } catch (error) {
      this.logger.warn({ error }, 'Failed to fetch LinkedIn account analytics');
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Engagement (commenters + reactors)                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Pull individual commenters and reactors for a post — the data LinkedIn's
   * Page Management review needs (who interacted, what their profile shows).
   *
   * Reads `/rest/socialActions/{shareUrn}/comments` and `/likes` with the
   * `r_organization_social` scope. Actor URNs are resolved best-effort to
   * a display name + photo via the comment's embedded fields and a follow-up
   * lookup; if the lookup is denied, we still surface the comment with a
   * generic "LinkedIn Member" label so the admin sees the engagement.
   */
  async getPostEngagement(
    channel: ChannelData,
    platformPostId: string,
    opts?: { commentsLimit?: number; reactionsLimit?: number },
  ): Promise<EngagementData> {
    if (!channel.accessToken) {
      return { comments: [], reactions: [], notice: 'No access token', commentsNotice: 'No access token' };
    }

    const commentsLimit = Math.min(opts?.commentsLimit ?? 25, 100);
    const reactionsLimit = Math.min(opts?.reactionsLimit ?? 25, 100);
    const headers = restHeaders(channel.accessToken);
    const encodedUrn = encodeURIComponent(platformPostId);

    const profileCache = new Map<string, EngagementActor>();
    const resolveActor = async (actorUrn: string): Promise<EngagementActor> => {
      const cached = profileCache.get(actorUrn);
      if (cached) return cached;
      const resolved = await this.resolveLinkedInActor(actorUrn, channel.accessToken).catch(() => null);
      const fallback: EngagementActor = {
        id: actorUrn,
        name: actorUrn.startsWith('urn:li:organization')
          ? 'LinkedIn Page'
          : 'LinkedIn Member',
      };
      const actor = resolved ?? fallback;
      profileCache.set(actorUrn, actor);
      return actor;
    };

    const result: EngagementData = { comments: [], reactions: [] };

    // ---- Comments ----
    type LinkedInComment = {
      id?: string;
      $URN?: string;
      actor?: string;
      message?: { text?: string };
      created?: { time?: number };
      likesSummary?: { totalLikes?: number };
    };
    type CommentsResponse = {
      elements?: LinkedInComment[];
      paging?: { total?: number; count?: number; start?: number };
    };

    try {
      const data = await this.fetchJson<CommentsResponse>(
        `${API_BASE}/rest/socialActions/${encodedUrn}/comments?count=${commentsLimit}`,
        { headers },
      );

      const elements = data.elements ?? [];
      const push = async (el: LinkedInComment, parentId?: string) => {
        const actorUrn = el.actor;
        if (!actorUrn || !el.message?.text) return;
        const actor = await resolveActor(actorUrn);
        result.comments.push({
          id: el.$URN ?? el.id ?? `${actorUrn}:${el.created?.time ?? Date.now()}`,
          text: el.message.text,
          createdAt: el.created?.time ? new Date(el.created.time).toISOString() : undefined,
          likeCount: el.likesSummary?.totalLikes,
          parentId,
          actor,
        });
      };

      // Each reply lookup is its own LinkedIn call, and this endpoint is hit
      // once per channel every time a post is selected in the analytics pane.
      // Cap the fan-out so a 25-comment post can't cost 25 extra calls; the
      // remaining threads are covered by hasMoreComments.
      const REPLY_FETCH_MAX = 10;
      let replyFetches = 0;

      let truncated = false;
      for (const el of elements) {
        if (result.comments.length >= commentsLimit) { truncated = true; break; }
        await push(el);

        // /socialActions/{postUrn}/comments returns TOP-LEVEL comments only —
        // replies live under the comment's own socialActions entity. Without
        // this second hop a reply thread rendered as its first message alone,
        // exactly like the Facebook `filter=toplevel` default did. A comment's
        // canonical id is `$URN`; `id` is only the numeric suffix on some
        // API versions, which is not addressable.
        const commentUrn = el.$URN;
        if (!commentUrn || result.comments.length >= commentsLimit) continue;
        if (replyFetches >= REPLY_FETCH_MAX) { truncated = true; continue; }
        replyFetches++;
        try {
          const replies = await this.fetchJson<CommentsResponse>(
            `${API_BASE}/rest/socialActions/${encodeURIComponent(commentUrn)}/comments?count=${commentsLimit - result.comments.length}`,
            { headers },
            { quiet: true }, // a comment with no replies / restricted thread 404s — expected
          );
          for (const reply of replies.elements ?? []) {
            if (result.comments.length >= commentsLimit) { truncated = true; break; }
            await push(reply, commentUrn);
          }
        } catch {
          // Replies unavailable for this comment — the top-level comment still shows.
        }
      }
      const total = data.paging?.total ?? elements.length;
      result.hasMoreComments = truncated || total > elements.length;
    } catch (error) {
      this.logger.warn({ error, platformPostId }, 'LinkedIn comments fetch failed');
      const commentsMsg = 'Comments unavailable (scope or post visibility may have changed)';
      result.commentsNotice = commentsMsg;
      result.notice = result.notice ? `${result.notice}; comments unavailable` : commentsMsg;
    }

    // ---- Reactions (likes) ----
    try {
      const data = await this.fetchJson<{
        elements?: Array<{
          id?: string;
          actor?: string;
          reactionType?: string;
          created?: { time?: number };
        }>;
        paging?: { total?: number };
      }>(
        `${API_BASE}/rest/reactions?q=entity&entity=${encodedUrn}&count=${reactionsLimit}`,
        { headers },
      );

      const elements = data.elements ?? [];
      for (const el of elements) {
        const actorUrn = el.actor;
        if (!actorUrn) continue;
        const actor = await resolveActor(actorUrn);
        result.reactions.push({
          id: el.id ?? `${actorUrn}:reaction`,
          type: el.reactionType,
          createdAt: el.created?.time ? new Date(el.created.time).toISOString() : undefined,
          actor,
        });
      }
      const total = data.paging?.total ?? elements.length;
      result.hasMoreReactions = total > elements.length;
    } catch (error) {
      this.logger.warn({ error, platformPostId }, 'LinkedIn reactions fetch failed');
      result.notice = result.notice
        ? `${result.notice}; reactions unavailable`
        : 'Reactions unavailable (scope or post visibility may have changed)';
    }

    return result;
  }

  /**
   * Best-effort actor → profile resolution. Personal URNs use /userinfo or
   * /people/{id}; organization URNs use /organizations/{id}. Failures return
   * null and the caller falls back to a generic label.
   */
  private async resolveLinkedInActor(
    actorUrn: string,
    accessToken: string,
  ): Promise<EngagementActor | null> {
    const id = actorUrn.split(':').pop();
    if (!id) return null;
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': LINKEDIN_VERSION,
    };

    if (actorUrn.startsWith('urn:li:organization')) {
      try {
        const data = await this.fetchJson<{
          localizedName?: string;
          vanityName?: string;
          logoV2?: { 'original~'?: { elements?: Array<{ identifiers?: Array<{ identifier: string }> }> } };
        }>(`${API_BASE}/v2/organizations/${id}`, { headers });
        return {
          id: actorUrn,
          name: data.localizedName || `Organization ${id}`,
          handle: data.vanityName,
          profileImage: data.logoV2?.['original~']?.elements?.[0]?.identifiers?.[0]?.identifier,
          profileUrl: data.vanityName
            ? `https://www.linkedin.com/company/${data.vanityName}`
            : `https://www.linkedin.com/company/${id}`,
        };
      } catch {
        return null;
      }
    }

    // Personal member URN — best-effort via /v2/people/(id:...)
    try {
      const data = await this.fetchJson<{
        localizedFirstName?: string;
        localizedLastName?: string;
        localizedHeadline?: string;
        vanityName?: string;
        profilePicture?: { 'displayImage~'?: { elements?: Array<{ identifiers?: Array<{ identifier: string }> }> } };
      }>(`${API_BASE}/v2/people/(id:${id})`, { headers });
      const name =
        [data.localizedFirstName, data.localizedLastName].filter(Boolean).join(' ') ||
        'LinkedIn Member';
      const photo = data.profilePicture?.['displayImage~']?.elements?.[0]?.identifiers?.[0]?.identifier;
      return {
        id: actorUrn,
        name,
        handle: data.vanityName,
        headline: data.localizedHeadline,
        profileImage: photo,
        profileUrl: data.vanityName
          ? `https://www.linkedin.com/in/${data.vanityName}`
          : `https://www.linkedin.com/in/${id}`,
      };
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Publishing                                                         */
  /* ------------------------------------------------------------------ */

  async publishPost(post: PostData, channel: ChannelData): Promise<PublishResult> {
    const accessToken = channel.accessToken;
    if (!accessToken) {
      return { success: false, error: 'No access token for LinkedIn account' };
    }

    // Determine author URN from channel metadata or construct from accountId
    const meta = (channel.metadata ?? {}) as Record<string, unknown>;
    const authorUrn =
      (meta.authorUrn as string) ||
      (channel.accountType === 'organization'
        ? `urn:li:organization:${channel.accountId}`
        : `urn:li:person:${channel.accountId}`);

    this.logger.info(
      {
        accountId: channel.accountId,
        accountType: channel.accountType,
        postType: post.postType,
        mediaCount: post.mediaFiles.length,
      },
      'LinkedIn publish started',
    );

    try {
      const images = post.mediaFiles.filter((f) => f.mimeType.startsWith('image/'));
      const videos = post.mediaFiles.filter((f) => f.mimeType.startsWith('video/'));

      // Article post
      if (post.postType === 'article') {
        return this.publishArticle(post, accessToken, authorUrn);
      }

      // PDF carousel
      if (post.postType === 'pdf_carousel' && images.length >= 2) {
        return this.publishPdfCarousel(post, accessToken, authorUrn, images);
      }

      // Video post
      if (videos.length > 0) {
        return this.publishVideo(post, accessToken, authorUrn, videos[0]);
      }

      // Multi-image post
      if (images.length >= 2) {
        return this.publishMultiImage(post, accessToken, authorUrn, images);
      }

      // Single image post
      if (images.length === 1) {
        return this.publishSingleImage(post, accessToken, authorUrn, images[0]);
      }

      // Text-only post
      return this.publishText(post, accessToken, authorUrn);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: message }, 'LinkedIn publish failed');
      return { success: false, error: message };
    }
  }

  /* ---- Text ---- */

  private async publishText(
    post: PostData,
    accessToken: string,
    authorUrn: string,
  ): Promise<PublishResult> {
    // LinkedIn's Posts API does NOT scrape URLs — a link card only appears if
    // the caller supplies content.article. When the post is text-only and the
    // worker attached an unfurled linkPreview (first URL, no media), build the
    // article card so the published post matches the Composer preview. Without
    // a title the card would render broken, so fall back to plain text then.
    const lp = post.linkPreview;
    let articleContent: Record<string, unknown> | undefined;
    if (lp?.url && lp.title) {
      let thumbnailUrn: string | undefined;
      if (lp.image) {
        try {
          thumbnailUrn = await this.uploadImageFromUrl(accessToken, authorUrn, lp.image);
        } catch (err) {
          this.logger.warn(
            { error: err instanceof Error ? err.message : String(err) },
            'LinkedIn article thumbnail upload failed; posting card without thumbnail',
          );
        }
      }
      articleContent = {
        article: {
          source: lp.url,
          title: lp.title,
          ...(lp.description ? { description: lp.description } : {}),
          ...(thumbnailUrn ? { thumbnail: thumbnailUrn } : {}),
        },
      };
    }

    return this.createPost(accessToken, {
      author: authorUrn,
      commentary: post.content,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      ...(articleContent ? { content: articleContent } : {}),
    });
  }

  /* ---- Single image ---- */

  private async publishSingleImage(
    post: PostData,
    accessToken: string,
    authorUrn: string,
    image: PostData['mediaFiles'][0],
  ): Promise<PublishResult> {
    const imageUrn = await this.uploadImage(accessToken, authorUrn, image);

    return this.createPost(accessToken, {
      author: authorUrn,
      commentary: post.content,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      content: {
        media: { id: imageUrn, altText: '' },
      },
    });
  }

  /* ---- Multi-image ---- */

  private async publishMultiImage(
    post: PostData,
    accessToken: string,
    authorUrn: string,
    images: PostData['mediaFiles'],
  ): Promise<PublishResult> {
    // Upload all images (sequentially to avoid rate limits)
    const imageUrns: string[] = [];
    for (const img of images) {
      const urn = await this.uploadImage(accessToken, authorUrn, img);
      imageUrns.push(urn);
    }

    return this.createPost(accessToken, {
      author: authorUrn,
      commentary: post.content,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      content: {
        multiImage: { images: imageUrns.map((id) => ({ id, altText: '' })) },
      },
    });
  }

  /* ---- Video ---- */

  private async publishVideo(
    post: PostData,
    accessToken: string,
    authorUrn: string,
    video: PostData['mediaFiles'][0],
  ): Promise<PublishResult> {
    const videoUrn = await this.uploadVideo(accessToken, authorUrn, video);

    const ytOptions = (post.platformSpecific ?? {}) as Record<string, unknown>;
    const title = typeof ytOptions.title === 'string' ? ytOptions.title : undefined;

    return this.createPost(accessToken, {
      author: authorUrn,
      commentary: post.content,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      content: {
        media: { id: videoUrn, ...(title ? { title } : {}) },
      },
    });
  }

  /* ---- Article ---- */

  private async publishArticle(
    post: PostData,
    accessToken: string,
    authorUrn: string,
  ): Promise<PublishResult> {
    const opts = (post.platformSpecific ?? {}) as Record<string, unknown>;
    const articleUrl = (opts.url as string) || '';
    const articleTitle = (opts.title as string) || '';
    const articleDesc = (opts.description as string) || '';

    if (!articleUrl) {
      return { success: false, error: 'Article URL is required for LinkedIn article posts' };
    }

    // Upload thumbnail if an image is provided
    let thumbnailUrn: string | undefined;
    const image = post.mediaFiles.find((f) => f.mimeType.startsWith('image/'));
    if (image) {
      thumbnailUrn = await this.uploadImage(accessToken, authorUrn, image);
    }

    return this.createPost(accessToken, {
      author: authorUrn,
      commentary: post.content,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      content: {
        article: {
          source: articleUrl,
          title: articleTitle,
          description: articleDesc,
          ...(thumbnailUrn ? { thumbnail: thumbnailUrn } : {}),
        },
      },
    });
  }

  /* ---- PDF Carousel ---- */

  private async publishPdfCarousel(
    post: PostData,
    accessToken: string,
    authorUrn: string,
    images: PostData['mediaFiles'],
  ): Promise<PublishResult> {
    // Convert images to a single PDF
    const pdfBuffer = await this.convertImagesToPdf(images);

    // Upload the PDF as a LinkedIn document
    const documentUrn = await this.uploadDocument(accessToken, authorUrn, pdfBuffer);

    const title = (post.platformSpecific?.carouselTitle as string) || 'Carousel';

    return this.createPost(accessToken, {
      author: authorUrn,
      commentary: post.content,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      content: {
        media: { id: documentUrn, title },
      },
    });
  }

  private async convertImagesToPdf(
    images: PostData['mediaFiles'],
  ): Promise<Buffer> {
    // Read and normalize all images to JPEG via sharp
    const processed: Array<{ buffer: Buffer; width: number; height: number }> = [];

    for (const img of images) {
      // sharp reads from the path itself — no need to hold the raw file in
      // heap alongside the processed JPEG (the carousel can be 20 images).
      const sharpImg = sharp(img.localPath, { animated: false }).jpeg();
      const metadata = await sharpImg.metadata();
      const buffer = await sharpImg.toBuffer();
      processed.push({
        buffer,
        width: metadata.width || 1080,
        height: metadata.height || 1080,
      });
    }

    // Use the largest image dimensions as the PDF page size
    const largest = processed.reduce((max, img) =>
      img.width * img.height > max.width * max.height ? img : max,
    );

    const imageBuffers = processed.map((p) => p.buffer);
    const pdfStream = imageToPDF(imageBuffers, [largest.width, largest.height]);

    // Collect stream into a buffer
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      pdfStream.on('data', (chunk: Buffer) => chunks.push(chunk));
      pdfStream.on('end', () => resolve(Buffer.concat(chunks)));
      pdfStream.on('error', reject);
    });
  }

  private async uploadDocument(
    accessToken: string,
    ownerUrn: string,
    pdfBuffer: Buffer,
  ): Promise<string> {
    // Step 1: Initialize document upload
    const initData = await this.fetchJson<{
      value: {
        uploadUrl: string;
        document: string; // document URN
      };
    }>(`${API_BASE}/rest/documents?action=initializeUpload`, {
      method: 'POST',
      headers: restHeaders(accessToken),
      body: JSON.stringify({
        initializeUploadRequest: { owner: ownerUrn },
      }),
    });

    const { uploadUrl, document: documentUrn } = initData.value;

    // Step 2: Upload PDF binary
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/pdf',
      },
      body: new Uint8Array(pdfBuffer),
    });

    if (!uploadResponse.ok) {
      const errText = await uploadResponse.text();
      throw new Error(`LinkedIn document upload failed (${uploadResponse.status}): ${errText}`);
    }

    this.logger.info({ documentUrn, sizeBytes: pdfBuffer.length }, 'LinkedIn PDF document uploaded');
    return documentUrn;
  }

  /* ------------------------------------------------------------------ */
  /*  Image upload                                                       */
  /* ------------------------------------------------------------------ */

  private async uploadImage(
    accessToken: string,
    ownerUrn: string,
    image: PostData['mediaFiles'][0],
  ): Promise<string> {
    // Step 1: Initialize upload
    const initData = await this.fetchJson<{
      value: {
        uploadUrl: string;
        image: string; // image URN
      };
    }>(`${API_BASE}/rest/images?action=initializeUpload`, {
      method: 'POST',
      headers: restHeaders(accessToken),
      body: JSON.stringify({
        initializeUploadRequest: { owner: ownerUrn },
      }),
    });

    const { uploadUrl, image: imageUrn } = initData.value;

    // Step 2: Upload binary
    if (!fs.existsSync(image.localPath)) {
      throw new Error(`Image file not found: ${image.localPath}`);
    }
    const fileBuffer = fs.readFileSync(image.localPath);
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/octet-stream',
      },
      // Zero-copy view — new Uint8Array(buffer) would duplicate the whole file.
      body: new Uint8Array(fileBuffer.buffer, fileBuffer.byteOffset, fileBuffer.length),
    });

    if (!uploadResponse.ok) {
      const errText = await uploadResponse.text();
      throw new Error(`LinkedIn image upload failed (${uploadResponse.status}): ${errText}`);
    }

    this.logger.info({ imageUrn }, 'LinkedIn image uploaded');
    return imageUrn;
  }

  /**
   * Upload a remote image (an unfurled og:image) to the Images API and return
   * its URN. The og:image URL comes from third-party page markup, so the fetch
   * is SSRF-guarded and size-capped.
   */
  private async uploadImageFromUrl(
    accessToken: string,
    ownerUrn: string,
    imageUrl: string,
  ): Promise<string> {
    const parsed = new URL(imageUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Unsupported thumbnail URL protocol');
    }
    if (!(await validateHostname(parsed.hostname))) {
      throw new Error('Thumbnail host failed SSRF validation');
    }
    const imgRes = await ssrfSafeFetch(imageUrl, { signal: AbortSignal.timeout(10_000) });
    if (!imgRes.ok) throw new Error(`Thumbnail fetch failed (${imgRes.status})`);
    const contentType = imgRes.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) throw new Error(`Thumbnail is not an image (${contentType})`);
    const MAX_THUMB_BYTES = 10 * 1024 * 1024;
    const reader = imgRes.body?.getReader();
    if (!reader) throw new Error('Thumbnail response has no body');
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_THUMB_BYTES) {
        await reader.cancel();
        throw new Error('Thumbnail exceeds 10 MB');
      }
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks);

    const initData = await this.fetchJson<{
      value: { uploadUrl: string; image: string };
    }>(`${API_BASE}/rest/images?action=initializeUpload`, {
      method: 'POST',
      headers: restHeaders(accessToken),
      body: JSON.stringify({ initializeUploadRequest: { owner: ownerUrn } }),
    });
    const { uploadUrl, image: imageUrn } = initData.value;

    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(buffer),
    });
    if (!uploadResponse.ok) {
      const errText = await uploadResponse.text();
      throw new Error(`LinkedIn thumbnail upload failed (${uploadResponse.status}): ${errText}`);
    }

    this.logger.info({ imageUrn }, 'LinkedIn article thumbnail uploaded');
    return imageUrn;
  }

  /* ------------------------------------------------------------------ */
  /*  Video upload (multipart chunked)                                   */
  /* ------------------------------------------------------------------ */

  private async uploadVideo(
    accessToken: string,
    ownerUrn: string,
    video: PostData['mediaFiles'][0],
  ): Promise<string> {
    const fileSize = video.sizeBytes || fs.statSync(video.localPath).size;

    // Step 1: Initialize upload
    const initData = await this.fetchJson<{
      value: {
        uploadInstructions: Array<{
          uploadUrl: string;
          firstByte: number;
          lastByte: number;
        }>;
        uploadToken: string;
        video: string; // video URN
      };
    }>(`${API_BASE}/rest/videos?action=initializeUpload`, {
      method: 'POST',
      headers: restHeaders(accessToken),
      body: JSON.stringify({
        initializeUploadRequest: {
          owner: ownerUrn,
          fileSizeBytes: fileSize,
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      }),
    });

    const { uploadInstructions, uploadToken, video: videoUrn } = initData.value;

    this.logger.info(
      { videoUrn, chunks: uploadInstructions.length, fileSize },
      'LinkedIn video upload initialized',
    );

    // Step 2: Upload each chunk
    const fd = fs.openSync(video.localPath, 'r');
    const etags: string[] = [];

    try {
      for (const instruction of uploadInstructions) {
        const chunkSize = instruction.lastByte - instruction.firstByte + 1;
        const buffer = Buffer.alloc(chunkSize);
        fs.readSync(fd, buffer, 0, chunkSize, instruction.firstByte);

        const chunkResponse = await fetch(instruction.uploadUrl, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/octet-stream',
          },
          body: new Uint8Array(buffer),
        });

        if (!chunkResponse.ok) {
          const errText = await chunkResponse.text();
          throw new Error(
            `LinkedIn video chunk upload failed (${chunkResponse.status}): ${errText}`,
          );
        }

        const etag = chunkResponse.headers.get('etag');
        if (etag) etags.push(etag);
      }
    } finally {
      fs.closeSync(fd);
    }

    // Step 3: Finalize upload
    await this.fetchJson(`${API_BASE}/rest/videos?action=finalizeUpload`, {
      method: 'POST',
      headers: restHeaders(accessToken),
      body: JSON.stringify({
        finalizeUploadRequest: {
          video: videoUrn,
          uploadToken,
          uploadedPartIds: etags,
        },
      }),
    });

    this.logger.info({ videoUrn }, 'LinkedIn video upload finalized');
    return videoUrn;
  }

  /* ------------------------------------------------------------------ */
  /*  Create post                                                        */
  /* ------------------------------------------------------------------ */

  async publishComment(
    channel: ChannelData,
    platformPostId: string,
    comment: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const meta = (channel.metadata ?? {}) as Record<string, unknown>;
      const actorUrn =
        (meta.authorUrn as string) ||
        (channel.accountType === 'organization'
          ? `urn:li:organization:${channel.accountId}`
          : `urn:li:person:${channel.accountId}`);

      const encodedUrn = encodeURIComponent(platformPostId);
      const response = await fetch(
        `${API_BASE}/rest/socialActions/${encodedUrn}/comments`,
        {
          method: 'POST',
          headers: restHeaders(channel.accessToken),
          body: JSON.stringify({
            actor: actorUrn,
            message: { text: comment },
          }),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `LinkedIn API error (${response.status}): ${text.slice(0, 300)}` };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async repost(
    channel: ChannelData,
    platformPostId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const meta = (channel.metadata ?? {}) as Record<string, unknown>;
      const authorUrn =
        (meta.authorUrn as string) ||
        (channel.accountType === 'organization'
          ? `urn:li:organization:${channel.accountId}`
          : `urn:li:person:${channel.accountId}`);

      const response = await fetch(`${API_BASE}/rest/posts`, {
        method: 'POST',
        headers: restHeaders(channel.accessToken),
        body: JSON.stringify({
          author: authorUrn,
          commentary: '',
          visibility: 'PUBLIC',
          distribution: {
            feedDistribution: 'MAIN_FEED',
            targetEntities: [],
            thirdPartyDistributionChannels: [],
          },
          lifecycleState: 'PUBLISHED',
          isReshareDisabledByAuthor: false,
          reshareContext: {
            parent: platformPostId,
          },
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `LinkedIn reshare failed (${response.status}): ${text.slice(0, 300)}` };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async createPost(
    accessToken: string,
    body: Record<string, unknown>,
  ): Promise<PublishResult> {
    const response = await fetch(`${API_BASE}/rest/posts`, {
      method: 'POST',
      headers: restHeaders(accessToken),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      this.logger.error({ status: response.status, text }, 'LinkedIn create post failed');
      return {
        success: false,
        error: `LinkedIn API error (${response.status}): ${text.slice(0, 300)}`,
      };
    }

    // LinkedIn returns the post URN in the x-restli-id header
    const postUrn = response.headers.get('x-restli-id') || '';
    const postUrl = postUrn
      ? `https://www.linkedin.com/feed/update/${postUrn}`
      : undefined;

    this.logger.info({ postUrn, postUrl }, 'LinkedIn post created');

    return {
      success: true,
      postId: postUrn,
      url: postUrl,
    };
  }
}
