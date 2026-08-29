/**
 * The per-platform / per-metric support matrix.
 *
 * `post_metrics` stores all eight metric columns as NOT NULL integers, so a
 * field the platform API never returns is persisted as 0 and is otherwise
 * indistinguishable from a measured zero. This matrix is the only thing that
 * tells the two apart — if it drifts from the handlers, analytics silently goes
 * back to reporting "0 reach" for platforms that have no reach.
 */
import { describe, it, expect } from 'vitest';
import {
  METRICS_SUPPORTED_PLATFORMS,
  METRIC_SUPPORT,
  ALL_METRIC_KEYS,
  postMetricsSupported,
  supportedMetrics,
  metricSupported,
  metricMayBeUnavailable,
} from '@/lib/platforms/metrics-support';

export {};

describe('metrics support matrix', () => {
  it('covers every metrics-supported platform and nothing else', () => {
    expect(Object.keys(METRIC_SUPPORT).sort()).toEqual([...METRICS_SUPPORTED_PLATFORMS].sort());
  });

  it('only uses known metric keys', () => {
    for (const [platform, keys] of Object.entries(METRIC_SUPPORT)) {
      for (const k of keys!) {
        expect(ALL_METRIC_KEYS, `${platform} → ${k}`).toContain(k);
      }
    }
  });

  it('lists engagementRate exactly where impressions are reported', () => {
    // The worker computes it as engagements ÷ impressions, so it can only be
    // non-zero when impressions exist.
    for (const [platform, keys] of Object.entries(METRIC_SUPPORT)) {
      expect(keys!.includes('engagementRate'), platform).toBe(keys!.includes('impressions'));
    }
  });

  it('never reports a metric its handler cannot return', () => {
    // X's public_metrics has impression/like/retweet/reply/quote/bookmark only
    // — bookmarks map to saves; there is no reach/clicks/videoViews field.
    for (const k of ['reach', 'clicks', 'videoViews'] as const) {
      expect(metricSupported('x', k)).toBe(false);
    }
    expect(metricSupported('x', 'saves')).toBe(true);
    // Reddit /api/info reports score/num_comments/num_crossposts; view_count
    // is null via the data API, so impressions must not be claimed.
    expect(metricSupported('reddit', 'likes')).toBe(true);
    expect(metricSupported('reddit', 'shares')).toBe(true);
    expect(metricSupported('reddit', 'impressions')).toBe(false);
    // Discord: reactions[].count (likes) + thread message_count (comments);
    // the Message resource has no views field.
    expect(metricSupported('discord', 'likes')).toBe(true);
    expect(metricSupported('discord', 'comments')).toBe(true);
    expect(metricSupported('discord', 'impressions')).toBe(false);
    expect(metricSupported('discord', 'shares')).toBe(false);
    // atproto and Mastodon expose engagement counts but no impression figure.
    for (const p of ['bluesky', 'mastodon']) {
      expect(metricSupported(p, 'impressions')).toBe(false);
      expect(metricSupported(p, 'engagementRate')).toBe(false);
      expect(metricSupported(p, 'likes')).toBe(true);
    }
    // Bluesky bookmarks map to saves; Mastodon has no equivalent.
    expect(metricSupported('bluesky', 'saves')).toBe(true);
    expect(metricSupported('mastodon', 'saves')).toBe(false);
    // Pinterest reports engagement via TOTAL_REACTIONS / TOTAL_COMMENTS, but
    // has no reach metric on the pin analytics endpoint.
    expect(metricSupported('pinterest', 'likes')).toBe(true);
    expect(metricSupported('pinterest', 'saves')).toBe(true);
    expect(metricSupported('pinterest', 'reach')).toBe(false);
    // Threads `reach` is a user-level metric — requesting it at media level
    // rejects the entire insights call.
    expect(metricSupported('threads', 'reach')).toBe(false);
    expect(metricSupported('threads', 'impressions')).toBe(true);
    // YouTube statistics have no share or reach field.
    expect(metricSupported('youtube', 'shares')).toBe(false);
    expect(metricSupported('youtube', 'videoViews')).toBe(true);
  });

  it('reports the metrics X does support', () => {
    expect(supportedMetrics('x').sort()).toEqual(
      // linkClicks rides along on every platform: we measure it ourselves on
      // our own redirector, so it needs no support from the platform's API.
      ['comments', 'engagementRate', 'impressions', 'likes', 'linkClicks', 'saves', 'shares'],
    );
  });

  it('gates LinkedIn on account type', () => {
    expect(postMetricsSupported('linkedin', 'organization')).toBe(true);
    expect(postMetricsSupported('linkedin', 'personal')).toBe(false);
    expect(supportedMetrics('linkedin', 'organization')).toContain('impressions');
    // Personal profiles have no share-statistics endpoint at all, so no
    // PLATFORM-reported metric is measurable — only our own link clicks.
    expect(supportedMetrics('linkedin', 'personal')).toEqual(['linkClicks']);
  });

  it('returns only our own metrics for platforms with no per-post statistics API', () => {
    // Verified against current docs (2026-08): GMB post insights were removed
    // in Feb 2023 with no replacement; the Telegram Bot API cannot read
    // messages on request; Tumblr reports only an unsplittable note_count.
    for (const p of ['gmb', 'telegram', 'tumblr']) {
      expect(postMetricsSupported(p)).toBe(false);
      // A platform that reports nothing back can still carry a tracked link,
      // so link clicks remain measurable there — that's the whole point of
      // owning the redirect.
      expect(supportedMetrics(p)).toEqual(['linkClicks']);
    }
  });

  it('flags Facebook insights as permission-dependent', () => {
    // read_insights may not be granted; a 0 there is "couldn't read", not "no
    // such metric", so it stays supported but is marked conditional.
    expect(metricSupported('facebook', 'impressions')).toBe(true);
    expect(metricMayBeUnavailable('facebook', 'impressions')).toBe(true);
    expect(metricMayBeUnavailable('facebook', 'likes')).toBe(false);
    expect(metricMayBeUnavailable('x', 'impressions')).toBe(false);
  });
});
