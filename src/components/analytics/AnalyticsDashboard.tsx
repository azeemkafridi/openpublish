import { useState, useCallback, useMemo } from 'react';
import { localDateStr, localDaysAgo, browserTz } from '@lib/dates';
import { StatCard } from '../overview/StatCard';
import { PostsBarChart } from './PostsBarChart';
import { ChannelBreakdown } from './ChannelBreakdown';
import { PostingHeatmap } from './PostingHeatmap';
import { StatIcons } from '../ui/StatIcons';
import { EngagementChart } from './EngagementChart';
import { TopPosts } from './TopPosts';
import { AnalyticsEmptyState } from '../ui/EmptyState';
import { useQueryState } from '@lib/useQueryState';
import { useApi } from '@lib/swr';
import { platformDisplayName } from '@lib/platforms/types';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface StatusCount {
  status: string;
  count: number;
}

interface PlatformCount {
  platform: string;
  count: number;
}

interface DayCount {
  date: string;
  count: number;
}

interface SummaryData {
  byStatus: StatusCount[];
  byPlatform: PlatformCount[];
  byDay: DayCount[];
}

type Preset = '7d' | '30d' | 'custom';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function getCount(byStatus: StatusCount[], status: string): number {
  return byStatus.find((s) => s.status === status)?.count ?? 0;
}

function daysAgo(n: number): string {
  return localDaysAgo(n);
}

function today(): string {
  return localDateStr();
}


/* ------------------------------------------------------------------ */
/*  Skeleton                                                           */
/* ------------------------------------------------------------------ */

