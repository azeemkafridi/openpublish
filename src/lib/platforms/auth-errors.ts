/**
 * Shared classifier for "this channel's token is dead — the user must reconnect"
 * errors, used across ALL platforms (not just Facebook).
 *
 * Why central: every handler funnels HTTP failures through `PlatformHandler.fetchJson`,
 * which surfaces the upstream status in the message — e.g. `x API error (401): ...`.
 * That lets us classify auth failures once instead of per handler.
 *
 * What counts as "needs reconnect" (verified against the platforms' docs):
 *   - HTTP 401 / "unauthorized" — the OAuth 2.0 Bearer-token standard (RFC 6750)
 *     for an invalid/expired/revoked token. Used by X, LinkedIn, Pinterest,
 *     TikTok, Mastodon, Bluesky, Google (YouTube/GMB).
 *   - OAuth refresh failures: `invalid_grant` / `invalid_token`.
 *   - Meta Graph API (Facebook, Instagram, Threads) is the outlier — it returns
 *     HTTP 400/200 with error code 190 / "Error validating access token" /
 *     `REVOKED_ACCESS_TOKEN`. (Facebook also sets `PublishResult.authExpired`
 *     precisely from code 190; this string check is the safety net + covers
 *     IG/Threads which share the Graph error shape.)
 *
 * Deliberately NOT matched: permission errors (e.g. Facebook code 200 / "Permission
 * denied"), rate limits, or content-policy rejections — those are not fixed by
 * reconnecting, and false-flagging them would disable a healthy channel.
 */

const RECONNECT_PATTERNS: RegExp[] = [
  /\b401\b/, // HTTP 401 (fetchJson formats it as "(401)")
  /\bunauthor(i|í)zed\b/i,
  /invalid[_\s-]?token/i,
  /invalid[_\s-]?grant/i, // OAuth refresh-token rejection
  /access[_\s-]?token[_\s-]?(invalid|expired|revoked)/i, // e.g. TikTok access_token_invalid
  /token (?:has )?(?:expired|been revoked|is invalid|is no longer valid)/i,
  /\b(?:expired|revoked|invalid)[_\s-]?(?:access[_\s-]?)?token\b/i,
  /revoked[_\s]?access[_\s]?token/i, // Bluesky/Meta REVOKED_ACCESS_TOKEN
  /OAuthException/i,
  /error validating access token/i, // Meta Graph (FB/IG/Threads) code 190
  /please re-?authenticate|please reconnect/i, // our own friendly auth messages
];

/**
 * True when `message` indicates the platform rejected the token and the account
 * must be reconnected (vs. a transient or content error).
 */
export function isReconnectError(message: string | null | undefined): boolean {
  if (!message) return false;
  return RECONNECT_PATTERNS.some((re) => re.test(message));
}

/**
 * Errors that are worth retrying automatically: the platform was rate-limiting,
 * briefly down, or the connection died — nothing about the post itself is wrong.
 * fetchJson formats upstream statuses as "(429)" etc.; network-level failures
 * surface as Node fetch/undici error strings.
 */
/**
 * Errors where the request may have REACHED the platform but the response was
 * lost — a timeout, an aborted wait, or a connection that died mid-flight. The
 * mutation may have committed on the platform's side, so re-publishing risks a
 * DUPLICATE post. These must never be auto-retried; the post goes to
 * 'unconfirmed' and the user is asked to check their account.
 *
 * Deliberately NOT here (provably never connected/committed — safe to retry):
 * ECONNREFUSED, EAI_AGAIN/DNS failures, and any complete HTTP response
 * (a status like "(429)"/"(503)" means the platform answered — the
 * status-pattern check in classifyPublishError runs before this list).
 */
const UNKNOWN_OUTCOME_PATTERNS: RegExp[] = [
  /\b(?:timeout|timed out)\b/i,
  /operation was aborted/i, // our AbortController timeout
  /ECONNRESET|ETIMEDOUT|EPIPE|socket hang up/i,
  // undici's generic wrapper: could be either side of the send — assume the worst.
  /fetch failed/i,
];

const TRANSIENT_PATTERNS: RegExp[] = [
  /\((?:429|500|502|503|504)\)/,
  /\brate.?limit/i,
  /too many requests/i,
  /service (?:temporarily )?unavailable/i,
  /internal (?:server )?error/i,
  /temporarily unavailable|try again later/i,
  // Meta Graph code 1 (API Unknown) — a throttle dressed up as a data-volume
  // complaint. Its own text tells you to retry, but nothing here matched it, so
  // the post was marked permanently failed on the first hiccup (one such row in
  // prod on 2026-07-28). "retry your request"/"retry later" covers Meta's and
  // Google's phrasings of the same advice.
  /reduce the amount of data/i,
  /\bretry (?:your request|later|after)/i,
  // Pinterest error code 12 — "Sorry! Something went wrong on our end." — its
  // server fault returned as HTTP 400, so the status pattern above never
  // matches. Community-confirmed intermittent (identical payloads succeed on
  // retry; prod post 1070 failed on the same image format as 72 prior pins).
  /went wrong on our end/i,
  // Reddit intermittently answers 200 + SUBREDDIT_NOEXIST for subreddits that
  // do exist (consistency lag on their side). The submit was refused outright —
  // no post was created — so retrying is duplicate-safe and usually succeeds.
  /SUBREDDIT_NOEXIST/,
  // Media still transcoding on the platform's side (e.g. Snapchat rejects the
  // story/Spotlight create until a finalized upload finishes processing). The
  // create was refused outright — no post exists — so retrying is
  // duplicate-safe and succeeds once the transcode completes.
  /still processing the media|media.*still (?:being )?process/i,
  // Failures that provably never delivered the request: connection refused,
  // DNS resolution. (Timeouts/resets/aborts are NOT safe — see
  // UNKNOWN_OUTCOME_PATTERNS above.)
  /\bnetwork\b|ECONNREFUSED|EAI_AGAIN/i,
];

export type PublishErrorVerdict = 'reconnect' | 'retry' | 'unknown' | 'fatal';

/**
 * Four-way classification of a publish failure:
 *   - 'reconnect' — the token is dead; flag the channel, don't retry.
 *   - 'retry'     — transient (rate limit / 5xx response / connection never
 *                   made); the platform did NOT create the post — safe to retry.
 *   - 'unknown'   — the request may have committed but the response was lost
 *                   (timeout/abort/reset). Retrying risks a DUPLICATE post:
 *                   mark unconfirmed, tell the user to check their account.
 *   - 'fatal'     — content/permission/validation error; retrying won't help.
 * Precedence: reconnect > complete-HTTP-response retry > unknown > retry > fatal.
 * A "(504) Gateway Timeout" contains the word "timeout" but IS a complete
 * response from the platform's edge — the status check must run before the
 * unknown-outcome check, or every 5xx would stop being retryable.
 */
export function classifyPublishError(message: string | null | undefined): PublishErrorVerdict {
  if (!message) return 'fatal';
  if (isReconnectError(message)) return 'reconnect';
  if (/\((?:429|500|502|503|504)\)/.test(message)) return 'retry';
  // A refused connection / failed DNS lookup never delivered the request —
  // checked before the unknown patterns because undici wraps these in the
  // same "fetch failed" prefix as genuinely ambiguous mid-flight failures.
  if (/ECONNREFUSED|EAI_AGAIN/i.test(message)) return 'retry';
  if (UNKNOWN_OUTCOME_PATTERNS.some((re) => re.test(message))) return 'unknown';
  if (TRANSIENT_PATTERNS.some((re) => re.test(message))) return 'retry';
  return 'fatal';
}
