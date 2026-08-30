import { useState, useRef, useEffect, lazy, Suspense } from 'react';
import { mediaImageUrl, resolvePreviewSource } from '@lib/media/display';
import { StatCard } from './StatCard';
import { StatIcons } from '../ui/StatIcons';
import { MediaPreview } from '../ui/MediaPreview';
import GettingStartedGuide from './GettingStartedGuide';
import { platformDisplayName } from '@lib/platforms/types';
import { PlatformIcon } from '../channels/PlatformIcon';
import { MetricsBadge } from '../analytics/MetricsBadge';
import { TopPosts, type TopPostItem } from '../analytics/TopPosts';
import { useApi } from '@lib/swr';
import { localDateStr, localDaysAgo, browserTz, localDayStartISO, localDayEndISO } from '@lib/dates';

const PostsOverTime = lazy(() => import('../analytics/PostsOverTime'));

type FeedTab = 'upcoming' | 'failures' | 'activity';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface SummaryData {
  totalPosts: number;
  published: number;
  scheduled: number;
  failed: number;
  partial: number;
}

interface PostPlatformEntry {
  platform: string;
  channelId?: number;
  status?: string;
  platformUrl?: string | null;
  errorMessage?: string | null;
}

interface Post {
  id: string;
  content: string;
  scheduledAt?: string;
  publishedAt?: string;
  failedAt?: string;
  error?: string;
  status: string;
  postPlatforms?: PostPlatformEntry[];
  mediaFiles?: { id: number; mimeType: string; thumbnailUrl?: string; previewUrl?: string; largeUrl?: string; originalUrl?: string; isOriginalDeleted?: boolean; width?: number; height?: number; sizeBytes?: number }[];
  createdAt?: string;
}

interface Channel {
  id: string;
  platform: string;
  accountName: string;
  isActive: boolean;
}

