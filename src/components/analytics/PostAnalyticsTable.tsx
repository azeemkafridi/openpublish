import { useEffect, useMemo, useState } from 'react';
import { localDateStr, localDaysAgo, browserTz } from '@lib/dates';
import { useQueryState } from '@lib/useQueryState';
import { useApi } from '@lib/swr';
import { platformDisplayName } from '@lib/platforms/types';
import { PlatformDots } from '../channels/PlatformIcon';
import { AnalyticsPostPreview, type PreviewPost } from './AnalyticsPostPreview';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface PlatformMetric {
  platform: string;
  platformUrl: string | null;
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  clicks: number;
  videoViews: number;
  /** Clicks on our tracked shortlinks — not the platform's own `clicks`. */
  linkClicks?: number;
}

interface PostRow {
  postId: number;
  content: string;
  thumbnail?: string;
  publishedAt: string;
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  clicks: number;
  videoViews: number;
  /** Clicks on our tracked shortlinks — not the platform's own `clicks`. */
  linkClicks?: number;
  engagementRate: number;
  platforms: Array<{ platform: string; platformUrl: string | null }>;
  platformMetrics: PlatformMetric[];
}

interface EngagementData {
  allPosts: PostRow[];
  [key: string]: unknown;
}

type SortField = 'date' | 'impressions' | 'likes' | 'comments' | 'shares' | 'linkClicks';
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

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const PRESETS: { key: Preset; label: string }[] = [
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
];

