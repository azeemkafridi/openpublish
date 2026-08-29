import type { PlatformName } from './types';

/**
 * Platforms whose handler implements `getPostMetrics()`. Anything not listed
 * inherits BasePlatform's empty-Map default, so no `post_metrics` row is ever
 * written for it.
 *
 * This is the single source of truth: the metrics-sync worker uses it to decide
 * what to fetch, and the analytics API uses it to decide whether a missing
 * snapshot means "not synced yet" or "this platform never reports". Analytics
 * LEFT JOINs post_metrics and COALESCEs to 0, so without this distinction a
 * Google Business post that the platform simply doesn't measure rendered as a
 * confident "0 impressions, 0 likes" — a number that disagrees with the
 * platform itself. (Prod, 2026-07-28: 76 published gmb rows, 0 metrics rows.)
 */
export const METRICS_SUPPORTED_PLATFORMS: PlatformName[] = [
  'x', 'youtube', 'linkedin', 'facebook',
  'instagram', 'threads', 'pinterest', 'tiktok',
  'bluesky', 'mastodon', 'reddit', 'discord', 'snapchat',
];

/**
 * Whether per-post metrics can exist for this channel.
 *
 * LinkedIn is platform-supported but account-type-gated: share statistics are
 * only exposed for ORGANIZATION posts. `getPostMetrics` returns early for
 * anything else (linkedin.ts), so personal/profile channels are permanently
 * unmeasured even though the platform is in the list above.
 */
export function postMetricsSupported(
  platform: string,
  accountType?: string | null,
): boolean {
  if (!METRICS_SUPPORTED_PLATFORMS.includes(platform as PlatformName)) return false;
  if (platform === 'linkedin') return accountType === 'organization';
  return true;
}

/* ------------------------------------------------------------------ */
/*  Per-metric support                                                 */
/* ------------------------------------------------------------------ */

/**
 * Platform support is not all-or-nothing: every platform in the list above
 * reports a DIFFERENT subset of the eight metric columns, and `post_metrics`
 * stores all eight as NOT NULL integers defaulting to 0. So a metric the
 * platform's API never returns is persisted as a hard 0 and is indistinguishable
 * from a real measurement of zero.
 *
 * That is why an org publishing only to X sees "Reach 0 / Saves 0 /
 * Video Views 0 / Clicks 0" — X's `public_metrics` has no such fields at all.
 * The numbers aren't wrong, they're nonexistent, and 0 misreports them as a
 * measurement.
 *
 * Each entry below is derived from the platform handler's `getPostMetrics()` —
 * ONLY the keys it can actually write. Keep this in sync when a handler starts
 * or stops returning a field.
 */
export type MetricKey =
  | 'impressions' | 'reach' | 'likes' | 'comments'
  | 'shares' | 'saves' | 'clicks' | 'videoViews' | 'engagementRate'
  | 'linkClicks';

/** Every metric column analytics surfaces, in display order. */
export const ALL_METRIC_KEYS: MetricKey[] = [
  'impressions', 'reach', 'likes', 'comments',
  'shares', 'saves', 'clicks', 'videoViews', 'engagementRate',
  'linkClicks',
];

/**
 * Metrics WE measure, so they don't depend on a platform API at all.
 *
 * `linkClicks` comes from the cloud link redirector,
 * which means it is available on every platform — including the ones that report
 * nothing, like Google Business or Telegram. It is deliberately kept separate
 * from `clicks`, which is the platform's own click figure (LinkedIn/Facebook/
 * Pinterest only); merging them would sum two different populations measured by
 * two different parties.
 */
export const UNIVERSAL_METRIC_KEYS: MetricKey[] = ['linkClicks'];

/**
 * platform → metrics its handler can populate. Sources (all in
 * `src/lib/platforms/*.ts`, function `getPostMetrics`):
 *  - x:         public_metrics → impression/like/retweet/reply/bookmark counts
 *               (bookmarks map to saves; quotes stay in extra).
 *  - youtube:   statistics → viewCount (impressions + videoViews), like, comment.
 *  - linkedin:  organizationalEntityShareStatistics → impression/unique/click/
 *               like/comment/share. Org channels only (see postMetricsSupported).
 *  - facebook:  likes/comments/shares + insights (media views → impressions and
 *               reach, post_clicks). Insights need read_insights; when the
 *               permission is missing those three stay 0 — see `mayBeUnavailable`.
 *  - instagram: views|impressions, reach, saved, likes, comments, shares.
 *  - threads:   views, likes, replies, reposts+shares. No reach — that is a
 *               USER-level Threads metric, not a media-level one.
 *  - pinterest: IMPRESSION, PIN_CLICK, SAVE, TOTAL_REACTIONS, TOTAL_COMMENTS,
 *               VIDEO_MRC_VIEW. No reach.
 *  - tiktok:    view_count (impressions + videoViews), like, comment, share.
 *  - bluesky:   like/reply/repost/bookmark counts (bookmarks map to saves) —
 *               app.bsky.feed.defs#postView exposes no impression figure.
 *  - mastodon:  favourites/replies/reblogs only; the Status entity has no
 *               impressions or views field.
 *  - reddit:    /api/info → score (likes), num_comments, num_crossposts
 *               (shares). view_count exists but is null via the data API, so
 *               impressions are not claimed.
 *  - discord:   message → reactions[].count summed (likes) and the started
 *               thread's message_count (comments). No views field exists.
 *
 * Still absent, and why (this list drives user-facing "not measured" prose,
 * so each exclusion must be a verified platform fact, not an oversight):
 *  - gmb:       post-level insights were shut down with the Feb 2023 v4
 *               deprecation and never replaced; the Performance API is
 *               location-level only.
 *  - telegram:  the Bot API has no getMessage — views/reactions arrive only as
 *               pushed updates, nothing is readable on request.
 *  - tumblr:    a post reports only a combined note_count; splitting it into
 *               likes/reblogs/replies means paginating the notes list, which
 *               truncates at scale — a wrong split is worse than none.
 *  - linkedin (personal): the Member Post Analytics API
 *               (memberCreatorPostAnalytics, r_member_postAnalytics) exists
 *               since mid-2025 but is approval-gated and one-metric-per-call;
 *               our app does not hold the scope, so personal channels remain
 *               unmeasured HERE — no longer a platform impossibility.
 *
 * `engagementRate` is computed by the metrics-sync worker as engagements ÷
 * impressions, so it exists exactly where `impressions` does.
 */