interface Activity {
  id: number;
  action: string;
  resource: string | null;
  resourceId: string | null;
  details: Record<string, unknown> | null;
  level: string | null;
  createdAt: string;
  thumbnail?: { url: string; mimeType: string };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */


function timeFromNow(iso: string): string {
  const now = Date.now();
  const target = new Date(iso).getTime();
  const diffMs = target - now;

  if (diffMs < 0) return 'Overdue';

  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `in ${mins}m`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h ${mins % 60}m`;

  const days = Math.floor(hours / 24);
  return `in ${days}d ${hours % 24}h`;
}

function timeAgo(iso: string): string {
  const now = Date.now();
  const past = new Date(iso).getTime();
  const diffMs = now - past;

  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function truncate(str: string, max: number): string {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '...' : str;
}

function scheduledLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffMs < 0) return 'Overdue';
  if (diffDays < 1) return `Today · ${timeStr}`;
  if (diffDays < 2) return `Tomorrow · ${timeStr}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` · ${timeStr}`;
}

const PLATFORM_STATUS_COLORS: Record<string, string> = {
  published: 'var(--color-success)',
  failed: 'var(--color-error)',
  pending: 'var(--color-warning)',
  publishing: 'var(--color-info)',
  processing: 'var(--color-info)',
  unconfirmed: 'var(--color-warning)',
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ------------------------------------------------------------------ */
/*  Skeleton                                                           */
/* ------------------------------------------------------------------ */

function SkeletonCard() {
  return (
    <div
      className="card"
      style={{
        padding: '20px',
        borderLeft: 'none',
      }}
    >
      <div style={{ ...shimmer, width: '60px', height: '32px', marginBottom: '8px' }} />
      <div style={{ ...shimmer, width: '80px', height: '14px' }} />
    </div>
  );
}

function SkeletonList() {
  return (
    <div className="card" style={{ padding: '20px' }}>
      <div style={{ ...shimmer, width: '120px', height: '16px', marginBottom: '16px' }} />
      {[1, 2, 3].map((i) => (
        <div key={i} style={{ marginBottom: '12px' }}>
          <div style={{ ...shimmer, width: '100%', height: '14px', marginBottom: '6px' }} />
          <div style={{ ...shimmer, width: '60%', height: '12px' }} />
        </div>
      ))}
    </div>
  );
}

const shimmer: React.CSSProperties = {
  background: 'linear-gradient(90deg, var(--stone-100) 25%, var(--stone-150) 50%, var(--stone-100) 75%)',
  backgroundSize: '200% 100%',
  animation: 'shimmer 1.5s ease-in-out infinite',
  borderRadius: 'var(--radius-sm)',
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function OverviewDashboard() {
  // Local calendar days + explicit viewer tz — toISOString() gave UTC days,
  // which put "today" a day off for viewers away from Greenwich.
  const fromDate = localDaysAgo(30);
  const toDate = localDateStr();
  const tz = browserTz();

  // keepPreviousData: a background revalidation must never flip isLoading back
  // on and blank a section that already has content on screen.
  const swrOpts = { keepPreviousData: true };

  const { data: summary, error: e1, isLoading: l1 } = useApi<any>(`/api/analytics/summary?from=${fromDate}&to=${toDate}&tz=${encodeURIComponent(tz)}`, swrOpts);
  const { data: upcomingRaw, isLoading: l2 } = useApi<any>('/api/posts?status=scheduled&limit=5', swrOpts);
  const { data: failuresRaw, isLoading: l3 } = useApi<any>('/api/posts?status=failed&limit=5', swrOpts);
  const { data: channelsRaw, isLoading: l4 } = useApi<any>('/api/channels', swrOpts);
  const { data: activityRaw, isLoading: l5 } = useApi<any>('/api/activity?limit=8', swrOpts);

  // Only the summary fetch is critical to the page. A secondary list failure (scheduled,
  // failed, channels) degrades to an empty section instead of blanking the whole dashboard.
  const error = e1?.message ?? null;

  // Per-section readiness. Previously a single `loading = l1 || l2 || ... ` gate
  // returned a skeleton tree for the WHOLE dashboard, so the slowest of five
  // endpoints unmounted and then remounted everything — measured as a 0.13 CLS
  // burst (stats grid jumping 298px, feed grid collapsing to zero) ~800ms after
  // LCP. Each section now owns its own placeholder and keeps its own box.
  const statsLoading = l1 || l4;
  const feedLoading = l2 || l3 || l5;

  const stats = {
    totalPosts: summary?.totalPosts ?? 0,
    // A partial post is live on at least one channel — count it as published
    // at display level (the API keeps the buckets separate).
    published: (summary?.published ?? 0) + (summary?.partial ?? 0),
    scheduled: summary?.scheduled ?? 0,
    failed: summary?.failed ?? 0,
    partial: summary?.partial ?? 0,
  };
  const upcoming = Array.isArray(upcomingRaw) ? upcomingRaw : upcomingRaw?.posts ?? [];
  const failures = Array.isArray(failuresRaw) ? failuresRaw : failuresRaw?.posts ?? [];
  const channels = Array.isArray(channelsRaw) ? channelsRaw : channelsRaw?.channels ?? [];
  const activities = activityRaw?.activities ?? [];

  /* --- Error state --- */
  if (error) {
    return (
      <div className="card" style={{ padding: '32px', textAlign: 'center' }}>
        <p style={{ color: 'var(--color-error)', fontWeight: 500, marginBottom: '8px' }}>
          Something went wrong
        </p>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-500)', marginBottom: '16px' }}>
          {error}
        </p>
        <button className="btn btn-secondary" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    );
  }

  const publishedCount = stats.published;
  const scheduledCount = stats.scheduled;
  const failedCount = stats.failed;
  const channelCount = channels.length;
  const totalPostCount = stats.totalPosts;
  const hasScheduled = scheduledCount > 0 || upcoming.length > 0;

  return (
    <div>
      <style>{shimmerKeyframes}</style>

      {/* Getting Started guide — renders itself as null until it knows whether
          the user still has onboarding steps left. */}
      {!statsLoading && (
        <GettingStartedGuide
          channelCount={channelCount}
          postCount={totalPostCount}
          scheduledCount={hasScheduled ? 1 : 0}
        />
      )}

      {/* Stat cards — skeletons occupy the same grid cells as the real cards,
          so filling them in swaps content without moving anything. */}
      <div className="stagger-children r-stats-grid" style={styles.statsGrid}>
        {statsLoading ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : (
          <>
            <StatCard label="Published" value={publishedCount} color="green" icon={StatIcons.published} />
            <StatCard label="Scheduled" value={scheduledCount} color="purple" icon={StatIcons.scheduled} />
            <StatCard label="Failed" value={failedCount} color="red" icon={StatIcons.failed} />
            <StatCard label="Channels" value={channelCount} color="blue" icon={StatIcons.channels} />
          </>
        )}
      </div>

      {/* Posts Over Time chart — same window as the summary fetch above, so SWR
          serves both from one request. */}
      <div style={{ marginTop: '4px' }}>
        {/* Fixed-height fallback: a null fallback collapsed this slot to zero
            and the card popped in after the lazy chunk loaded (layout jump). */}
        <Suspense fallback={<div className="card" style={{ minHeight: '220px' }} />}>
          <PostsOverTime from={fromDate} to={toDate} />
        </Suspense>
      </div>

      {/* Feed + Top Performing — side by side. The grid itself always renders,
          so a slow feed can't collapse the row and shove the page around. */}
      <div className="r-overview-feed-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '4px' }}>
        {feedLoading ? (
          <SkeletonList />
        ) : (
          <FeedCard
            upcoming={upcoming}
            failures={failures}
            activities={activities}
          />
        )}
        <TopPerformingPosts />
      </div>

    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Feed Card                                                          */
/* ------------------------------------------------------------------ */

const TABS: { key: FeedTab; label: string; href: string }[] = [
  { key: 'upcoming', label: 'Upcoming', href: '/calendar?status=scheduled' },
  { key: 'failures', label: 'Failures', href: '/calendar?status=failed' },
  { key: 'activity', label: 'Activity', href: '/notifications' },
];

function activityLabel(action: string): string {
  const map: Record<string, string> = {
    'post.created': 'Created a post',
    'post.drafted': 'Drafted a post',
    'post.scheduled': 'Scheduled a post',
    'post.rescheduled': 'Rescheduled a post',
    'post.unscheduled': 'Unscheduled a post',
    'post.edited': 'Edited a post',
    'post.updated': 'Updated a post',
    'post.deleted': 'Deleted a post',
    'post.publish_queued': 'Queued post for publishing',
    'post.published': 'Post published successfully',
    'post.partially_published': 'Post partially published',
    'post.publish_failed': 'Post publish failed',
    'post.retried': 'Retried a failed post',
    'post.bulk_deleted': 'Bulk deleted posts',
    'post.bulk_retried': 'Bulk retried posts',
    'post.bulk_rescheduled': 'Bulk rescheduled posts',
    'post.status_confirmed': 'Post publish confirmed',
    'post.status_failed': 'Post async publish failed',
    'channel.connected': 'Connected a channel',
    'channel.reconnected': 'Reconnected a channel',
    'channel.disconnected': 'Disconnected a channel',
    'label.created': 'Created a label',
    'label.updated': 'Updated a label',
    'label.deleted': 'Deleted a label',
    'media.uploaded': 'Uploaded media',
    'media.deleted': 'Deleted media',
    'schedule.created': 'Created a repeat post',
    'schedule.updated': 'Updated a repeat post',
    'schedule.deleted': 'Deleted a repeat post',
    'repeat.triggered': 'Repeat post ran',
    'api_key.created': 'Created an API key',
    'api_key.deleted': 'Deleted an API key',
    'settings.notifications_updated': 'Updated notification settings',
  };
  return map[action] || action.replace('.', ' ').replace(/_/g, ' ');
}

function activityIcon(action: string): React.ReactNode {
  const resource = action.split('.')[0];
  const iconProps = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

  switch (resource) {
    case 'post':
      return <svg {...iconProps}><rect x="2" y="2" width="12" height="12" rx="2" /><line x1="5" y1="5.5" x2="11" y2="5.5" /><line x1="5" y1="8" x2="11" y2="8" /><line x1="5" y1="10.5" x2="8.5" y2="10.5" /></svg>;
    case 'channel':
      return <svg {...iconProps}><rect x="2" y="2" width="12" height="12" rx="2" /><path d="M2 8h12M8 2v12" /></svg>;
    case 'label':
      return <svg {...iconProps}><path d="M2 4a2 2 0 012-2h3.17a2 2 0 011.42.59l5.24 5.24a2 2 0 010 2.83l-3.18 3.17a2 2 0 01-2.82 0L2.59 8.59A2 2 0 012 7.17V4z" /><circle cx="5.5" cy="5.5" r="0.5" fill="currentColor" /></svg>;
    case 'media':
      return <svg {...iconProps}><rect x="2" y="3" width="12" height="10" rx="2" /><circle cx="5.5" cy="6.5" r="1" /><path d="M14 10l-3-3-7 7" /></svg>;
    case 'schedule':
    case 'repeat':
      return <svg {...iconProps}><circle cx="8" cy="8" r="6" /><path d="M8 5v3l2 2" /></svg>;
    case 'api_key':
      return <svg {...iconProps}><path d="M11 2H5a2 2 0 00-2 2v8a2 2 0 002 2h6a2 2 0 002-2V4a2 2 0 00-2-2z" /><path d="M5 6h6M5 9h3" /></svg>;
    case 'settings':
      return <svg {...iconProps}><circle cx="8" cy="8" r="2" /><path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.76 3.76l1.06 1.06M11.18 11.18l1.06 1.06M3.76 12.24l1.06-1.06M11.18 4.82l1.06-1.06" /></svg>;
    default:
      return <svg {...iconProps}><circle cx="8" cy="8" r="6" /><path d="M8 6v2" /><circle cx="8" cy="11" r="0.5" fill="currentColor" /></svg>;
  }
}

function activityIconColor(level: string | null): string {
  switch (level) {
    case 'error': return 'var(--color-error)';
    case 'warning': return '#D97706';
    default: return 'var(--stone-400)';
  }
}

function activityHref(resource: string | null): string | null {
  switch (resource) {
    case 'post': return '/calendar';
    case 'channel': return '/channels';
    case 'label': return '/labels';
    case 'media': return '/media';
    case 'api_key':
    case 'settings': return '/settings';
    default: return null;
  }
}

function FeedCard({
  upcoming,
  failures,
  activities,
}: {
  upcoming: Post[];
  failures: Post[];
  activities: Activity[];
}) {
  const [tab, setTab] = useState<FeedTab>('upcoming');
  const [previewMedia, setPreviewMedia] = useState<{ url: string; posterUrl?: string; mimeType: string; isPreviewOnly?: boolean; fileName?: string; width?: number; height?: number; sizeBytes?: number } | null>(null);

  const activeTabInfo = TABS.find((t) => t.key === tab)!;

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {/* Tab bar */}
      <div style={styles.tabBar}>
        <div style={styles.tabGroup}>
          {TABS.map((t) => {
            const isActive = tab === t.key;
            const count =
              t.key === 'upcoming' ? upcoming.length :
              t.key === 'failures' ? failures.length :
              activities.length;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                style={{
                  ...styles.tab,
                  ...(isActive ? styles.tabActive : {}),
                }}
              >
                {t.label}
                {count > 0 && (
                  <span
                    style={{
                      ...styles.tabCount,
                      background: isActive ? 'var(--accent-500)' : 'var(--stone-200)',
                      color: isActive ? '#fff' : 'var(--stone-500)',
                    }}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <a href={activeTabInfo.href} style={styles.sectionLink}>View all</a>
      </div>

      {/* Content */}
      <div>
        {tab === 'upcoming' && (
          upcoming.length === 0 ? (
            <EmptyFeed
              icon={
                <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="var(--stone-300)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5" y="6.5" width="22" height="19" rx="3" />
                  <line x1="5" y1="12.5" x2="27" y2="12.5" />
                  <line x1="11" y1="3.5" x2="11" y2="9.5" />
                  <line x1="21" y1="3.5" x2="21" y2="9.5" />
                </svg>
              }
              title="No scheduled posts"
              subtitle="Create your first post to get started."
              cta={{ label: 'Compose Post', href: '/compose' }}
            />
          ) : (
            <div style={styles.listContainer}>
              {upcoming.map((post, i) => (
                <a key={post.id} href={`/compose?edit=${post.id}`} style={styles.listItem} className="overview-feed-item">
                  <PostThumb post={post} index={i} onPreview={post.mediaFiles?.length ? setPreviewMedia : undefined} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ marginBottom: 5 }}>
                      <p style={styles.listItemContent}>{post.content}</p>
                    </div>
                    <div style={styles.listItemMeta}>
                      {post.scheduledAt ? (
                        <span style={styles.timeBadge}>{scheduledLabel(post.scheduledAt)}</span>
                      ) : post.createdAt ? (
                        <span style={styles.timeBadge}>{timeAgo(post.createdAt)}</span>
                      ) : null}
                      <PlatformDots platforms={post.postPlatforms} />
                    </div>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--stone-300)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <polyline points="6,4 10,8 6,12" />
                  </svg>
                </a>
              ))}
            </div>
          )
        )}

        {tab === 'failures' && (
          failures.length === 0 ? (
            <EmptyFeed
              icon={
                <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="var(--color-success)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="14" cy="14" r="10" />
                  <path d="M9 14l3 3 7-7" />
                </svg>
              }
              title="No failed posts"
              subtitle="Everything is running smoothly."
            />
          ) : (
            <div style={styles.listContainer}>
              {failures.map((post, i) => (
                <FailureItem key={post.id} post={post} index={i} onPreview={post.mediaFiles?.length ? setPreviewMedia : undefined} />
              ))}
            </div>
          )
        )}

        {tab === 'activity' && (
          activities.length === 0 ? (
            <EmptyFeed
              icon={
                <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="var(--stone-300)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 5a7 7 0 0 1 7 7c0 3.5 1.5 5.5 2.5 6.5H4.5c1-1 2.5-3 2.5-6.5a7 7 0 0 1 7-7Z" />
                  <path d="M11.5 23.5a3 3 0 0 0 5 0" />
                </svg>
              }
              title="No recent activity"
              subtitle="Activity will appear here as you use the app."
            />
          ) : (
            <div style={styles.listContainer}>
              {activities.map((act) => {
                const href = activityHref(act.resource);
                const Tag = href ? 'a' : 'div';
                return (
                  <Tag key={act.id} {...(href ? { href } : {})} style={styles.listItem} className="overview-feed-item">
                    <ActivityThumb activity={act} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={styles.listItemContent}>{activityLabel(act.action)}</p>
                      <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', margin: '2px 0 0' }}>
                        {timeAgo(act.createdAt)}
                      </p>
                    </div>
                    {href && (
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--stone-300)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <polyline points="6,4 10,8 6,12" />
                      </svg>
                    )}
                  </Tag>
                );
              })}
            </div>
          )
        )}
      </div>

      {/* Media preview lightbox */}
      <MediaPreview
        open={!!previewMedia}
        onClose={() => setPreviewMedia(null)}
        url={previewMedia?.url || ''}
        posterUrl={previewMedia?.posterUrl}
        mimeType={previewMedia?.mimeType || 'image/jpeg'}
        fileName={previewMedia?.fileName}
        width={previewMedia?.width}
        height={previewMedia?.height}
        sizeBytes={previewMedia?.sizeBytes}
        isPreviewOnly={previewMedia?.isPreviewOnly}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Platform Status Dots                                               */
/* ------------------------------------------------------------------ */

function PlatformDots({ platforms }: { platforms?: PostPlatformEntry[] }) {
  if (!platforms || platforms.length === 0) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
      {platforms.map((pp, idx) => {
        const statusColor = PLATFORM_STATUS_COLORS[pp.status || ''] ?? 'var(--stone-300)';
        const isPublished = pp.status === 'published' && pp.platformUrl;
        const Wrapper = isPublished ? 'a' : 'div';
        const wrapperProps = isPublished
          ? { href: pp.platformUrl!, target: '_blank', rel: 'noopener noreferrer', onClick: (e: React.MouseEvent<HTMLAnchorElement>) => e.stopPropagation() }
          : {};
        return (
          <Wrapper
            key={idx}
            title={
              isPublished
                ? `View on ${platformDisplayName(pp.platform)}`
                : pp.status === 'published'
                  ? `Published on ${platformDisplayName(pp.platform)} (no link available)`
                  : `${platformDisplayName(pp.platform)}: ${pp.status || 'pending'}`
            }
            {...(wrapperProps as any)}
            style={{ position: 'relative', flexShrink: 0, cursor: isPublished ? 'pointer' : 'default', textDecoration: 'none' }}
          >
            <PlatformIcon platform={pp.platform} size="xs" />
            <div
              style={{
                position: 'absolute',
                bottom: '-1px',
                right: '-1px',
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: statusColor,
              }}
            />
          </Wrapper>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Failure Item (with expandable errors)                              */
/* ------------------------------------------------------------------ */

function FailureItem({
  post,
  index,
  onPreview,
}: {
  post: Post;
  index: number;
  onPreview?: (media: { url: string; posterUrl?: string; mimeType: string; isPreviewOnly?: boolean }) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the actions menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  // Collect all per-platform errors
  const platformErrors = (post.postPlatforms || [])
    .filter((pp) => pp.status === 'failed' && pp.errorMessage)
    .map((pp) => ({ platform: pp.platform, error: pp.errorMessage! }));

  const hasErrors = platformErrors.length > 0 || !!post.error;
  const failedTime = post.failedAt || post.createdAt;

  const toggleExpand = (e: React.MouseEvent) => {
    if (hasErrors) {
      e.preventDefault();
      e.stopPropagation();
      setExpanded((v) => !v);
    }
  };

  return (
    <div style={{ ...styles.listItem, flexDirection: 'column', alignItems: 'stretch', cursor: 'default' }} className="overview-feed-item">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
        <PostThumb post={post} index={index} onPreview={onPreview} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ marginBottom: 5 }}>
            <p style={styles.listItemContent}>{post.content}</p>
          </div>
          <div style={styles.listItemMeta}>
            {failedTime && <span style={styles.timeBadge}>{timeAgo(failedTime)}</span>}
            <PlatformDots platforms={post.postPlatforms} />
            {hasErrors && (
              <button
                onClick={toggleExpand}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '3px',
                  fontSize: 'var(--text-xs)',
                  color: 'var(--color-error)',
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  fontWeight: 500,
                }}
              >
                {expanded ? 'Hide errors' : 'View errors'}
                <svg
                  width="10" height="10" viewBox="0 0 10 10" fill="none"
                  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                  style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 150ms ease' }}
                >
                  <polyline points="2,3.5 5,6.5 8,3.5" />
                </svg>
              </button>
            )}
          </div>
          {expanded && hasErrors && (
            <div style={styles.errorPanel}>
              {platformErrors.map((pe, idx) => (
                <div key={idx} style={styles.errorRow}>
                  <div style={{ flexShrink: 0 }}>
                    <PlatformIcon platform={pe.platform} size="xs" />
                  </div>
                  <span style={{ fontSize: '11px', color: 'var(--color-error)', lineHeight: 1.4 }}>{pe.error}</span>
                </div>
              ))}
              {platformErrors.length === 0 && post.error && (
                <div style={styles.errorRow}>
                  <span style={{ fontSize: '11px', color: 'var(--color-error)', lineHeight: 1.4 }}>{post.error}</span>
                </div>
              )}
            </div>
          )}
        </div>
        <div ref={menuRef} style={{ position: 'relative', flexShrink: 0 }}>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
            aria-label="Post actions"
            style={{
              width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 'var(--radius-md)', color: 'var(--stone-400)', background: 'transparent',
              border: 'none', cursor: 'pointer', transition: 'background var(--transition-fast)',
            }}
            onMouseOver={(e) => (e.currentTarget.style.background = 'var(--stone-150)')}
            onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <circle cx="8" cy="3" r="1.5" />
              <circle cx="8" cy="8" r="1.5" />
              <circle cx="8" cy="13" r="1.5" />
            </svg>
          </button>
          {menuOpen && (
            <div
              style={{
                position: 'absolute', top: '100%', right: 0, marginTop: '4px',
                background: 'var(--surface-main)', borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--stone-200)', boxShadow: 'var(--shadow-lg)',
                minWidth: '160px', padding: '4px', zIndex: 'var(--z-dropdown)' as any,
                animation: 'fadeIn 120ms ease both',
              }}
            >
              <MenuAction
                label="Retry"
                onClick={() => { setMenuOpen(false); window.location.href = `/compose?repost=${post.id}`; }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Menu action (a row inside the 3-dot actions popover)               */
/* ------------------------------------------------------------------ */

function MenuAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px',
        fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--stone-700)',
        background: 'transparent', border: 'none', borderRadius: '8px', cursor: 'pointer',
        transition: 'background var(--transition-fast)',
      }}
      onMouseOver={(e) => (e.currentTarget.style.background = 'var(--stone-100)')}
      onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {label}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Post Thumbnail                                                     */
/* ------------------------------------------------------------------ */

// Dummy colored thumbnails for UI development
const DUMMY_COLORS: { bg: string; accent: string; shape: 'rect' | 'circle' | 'triangle' | 'diamond' }[] = [
  { bg: '#E0E7FF', accent: '#818CF8', shape: 'rect' },
  { bg: '#FCE7F3', accent: '#F472B6', shape: 'circle' },
  { bg: '#ECFDF5', accent: '#34D399', shape: 'diamond' },
  { bg: '#FEF3C7', accent: '#FBBF24', shape: 'triangle' },
  { bg: '#FEE2E2', accent: '#F87171', shape: 'circle' },
];

function DummyThumb({ index }: { index: number }) {
  const d = DUMMY_COLORS[index % DUMMY_COLORS.length];
  return (
    <div style={{ ...styles.thumb, background: d.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width="18" height="18" viewBox="0 0 18 18" fill={d.accent} opacity="0.5">
        {d.shape === 'rect' && <rect x="2" y="4" width="14" height="10" rx="2" />}
        {d.shape === 'circle' && <circle cx="9" cy="9" r="7" />}
        {d.shape === 'triangle' && <polygon points="9,2 16,16 2,16" />}
        {d.shape === 'diamond' && <polygon points="9,1 17,9 9,17 1,9" />}
      </svg>
    </div>
  );
}

function PostThumb({ post, index = 0, onPreview }: { post: Post; index?: number; onPreview?: (media: { url: string; posterUrl?: string; mimeType: string; isPreviewOnly?: boolean; fileName?: string; width?: number; height?: number; sizeBytes?: number }) => void }) {
  const [imgError, setImgError] = useState(false);
  const media = post.mediaFiles?.[0];
  const hasImage = media && media.mimeType?.startsWith('image');
  const hasVideo = media && media.mimeType?.startsWith('video');
  // Sized derivative only — never the original in a 48px tile (a full-res photo
  // decodes to tens of MB of bitmap, and a video's "original" is the whole file).
  const thumbUrl = mediaImageUrl(media, 'thumb');
  const preview = resolvePreviewSource(media);
  const mediaCount = post.mediaFiles?.length ?? 0;

  const handleClick = (e: React.MouseEvent) => {
    if (onPreview && media && preview.url) {
      e.preventDefault();
      e.stopPropagation();
      onPreview({
        url: preview.url,
        posterUrl: preview.posterUrl,
        mimeType: preview.mimeType,
        isPreviewOnly: preview.isPreviewOnly,
        width: media.width,
        height: media.height,
        sizeBytes: media.sizeBytes,
      });
    }
  };

  // Real image thumbnail
  if (hasImage && thumbUrl && !imgError) {
    return (
      <div style={{ ...styles.thumb, cursor: onPreview ? 'pointer' : undefined }} onClick={handleClick}>
        <img src={thumbUrl} alt="" style={styles.thumbImg} loading="lazy" onError={() => setImgError(true)} />
        {mediaCount > 1 && <div style={styles.thumbCountBadge as React.CSSProperties}>+{mediaCount - 1}</div>}
      </div>
    );
  }

  // Real video thumbnail
  if (hasVideo && thumbUrl && !imgError) {
    return (
      <div style={{ ...styles.thumb, cursor: onPreview ? 'pointer' : undefined }} onClick={handleClick}>
        <img src={thumbUrl} alt="" style={styles.thumbImg} loading="lazy" onError={() => setImgError(true)} />
        <div style={styles.thumbOverlay}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="#fff">
            <polygon points="3,1.5 10.5,6 3,10.5" />
          </svg>
        </div>
        {mediaCount > 1 && <div style={styles.thumbCountBadge as React.CSSProperties}>+{mediaCount - 1}</div>}
      </div>
    );
  }

  // Text-only post — show "T" icon
  return (
    <div style={{ ...styles.thumb, ...styles.thumbText }}>
      <span style={{ fontSize: '16px', fontWeight: 700, color: 'var(--stone-300)', lineHeight: 1 }}>T</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Empty Feed                                                         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Activity Thumbnail                                                 */
/* ------------------------------------------------------------------ */

function ActivityThumb({ activity }: { activity: Activity }) {
  const [imgError, setImgError] = useState(false);

  // Post activity with media thumbnail
  if (activity.thumbnail && !imgError) {
    const isVideo = activity.thumbnail.mimeType?.startsWith('video');
    return (
      <div style={styles.thumb}>
        <img
          src={activity.thumbnail.url}
          alt=""
          style={styles.thumbImg}
          loading="lazy"
          onError={() => setImgError(true)}
        />
        {isVideo && (
          <div style={styles.thumbOverlay}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="#fff">
              <polygon points="3,1.5 10.5,6 3,10.5" />
            </svg>
          </div>
        )}
      </div>
    );
  }

  // Post activity without media — show "T"
  if (activity.resource === 'post') {
    return (
      <div style={{ ...styles.thumb, ...styles.thumbText }}>
        <span style={{ fontSize: '16px', fontWeight: 700, color: 'var(--stone-300)', lineHeight: 1 }}>T</span>
      </div>
    );
  }

  // Non-post activity — show resource icon
  return (
    <div style={{ ...styles.thumb, ...styles.thumbText, color: activityIconColor(activity.level) }}>
      {activityIcon(activity.action)}
    </div>
  );
}

function EmptyFeed({
  icon,
  title,
  subtitle,
  cta,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  cta?: { label: string; href: string };
}) {
  return (
    <div style={styles.emptySection}>
      {icon}
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-500)', fontWeight: 500 }}>{title}</p>
      <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>{subtitle}</p>
      {cta && (
        <a href={cta.href} className="btn btn-primary btn-sm" style={{ marginTop: '4px' }}>
          {cta.label}
        </a>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const shimmerKeyframes = `
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.overview-feed-item:hover {
  background: var(--stone-50) !important;
}
`;

/* ------------------------------------------------------------------ */
/*  Top Performing Posts                                                */
/* ------------------------------------------------------------------ */

type TopPeriod = 'today' | 'yesterday' | 'week' | 'month';

const TOP_PERIODS: { key: TopPeriod; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'This Week' },
  { key: 'month', label: 'This Month' },
];

/**
 * Viewer-local period edges as full ISO instants. Bare UTC dates had two bugs:
 * "today" was the UTC day, and from=to collapsed the server window to a
 * zero-width instant (bare dates parse to midnight), so the Today and
 * Yesterday tabs could never match anything.
 */
function getTopPeriodRange(period: TopPeriod): { from: string; to: string } {
  const now = new Date();
  const end = localDayEndISO(now);

  if (period === 'today') return { from: localDayStartISO(now), to: end };
  if (period === 'yesterday') {
    const y = new Date(now); y.setDate(y.getDate() - 1);
    return { from: localDayStartISO(y), to: localDayEndISO(y) };
  }
  const back = new Date(now);
  back.setDate(back.getDate() - (period === 'week' ? 7 : 30));
  return { from: localDayStartISO(back), to: end };
}

function TopPerformingPosts() {
  const [period, setPeriod] = useState<TopPeriod>('week');
  const { from, to } = getTopPeriodRange(period);

  // Same endpoint and same ranking as the Analytics page's Top Posts. This used
  // to fetch `/api/posts?limit=25` and rank client-side, which meant two
  // different "Top Posts": Analytics ranked ALL published posts in range by
  // impressions, Overview ranked only the 25 most recently *created* ones by
  // likes+comments+shares. With 337 published posts in prod the real top
  // performer routinely fell outside Overview's page and the two lists
  // disagreed. The server already returns topPosts ranked and capped.
  const { data } = useApi<{ topPosts: TopPostItem[] }>(
    `/api/analytics/engagement?top=1&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );

  const sorted = (data?.topPosts ?? []).slice(0, 5);

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {/* Tab bar */}
      <div style={styles.tabBar}>
        <div style={styles.tabGroup}>
          {TOP_PERIODS.map((t) => {
            const isActive = period === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setPeriod(t.key)}
                style={{ ...styles.tab, ...(isActive ? styles.tabActive : {}) }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* The wrapper card is padding:0 so the tab bar can span full width;
          TopPosts' rows bring only vertical padding, so inset them here to
          line up with the tabs above. */}
      <div style={{ padding: '0 14px 6px' }}>
        <TopPosts posts={sorted} />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
    gap: '16px',
    marginBottom: '4px',
  },

  /* Tab bar */
  tabBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 14px 0',
    borderBottom: '1px solid var(--stone-100)',
  },
  tabGroup: {
    display: 'flex',
    gap: '2px',
  },
  tab: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '10px 14px',
    fontSize: '13px',
    fontWeight: 500,
    color: 'var(--stone-400)',
    background: 'none',
    border: 'none',
    borderBottom: '2px solid transparent',
    cursor: 'pointer',
    transition: 'color 150ms ease',
    marginBottom: '-1px',
  },
  tabActive: {
    color: '#292524',
    fontWeight: 600,
    borderBottomColor: 'var(--accent-500)',
  },
  tabCount: {
    fontSize: '10px',
    fontWeight: 700,
    padding: '1px 6px',
    borderRadius: '99px',
    lineHeight: '16px',
  },
  sectionLink: {
    fontSize: '12px',
    fontWeight: 500,
    color: 'var(--accent-500)',
    textDecoration: 'none',
  },

  /* List */
  listContainer: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  listItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '10px 12px',
    borderRadius: '10px',
    textDecoration: 'none',
    transition: 'background var(--transition-fast)',
    cursor: 'pointer',
    background: 'transparent',
  },
  thumb: {
    width: '48px',
    height: '48px',
    borderRadius: '8px',
    flexShrink: 0,
    overflow: 'hidden',
    position: 'relative',
  },
  thumbImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  thumbOverlay: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.3)',
  },
  thumbText: {
    background: 'var(--stone-100)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbCountBadge: {
    position: 'absolute',
    bottom: 3,
    right: 3,
    background: 'rgba(0,0,0,0.55)',
    color: '#fff',
    fontSize: '9px',
    fontWeight: 700,
    padding: '1px 4px',
    borderRadius: '4px',
    lineHeight: 1.4,
  },
  thumbSnippet: {
    fontSize: '13px',
    fontWeight: 700,
    color: 'var(--stone-400)',
    letterSpacing: '-0.02em',
    lineHeight: 1,
  },
  listItemContent: {
    fontSize: 'var(--text-sm)',
    color: 'var(--stone-800)',
    fontWeight: 500,
    lineHeight: 1.4,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    margin: 0,
  } as React.CSSProperties,
  listItemMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginTop: '3px',
  },
  timeBadge: {
    fontSize: '11px',
    fontWeight: 600,
    color: 'var(--stone-500)',
    background: 'var(--stone-100)',
    padding: '2px 8px',
    borderRadius: '99px',
    height: '20px',
    display: 'inline-flex',
    alignItems: 'center',
  },
  channelTag: {
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-400)',
  },
  errorPreview: {
    fontSize: 'var(--text-xs)',
    color: 'var(--color-error)',
  },
  unreadDot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    background: 'var(--accent-500)',
    flexShrink: 0,
  },
};
