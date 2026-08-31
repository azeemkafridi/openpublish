import { useState } from 'react';
import { mediaImageUrl } from '@lib/media/display';
import { useApi } from '@lib/swr';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Spinner } from '../ui/Spinner';
import { PlatformIcon } from '../channels/PlatformIcon';
import { platformDisplayName } from '@lib/platforms/types';
import { PostMetrics } from '../analytics/PostMetrics';
import { EngagementPanel } from '../analytics/EngagementPanel';
import { emptyContentLabel } from '@lib/posts/contentLabel';
import { DetailSection, sectionStyles } from './detail-section';
import type { Post, PostStatusValue, PostPlatformEntry } from './PostCard';

export interface PostDetailProps {
  postId: number;
}

const STATUS_BADGE_MAP: Record<
  string,
  { variant: 'success' | 'error' | 'warning' | 'info' | 'scheduled' | 'neutral'; label: string }
> = {
  draft: { variant: 'neutral', label: 'Draft' },
  scheduled: { variant: 'scheduled', label: 'Scheduled' },
  published: { variant: 'success', label: 'Published' },
  partial: { variant: 'warning', label: 'Partial' },
  failed: { variant: 'error', label: 'Failed' },
  publishing: { variant: 'info', label: 'Publishing...' },
  processing: { variant: 'info', label: 'Processing...' },
  pending: { variant: 'warning', label: 'Pending' },
};


function formatDateTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function PostDetail({ postId }: PostDetailProps) {
  const { data: post, error: _fetchError, isLoading: loading, mutate: mutatePost } = useApi<Post>(`/api/posts/${postId}`);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function handleAction(action: 'publish' | 'retry' | 'delete') {
    if (!post) return;
    setActionLoading(true);
    try {
      let url: string;
      let method: string;

      if (action === 'publish') {
        url = `/api/posts/${post.id}/publish`;
        method = 'POST';
      } else if (action === 'retry') {
        url = `/api/posts/${post.id}/retry`;
        method = 'POST';
      } else {
        url = `/api/posts/${post.id}`;
        method = 'DELETE';
      }

      const res = await fetch(url, { method });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message || `Action "${action}" failed`);
      }

      if (action === 'delete') {
        // Navigate back after deletion
        window.location.href = '/calendar';
        return;
      }

      // Re-fetch to get updated state
      await mutatePost(undefined, { revalidate: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionLoading(false);
    }
  }

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '48px 0',
        }}
      >
        <Spinner size="lg" />
      </div>
    );
  }

  if ((error || _fetchError) && !post) {
    return (
      <div
        style={{
          textAlign: 'center',
          padding: '48px 20px',
        }}
      >
        <p
          style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--color-error)',
            marginBottom: '12px',
          }}
        >
          {error || _fetchError?.message || 'Failed to load post'}
        </p>
        <Button variant="secondary" size="sm" onClick={() => mutatePost()}>
          Try Again
        </Button>
      </div>
    );
  }

  if (!post) return null;

  const badgeInfoBase = STATUS_BADGE_MAP[post.status] ?? STATUS_BADGE_MAP.draft;
  const publishingPlatforms = post.postPlatforms.filter((p: PostPlatformEntry) => p.status === 'publishing' || p.status === 'processing');
  let badgeLabel = badgeInfoBase.label;
  if ((post.status === 'publishing' || post.status === 'processing') && post.postPlatforms.length > 1 && publishingPlatforms.length > 0) {
    const name = platformDisplayName(publishingPlatforms[0].platform);
    badgeLabel = `Publishing to ${name}...`;
  }
  const badgeInfo = { ...badgeInfoBase, label: badgeLabel };
  const canPublish = post.status === 'draft' || post.status === 'scheduled';
  const canRetry =
    post.status === 'failed' ||
    post.status === 'partial' ||
    post.postPlatforms.some((p) => p.status === 'failed');
  const canRepost = post.status === 'published' || post.status === 'partial';
  const hasMedia = post.mediaFiles && post.mediaFiles.length > 0;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
        animation: 'fadeInUp 300ms ease both',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Badge variant={badgeInfo.variant} dot>
            {badgeInfo.label}
          </Badge>
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              window.location.href = `/compose?edit=${post.id}`;
            }}
          >
            Edit
          </Button>
          {canPublish && (
            <Button
              variant="primary"
              size="sm"
              loading={actionLoading}
              onClick={() => handleAction('publish')}
            >
              Publish
            </Button>
          )}
          {canRetry && (
            <Button
              variant="secondary"
              size="sm"
              loading={actionLoading}
              onClick={() => handleAction('retry')}
            >
              Retry Failed
            </Button>
          )}
          {canRepost && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                window.location.href = `/compose?repost=${post.id}`;
              }}
            >
              Post Again
            </Button>
          )}
          <Button
            variant="danger"
            size="sm"
            loading={actionLoading}
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this post?"
        message="The post and its publishing history will be removed. This cannot be undone."
        confirmLabel="Delete post"
        danger
        busy={actionLoading}
        onConfirm={() => {
          setConfirmDelete(false);
          handleAction('delete');
        }}
        onCancel={() => setConfirmDelete(false)}
      />

      {error && (
        <p
          style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--color-error)',
            padding: '8px 12px',
            background: 'var(--color-error-bg)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          {error}
        </p>
      )}

      {/* Content */}
      <DetailSection>
        <p
          style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--stone-800)',
            lineHeight: 'var(--leading-relaxed)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            margin: 0,
          }}
        >
          {post.content || emptyContentLabel(post.status, post.createdAt)}
        </p>
      </DetailSection>

      {/* Comments the app posted on the user's behalf — directly under the post
          they belong to. */}
      <AppEngagementSummary post={post} />

      {/* Media files */}
      {hasMedia && (
        <div style={sectionStyles.card}>
          <p style={sectionStyles.titleSpaced}>Media ({post.mediaFiles.length})</p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
              gap: '8px',
            }}
          >
            {post.mediaFiles.map((mf) => (
              <div
                key={mf.id}
                style={{
                  borderRadius: 'var(--radius-md)',
                  overflow: 'hidden',
                  background: 'var(--stone-150)',
                  aspectRatio: '1',
                  position: 'relative',
                }}
              >
                {mediaImageUrl(mf, 'preview') ? (
                  <>
                    <img
                      src={mediaImageUrl(mf, 'preview') ?? ''}
                      alt=""
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                      }}
                      loading="lazy"
                    />
                    {/* Videos now have a poster, so without this a clip looks
                        exactly like a photo in the tile grid. */}
                    {mf.mimeType?.startsWith('video') && (
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
                        <svg width="18" height="18" viewBox="0 0 12 12" fill="#fff">
                          <polygon points="3,1.5 10.5,6 3,10.5" />
                        </svg>
                      </div>
                    )}
                  </>
                ) : (
                  <div
                    style={{
                      width: '100%',
                      height: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexDirection: 'column',
                      gap: '4px',
                    }}
                  >
                    <svg
                      width="24"
                      height="24"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="var(--stone-400)"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polygon points="23 7 16 12 23 17 23 7" />
                      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                    </svg>
                    <span
                      style={{
                        fontSize: 'var(--text-xs)',
                        color: 'var(--stone-400)',
                      }}
                    >
                      Video
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Platform status table */}
      {post.postPlatforms.length > 0 && (
        <div style={sectionStyles.card}>
          <p style={sectionStyles.titleSpaced}>Platform Status</p>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            {post.postPlatforms.map((pp: PostPlatformEntry) => {
              const statusInfo = STATUS_BADGE_MAP[pp.status] ?? {
                variant: 'neutral' as const,
                label: pp.status,
              };

              return (
                <div
                  key={pp.id}
                  className="card"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                    padding: '10px 14px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    {/* Platform icon */}
                    <PlatformIcon platform={pp.platform} size="sm" />

                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: 'var(--text-sm)',
                        color: 'var(--stone-800)',
                        minWidth: '80px',
                      }}
                    >
                      {platformDisplayName(pp.platform)}
                    </span>

                    <Badge variant={statusInfo.variant} dot>
                      {statusInfo.label}
                    </Badge>

                    <div style={{ flex: 1 }} />

                    {pp.platformUrl && (
                      <a
                        href={pp.platformUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          fontSize: 'var(--text-xs)',
                          color: 'var(--accent-600)',
                          fontWeight: 500,
                        }}
                      >
                        View post
                      </a>
                    )}

                    {pp.publishedAt && (
                      <span
                        style={{
                          fontSize: 'var(--text-xs)',
                          color: 'var(--stone-400)',
                        }}
                      >
                        {formatDateTime(pp.publishedAt)}
                      </span>
                    )}
                  </div>

                  {pp.errorMessage && (
                    <p
                      style={{
                        fontSize: 'var(--text-xs)',
                        color: 'var(--color-error)',
                        lineHeight: 1.4,
                        margin: 0,
                        wordBreak: 'break-word',
                      }}
                    >
                      {pp.errorMessage}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Labels */}
      {post.labels.length > 0 && (
        <div style={sectionStyles.card}>
          <p style={sectionStyles.titleSpaced}>Labels</p>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {post.labels.map((lbl) => (
              <span
                key={lbl.id}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                  padding: '4px 10px',
                  borderRadius: 'var(--radius-pill)',
                  fontSize: 'var(--text-xs)',
                  fontWeight: 500,
                  background: `${lbl.color}18`,
                  color: lbl.color,
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
          </div>
        </div>
      )}

      {/* Metadata */}
      <div>
        <p
          style={{
            fontSize: 'var(--text-xs)',
            fontWeight: 600,
            color: 'var(--stone-500)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            marginBottom: '10px',
          }}
        >
          Details
        </p>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '8px',
          }}
        >
          <MetaItem label="Created" value={formatDateTime(post.createdAt)} />
          <MetaItem label="Scheduled" value={formatDateTime(post.scheduledAt)} />
          <MetaItem label="Published" value={formatDateTime(post.publishedAt)} />
          <MetaItem label="Timezone" value={post.timezone || 'UTC'} />
        </div>
      </div>

      {/* Per-post analytics — shows only if metrics have been synced */}
      {(post.status === 'published' || post.status === 'partial') && (
        <>
          <PostMetrics postId={post.id} />
          <EngagementPanel postId={post.id} />
        </>
      )}
    </div>
  );
}

/**
 * "Posted by openPublish" — the comments the app writes on the user's behalf:
 * the First Comment reply, and the Auto-comment that fires on a like threshold.
 * Shows the configured text plus the real per-platform outcome recorded by the
 * workers, so the before/after state of an app-authored comment is visible.
 */
/**
 * "Posted by openPublish" — the comments the app writes on the user's behalf:
 * the First Comment reply, and the Auto-comment that fires on a like threshold.
 *
 * Deliberately terse. The previous version stacked a section heading, a label,
 * a hint line, the text and a status pill, which buried the one thing that
 * matters: what was posted, and did it land.
 */
function AppEngagementSummary({ post }: { post: Post }) {
  const ps = (post.platformSpecific || {}) as Record<string, unknown>;
  const firstComment = typeof ps._firstComment === 'string' ? ps._firstComment : '';
  const results = (ps._firstCommentResults || {}) as Record<
    string,
    { status?: string; error?: string; at?: string }
  >;
  const autoPlug = post.autoPlugEnabled && post.autoPlugText;

  if (!firstComment && !autoPlug) return null;

  return (
    <div style={sectionStyles.card}>
      <p style={sectionStyles.titleSpaced}>Posted by openPublish</p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {firstComment && (
          <AppComment
            label="First comment"
            text={firstComment}
            statuses={post.postPlatforms.map((pp) => {
              const r = results[pp.platform];
              return {
                label: platformDisplayName(pp.platform),
                state: (r?.status === 'posted' ? 'posted' : r?.status === 'failed' ? 'failed' : 'pending') as AppCommentState,
                detail: r?.error || (r?.at ? new Date(r.at).toLocaleString() : undefined),
              };
            })}
          />
        )}

        {autoPlug && (
          <AppComment
            label="Auto-comment"
            text={post.autoPlugText!}
            statuses={[
              {
                label: `At ${post.autoPlugThreshold ?? 50} likes`,
                state: post.autoPlugFired ? 'posted' : 'pending',
              },
            ]}
          />
        )}
      </div>
    </div>
  );
}

type AppCommentState = 'posted' | 'failed' | 'pending';

const STATE_STYLE: Record<AppCommentState, { dot: string; label: string }> = {
  posted: { dot: 'var(--color-success)', label: 'posted' },
  failed: { dot: 'var(--color-error)', label: 'failed' },
  pending: { dot: 'var(--stone-300)', label: 'pending' },
};

/** One app-authored comment: what it says, then where it stands, per channel. */
function AppComment({
  label,
  text,
  statuses,
}: {
  label: string;
  text: string;
  statuses: Array<{ label: string; state: AppCommentState; detail?: string }>;
}) {
  return (
    <div>
      <p
        style={{
          fontSize: 'var(--text-xs)',
          fontWeight: 600,
          color: 'var(--stone-600)',
          margin: '0 0 6px',
        }}
      >
        {label}
      </p>

      {/* The comment text, set off by a rule so it reads as a quotation. */}
      <p
        style={{
          fontSize: 'var(--text-sm)',
          color: 'var(--stone-800)',
          lineHeight: 'var(--leading-relaxed)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          borderLeft: '2px solid var(--stone-200)',
          paddingLeft: '10px',
          margin: '0 0 8px',
        }}
      >
        {text}
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
        {statuses.map((st) => {
          const style = STATE_STYLE[st.state];
          return (
            <span
              key={st.label}
              title={st.detail}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: 'var(--text-xs)',
                color: 'var(--stone-500)',
              }}
            >
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  background: style.dot,
                  flexShrink: 0,
                }}
              />
              {st.label} {style.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: '8px 12px',
        background: 'var(--stone-100)',
        borderRadius: 'var(--radius-md)',
        border: 'none',
      }}
    >
      <span
        style={{
          display: 'block',
          fontSize: 'var(--text-xs)',
          color: 'var(--stone-400)',
          marginBottom: '2px',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 'var(--text-sm)',
          fontWeight: 500,
          color: 'var(--stone-700)',
        }}
      >
        {value}
      </span>
    </div>
  );
}