const RAW_METRIC_SUPPORT: Partial<Record<PlatformName, MetricKey[]>> = {
  x:         ['impressions', 'likes', 'comments', 'shares', 'saves'],
  youtube:   ['impressions', 'likes', 'comments', 'videoViews'],
  linkedin:  ['impressions', 'reach', 'likes', 'comments', 'shares', 'clicks'],
  facebook:  ['impressions', 'reach', 'likes', 'comments', 'shares', 'clicks'],
  instagram: ['impressions', 'reach', 'likes', 'comments', 'shares', 'saves'],
  threads:   ['impressions', 'likes', 'comments', 'shares'],
  pinterest: ['impressions', 'clicks', 'saves', 'videoViews', 'likes', 'comments'],
  tiktok:    ['impressions', 'likes', 'comments', 'shares', 'videoViews'],
  bluesky:   ['likes', 'comments', 'shares', 'saves'],
  mastodon:  ['likes', 'comments', 'shares'],
  reddit:    ['likes', 'comments', 'shares'],
  // Snap stats: VIEWS→impressions/videoViews, VIEWERS→reach, SHARES, REPLIES→
  // comments, FAVORITES→likes, SWIPE_UPS→clicks (Public Profile API /stats).
  snapchat:  ['impressions', 'reach', 'likes', 'comments', 'shares', 'clicks', 'videoViews'],
  discord:   ['likes', 'comments'],
};

export const METRIC_SUPPORT: Partial<Record<PlatformName, MetricKey[]>> =
  Object.fromEntries(
    Object.entries(RAW_METRIC_SUPPORT).map(([platform, keys]) => [
      platform,
      // Derived, not hand-maintained: the worker computes engagementRate from
      // impressions, so listing it separately would drift the moment a
      // platform's impressions support changes.
      keys.includes('impressions') ? [...keys, 'engagementRate' as MetricKey] : keys,
    ]),
  );

/**
 * Metrics this channel can ever report.
 *
 * Always includes the universal ones: a platform that reports nothing back to us
 * can still carry a tracked link, so `linkClicks` is measurable everywhere.
 * Platform-reported metrics remain empty for unmeasured platforms.
 */
export function supportedMetrics(
  platform: string,
  accountType?: string | null,
): MetricKey[] {
  const platformKeys = postMetricsSupported(platform, accountType)
    ? (METRIC_SUPPORT[platform as PlatformName] ?? [])
    : [];
  return [...platformKeys, ...UNIVERSAL_METRIC_KEYS];
}

/** Whether a single metric can ever be non-zero for this channel. */
export function metricSupported(
  platform: string,
  metric: MetricKey,
  accountType?: string | null,
): boolean {
  return supportedMetrics(platform, accountType).includes(metric);
}

/**
 * Metrics that are listed as supported but silently depend on a permission the
 * user may not have granted. A 0 here means "supported, but we may not be
 * allowed to read it" — worth a different hint than a hard dash.
 *
 * Facebook's impressions/reach/clicks come from the Page Insights edge, which
 * needs `read_insights`; without it the insights call 400s and the handler keeps
 * the likes/comments/shares it already fetched.
 */
export const CONDITIONAL_METRICS: Partial<Record<PlatformName, MetricKey[]>> = {
  facebook: ['impressions', 'reach', 'clicks', 'engagementRate'],
};

export function metricMayBeUnavailable(platform: string, metric: MetricKey): boolean {
  return (CONDITIONAL_METRICS[platform as PlatformName] ?? []).includes(metric);
}

/**
 * Platforms whose API reports a comments COUNT but refuses to return the
 * comments themselves — their `getPostEngagement` is `unsupported`, so a
 * "3 Comments" stat has no thread anywhere in the product. The analytics
 * preview uses this to say WHY, next to the count, instead of leaving a number
 * that looks like a broken drill-down. Each entry is a verified platform fact
 * (matching the handler's own unsupported message), not an oversight:
 *  - tiktok:    Display API returns comment_count only; the comment list API
 *               is closed to third-party apps.
 *  - pinterest: analytics report TOTAL_COMMENTS; no comment-read endpoint.
 *  - snapchat:  Public Profile stats report reply counts; replies themselves
 *               are not exposed.
 * YouTube is deliberately NOT here — comment reading exists behind the
 * youtube.force-ssl scope (`YOUTUBE_COMMENTS_SCOPE`), and its handler already
 * explains a gated read via `commentsNotice`.
 */
export const COMMENTS_UNREADABLE: Partial<Record<PlatformName, string>> = {
  tiktok: 'TikTok reports the comment count but does not let apps read the comments themselves.',
  pinterest: 'Pinterest reports the comment count but does not let apps read the comments themselves.',
  snapchat: 'Snapchat reports the reply count but does not let apps read the replies themselves.',
};
