import { useState, useEffect } from 'react';
import { sectionStyles } from '../posts/detail-section';
import { platformDisplayName } from '@lib/platforms/types';

interface PlatformMetrics {
  platform: string;
  platformPostId: string | null;
  platformUrl: string | null;
  status: string;
  /** Metrics this channel's API can report; the rest are stored zeros. */
  supportedMetrics?: string[];
  metricsSupported?: boolean;
  /**
   * Clicks on our own tracked shortlinks. Sits outside `latest` because it
   * is not a platform snapshot — it exists even when the platform reports
   * nothing at all.
   */
  linkClicks?: number;
  latest: {
    impressions: number;
    reach: number;
    likes: number;
    comments: number;
    shares: number;
    saves: number;
    clicks: number;
    videoViews: number;
    engagementRate: number;
    platformSpecificMetrics: Record<string, number>;
    fetchedAt: string;
  } | null;
  history: Array<{
    impressions: number;
    likes: number;
    comments: number;
    shares: number;
    fetchedAt: string;
  }>;
}

interface MetricsResponse {
  postId: number;
  platforms: PlatformMetrics[];
  totals: {
    impressions: number;
    likes: number;
    comments: number;
    shares: number;
    clicks: number;
    videoViews: number;
    linkClicks?: number;
  };
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatRate(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(2)}%`;
}

const STAT_DEFS: { key: string; label: string }[] = [
  { key: 'impressions', label: 'Impressions' },
  { key: 'reach', label: 'Reach' },
  { key: 'likes', label: 'Likes' },
  { key: 'comments', label: 'Comments' },
  { key: 'shares', label: 'Shares' },
  { key: 'saves', label: 'Saves' },
  { key: 'clicks', label: 'Clicks' },
  { key: 'videoViews', label: 'Video Views' },
  { key: 'engagementRate', label: 'Eng. Rate' },
  // Ours, not the platform's — labelled "Link clicks" everywhere so it is never
  // read as the platform's own `clicks` figure.
  { key: 'linkClicks', label: 'Link clicks' },
];

/** True when at least one channel on the post can report `metric`. */
function supportsAny(platforms: PlatformMetrics[], metric: string): boolean {
  // Unknown support (older payload) => assume yes, matching prior behaviour.
  return platforms.some((p) => !p.supportedMetrics || p.supportedMetrics.includes(metric));
}

/**
 * The metrics worth a cell for this platform. Prefers the server's per-platform
 * support list; falls back to the old non-zero heuristic for cached responses
 * that predate the field.
 */
function visibleStats(p: PlatformMetrics): { key: string; label: string }[] {
  const stats = p.supportedMetrics
    ? STAT_DEFS.filter((s) => p.supportedMetrics!.includes(s.key))
    : STAT_DEFS.filter((s) => ((p.latest as Record<string, number> | null)?.[s.key] ?? 0) > 0);
  return stats.filter((s) => {
    // Only worth a cell once the post actually carries a tracked link — else
    // every post from before link tracking was on shows "0 link clicks".
    if (s.key === 'linkClicks') return (p.linkClicks ?? 0) > 0;
    // Everything else is read off the snapshot, which may not exist.
    return Boolean(p.latest);
  });
}

/** Reads a stat off the right source: link clicks are ours, the rest are the platform's. */
function statValue(p: PlatformMetrics, key: string): number {
  if (key === 'linkClicks') return p.linkClicks ?? 0;
  return ((p.latest as unknown as Record<string, number> | null)?.[key] ?? 0);
}

export function PostMetrics({ postId }: { postId: number }) {
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    fetch(`/api/posts/${postId}/metrics`)
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [postId]);

  if (loading) return null;
  // Link clicks are measured by us, so a post can have them with no platform
  // snapshot at all (Google Business, Telegram, or simply not synced yet).
  // Gating purely on `latest` would hide those posts' only real number.
  const hasAnything =
    data && data.platforms.some((p) => p.latest || (p.linkClicks ?? 0) > 0);
  if (!hasAnything) return null;

  const { totals } = data;
  // Show the panel whenever a snapshot exists (the guard above). Gating on
  // "impressions or likes > 0" hid Performance entirely for a synced post that
  // genuinely has no engagement yet, and for Bluesky/Mastodon posts, which
  // report no impressions at all — both read as "metrics are broken".

  return (
    // No margin of its own — the details pane's root gap sets the rhythm, and a
    // local margin made this section sit further apart than the others.
    <div style={sectionStyles.card}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          width: '100%',
          padding: 0,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          fontSize: 'var(--text-sm)',
          fontWeight: 600,
          color: 'var(--stone-700)',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 12V8l3-2 3 3 3-5 3 2v6H2z" />
        </svg>
        Performance
        <div style={{ display: 'flex', gap: '12px', marginLeft: 'auto', fontSize: '12px', fontWeight: 500, color: 'var(--stone-500)' }}>
          {/* Drop "views" when no channel on this post reports impressions —
              a Bluesky/Mastodon-only post would otherwise lead with "0 views". */}
          {supportsAny(data.platforms, 'impressions') && <span>{formatNumber(totals.impressions)} views</span>}
          <span>{formatNumber(totals.likes)} likes</span>
          <span>{formatNumber(totals.comments)} comments</span>
          {(totals.linkClicks ?? 0) > 0 && (
            <span>{formatNumber(totals.linkClicks!)} link clicks</span>
          )}
        </div>
        <svg
          width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"
          strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 150ms ease', flexShrink: 0 }}
        >
          <polyline points="2,4 6,8 10,4" />
        </svg>
      </button>

      {expanded && (
        <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {data.platforms.filter((p) => p.latest || (p.linkClicks ?? 0) > 0).map((p) => (
            <div key={p.platform} style={{
              padding: '12px 14px',
              background: 'var(--stone-50)',
              border: '1px solid var(--stone-100)',
              borderRadius: '10px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--stone-700)' }}>
                  {platformDisplayName(p.platform)}
                </span>
                {p.platformUrl && (
                  <a href={p.platformUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: '11px', color: 'var(--accent-500)' }}>
                    View post
                  </a>
                )}
                {p.latest && (
                  <span style={{ fontSize: '10px', color: 'var(--stone-400)', marginLeft: 'auto' }}>
                    Updated {new Date(p.latest.fetchedAt).toLocaleString()}
                  </span>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(80px, 1fr))', gap: '8px' }}>
                {/* Driven by what the platform CAN report, not by which numbers
                    happen to be non-zero. The old `> 0` gate hid a genuine
                    measured zero ("0 comments" silently vanished, reading as a
                    sync failure) while never explaining the metrics the platform
                    has no field for at all. */}
                {visibleStats(p).map((s) => (
                  s.key === 'engagementRate' ? (
                    <div key={s.key} style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--stone-800)' }}>
                        {formatRate(p.latest!.engagementRate)}
                      </div>
                      <div style={{ fontSize: '10px', color: 'var(--stone-400)', marginTop: '2px' }}>Eng. Rate</div>
                    </div>
                  ) : (
                    <MiniStat key={s.key} label={s.label} value={statValue(p, s.key)} />
                  )
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--stone-800)' }}>
        {formatNumber(value)}
      </div>
      <div style={{ fontSize: '10px', color: 'var(--stone-400)', marginTop: '2px' }}>{label}</div>
    </div>
  );
}