const SORT_OPTIONS: { value: SortField; label: string }[] = [
  { value: 'date', label: 'Most recent' },
  { value: 'impressions', label: 'Impressions' },
  { value: 'likes', label: 'Likes' },
  { value: 'comments', label: 'Comments' },
  { value: 'shares', label: 'Shares' },
  { value: 'linkClicks', label: 'Link clicks' },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function PostAnalyticsTable() {
  const [preset, setPreset] = useQueryState<Preset>('postPreset', '30d');
  const [sort, setSort] = useState<SortField>('date');
  const [channelId, setChannelId] = useState('');
  // A `?post=<id>` deep-link selects that post once it's in the list.
  const linkedPostId = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const p = new URLSearchParams(window.location.search).get('post');
    return p ? parseInt(p, 10) : null;
  }, []);
  const [selectedPostId, setSelectedPostId] = useState<number | null>(linkedPostId);
  const [page, setPage] = useState(1);
  const perPage = 25;

  const days = preset === '7d' ? 7 : 30;
  const from = daysAgo(days);
  const to = today();
  const channelParam = channelId ? `&channelId=${channelId}` : '';

  const { data, isLoading } = useApi<EngagementData>(
    `/api/analytics/engagement?from=${from}&to=${to}&sort=${sort}&order=desc${channelParam}`,
  );
  const { data: channelsData } = useApi<{ channels: Array<{ id: number; platform: string; accountName: string }> }>('/api/channels');

  const posts = data?.allPosts ?? [];
  const totalPages = Math.ceil(posts.length / perPage);
  const paginated = posts.slice(0, page * perPage);

  // Keep a valid selection: prefer the existing one, then the deep-linked post, then the
  // first post. Re-runs whenever the list changes (sort / filter / period).
  useEffect(() => {
    if (posts.length === 0) {
      if (selectedPostId !== null) setSelectedPostId(null);
      return;
    }
    const stillThere = selectedPostId != null && posts.some((p) => p.postId === selectedPostId);
    if (!stillThere) {
      const linked = linkedPostId != null && posts.some((p) => p.postId === linkedPostId) ? linkedPostId : null;
      setSelectedPostId(linked ?? posts[0].postId);
    }
  }, [posts, selectedPostId, linkedPostId]);

  // A `?post=<id>` link lands on a post that may sort past the first page, so the
  // preview rendered it while the list showed no selection at all. Page forward
  // until the row exists, then scroll it into view once.
  const selectedIndex = posts.findIndex((p) => p.postId === selectedPostId);
  useEffect(() => {
    if (selectedIndex >= 0 && selectedIndex >= page * perPage) {
      setPage(Math.ceil((selectedIndex + 1) / perPage));
    }
  }, [selectedIndex, page]);

  const [didScroll, setDidScroll] = useState(false);
  useEffect(() => {
    if (didScroll || linkedPostId == null || selectedPostId !== linkedPostId) return;
    const el = document.querySelector(`[data-post-row="${linkedPostId}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setDidScroll(true);
  }, [didScroll, linkedPostId, selectedPostId, paginated.length]);

  const selectedPost = useMemo(
    () => (posts.find((p) => p.postId === selectedPostId) ?? null) as PreviewPost | null,
    [posts, selectedPostId],
  );

  return (
    <div>
      {/* Controls */}
      <div className="card" style={{ padding: '14px 20px', marginBottom: '12px' }}>
        <div style={s.controls}>
          <div style={s.presetRow}>
            {PRESETS.map((p) => (
              <button
                key={p.key}
                className={preset === p.key ? 'btn btn-active btn-sm' : 'btn btn-ghost btn-sm'}
                onClick={() => { setPreset(p.key); setPage(1); }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div style={s.presetRow}>
            <div style={s.selectWrap}>
              <select
                className="input"
                value={sort}
                onChange={(e) => { setSort(e.target.value as SortField); setPage(1); }}
                style={s.select}
                aria-label="Sort posts"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>Sort: {o.label}</option>
                ))}
              </select>
              <ChevronIcon />
            </div>
            {channelsData?.channels && channelsData.channels.length > 0 && (
              <div style={s.selectWrap}>
                <select
                  className="input"
                  value={channelId}
                  onChange={(e) => { setChannelId(e.target.value); setPage(1); }}
                  style={s.select}
                  aria-label="Filter by channel"
                >
                  <option value="">All Channels</option>
                  {channelsData.channels.map((ch) => (
                    <option key={ch.id} value={ch.id}>
                      {ch.accountName} ({platformDisplayName(ch.platform)})
                    </option>
                  ))}
                </select>
                <ChevronIcon />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="card" style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ color: 'var(--stone-400)', fontSize: 'var(--text-sm)' }}>Loading post metrics...</p>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && posts.length === 0 && (
        <div className="card" style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ color: 'var(--stone-500)', fontSize: 'var(--text-sm)', fontWeight: 500 }}>
            No published posts in this period
          </p>
          <p style={{ color: 'var(--stone-400)', fontSize: 'var(--text-xs)', marginTop: '6px', maxWidth: '440px', marginInline: 'auto', lineHeight: 1.5 }}>
            Published posts appear here right away; engagement numbers fill in once the
            next metrics sync runs. Note: TikTok only reports metrics for public videos, so
            posts published privately (e.g. while a TikTok app is still unaudited) won't have them.
          </p>
        </div>
      )}

      {/* Split: post list (left) + live preview pane (right) */}
      {!isLoading && posts.length > 0 && (
        <div className="r-analytics-split" style={s.split}>
          {/* Left — compact, selectable list */}
          <div className="card" style={{ overflow: 'hidden' }}>
            <div style={s.listHead}>
              Posts <span style={s.headCount}>{posts.length}</span>
            </div>
            <div style={s.list}>
              {paginated.map((post) => (
                <PostListItem
                  key={post.postId}
                  post={post}
                  selected={post.postId === selectedPostId}
                  onSelect={() => setSelectedPostId(post.postId)}
                />
              ))}
            </div>
            {page < totalPages && (
              <div style={s.loadMore}>
                <button className="btn btn-ghost btn-sm" onClick={() => setPage((p) => p + 1)}>
                  Show more ({posts.length - paginated.length} remaining)
                </button>
              </div>
            )}
          </div>

          {/* Right — sticky live preview with real engagement */}
          <div className="r-analytics-preview">
            <AnalyticsPostPreview post={selectedPost} />
          </div>
        </div>
      )}

      <style>{`
        .r-analytics-split { display: grid; grid-template-columns: 3fr 2fr; gap: 16px; align-items: start; }
        .r-analytics-preview { position: sticky; top: 16px; }
        .r-analytics-row:hover { background: var(--stone-100); }
        .r-analytics-row[aria-pressed="true"]:hover { background: var(--stone-150); }
        @media (max-width: 900px) {
          .r-analytics-split { grid-template-columns: 1fr; }
          .r-analytics-preview { position: static; }
        }
      `}</style>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Schedule-picker-style select chevron                              */
/* ------------------------------------------------------------------ */

function ChevronIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="var(--stone-400)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}
    >
      <polyline points="4 6 8 10 12 6" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Compact list item                                                 */
/* ------------------------------------------------------------------ */

function PostListItem({ post, selected, onSelect }: { post: PostRow; selected: boolean; onSelect: () => void }) {
  const d = new Date(post.publishedAt);
  return (
    <button
      type="button"
      onClick={onSelect}
      data-post-row={post.postId}
      className="r-analytics-row"
      style={{ ...s.item, ...(selected ? s.itemSelected : {}) }}
      aria-pressed={selected}
    >
      {post.thumbnail ? (
        <div style={s.thumb}>
          <img src={post.thumbnail} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>
      ) : (
        <div style={{ ...s.thumb, background: selected ? 'var(--surface-main)' : 'var(--stone-100)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--stone-300)' }}>T</span>
        </div>
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <p style={s.itemContent}>{post.content || '(no text)'}</p>
        <div style={s.itemMeta}>
          <PlatformDots platforms={post.platforms.map((p) => p.platform)} />
          <span style={s.itemDate}>{d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
        </div>
      </div>
      <div style={s.itemMetric}>
        <span style={s.itemMetricValue}>{formatNumber(post.impressions)}</span>
        <span style={s.itemMetricLabel}>impressions</span>
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const s: Record<string, React.CSSProperties> = {
  controls: {
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
  select: {
    appearance: 'none',
    paddingRight: '36px',
    cursor: 'pointer',
    minWidth: '150px',
    // Same edge as the Media Library's "Search files" field.
    border: '2px solid var(--surface-card)',
  },
  selectWrap: {
    position: 'relative',
    display: 'inline-flex',
  },
  split: {
    // grid layout is defined in the scoped <style> so it can stack on mobile
  },
  listHead: {
    padding: '14px 18px',
    fontSize: '11px',
    fontWeight: 600,
    color: 'var(--stone-500)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    borderBottom: '1px solid var(--stone-100)',
  },
  headCount: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '18px',
    height: '18px',
    padding: '0 5px',
    marginLeft: '6px',
    borderRadius: 'var(--radius-pill)',
    background: 'var(--stone-150)',
    color: 'var(--stone-500)',
    fontSize: '10px',
    fontWeight: 600,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    width: '100%',
    padding: '12px 18px',
    border: 'none',
    borderLeft: '3px solid transparent',
    borderBottom: '1px solid var(--stone-100)',
    background: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'background 100ms ease',
  },
  itemSelected: {
    // Neutral grey, not the accent tint: the row is a selection, not a status,
    // and the orange wash read as a highlighted/flagged post.
    background: 'var(--stone-150)',
    borderLeftColor: 'var(--accent-500)',
  },
  thumb: {
    width: '40px',
    height: '40px',
    borderRadius: '8px',
    overflow: 'hidden',
    flexShrink: 0,
  },
  itemContent: {
    fontSize: 'var(--text-sm)',
    color: 'var(--stone-800)',
    fontWeight: 500,
    margin: 0,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  itemMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginTop: '5px',
  },
  itemMore: {
    fontSize: '10px',
    color: 'var(--stone-400)',
    fontWeight: 600,
  },
  itemDate: {
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-400)',
  },
  itemMetric: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    flexShrink: 0,
  },
  itemMetricValue: {
    fontSize: 'var(--text-sm)',
    fontWeight: 700,
    color: 'var(--stone-800)',
    fontFamily: 'var(--font-numeric)',
    fontVariantNumeric: 'tabular-nums',
  },
  itemMetricLabel: {
    fontSize: '10px',
    color: 'var(--stone-400)',
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
  },
  loadMore: {
    padding: '12px',
    textAlign: 'center',
    borderTop: '1px solid var(--stone-100)',
  },
};
