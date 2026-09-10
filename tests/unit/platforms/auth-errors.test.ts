/**
 * Tests for isReconnectError — the shared classifier that decides whether a
 * publish/refresh failure means "the token is dead, the user must reconnect"
 * (→ flag the channel needsReconnect) vs. a transient/content/permission error.
 *
 * Cases are written from REAL error shapes each platform produces, surfaced via
 * base.ts fetchJson as e.g. `x API error (401): ...`.
 */
import { isReconnectError, classifyPublishError } from '@/lib/platforms/auth-errors';

describe('isReconnectError', () => {
  describe('flags reconnect (dead/revoked token)', () => {
    it.each<[string, string]>([
      // OAuth 2.0 Bearer standard — invalid/expired token → HTTP 401
      ['X (401)', 'x API error (401): Unauthorized'],
      ['LinkedIn (401)', 'linkedin API error (401): Invalid access token'],
      ['Pinterest (401)', 'pinterest API error (401): Authentication failed'],
      ['Mastodon (401)', 'mastodon API error (401): The access token is invalid'],
      ['YouTube/Google 401', 'youtube API error (401): Invalid Credentials'],
      ['generic unauthorized', 'Request failed: Unauthorized'],
      // OAuth refresh-token rejection
      ['invalid_grant', 'token refresh failed: invalid_grant'],
      ['invalid_token', 'API error (403): invalid_token'],
      // Meta Graph (Facebook / Instagram / Threads) — code 190 family
      ['FB validating token', 'facebook API error (400): Error validating access token: Session has expired'],
      ['FB friendly 190', 'Access token expired. Please reconnect your Facebook account.'],
      ['OAuthException', 'instagram API error (400): OAuthException: The access token could not be decrypted'],
      ['revoked token', 'threads API error (400): REVOKED_ACCESS_TOKEN'],
      ['Meta 190 invalid OAuth', 'instagram API error (400): Invalid OAuth 2.0 Access Token'],
      ['Meta 190 cannot parse', 'threads API error (400): Invalid OAuth access token - Cannot parse access token'],
      // TikTok
      ['TikTok token invalid', 'tiktok API error: access_token_invalid'],
      ['Bluesky expired', 'bluesky API error (400): Token has expired'],
    ])('%s', (_label, message) => {
      expect(isReconnectError(message)).toBe(true);
    });
  });

  describe('does NOT flag reconnect (transient / content / permission)', () => {
    it.each<[string, string]>([
      // Facebook code 200 is a PERMISSION error — fix permissions, not the token
      ['FB permission (200)', 'Permission denied. Please re-authorize your Facebook account.'],
      ['FB missing perm', 'facebook API error (400): (#200) Requires pages_manage_posts permission'],
      // Rate limits / content / size / policy
      ['rate limit', 'x API error (429): Too Many Requests'],
      ['media too large', 'instagram API error (400): Media file is too large'],
      ['content policy', 'facebook API error (400): Content flagged as abusive'],
      ['server error', 'tiktok API error (500): Internal server error'],
      ['bad request', 'pinterest API error (400): Invalid board id'],
      ['no media', 'No video file provided for YouTube upload'],
      ['empty', ''],
    ])('%s', (_label, message) => {
      expect(isReconnectError(message)).toBe(false);
    });

    it('handles null/undefined', () => {
      expect(isReconnectError(null)).toBe(false);
      expect(isReconnectError(undefined)).toBe(false);
    });
  });
});