const shimmer: React.CSSProperties = {
  background: 'linear-gradient(90deg, var(--stone-100) 25%, var(--stone-150) 50%, var(--stone-100) 75%)',
  backgroundSize: '200% 100%',
  animation: 'shimmer 1.5s ease-in-out infinite',
  borderRadius: 'var(--radius-sm)',
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function AnalyticsDashboard() {
  const [preset, setPreset] = useQueryState<Preset>('preset', '30d');
  const [customFrom, setCustomFrom] = useState(daysAgo(30));
  const [customTo, setCustomTo] = useState(today());
  const getDateRange = useCallback((): { from: string; to: string } => {
    if (preset === 'custom') {
      // Clamp the custom start to the 30-day cap, and fall back gracefully when a field is
      // cleared so we never query an empty or inverted range. The data re-fetches on change
      // (the SWR key is derived from this), so there's no Apply step.
      const floor = daysAgo(30);
      const from = !customFrom || customFrom < floor ? floor : customFrom;
      const to = customTo || today();
      return { from, to: to < from ? from : to };
    }
    const days = preset === '7d' ? 7 : 30;
    return { from: daysAgo(days), to: today() };
  }, [preset, customFrom, customTo]);

  const { from: _from, to: _to } = getDateRange();
  const { data: _raw, error: _fetchErr, isLoading: loading, mutate: refetch } = useApi<any>(
    `/api/analytics/summary?from=${_from}&to=${_to}&tz=${encodeURIComponent(browserTz())}&heatmap=1`,
  );
  const [engChannelId, setEngChannelId] = useState<string>('');
  const engUrl = `/api/analytics/engagement?from=${_from}&to=${_to}${engChannelId ? `&channelId=${engChannelId}` : ''}`;
  const { data: engagementData, mutate: refetchEngagement } = useApi<any>(engUrl);
  const { data: channelsData } = useApi<any>('/api/channels');
  const error = _fetchErr?.message ?? null;
  const data: SummaryData | null = useMemo(() => {
    if (!_raw) return null;
    // byPlatform comes as an object { facebook: { total, published, failed } } — convert to array
    const rawPlatform = _raw.byPlatform ?? {};
    const byPlatform = Array.isArray(rawPlatform)
      ? rawPlatform
      : Object.entries(rawPlatform).map(([platform, d]: [string, any]) => ({ platform, count: d.total ?? 0 }));
    // API returns flat fields (published, scheduled, failed, partial) — build byStatus array
    const byStatus = Array.isArray(_raw.byStatus) ? _raw.byStatus : [
      { status: 'published', count: _raw.published ?? 0 },
      { status: 'scheduled', count: _raw.scheduled ?? 0 },
      { status: 'failed', count: _raw.failed ?? 0 },
      { status: 'partial', count: _raw.partial ?? 0 },
    ];
    return { byStatus, byPlatform, byDay: _raw.byDay ?? [] };
  }, [_raw]);

  const [refreshing, setRefreshing] = useState(false);
  // What the last refresh actually did. The button used to fire and ignore the
  // response entirely: a `{status:'throttled'}` reply still showed "Refreshing…"
  // for 3s and then the same stale numbers, which reads as "refresh is broken".
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const handleRefreshMetrics = async () => {
    setRefreshing(true);
    setRefreshNote(null);
    try {
      const res = await fetch('/api/analytics/refresh?force=1', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const body = await res.json().catch(() => null);
      if (body?.status === 'throttled') {
        setRefreshNote('Recently refreshed. Try again in a minute.');
        setRefreshing(false);
        return;
      }
      // A sync is a queued background job that fans out one platform read per
      // channel; it does not finish in 3s. Say so instead of implying the
      // numbers on screen are now current.
      setRefreshNote('Sync queued. New numbers appear once it finishes.');
      setTimeout(() => {
        refetchEngagement();
        setRefreshing(false);
      }, 3000);
    } catch {
      setRefreshNote('Could not start a refresh.');
      setRefreshing(false);
    }
  };

  /* --- Preset buttons --- */
  const presets: { key: Preset; label: string }[] = [
    { key: '7d', label: 'Last 7 days' },
    { key: '30d', label: 'Last 30 days' },
    { key: 'custom', label: 'Custom' },
  ];

  return (
    <div>
      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>

      {/* Date range picker */}
      <div className="card" style={{ padding: '16px 20px', marginBottom: '20px' }}>
        <div style={styles.datePickerRow}>
          <div style={styles.presetButtons}>
            {presets.map((p) => (
              <button
                key={p.key}
                className={preset === p.key ? 'btn btn-active btn-sm' : 'btn btn-ghost btn-sm'}
                onClick={() => setPreset(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>

          {preset === 'custom' && (
            <div style={styles.customInputs}>
              <label style={styles.dateLabel}>
                From
                <input
                  type="date"
                  className="input r-date-input"
                  value={customFrom}
                  min={daysAgo(30)}
                  max={today()}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  style={styles.dateInput}
                />
              </label>
              <label style={styles.dateLabel}>
                To
                <input
                  type="date"
                  className="input r-date-input"
                  value={customTo}
                  min={daysAgo(30)}
                  max={today()}
                  onChange={(e) => setCustomTo(e.target.value)}
                  style={styles.dateInput}
                />
              </label>
            </div>
          )}

        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="card" style={{ padding: '24px', textAlign: 'center', marginBottom: '20px' }}>
          <p style={{ color: 'var(--color-error)', fontWeight: 500, marginBottom: '8px' }}>
            {error}
          </p>
          <button className="btn btn-secondary btn-sm" onClick={() => refetch()}>
            Retry
          </button>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !data && (
        <>
          <div className="r-stats-grid" style={styles.statsGrid}>
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="card"
                style={{ padding: '20px', borderLeft: 'none' }}
              >
                <div style={{ ...shimmer, width: '60px', height: '32px', marginBottom: '8px' }} />
                <div style={{ ...shimmer, width: '80px', height: '14px' }} />
              </div>
            ))}
          </div>
          <div className="r-charts-row" style={styles.chartsRow}>
            <div className="card" style={{ padding: '20px', flex: 2 }}>
              <div style={{ ...shimmer, width: '100%', height: '240px' }} />
            </div>
            <div className="card" style={{ padding: '20px', flex: 1 }}>
              <div style={{ ...shimmer, width: '100%', height: '240px' }} />
            </div>
          </div>
        </>
      )}

      {/* Empty state — no data at all */}
      {data && data.byStatus.every((s) => s.count === 0) && data.byDay.length === 0 && (
        <AnalyticsEmptyState />
      )}

      {/* Data loaded */}
      {data && !(data.byStatus.every((s) => s.count === 0) && data.byDay.length === 0) && (
        <>
          {/* Summary stat cards */}
          <div className="stagger-children r-stats-grid" style={styles.statsGrid}>
            <StatCard
              label="Published"
              // partial = live on at least one channel; display-level merge
              // (the byStatus buckets stay separate so Total doesn't double-count)
              value={getCount(data.byStatus, 'published') + getCount(data.byStatus, 'partial')}
              color="green"
              icon={StatIcons.published}
            />
            <StatCard
              label="Scheduled"
              value={getCount(data.byStatus, 'scheduled')}
              color="purple"
              icon={StatIcons.scheduled}
            />
            <StatCard
              label="Failed"
              value={getCount(data.byStatus, 'failed')}
              color="red"
              icon={StatIcons.failed}
            />
            <StatCard
              label="Total"
              // summary.totalPosts counts EVERY status in range. Summing the
              // byStatus buckets instead silently dropped draft / publishing /
              // processing posts (27 drafts in prod on 2026-07-28), so "Total"
              // was smaller than the real post count and disagreed with the
              // posts list. Fall back to the sum only for older payloads.
              value={_raw?.totalPosts ?? data.byStatus.reduce((s, r) => s + r.count, 0)}
              color="blue"
              icon={StatIcons.total}
            />
          </div>

          {/* Charts */}
          <div className="r-charts-row" style={styles.chartsRow}>
            <div className="card" style={{ padding: '20px', flex: 2, minWidth: 0 }}>
              <h3 style={styles.chartTitle}>Posts Over Time</h3>
              <PostsBarChart data={data.byDay} from={_from} to={_to} />
            </div>
            <div className="card" style={{ padding: '20px', flex: 1, minWidth: 0 }}>
              <ChannelBreakdown data={data.byPlatform} />
            </div>
          </div>

          {/* Posting activity heatmap — when each post went out (day × hour) */}
          <div className="card" style={{ padding: '20px', marginTop: '16px' }}>
            <PostingHeatmap
              publishedTimes={_raw?.publishedTimes ?? []}
              from={_from}
              to={_to}
            />
          </div>

          {/* Engagement Section */}
          {engagementData && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '28px 0 16px', flexWrap: 'wrap', gap: '10px' }}>
                <h2 style={{ fontSize: 'var(--text-xl)', fontFamily: 'var(--font-display)', color: 'var(--stone-900)', margin: 0 }}>
                  Engagement
                </h2>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <select
                    className="input"
                    value={engChannelId}
                    onChange={(e) => setEngChannelId(e.target.value)}
                    style={{ fontSize: 'var(--text-sm)', padding: '4px 8px', height: 'var(--control-height-sm)', minWidth: '140px' }}
                  >
                    <option value="">All Channels</option>
                    {(channelsData?.channels ?? []).map((ch: any) => (
                      <option key={ch.id} value={ch.id}>
                        {ch.accountName || ch.platform} ({ch.platform})
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={handleRefreshMetrics}
                    disabled={refreshing}
                    style={{ fontSize: '12px' }}
                  >
                    {refreshing ? 'Syncing...' : 'Refresh Metrics'}
                  </button>
                </div>
              </div>

              {/* These tiles are a synced snapshot (every 6h, or on demand via
                  Refresh Metrics) — not a live read like the per-post
                  engagement pane. Say so, and say what Refresh actually did. */}
              <div style={{ fontSize: '12px', color: 'var(--stone-500)', margin: '-8px 0 12px' }}>
                Synced snapshot, updated every 6 hours.
                {refreshNote ? ` ${refreshNote}` : ''}
              </div>

              {engagementData.metricsDisabledChannels?.length > 0 && (
                // X reads are billed, so its metrics sync is off until enabled
                // per channel. Nothing on this page said so — the numbers just
                // stayed 0 and Refresh Metrics appeared to do nothing.
                <div style={{ fontSize: '12px', color: 'var(--stone-500)', margin: '0 0 12px' }}>
                  Metrics sync is off for{' '}
                  {engagementData.metricsDisabledChannels
                    .map((c: any) => `${c.accountName || platformDisplayName(c.platform)} (${platformDisplayName(c.platform)})`)
                    .join(', ')}
                  , so their posts show 0. X charges for every read, so it is opt-in per channel and
                  syncs at most once a week. Enable it on the{' '}
                  <a href="/channels" style={{ color: 'var(--accent-500)' }}>Channels</a> page.
                </div>
              )}

              {engagementData.unmeasuredPlatforms?.length > 0 && (
                // Without this, a Google Business or Telegram post renders a
                // confident "0 impressions / 0 likes" for a platform that never
                // reports any figure at all.
                <div style={{ fontSize: '12px', color: 'var(--stone-500)', margin: '0 0 12px' }}>
                  {/* "aren't available", not "do not report": for Tumblr the
                      platform reports a combined notes total we can't split,
                      and LinkedIn personal analytics need an approval-gated
                      API product — "does not report" would state a falsehood
                      about the platform itself. */}
                  Per-post metrics aren&apos;t available for{' '}
                  {engagementData.unmeasuredPlatforms.map(platformDisplayName).join(', ')}, so their
                  posts count as 0 in these totals.
                </div>
              )}

              <div className="stagger-children r-stats-grid" style={styles.statsGrid}>
                <EngagementStat metric="impressions" label="Impressions" value={engagementData.totalImpressions} data={engagementData} color="blue" icon={StatIcons.impressions} />
                <EngagementStat metric="likes" label="Likes" value={engagementData.totalLikes} data={engagementData} color="red" icon={StatIcons.likes} />
                <EngagementStat metric="comments" label="Comments" value={engagementData.totalComments} data={engagementData} color="purple" icon={StatIcons.comments} />
                <EngagementStat metric="shares" label="Shares" value={engagementData.totalShares} data={engagementData} color="green" icon={StatIcons.shares} />
              </div>

              <div className="stagger-children r-stats-grid" style={{ ...styles.statsGrid, marginTop: '-4px' }}>
                <EngagementStat metric="reach" label="Reach" value={engagementData.totalReach} data={engagementData} color="blue" icon={StatIcons.reach} />
                <EngagementStat metric="saves" label="Saves" value={engagementData.totalSaves} data={engagementData} color="purple" icon={StatIcons.saves} />
                <EngagementStat metric="videoViews" label="Video Views" value={engagementData.totalVideoViews} data={engagementData} color="red" icon={StatIcons.videoViews} />
                <EngagementStat metric="clicks" label="Clicks" value={engagementData.totalClicks} data={engagementData} color="green" icon={StatIcons.clicks} />
              </div>

              {/* Link tracking is opt-in, so this row only appears once the org
                  has clicks to show — otherwise every account would carry a
                  permanently-zero card for a feature it never turned on. It is
                  kept separate from the platform metrics above because we
                  measure it ourselves, on our own redirector. */}
              {(engagementData.totalLinkClicks ?? 0) > 0 && (
                <div className="stagger-children r-stats-grid" style={{ ...styles.statsGrid, marginTop: '-4px' }}>
                  <div title="Clicks on tracked links. Available with openPublish cloud link tracking.">
                    <StatCard
                      label="Link clicks"
                      value={engagementData.totalLinkClicks}
                      color="blue"
                      icon={StatIcons.clicks}
                    />
                  </div>
                </div>
              )}

              <div className="r-charts-row" style={styles.chartsRow}>
                <div className="card" style={{ padding: '20px', flex: 2, minWidth: 0 }}>
                  <h3 style={styles.chartTitle}>Engagement Over Time</h3>
                  <EngagementChart data={engagementData.byDay ?? []} />
                </div>
                <div className="card" style={{ padding: '20px', flex: 1, minWidth: 0, maxHeight: '320px', overflow: 'auto' }}>
                  <h3 style={styles.chartTitle}>Top Posts</h3>
                  <TopPosts posts={engagementData.topPosts ?? []} />
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Metric-support-aware stat cards                                    */
/* ------------------------------------------------------------------ */

/**
 * A total is only a measurement if some platform in range actually reports that
 * metric. X has no reach/saves/clicks/videoViews fields at all, so for an X-only
 * org those four summed to a confident "0" that read as broken analytics. Render
 * an em dash instead, and say which platforms are missing when only some report.
 */
function EngagementStat({
  metric, label, value, data, color, icon,
}: {
  metric: string;
  label: string;
  value: number | undefined;
  data: any;
  color: 'green' | 'purple' | 'red' | 'blue';
  icon?: React.ReactNode;
}) {
  // Older cached payloads have no support info — fall back to showing the number
  // rather than dashing everything out.
  const supported: string[] | undefined = data.supportedTotals;
  const isSupported = !supported || supported.includes(metric);
  const missing: string[] = data.partialTotals?.[metric] ?? [];

  // Platforms that CAN report this metric but only with an extra permission
  // (today: Facebook's Page Insights / read_insights). Explained in the tooltip
  // rather than a page-level footnote — the note repeated for every metric and
  // pushed the charts below the fold.
  const permissionGated = Object.entries((data.conditionalMetrics ?? {}) as Record<string, string[]>)
    .filter(([, keys]) => keys.includes(metric))
    .map(([platform]) => platformDisplayName(platform));

  const title = [
    !isSupported
      ? `No connected platform in this period reports ${label.toLowerCase()}.`
      : missing.length > 0
        ? `Not reported by ${missing.map(platformDisplayName).join(', ')}. Their posts are excluded from this total.`
        : '',
    permissionGated.length > 0 && isSupported
      ? `${permissionGated.join(', ')} ${permissionGated.length === 1 ? 'reports' : 'report'} this via Page Insights, which needs the read_insights permission. Reconnect the channel if it stays at 0.`
      : '',
  ].filter(Boolean).join(' ');

  return (
    <div title={title || undefined}>
      <StatCard
        label={missing.length > 0 && isSupported ? `${label} *` : label}
        value={isSupported ? (value ?? 0) : '—'}
        color={color}
        icon={icon}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const styles: Record<string, React.CSSProperties> = {
  datePickerRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '12px',
  },
  presetButtons: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  customInputs: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '10px',
    marginLeft: 'auto',
  },
  dateLabel: {
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-500)',
    fontWeight: 500,
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  dateInput: {
    width: '160px',
  },
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: '16px',
    marginBottom: '20px',
  },
  chartsRow: {
    display: 'flex',
    gap: '16px',
  },
  chartTitle: {
    fontSize: 'var(--text-lg)',
    fontFamily: 'var(--font-display)',
    color: 'var(--stone-900)',
    marginBottom: '16px',
  },
};
