import type {
  PlatformName,
  TokenData,
  AccountInfo,
  PublishResult,
  StatusResult,
  PostData,
  ChannelData,
  PlatformConfig,
  ThreadPublishResult,
  MetricsData,
  PostMetricsOptions,
  EngagementData,
  EngagementOptions,
} from './types';
import { createLogger } from '../logger';
import { parseJsonPreservingBigInts } from './json-bigint';
import { ssrfSafeDispatcher, ssrfSafeFetch, validateHostname } from '../security/url-guard';

/** Extract a human-readable message from common API error response shapes */
function extractErrorMessage(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;

  // { error: { message: "..." } }  (TikTok, Pinterest, etc.)
  if (obj.error && typeof obj.error === 'object') {
    const err = obj.error as Record<string, unknown>;
    if (typeof err.message === 'string') return err.message;
  }
  // { error: "message" }
  if (typeof obj.error === 'string') return obj.error;
  // { message: "..." }
  if (typeof obj.message === 'string') return obj.message;
  // { error_description: "..." }  (OAuth flows)
  if (typeof obj.error_description === 'string') return obj.error_description;

  return null;
}

const SENSITIVE_PARAMS = ['access_token', 'token', 'key', 'client_secret', 'fb_exchange_token'];
function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of SENSITIVE_PARAMS) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, '***');
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Delay before retrying a transient upstream failure: honor Retry-After
 * (seconds or HTTP-date) clamped to [1s, 30s]; otherwise linear 2s/4s backoff.
 */
function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds)
      ? seconds * 1000
      : new Date(header).getTime() - Date.now();
    if (Number.isFinite(ms) && ms > 0) return Math.min(Math.max(ms, 1000), 30_000);
  }
  return attempt * 2000;
}

export abstract class PlatformHandler {
  protected logger;

  constructor(public readonly config: PlatformConfig) {
    this.logger = createLogger(`platform:${config.name}`);
  }

  get name(): PlatformName {
    return this.config.name;
  }

  abstract getOAuthUrl(redirectUri: string, state: string): Promise<string>;

  abstract exchangeCodeForToken(
    code: string,
    redirectUri: string,
    state?: string,
  ): Promise<TokenData>;

  abstract getAccountInfo(accessToken: string): Promise<AccountInfo>;

  /**
   * Assert a field we just parsed out of an OAuth response is actually there.
   *
   * A token endpoint that answers 200 with a body we mis-read yields
   * `undefined`, and `undefined` is not inert: it gets interpolated into the
   * next request as the literal string "undefined", so the platform rejects a
   * request that looks well-formed and returns a generic error naming neither
   * the field nor the cause. Instagram moved its short-lived token into a
   * `data[]` wrapper; we kept reading the old top-level shape, sent
   * `access_token=undefined` to the long-lived exchange, and got back
   * "Unsupported request - method type: get" — which reads like a wrong HTTP
   * verb and hid the real bug for three weeks while every Instagram connect
   * failed. Fail here, at the field that is actually missing.
   */
  protected requireOAuthField<T>(value: T | undefined | null, field: string): T {
    if (value === undefined || value === null || value === '') {
      throw new Error(
        `${this.config.displayName} OAuth response is missing "${field}". ` +
        'This usually means the provider changed its response shape: ' +
        'the token exchange succeeded but could not be parsed.',
      );
    }
    return value;
  }

  abstract publishPost(
    post: PostData,
    channel: ChannelData,
  ): Promise<PublishResult>;

  async publishThread(
    _segments: Array<PostData & { sequence: number }>,
    _channel: ChannelData,
    _alreadyPosted?: ThreadPublishResult['posts'],
  ): Promise<ThreadPublishResult> {
    return { success: false, error: `${this.config.displayName} does not support threads` };
  }

  async checkPublishStatus(
    _channel: ChannelData,
    _publishId: string,
  ): Promise<StatusResult> {
    return { status: 'published' };
  }

