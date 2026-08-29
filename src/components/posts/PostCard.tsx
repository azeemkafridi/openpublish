import { useState, useRef, useEffect, type CSSProperties } from 'react';
import { mediaImageUrl, resolvePreviewSource } from '@lib/media/display';
import { MediaPreview } from '../ui/MediaPreview';
import { PlatformIcon } from '../channels/PlatformIcon';
import { platformDisplayName } from '@lib/platforms/types';
import { MetricsBadge } from '../analytics/MetricsBadge';
import { emptyContentLabel } from '@lib/posts/contentLabel';

// ---- Types ----

export interface PostPlatformEntry {
  id: number;
  platform: string;
  status: 'pending' | 'publishing' | 'published' | 'failed' | 'processing';
  platformUrl?: string | null;
  errorMessage?: string | null;
  channelId?: number;
  publishedAt?: string | null;
}

export interface PostLabel {
  id: number;
  name: string;
  color: string;
}

export interface MediaFileRef {
  id: number;
  originalUrl: string;
  thumbnailUrl: string;
  previewUrl?: string;
  largeUrl?: string;
  mimeType: string;
  width?: number;
  height?: number;
  duration?: number;
  sizeBytes: number;
  isOriginalDeleted?: boolean;
}

export type PostStatusValue =
  | 'draft'
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'partial'
  | 'failed'
  | 'processing';

export interface RecurringScheduleInfo {
  frequency: string;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  timeOfDay: string;
  timezone: string | null;
  nextRunAt: string | null;
  isActive: boolean | null;
}

export interface Post {
  id: number;
  content: string;
  status: PostStatusValue;
  scheduledAt: string | null;
  publishedAt: string | null;
  mediaFiles: MediaFileRef[];
  postPlatforms: PostPlatformEntry[];
  labels: PostLabel[];
  recurringScheduleId?: number | null;
  recurringSchedule?: RecurringScheduleInfo | null;
  approvalStatus?: 'none' | 'pending' | 'approved' | 'rejected' | null;
  rejectionReason?: string | null;
  timezone?: string;
  createdAt?: string;
  updatedAt?: string;
  metrics?: {
    impressions?: number;
    likes?: number;
    comments?: number;
    shares?: number;
  } | null;
  /** Composer extras — `_firstComment` (text) and `_firstCommentResults` (per-platform outcome). */
  platformSpecific?: Record<string, unknown> | null;
  autoPlugEnabled?: boolean | null;
  autoPlugText?: string | null;
  autoPlugThreshold?: number | null;
  autoPlugFired?: boolean | null;
}

export type PostAction = 'details' | 'edit' | 'publish' | 'retry' | 'delete' | 'automate' | 'edit-automation' | 'remove-automation' | 'repost' | 'fb-story' | 'ig-story' | 'approve' | 'reject';

export interface PostCardProps {
  post: Post;
  selected: boolean;
  onSelect: (id: number, selected: boolean) => void;
  onAction: (postId: number, action: PostAction) => void;
  /** Role-derived flags from the parent list (default true for back-compat). */
  viewerCanPublish?: boolean;
  viewerCanApprove?: boolean;
}

// ---- Helpers ----

const PLATFORM_STATUS_COLORS: Record<string, string> = {
  published: 'var(--color-success)',
  failed: 'var(--color-error)',
  pending: 'var(--color-warning)',
  publishing: 'var(--color-info)',
  processing: 'var(--color-info)',
  unconfirmed: 'var(--color-warning)',
};


function formatTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMs < 0) {
    // Future date
    const absMins = Math.abs(diffMins);
    if (absMins < 60) return `in ${absMins}m`;
    const absHours = Math.abs(diffHours);
    if (absHours < 24) return `in ${absHours}h`;
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + '...';
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatRepeatSummary(schedule: RecurringScheduleInfo): string {
  const time = schedule.timeOfDay || '09:00';
  const [h, m] = time.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  const timeStr = `${h12}:${String(m).padStart(2, '0')} ${ampm}`;

  if (schedule.frequency === 'daily') {
    return `Every day at ${timeStr}`;
  }
  if (schedule.frequency === 'weekly' || schedule.frequency === 'biweekly') {
    const dayName = schedule.dayOfWeek != null ? DAY_NAMES[schedule.dayOfWeek] : 'Mon';
    const prefix = schedule.frequency === 'biweekly' ? 'Every other' : 'Every';
    return `${prefix} ${dayName} at ${timeStr}`;
  }
  if (schedule.frequency === 'monthly') {
    const d = schedule.dayOfMonth ?? 1;
    const suffix = d === 1 || d === 21 || d === 31 ? 'st' : d === 2 || d === 22 ? 'nd' : d === 3 || d === 23 ? 'rd' : 'th';
    return `${d}${suffix} of every month at ${timeStr}`;
  }
  return `Repeats ${schedule.frequency}`;
}

// ---- Component ----

export function PostCard({ post, selected, onSelect, onAction, viewerCanPublish = true, viewerCanApprove = true }: PostCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [mediaPreview, setMediaPreview] = useState<MediaFileRef | null>(null);
  const [hoveredPlatform, setHoveredPlatform] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  // Video plays from the original; images open at full quality. Once the
  // original has been swept only the poster survives — fall back to it AS AN
  // IMAGE, since a poster URL inside a <video> renders an empty player.
  const previewSource = resolvePreviewSource(mediaPreview);

  const hasMedia = post.mediaFiles && post.mediaFiles.length > 0;
  // Any media with a still to show — videos now carry a generated poster, so
  // the card no longer skips straight past them to find an image.
  const firstImage = hasMedia
    ? (post.mediaFiles.find((m) => mediaImageUrl(m, 'thumb')) ?? null)
    : null;

  const timeLabel = (() => {
    if (post.status === 'published' || post.status === 'partial') {
      return post.publishedAt ? `Published ${formatTime(post.publishedAt)}` : 'Published';
    }
    if (post.status === 'publishing' || post.status === 'processing') {
      return 'Publishing now';
    }
    if (post.status === 'scheduled' && post.scheduledAt) {
      return `Scheduled for ${formatTime(post.scheduledAt)}`;
    }
    if (post.status === 'failed') {
      return post.scheduledAt ? `Failed · was scheduled ${formatTime(post.scheduledAt)}` : 'Failed';
    }
    return post.createdAt ? `Created ${formatTime(post.createdAt)}` : '';
  })();

  // Action visibility per status (crossed with the viewer's role capabilities)
  const isPendingApproval = post.approvalStatus === 'pending';
  const isRejected = post.approvalStatus === 'rejected';
  const canEdit = post.status === 'draft' || post.status === 'scheduled' || post.status === 'failed';
  const canPublish = viewerCanPublish && (post.status === 'draft' || post.status === 'scheduled');
  const canRetry =
    viewerCanPublish &&
    (post.status === 'failed' ||
      post.status === 'partial' ||
      post.postPlatforms.some((p) => p.status === 'failed'));
  const canDelete = post.status === 'draft' || post.status === 'scheduled' || post.status === 'failed';
  const isAutomated = !!post.recurringScheduleId;
  const canAutomate = !isAutomated;
  const canRepost = viewerCanPublish && (post.status === 'published' || post.status === 'partial');
  const canFbStory = canRepost && hasMedia && post.postPlatforms.some((pp) => pp.platform === 'facebook');
  const canIgStory = canRepost && hasMedia && post.postPlatforms.some((pp) => pp.platform === 'instagram');
  const canApproveThis = viewerCanApprove && isPendingApproval;
  const hasActions = canEdit || canPublish || canRetry || canDelete || canAutomate || isAutomated || canRepost || canFbStory || canIgStory || canApproveThis;

  const cardStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '12px',
    padding: '14px 16px',
    background: selected ? 'var(--accent-50)' : 'var(--surface-card)',
    transition: 'background var(--transition-fast)',
    borderRadius: 'inherit',
    cursor: 'pointer',
  };

  function handleRowClick(e: React.MouseEvent) {
    // Don't navigate if user clicked on an interactive child (checkbox, button, link, menu)
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, [role="menu"]')) return;
    if (post.status === 'published' || post.status === 'partial') {
      window.location.href = `/analytics?tab=posts&post=${post.id}`;
    } else {
      window.location.href = `/compose?edit=${post.id}`;
    }
  }

  return (
    <div className="card" style={{ padding: 0 }}>
      <div
        style={cardStyle}
        onClick={handleRowClick}
        onMouseOver={(e) => {
          if (!selected) {
            e.currentTarget.style.background = 'var(--stone-100)';
          }
        }}
        onMouseOut={(e) => {
          if (!selected) {
            e.currentTarget.style.background = 'var(--surface-card)';
          }
        }}
      >
        {/* Checkbox */}
        <div
          style={{
            paddingTop: '2px',
            flexShrink: 0,
          }}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onSelect(post.id, e.target.checked)}
            className="post-checkbox"
            aria-label={`Select post ${post.id}`}
          />
          <style>{`
            .post-checkbox {
              width: 16px;
              height: 16px;
              cursor: pointer;
              accent-color: var(--accent-500);
              border: 1.5px solid #D6D3D1;
              border-radius: 4px;
              appearance: none;
              -webkit-appearance: none;
              background: transparent;
              position: relative;
            }
            .post-checkbox:checked {
              background: var(--accent-500);
              border-color: var(--accent-500);
            }
            .post-checkbox:checked::after {
              content: '';
              position: absolute;
              left: 4.5px;
              top: 1.5px;
              width: 4px;
              height: 8px;
              border: solid white;
              border-width: 0 2px 2px 0;
              transform: rotate(45deg);
            }
            .post-checkbox:hover {
              border-color: var(--stone-400);
            }
            .post-checkbox:focus {
              outline: 2px solid var(--accent-200);
              outline-offset: 1px;
            }
          `}</style>
        </div>

        {/* Media thumbnail */}
        <div
          style={{
            width: '48px',
            height: '48px',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
            flexShrink: 0,
            background: 'var(--stone-100)',
            alignSelf: 'flex-start',
            marginTop: '2px',
            position: 'relative',
          }}
        >
          {firstImage && !imageError ? (
            <>
              <img
                src={mediaImageUrl(firstImage, 'thumb') ?? ''}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', cursor: 'pointer' }}
                loading="lazy"
                onError={() => setImageError(true)}
                onClick={(e) => { e.stopPropagation(); setMediaPreview(firstImage); }}
              />
              {/* A video's poster is just an image — without this badge a clip
                  is indistinguishable from a photo in the list. */}
              {firstImage.mimeType?.startsWith('video') && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'rgba(0,0,0,0.3)',
                    pointerEvents: 'none',
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="#fff">
                    <polygon points="3,1.5 10.5,6 3,10.5" />
                  </svg>
                </div>
              )}
            </>
          ) : (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--stone-300)', lineHeight: 1 }}>T</span>
            </div>
          )}
        </div>

        {/* Content body */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Top row: content + status badge */}
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: '12px',
              marginBottom: '6px',
            }}
          >
            <p
              style={{
                fontSize: 'var(--text-sm)',
                color: 'var(--stone-800)',
                lineHeight: 'var(--leading-normal)',
                flex: 1,
                minWidth: 0,
                wordBreak: 'break-word',
              }}
            >
              {post.content
                ? truncate(post.content, 150)
                : emptyContentLabel(post.status, post.createdAt)}
            </p>
          </div>

          {/* Platform status row */}
          {post.postPlatforms.length > 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                marginBottom: '6px',
              }}
            >
              {post.postPlatforms.map((pp, idx) => {
                const statusColor = PLATFORM_STATUS_COLORS[pp.status] ?? 'var(--stone-400)';
                const isPublished = pp.status === 'published' && pp.platformUrl;
                const Wrapper = isPublished ? 'a' : 'div';
                const wrapperProps = isPublished
                  ? { href: pp.platformUrl!, target: '_blank', rel: 'noopener noreferrer', title: `View on ${platformDisplayName(pp.platform)}`, onClick: (e: React.MouseEvent) => e.stopPropagation() }
                  : pp.status === 'published'
                    // Some platforms (GMB; TikTok id-pending) never expose a permalink —
                    // say so instead of rendering a silently dead icon.
                    ? { title: `Published on ${platformDisplayName(pp.platform)} (no link available)` }
                    : {};

                return (
                  <Wrapper
                    key={pp.id}
                    {...(wrapperProps as any)}
                    style={{ position: 'relative', flexShrink: 0, cursor: isPublished ? 'pointer' : 'default', textDecoration: 'none' }}
                  >
                    <PlatformIcon platform={pp.platform} size="sm" />
                    {/* Status indicator dot — hover the dot (not the icon) for the status / error popover */}
                    <div
                      onMouseEnter={() => setHoveredPlatform(idx)}
                      onMouseLeave={() => setHoveredPlatform(null)}
                      style={{
                        position: 'absolute',
                        bottom: '-1px',
                        right: '-1px',
                        width: '7px',
                        height: '7px',
                        borderRadius: '50%',
                        background: statusColor,
                        border: 'none',
                        cursor: 'help',
                      }}
                    />
                    {/* Per-platform status / error popover on hover */}
                    {hoveredPlatform === idx && (
                      <div
                        style={{
                          position: 'absolute',
                          bottom: '100%',
                          left: 0,
                          marginBottom: '6px',
                          background: 'var(--surface-main)',
                          borderRadius: 'var(--radius-md)',
                          boxShadow: 'var(--shadow-lg)',
                          padding: '8px 10px',
                          width: 'max-content',
                          maxWidth: '260px',
                          zIndex: 9999,
                          pointerEvents: 'none',
                          animation: 'fadeIn 120ms ease both',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: pp.status === 'failed' && pp.errorMessage ? '4px' : 0 }}>
                          <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--stone-700)' }}>
                            {platformDisplayName(pp.platform)}
                          </span>
                          <span style={{ fontSize: 'var(--text-xs)', fontWeight: 500, textTransform: 'capitalize', color: statusColor }}>
                            {pp.status}
                          </span>
                        </div>
                        {pp.status === 'failed' && pp.errorMessage && (
                          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-600)', lineHeight: 'var(--leading-relaxed)', margin: 0, wordBreak: 'break-word' }}>
                            {pp.errorMessage}
                          </p>
                        )}
                      </div>
                    )}
                  </Wrapper>
                );
              })}
            </div>
          )}

          {/* Time and labels row */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              flexWrap: 'wrap',
            }}
          >
            {timeLabel && (
              <span
                style={{
                  fontSize: 'var(--text-xs)',
                  color: 'var(--stone-400)',
                }}
              >
                {timeLabel}
              </span>
            )}

            {post.labels.map((lbl) => (
              <span
                key={lbl.id}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-pill)',
                  fontSize: 'var(--text-xs)',
                  fontWeight: 500,
                  background: `${lbl.color}18`,
                  color: lbl.color,
                  lineHeight: 1.3,
                }}
              >
                <span
                  style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    background: lbl.color,
                    flexShrink: 0,
                  }}
                />
                {lbl.name}
              </span>
            ))}

            {isPendingApproval && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-pill)',
                  fontSize: 'var(--text-xs)',
                  fontWeight: 500,
                  background: 'var(--color-warning-bg)',
                  color: '#92400E',
                  lineHeight: 1.3,
                }}
              >
                <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--color-warning)', flexShrink: 0 }} />
                Awaiting approval
              </span>
            )}
            {isRejected && (
              <span
                title={post.rejectionReason || undefined}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-pill)',
                  fontSize: 'var(--text-xs)',
                  fontWeight: 500,
                  background: 'var(--color-error-bg)',
                  color: 'var(--color-error-text)',
                  lineHeight: 1.3,
                }}
              >
                <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--color-error)', flexShrink: 0 }} />
                Rejected
              </span>
            )}

            {post.recurringScheduleId && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-pill)',
                  fontSize: 'var(--text-xs)',
                  fontWeight: 500,
                  background: '#EDE9FE',
                  color: '#7C3AED',
                  lineHeight: 1.3,
                }}
              >
                <svg width="10" height="10" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 9a6 6 0 0111.5-2.4" />
                  <polyline points="15 3 15 7 11 7" />
                  <path d="M15 9a6 6 0 01-11.5 2.4" />
                  <polyline points="3 15 3 11 7 11" />
                </svg>
                {post.recurringSchedule
                  ? formatRepeatSummary(post.recurringSchedule)
                  : 'Repeat'}
              </span>
            )}

            {hasMedia && (
              <span
                style={{
                  fontSize: 'var(--text-xs)',
                  color: 'var(--stone-400)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <span style={{ fontSize: '8px', color: 'var(--stone-300)' }}>{'\u2022'}</span>
                {post.mediaFiles.length} media
              </span>
            )}

            {post.status === 'published' && post.metrics && (
              <MetricsBadge impressions={post.metrics.impressions} likes={post.metrics.likes} comments={post.metrics.comments} shares={post.metrics.shares} />
            )}
          </div>
        </div>

        {/* Action menu — hidden when no actions available */}
        {hasActions && <div ref={menuRef} style={{ position: 'relative', flexShrink: 0 }}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(!menuOpen);
            }}
            style={{
              width: '32px',
              height: '32px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 'var(--radius-md)',
              color: 'var(--stone-400)',
              transition: 'background var(--transition-fast)',
            }}
            onMouseOver={(e) =>
              (e.currentTarget.style.background = 'var(--stone-150)')
            }
            onMouseOut={(e) =>
              (e.currentTarget.style.background = 'transparent')
            }
            aria-label="Post actions"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="currentColor"
            >
              <circle cx="8" cy="3" r="1.5" />
              <circle cx="8" cy="8" r="1.5" />
              <circle cx="8" cy="13" r="1.5" />
            </svg>
          </button>

          {menuOpen && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                marginTop: '4px',
                background: 'var(--surface-main)',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--stone-200)',
                boxShadow: 'var(--shadow-lg)',
                minWidth: '160px',
                padding: '4px',
                zIndex: 'var(--z-dropdown)' as any,
                animation: 'fadeIn 120ms ease both',
              }}
            >
              <MenuAction
                label="View Details"
                onClick={() => {
                  setMenuOpen(false);
                  onAction(post.id, 'details');
                }}
              />
              {canApproveThis && (
                <MenuAction
                  label="Approve"
                  onClick={() => {
                    setMenuOpen(false);
                    onAction(post.id, 'approve');
                  }}
                />
              )}
              {canApproveThis && (
                <MenuAction
                  label="Reject"
                  danger
                  onClick={() => {
                    setMenuOpen(false);
                    onAction(post.id, 'reject');
                  }}
                />
              )}
              {canEdit && (
                <MenuAction
                  label="Edit"
                  onClick={() => {
                    setMenuOpen(false);
                    window.location.href = `/compose?edit=${post.id}`;
                  }}
                />
              )}
              {canPublish && (
                <MenuAction
                  label="Publish"
                  onClick={() => {
                    setMenuOpen(false);
                    onAction(post.id, 'publish');
                  }}
                />
              )}
              {canRetry && (
                <MenuAction
                  label="Retry Failed"
                  onClick={() => {
                    setMenuOpen(false);
                    onAction(post.id, 'retry');
                  }}
                />
              )}
              {canRepost && (
                <MenuAction
                  label="Post again"
                  onClick={() => {
                    setMenuOpen(false);
                    onAction(post.id, 'repost');
                  }}
                />
              )}
              {canFbStory && (
                <MenuAction
                  label="Post to Facebook Story"
                  onClick={() => {
                    setMenuOpen(false);
                    onAction(post.id, 'fb-story');
                  }}
                />
              )}
              {canIgStory && (
                <MenuAction
                  label="Post to Instagram Story"
                  onClick={() => {
                    setMenuOpen(false);
                    onAction(post.id, 'ig-story');
                  }}
                />
              )}
              {canAutomate && (
                <MenuAction
                  label="Set post on repeat"
                  onClick={() => {
                    setMenuOpen(false);
                    onAction(post.id, 'automate');
                  }}
                />
              )}
              {isAutomated && (
                <MenuAction
                  label="Edit Repeat"
                  onClick={() => {
                    setMenuOpen(false);
                    onAction(post.id, 'edit-automation');
                  }}
                />
              )}
              {isAutomated && (
                <MenuAction
                  label="Remove Repeat"
                  danger
                  onClick={() => {
                    setMenuOpen(false);
                    onAction(post.id, 'remove-automation');
                  }}
                />
              )}
              {canDelete && (
                <MenuAction
                  label="Delete"
                  danger
                  onClick={() => {
                    setMenuOpen(false);
                    onAction(post.id, 'delete');
                  }}
                />
              )}
            </div>
          )}
        </div>}
      </div>

      {/* Media preview lightbox */}
      <MediaPreview
        open={!!mediaPreview}
        onClose={() => setMediaPreview(null)}
        url={previewSource.url}
        posterUrl={previewSource.posterUrl}
        mimeType={previewSource.mimeType}
        isPreviewOnly={previewSource.isPreviewOnly}
        width={mediaPreview?.width}
        height={mediaPreview?.height}
        sizeBytes={mediaPreview?.sizeBytes}
      />
    </div>
  );
}

// ---- Menu Action item ----

function MenuAction({
  label,
  danger,
  onClick,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '12px',
        fontSize: 'var(--text-sm)',
        fontWeight: 500,
        color: danger ? 'var(--color-error)' : 'var(--stone-700)',
        borderRadius: '10px',
        transition: 'background var(--transition-fast)',
      }}
      onMouseOver={(e) =>
        (e.currentTarget.style.background = danger
          ? 'var(--color-error-bg)'
          : '#FFFFFF')
      }
      onMouseOut={(e) =>
        (e.currentTarget.style.background = 'transparent')
      }
    >
      {label}
    </button>
  );
}
