import { useState, useMemo } from 'react';
import { localDateStr, localDaysAgo, browserTz } from '@lib/dates';
import { useQueryState } from '@lib/useQueryState';
import { useApi } from '@lib/swr';
import { platformDisplayName } from '@lib/platforms/types';
import { PlatformIcon } from '../channels/PlatformIcon';
import { FollowerChart } from './FollowerChart';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface MetricRow {
  date: string;
  channelId: number;
  platform: string;
  followers: number;
  following: number;
  impressions: number;
  reach: number;
  profileViews: number;
  websiteClicks: number;
  /** Always null — no handler computes an account-level rate. Use the
   *  per-post engagementRate from /api/analytics/engagement instead. */
  engagementRate: number | null;
  platformSpecific?: Record<string, number> | null;
}

// Friendly labels for platform-specific account metrics (camelCase keys from the
// handler's getAccountAnalytics platformSpecific). Falls back to a humanized key.
const METRIC_LABELS: Record<string, string> = {
  likesCount: 'Total Likes',
  videoCount: 'Videos',
  mediaCount: 'Posts',
  tweetCount: 'Posts',
};
function metricLabel(key: string): string {
  return METRIC_LABELS[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
}

interface ChannelInfo {
  id: number;
  platform: string;
  accountName: string;
}

interface AccountData {
  metrics: MetricRow[];
  channels: ChannelInfo[];
}

type Preset = '7d' | '30d';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function daysAgo(n: number): string {
  return localDaysAgo(n);
}

function today(): string {
  return localDateStr();
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}


/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function AccountAnalytics() {
  const [preset, setPreset] = useQueryState<Preset>('acctPreset', '30d');
  const [selectedChannel, setSelectedChannel] = useState<string>('all');

  const days = preset === '7d' ? 7 : 30;
  const from = daysAgo(days);
  const to = today();

  const channelParam = selectedChannel !== 'all' ? `&channelId=${selectedChannel}` : '';
  const { data, error: _fetchErr, isLoading: loading, mutate: refetch } = useApi<AccountData>(
    `/api/analytics/account?from=${from}&to=${to}${channelParam}`,
  );
  // Published posts per day (for the Posts column)
  const { data: summaryData } = useApi<{ byDay: Array<{ date: string; count: number; platforms: Record<string, number> }> }>(
    `/api/analytics/summary?from=${from}&to=${to}&tz=${encodeURIComponent(browserTz())}`,
  );
  const publishedByDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of summaryData?.byDay ?? []) map.set(d.date, d.count);
    return map;
  }, [summaryData?.byDay]);

  const error = _fetchErr?.message ?? null;

  const presets: { key: Preset; label: string }[] = [
    { key: '7d', label: '7 days' },
    { key: '30d', label: '30 days' },
  ];

  // Channel lookup: channelId → { platform, accountName }
  const channelMap = useMemo(() => {
    const map = new Map<number, { platform: string; accountName: string }>();
    for (const ch of data?.channels ?? []) {
      map.set(ch.id, { platform: ch.platform, accountName: ch.accountName });
    }
    return map;
  }, [data?.channels]);

  // Sort metrics ascending for trend calculation (first → last = growth)
  const sortedMetrics = useMemo(() => {
    if (!data?.metrics) return [];
    return [...data.metrics].sort((a, b) => a.date.localeCompare(b.date));
  }, [data?.metrics]);

  // Descending for display (today first)
  const displayMetrics = useMemo(() => [...sortedMetrics].reverse(), [sortedMetrics]);

  // Platform-specific account metrics (e.g. TikTok's Total Likes / Videos) from the
  // selected channel's latest snapshot. Only meaningful for a single channel, since
  // the keys differ per platform.
  const platformExtras = useMemo(() => {
    if (selectedChannel === 'all' || displayMetrics.length === 0) return [];
    const latest = displayMetrics[0]?.platformSpecific;
    if (!latest || typeof latest !== 'object') return [];
    return Object.entries(latest)
      .filter(([, v]) => typeof v === 'number' && v > 0)
      .map(([key, value]) => ({ label: metricLabel(key), value: value as number }));
  }, [displayMetrics, selectedChannel]);

  // Lookup: for each (channelId, date) find the previous day's data for that channel
  const prevDayLookup = useMemo(() => {
    const map = new Map<string, MetricRow>();
    // Group by channelId, sorted ascending
    const byChannel = new Map<number, MetricRow[]>();
    for (const row of sortedMetrics) {
      const list = byChannel.get(row.channelId) || [];
      list.push(row);
      byChannel.set(row.channelId, list);
    }
    for (const [, rows] of byChannel) {
      for (let i = 1; i < rows.length; i++) {
        map.set(`${rows[i].channelId}:${rows[i].date}`, rows[i - 1]);
      }
    }
    return map;
  }, [sortedMetrics]);

  // Get the latest snapshot value (followers/following) per channel, then sum across channels.
  // These are point-in-time counts, not cumulative — we need the most recent value per channel.
  function latestPerChannel(rows: MetricRow[], field: 'followers' | 'following'): number {
    const latest = new Map<number, number>();
    // rows are sorted ascending by date, so later entries overwrite earlier ones
    for (const r of rows) {
      latest.set(r.channelId, r[field] ?? 0);
    }
    let total = 0;
    for (const v of latest.values()) total += v;
    return total;
  }

  // Latest snapshot totals for the current (≤30-day) window. Period-over-period comparison
  // was removed: the prior period is older than the 30-day statistics-retention cap, so we
  // neither store nor display it.
  const summary = useMemo(() => {
    if (sortedMetrics.length === 0) return null;
    return {
      followers: latestPerChannel(sortedMetrics, 'followers'),
      following: latestPerChannel(sortedMetrics, 'following'),
      impressions: sortedMetrics.reduce((sum, r) => sum + (r.impressions ?? 0), 0),
      reach: sortedMetrics.reduce((sum, r) => sum + (r.reach ?? 0), 0),
    };
  }, [sortedMetrics]);

  // Cards to show: Followers + Following always; Impressions/Reach only when they have
  // data (TikTok's account API never reports them, so we hide the empty cards); then any
  // platform-specific metrics for the selected channel.
  const statCards = useMemo(() => {
    if (!summary) return [];
    const out: { label: string; value: number }[] = [
      { label: 'Followers', value: summary.followers },
      { label: 'Following', value: summary.following },
    ];
    if (summary.impressions > 0) out.push({ label: 'Impressions', value: summary.impressions });
    if (summary.reach > 0) out.push({ label: 'Reach', value: summary.reach });
    for (const e of platformExtras) out.push({ label: e.label, value: e.value });
    return out;
  }, [summary, platformExtras]);

  return (
    <div>
      {/* Section header */}
      <div className="card" style={{ padding: '14px 20px', marginBottom: '12px' }}>
        <div style={s.topBar}>
          <div style={s.presetRow}>
            <h3 style={{ ...s.sectionTitle, marginRight: '16px' }}>Account Metrics</h3>
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

          <div style={s.presetRow}>
            {data?.channels && data.channels.length > 0 && (
              <select
                className="input"
                value={selectedChannel}
                onChange={(e) => setSelectedChannel(e.target.value)}
                style={s.channelSelect}
              >
                <option value="all">All channels</option>
                {data.channels.map((ch) => (
                  <option key={ch.id} value={String(ch.id)}>
                    {ch.accountName} ({platformDisplayName(ch.platform)})
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="card" style={{ padding: '20px', textAlign: 'center', marginBottom: '12px' }}>
          <p style={{ color: 'var(--color-error)', fontWeight: 500, marginBottom: '8px' }}>{error}</p>
          <button className="btn btn-secondary btn-sm" onClick={() => refetch()}>Retry</button>
        </div>
      )}

      {/* Loading */}
      {loading && !data && (
        <div className="card" style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ color: 'var(--stone-400)', fontSize: 'var(--text-sm)' }}>Loading account metrics...</p>
        </div>
      )}

      {/* Empty state */}
      {data && sortedMetrics.length === 0 && (
        <div className="card" style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ color: 'var(--stone-500)', fontSize: 'var(--text-sm)', fontWeight: 500, marginBottom: '6px' }}>
            No account metrics yet
          </p>
          <p style={{ color: 'var(--stone-400)', fontSize: 'var(--text-xs)' }}>
            Metrics are collected automatically once your channels are connected.
          </p>
        </div>
      )}

      {data && summary && sortedMetrics.length > 0 && (
        <>
          {/* Stat cards */}
          <div style={s.cardGrid}>
            {statCards.map((card) => (
              <div key={card.label} className="card" style={s.statCard}>
                <span style={s.statLabel}>{card.label}</span>
                <span style={s.statValue}>{formatNumber(card.value)}</span>
              </div>
            ))}
          </div>

          {/* Follower Growth Chart */}
          {(() => {
            // Group by date, sum followers across channels (or single channel if filtered)
            const followerByDate = new Map<string, number>();
            for (const row of sortedMetrics) {
              const existing = followerByDate.get(row.date) ?? 0;
              followerByDate.set(row.date, existing + (row.followers ?? 0));
            }
            const chartData = Array.from(followerByDate.entries())
              .map(([date, followers]) => ({ date, followers }))
              .sort((a, b) => a.date.localeCompare(b.date));
            if (chartData.length < 2) return null;
            return (
              <div className="card" style={{ padding: '20px', marginBottom: '20px' }}>
                <h3 style={s.tableTitle}>Follower Growth</h3>
                <FollowerChart data={chartData} />
              </div>
            );
          })()}

          {/* Daily breakdown table */}
          <div className="card" style={{ overflow: 'hidden' }}>
            <div style={s.tableHeader}>
              <h3 style={s.tableTitle}>Daily Breakdown</h3>
              <span style={s.rowCount}>{sortedMetrics.length} days</span>
            </div>
            <div className="r-table-scroll" style={{ maxHeight: '400px', overflowY: 'auto' }}>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={{ ...s.th, position: 'sticky', top: 0, background: 'var(--surface-card)', zIndex: 1 }}>Date</th>
                    <th style={{ ...s.th, position: 'sticky', top: 0, background: 'var(--surface-card)', zIndex: 1 }}>Channel</th>
                    <th style={{ ...s.th, textAlign: 'right', position: 'sticky', top: 0, background: 'var(--surface-card)', zIndex: 1 }}>Followers</th>
                    <th style={{ ...s.th, textAlign: 'right', position: 'sticky', top: 0, background: 'var(--surface-card)', zIndex: 1 }}>Impressions</th>
                    <th style={{ ...s.th, textAlign: 'right', position: 'sticky', top: 0, background: 'var(--surface-card)', zIndex: 1 }}>Reach</th>
                    <th style={{ ...s.th, textAlign: 'right', position: 'sticky', top: 0, background: 'var(--surface-card)', zIndex: 1 }}>Profile Views</th>
                    <th style={{ ...s.th, textAlign: 'right', position: 'sticky', top: 0, background: 'var(--surface-card)', zIndex: 1 }}>Published</th>
                  </tr>
                </thead>
                <tbody>
                  {displayMetrics.map((row) => {
                    const d = new Date(row.date + 'T00:00:00');
                    const prev = prevDayLookup.get(`${row.channelId}:${row.date}`);
                    const fDelta = prev ? (row.followers ?? 0) - (prev.followers ?? 0) : null;
                    const iDelta = prev ? (row.impressions ?? 0) - (prev.impressions ?? 0) : null;
                    const rDelta = prev ? (row.reach ?? 0) - (prev.reach ?? 0) : null;
                    return (
                      <tr key={`${row.date}-${row.channelId}`}>
                        <td style={s.td}>
                          {d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                        </td>
                        <td style={s.td}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                            <PlatformIcon platform={row.platform as any} size="sm" />
                            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-600)' }}>
                              {channelMap.get(row.channelId)?.accountName || row.platform}
                            </span>
                          </span>
                        </td>
                        <td style={{ ...s.td, textAlign: 'right', fontFamily: 'var(--font-numeric)', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                          {formatNumber(row.followers)}
                          {fDelta != null && fDelta !== 0 && (
                            <span style={{ fontSize: '10px', marginLeft: '4px', color: fDelta > 0 ? 'var(--color-success)' : 'var(--color-error)' }}>
                              {fDelta > 0 ? '+' : ''}{fDelta}
                            </span>
                          )}
                        </td>
                        <td style={{ ...s.td, textAlign: 'right', fontFamily: 'var(--font-numeric)', fontVariantNumeric: 'tabular-nums' }}>
                          {formatNumber(row.impressions)}
                          {iDelta != null && iDelta !== 0 && (
                            <span style={{ fontSize: '10px', marginLeft: '4px', color: iDelta > 0 ? 'var(--color-success)' : 'var(--color-error)' }}>
                              {iDelta > 0 ? '+' : ''}{iDelta}
                            </span>
                          )}
                        </td>
                        <td style={{ ...s.td, textAlign: 'right', fontFamily: 'var(--font-numeric)', fontVariantNumeric: 'tabular-nums' }}>
                          {formatNumber(row.reach)}
                          {rDelta != null && rDelta !== 0 && (
                            <span style={{ fontSize: '10px', marginLeft: '4px', color: rDelta > 0 ? 'var(--color-success)' : 'var(--color-error)' }}>
                              {rDelta > 0 ? '+' : ''}{rDelta}
                            </span>
                          )}
                        </td>
                        <td style={{ ...s.td, textAlign: 'right', fontFamily: 'var(--font-numeric)', fontVariantNumeric: 'tabular-nums' }}>
                          {formatNumber(row.profileViews)}
                          {(() => {
                            const pvDelta = prev ? (row.profileViews ?? 0) - (prev.profileViews ?? 0) : null;
                            return pvDelta != null && pvDelta !== 0 ? (
                              <span style={{ fontSize: '10px', marginLeft: '4px', color: pvDelta > 0 ? 'var(--color-success)' : 'var(--color-error)' }}>
                                {pvDelta > 0 ? '+' : ''}{pvDelta}
                              </span>
                            ) : null;
                          })()}
                        </td>
                        <td style={{ ...s.td, textAlign: 'right', fontFamily: 'var(--font-numeric)', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: 'var(--color-success)' }}>
                          {publishedByDate.get(row.date) || '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const s: Record<string, React.CSSProperties> = {
  topBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: '12px',
  },
  presetRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  sectionTitle: {
    fontSize: 'var(--text-sm)',
    fontWeight: 600,
    color: 'var(--stone-800)',
    margin: 0,
  },
  channelSelect: {
    padding: '5px 10px',
    fontSize: 'var(--text-sm)',
    minWidth: '180px',
    // Matches the Media Library's "Search files" field — .input has no border of
    // its own, so on a white card the control had no visible edge at all.
    border: '2px solid var(--surface-card)',
  },
  cardGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: '12px',
    marginBottom: '12px',
  },
  statCard: {
    padding: '16px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  statLabel: {
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    color: 'var(--stone-500)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  statValue: {
    fontSize: 'var(--text-xl)',
    fontWeight: 700,
    color: 'var(--stone-800)',
    fontFamily: 'var(--font-numeric)', fontVariantNumeric: 'tabular-nums',
  },
  statChange: {
    fontSize: 'var(--text-xs)',
    fontWeight: 500,
  },
  tableHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 20px',
    borderBottom: 'none',
  },
  tableTitle: {
    fontSize: 'var(--text-sm)',
    fontWeight: 600,
    color: 'var(--stone-800)',
    margin: 0,
  },
  rowCount: {
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-400)',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 'var(--text-sm)',
  },
  th: {
    padding: '10px 20px',
    textAlign: 'left',
    fontSize: '11px',
    fontWeight: 600,
    color: 'var(--stone-500)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    borderBottom: 'none',
  },
  td: {
    padding: '10px 20px',
    borderBottom: 'none',
    color: 'var(--stone-700)',
    fontSize: '13px',
  },
};