  /**
   * True when an error thrown during a status/read call is worth retrying —
   * a 429/5xx from the platform, or anything without a parsable status code
   * (network failure, 30s abort, non-JSON body). False for 4xx, where the
   * platform understood the request and rejected it; retrying returns the
   * same answer.
   *
   * checkPublishStatus implementations rethrow transient errors instead of
   * returning `failed`: the status-check worker retries thrown errors with
   * backoff and only marks the row failed on its final attempt. Returning
   * `failed` is terminal on the FIRST attempt — a single upstream 500 during
   * the poll then marks a post failed that may in fact be live (this happened
   * with TikTok post 989 on 2026-08-01).
   */
  /**
   * For token refresh only: was the failure about the network or the
   * platform being down, rather than about the token? Unlike
   * isTransientApiError this does NOT default to true — a refresh that fails
   * for a reason we cannot name (a 200 with no access_token, a parse error)
   * must return null, never throw, or the sweep would retry it forever.
   */
  protected isTransientRefreshFailure(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    if (/API error \((?:429|5\d\d)\)/.test(message)) return true;
    return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|fetch failed|timed out|operation was aborted/i.test(message);
  }

  protected isTransientApiError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const match = message.match(/API error \((\d{3})\)/);
    if (match) {
      const status = Number(match[1]);
      return status === 429 || status >= 500;
    }
    return true;
  }

  async refreshToken(
    _refreshToken: string,
    _accountType?: string,
  ): Promise<TokenData | null> {
    return null;
  }

  async publishComment(
    _channel: ChannelData,
    _platformPostId: string,
    _comment: string,
  ): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: `${this.config.displayName} does not support first comments` };
  }

  async repost(
    _channel: ChannelData,
    _platformPostId: string,
  ): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: `${this.config.displayName} does not support repost` };
  }

  async getAccountAnalytics(
    _channel: ChannelData,
  ): Promise<{ followers?: number; following?: number; impressions?: number; reach?: number; profileViews?: number; websiteClicks?: number; platformSpecific?: Record<string, number> } | null> {
    return null;
  }

  async getPostMetrics(
    _channel: ChannelData,
    _platformPostIds: string[],
    _opts?: PostMetricsOptions,
  ): Promise<Map<string, MetricsData>> {
    return new Map();
  }

  /**
   * Fetch the people/pages who commented on or reacted to a post. Used by the
   * Engagement panel so admins can see *who* is engaging, not just counts.
   *
   * Default: report unsupported. Each platform overrides with its own API
   * (LinkedIn /socialActions, Facebook /comments+/reactions, etc.). Some
   * platforms genuinely don't expose this (TikTok) — they keep the default.
   */
  async getPostEngagement(
    _channel: ChannelData,
    _platformPostId: string,
    _opts?: EngagementOptions,
  ): Promise<EngagementData> {
    return {
      comments: [],
      reactions: [],
      unsupported: true,
    };
  }

  /**
   * Resolve a deferred publish id to the canonical post id used for analytics.
   * Only TikTok needs this: a post can complete before TikTok exposes its public
   * video id, leaving a non-queryable publish_id stored. Default: no-op.
   */
  async resolvePublishId(
    _channel: ChannelData,
    _publishId: string,
  ): Promise<string | null> {
    return null;
  }

  async searchUsers(
    _channel: ChannelData,
    _query: string,
  ): Promise<Array<{ id: string; handle: string; name: string; profileImage?: string }>> {
    return [];
  }

  protected async fetchJson<T>(
    url: string,
    options: RequestInit = {},
    opts: { quiet?: boolean; preserveBigInts?: boolean } = {},
  ): Promise<T> {
    // In-band retry for transient upstream failures. 429s are always safe to
    // retry (the platform rejected the request without processing it); transient
    // 5xx responses are retried only for GETs — a 500 on a publish POST may have
    // gone through server-side, and retrying would risk a duplicate post.
    const method = (options.method || 'GET').toUpperCase();
    const maxAttempts = 3;
    // Total budget across retries — fetchJson also serves interactive request
    // paths (channel connect, analytics), which must not block for minutes on
    // a flapping upstream. The per-attempt 30s abort still applies.
    const retryDeadline = Date.now() + 60_000;

    for (let attempt = 1; ; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      try {
        // Every handler fetch goes through the SSRF-pinned dispatcher. Platform
        // API hosts are always public, so this is free for them — the point is
        // that any user-influenced URL that reaches a handler (media by URL,
        // custom Mastodon instances, thumbnails) is safe by construction.
        const response = await fetch(url, {
          ...options,
          dispatcher: ssrfSafeDispatcher,
          signal: controller.signal,
        } as RequestInit);

        const retryable =
          response.status === 429 ||
          (method === 'GET' && [500, 502, 503, 504].includes(response.status));
        if (retryable && attempt < maxAttempts) {
          const delayMs = retryDelayMs(response, attempt);
          if (Date.now() + delayMs <= retryDeadline) {
            this.logger.warn(
              {
                url: sanitizeUrl(url),
                status: response.status,
                attempt,
                delayMs,
                // Which budget was exhausted, and how it is scoped. Pinterest
                // sends `x-ratelimit-limit: 100, 100;w=1, 1000;w=60` — the
                // window sizes distinguish a per-minute per-user cap from a
                // per-day per-app one, which is the difference between one
                // noisy account and every account sharing a single quota.
                ...(response.status === 429
                  ? {
                      rateLimit: response.headers.get('x-ratelimit-limit'),
                      rateRemaining: response.headers.get('x-ratelimit-remaining'),
                      rateReset: response.headers.get('x-ratelimit-reset'),
                      retryAfter: response.headers.get('retry-after'),
                    }
                  : {}),
              },
              'Transient API error — retrying',
            );
            // Drain the abandoned body so its socket returns to undici's pool.
            await response.text().catch(() => {});
            clearTimeout(timeoutId);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }
        }

        const text = await response.text();

        // An error status with an empty body (Snap's businessapi 403s carry no
        // body at all) must surface as an API error with its status — running
        // it through JSON.parse below would mask it as "Non-JSON response".
        if (!response.ok && text.trim() === '') {
          if (!opts.quiet) {
            this.logger.error({ url: sanitizeUrl(url), status: response.status }, 'API error (empty body)');
          }
          throw new Error(`${this.name} API error (${response.status}): empty response body`);
        }

        let data: unknown;

        try {
          // preserveBigInts: the endpoint returns 64-bit object ids as bare JSON
          // numbers, which JSON.parse rounds past 2^53 (see json-bigint.ts).
          data = opts.preserveBigInts ? parseJsonPreservingBigInts(text) : JSON.parse(text);
        } catch {
          if (!opts.quiet) {
            this.logger.error({ url: sanitizeUrl(url), status: response.status, text }, 'Non-JSON response');
          }
          throw new Error(`Non-JSON response from ${this.name}: ${text.slice(0, 200)}`);
        }

        if (!response.ok) {
          // `quiet` suppresses the error-level log for calls the caller expects may
          // fail and handles gracefully (e.g. probing a field that doesn't exist on
          // a given post type), so logs aren't spammed with non-actionable errors.
          if (!opts.quiet) {
            this.logger.error({ url: sanitizeUrl(url), status: response.status, data }, 'API error');
          }
          const friendlyMsg = extractErrorMessage(data) || JSON.stringify(data).slice(0, 200);
          throw new Error(
            `${this.name} API error (${response.status}): ${friendlyMsg}`,
          );
        }

        return data as T;
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }

  protected async fetchWithFile(
    url: string,
    body: FormData | Buffer | ArrayBuffer,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 min for uploads

    try {
      // Zero-copy Uint8Array view for fetch compatibility (new Uint8Array(buf)
      // would duplicate the payload — for uploads that can be a whole video).
      const fetchBody = Buffer.isBuffer(body)
        ? new Uint8Array(body.buffer, body.byteOffset, body.length)
        : body;
      return await fetch(url, {
        method: 'POST',
        body: fetchBody,
        headers,
        dispatcher: ssrfSafeDispatcher,
        signal: controller.signal,
      } as RequestInit);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Fetch a media URL that may be user-influenced (platformSpecific thumbnail /
   * cover URLs, scraped og:image, external media). Enforces http(s), pre-checks
   * the hostname against private/reserved ranges, and fetches through the
   * IP-pinned dispatcher so DNS rebinding can't swap in an internal address.
   * Throws with a friendly message on a blocked or unreachable URL.
   */
  protected async fetchRemoteMedia(url: string, init: RequestInit = {}): Promise<Response> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid media URL: ${url.slice(0, 200)}`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`Media URLs must use http(s), got ${parsed.protocol}`);
    }
    if (!(await validateHostname(parsed.hostname))) {
      throw new Error(`Media URL host is not reachable from here: ${parsed.hostname}`);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    try {
      return await ssrfSafeFetch(parsed, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