describe('classifyPublishError', () => {
  it.each([
    ['429 rate limit', 'x API error (429): Too Many Requests'],
    ['500 server error', 'tiktok API error (500): Internal server error'],
    ['502 bad gateway', 'linkedin API error (502): Bad Gateway'],
    ['503 unavailable', 'facebook API error (503): Service temporarily unavailable'],
    ['rate limit prose', 'Rate limit exceeded, slow down'],
    ['connection refused', 'fetch failed: connect ECONNREFUSED 1.2.3.4:443'],
    ['dns failure', 'network error: getaddrinfo EAI_AGAIN api.example.com'],
    ['try again', 'Something went wrong, please try again later'],
    // Pinterest code 12 — a server fault delivered as HTTP 400, so only the
    // phrase can identify it (prod post 1070, 2026-08-07).
    ['Pinterest code 12', 'pinterest API error (400): Sorry! Something went wrong on our end.'],
    // Reddit intermittently answers 200 + SUBREDDIT_NOEXIST for subreddits that
    // exist; the submit was refused outright so retrying is duplicate-safe.
    ['Reddit NOEXIST', '["SUBREDDIT_NOEXIST","that community doesn\'t exist","sr"]'],
    // Snapchat rejects the story/Spotlight create while a finalized upload is
    // still transcoding — refused outright, so retrying is duplicate-safe.
    ['Snapchat transcode', 'Snapchat is still processing the media — try again shortly.'],
    ['Snapchat transcode raw', 'snapchat API error (400): Media is still being processed'],
  ])('retry: %s', (_label, message) => {
    expect(classifyPublishError(message)).toBe('retry');
  });

  it.each([
    ['401', 'x API error (401): Unauthorized'],
    ['invalid token', 'linkedin API error (400): invalid_token'],
    ['Meta 190', 'facebook API error (400): Error validating access token'],
  ])('reconnect wins: %s', (_label, message) => {
    expect(classifyPublishError(message)).toBe('reconnect');
  });

  it.each([
    ['content policy', 'facebook API error (400): Content flagged as abusive'],
    ['media too large', 'instagram API error (400): Media file is too large'],
    ['permission', 'facebook API error (400): (#200) Requires pages_manage_posts permission'],
    ['empty', ''],
  ])('fatal: %s', (_label, message) => {
    expect(classifyPublishError(message)).toBe('fatal');
  });

  it('handles null/undefined as fatal', () => {
    expect(classifyPublishError(null)).toBe('fatal');
    expect(classifyPublishError(undefined)).toBe('fatal');
  });

  // The request may have REACHED the platform and only the response was lost —
  // retrying could publish a duplicate, so these must be 'unknown', not 'retry'.
  it.each([
    ['timeout', 'Request timed out after 30000ms'],
    ['abort', 'The operation was aborted'],
    ['reset mid-flight', 'fetch failed: ECONNRESET'],
    ['socket hang up', 'socket hang up'],
    ['ETIMEDOUT', 'connect ETIMEDOUT 104.244.42.1:443'],
    ['bare fetch failed', 'fetch failed'],
  ])('unknown outcome: %s', (_label, message) => {
    expect(classifyPublishError(message)).toBe('unknown');
  });

  it('a complete HTTP response wins over timeout wording — "(504) Gateway Timeout" is retryable', () => {
    expect(classifyPublishError('linkedin API error (504): Gateway Timeout')).toBe('retry');
  });

  it('a 401 containing timeout wording is still reconnect', () => {
    expect(classifyPublishError('x API error (401): request timed out validating token')).toBe('reconnect');
  });
});

export {};

describe('classifyPublishError — Meta throttles are retryable', () => {
  it.each<[string, string]>([
    // Graph code 1. Its own text says to retry, but nothing matched it, so the
    // post was marked permanently failed on the first hiccup.
    ['Graph code 1', "Please reduce the amount of data you're asking for, then retry your request"],
    ['friendly code 1', 'Facebook was temporarily unavailable or rate-limiting. Please try again later.'],
    ['retry later', 'Quota exceeded, please retry later'],
  ])('%s -> retry', (_label, message) => {
    expect(classifyPublishError(message)).toBe('retry');
  });

  it('still treats a genuine media rejection as fatal', () => {
    expect(classifyPublishError('Videos must be MP4/MOV format, under 2GB.')).toBe('fatal');
    expect(classifyPublishError('Missing or invalid image file.')).toBe('fatal');
  });
});
