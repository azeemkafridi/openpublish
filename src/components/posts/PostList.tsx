import { useState, useEffect, useCallback, useRef, type CSSProperties } from 'react';
import { useApi } from '@lib/swr';
import { StatusFilter } from './StatusFilter';
import { PostCard, type Post, type PostAction } from './PostCard';
import { BulkActions } from './BulkActions';
import { PostDetail } from './PostDetail';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { Dialog } from '../ui/Dialog';
import { useQueryState } from '@lib/useQueryState';
import { can } from '@lib/team/permissions';

// ---- Types ----

interface PostListResponse {
  posts: Post[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ---- Component ----

interface PostListProps {
  labelIds?: number[];
  labelMode?: 'or' | 'and';
  /** Viewer's org role (SSR-provided) — drives approval actions and publish gating. */
  userRole?: string;
}

export function PostList({ labelIds, labelMode, userRole }: PostListProps = {}) {
  const viewerCanPublish = can(userRole ?? 'owner', 'post:publish');
  const viewerCanApprove = can(userRole ?? 'owner', 'post:approve');
  const [rejectReason, setRejectReason] = useState('');
  // Filters
  const [statusParam, setStatusParam] = useQueryState<string>('status', '');
  const status = statusParam || null;
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [pageParam, setPageParam] = useQueryState<string>('page', '1');
  const page = parseInt(pageParam, 10) || 1;
  const setPage = (p: number) => setPageParam(String(p));
  const limit = 20;

  // Data — defined after postsKey below
  const [actionError, setActionError] = useState<string | null>(null);


  // Selection
  const [selectedIds, setSelectedIds] = useState<number[]>([]);

  // Detail view
  const [detailPostId, setDetailPostId] = useState<number | null>(null);

  // Action confirmation
  const [confirmAction, setConfirmAction] = useState<{
    postId: number;
    action: PostAction;
  } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Debounce search input
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 350);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [search]);

  // Build SWR key from all filter params
  const _postsParams = new URLSearchParams();
  _postsParams.set('page', String(page));
  _postsParams.set('limit', String(limit));
  if (status === 'needs_approval') _postsParams.set('approvalStatus', 'pending');
  else if (status) _postsParams.set('status', status);
  if (debouncedSearch) _postsParams.set('search', debouncedSearch);
  if (labelIds && labelIds.length > 0) {
    _postsParams.set('labelIds', labelIds.join(','));
    _postsParams.set('labelMode', labelMode || 'or');
  }

  const [_pollInterval, _setPollInterval] = useState(0);
  const { data, error: _fetchErr, isLoading: loading, mutate: mutatePosts } = useApi<PostListResponse>(
    `/api/posts?${_postsParams.toString()}`,
    { refreshInterval: _pollInterval },
  );
  const error = actionError ?? _fetchErr?.message ?? null;

  // Toggle polling when posts are in publishing/processing state
  useEffect(() => {
    const hasInProgress = data?.posts?.some(
      (p) => p.status === 'publishing' || p.status === 'processing',
    );
    _setPollInterval(hasInProgress ? 5000 : 0);
  }, [data]);

  // Reset selection when data changes
  useEffect(() => {
    setSelectedIds([]);
  }, [data]);

  // ---- Handlers ----

  function handleStatusChange(newStatus: string | null) {
    setStatusParam(newStatus ?? '');
    setPage(1);
  }

  function handleSelect(id: number, checked: boolean) {
    setSelectedIds((prev) =>
      checked ? [...prev, id] : prev.filter((x) => x !== id),
    );
  }

  function handleSelectAll() {
    if (!data) return;
    if (selectedIds.length === data.posts.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(data.posts.map((p) => p.id));
    }
  }

  function handleCardAction(postId: number, action: PostAction) {
    if (action === 'details') {
      setDetailPostId(postId);
      return;
    }
    if (action === 'edit') {
      window.location.href = `/compose?edit=${postId}`;
      return;
    }
    if (action === 'repost') {
      window.location.href = `/compose?repost=${postId}`;
      return;
    }
    if (action === 'fb-story' || action === 'ig-story') {
      setConfirmAction({ postId, action });
      return;
    }
    setConfirmAction({ postId, action });
  }

  async function executeAction() {
    if (!confirmAction) return;
    setActionLoading(true);
    try {
      const { postId, action } = confirmAction;
      let url: string;
      let method: string;

      if (action === 'publish') {
        url = `/api/posts/${postId}/publish`;
        method = 'POST';
      } else if (action === 'approve') {
        url = `/api/posts/${postId}/approve`;
        method = 'POST';
      } else if (action === 'reject') {
        url = `/api/posts/${postId}/reject`;
        method = 'POST';
      } else if (action === 'retry') {
        url = `/api/posts/${postId}/retry`;
        method = 'POST';
      } else if (action === 'fb-story' || action === 'ig-story') {
        url = `/api/posts/${postId}/story`;
        method = 'POST';
      } else {
        url = `/api/posts/${postId}`;
        method = 'DELETE';
      }

      const fetchOpts: RequestInit = { method };
      if (action === 'fb-story' || action === 'ig-story') {
        fetchOpts.headers = { 'Content-Type': 'application/json' };
        fetchOpts.body = JSON.stringify({ platform: action === 'fb-story' ? 'facebook' : 'instagram' });
      } else if (action === 'reject') {
        fetchOpts.headers = { 'Content-Type': 'application/json' };
        fetchOpts.body = JSON.stringify({ reason: rejectReason.trim() || undefined });
      }

      const res = await fetch(url, fetchOpts);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const apiMsg = typeof body?.error === 'string' ? body.error : body?.error?.message;
        const actionLabel: Record<string, string> = {
          publish: 'Publish', retry: 'Retry', delete: 'Delete',
          'fb-story': 'Facebook Story', 'ig-story': 'Instagram Story',
          approve: 'Approve', reject: 'Reject',
        };
        throw new Error(apiMsg || `${actionLabel[action] || action} failed`);
      }

      setConfirmAction(null);
      setRejectReason('');
      mutatePosts(undefined, { revalidate: true });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Something went wrong');
      setConfirmAction(null);
    } finally {
      setActionLoading(false);
    }
  }

  function handleBulkAction() {
    setSelectedIds([]);
    mutatePosts(undefined, { revalidate: true });
  }

  // ---- Pagination helpers ----

  function pageNumbers(): number[] {
    if (!data) return [];
    const total = data.totalPages;
    const current = data.page;
    const pages: number[] = [];
    const delta = 2;

    for (
      let i = Math.max(1, current - delta);
      i <= Math.min(total, current + delta);
      i++
    ) {
      pages.push(i);
    }

    if (pages[0] > 1) {
      if (pages[0] > 2) pages.unshift(-1); // ellipsis
      pages.unshift(1);
    }
    if (pages[pages.length - 1] < total) {
      if (pages[pages.length - 1] < total - 1) pages.push(-1);
      pages.push(total);
    }

    return pages;
  }

  // ---- Render ----

  const containerStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
    position: 'relative',
    minHeight: '400px',
  };

  const topBarStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '16px',
    marginBottom: '20px',
    flexWrap: 'wrap',
  };

  return (
    <div style={containerStyle}>
      {/* Top bar */}
      <div style={topBarStyle}>
        <StatusFilter value={status} onChange={handleStatusChange} />

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {/* Search */}
          <div style={{ position: 'relative' }}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="var(--stone-400)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                position: 'absolute',
                left: '10px',
                top: '50%',
                transform: 'translateY(-50%)',
                pointerEvents: 'none',
              }}
            >
              <circle cx="7" cy="7" r="5" />
              <line x1="11" y1="11" x2="14.5" y2="14.5" />
            </svg>
            <input
              type="text"
              className="input"
              placeholder="Search posts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                width: '220px',
                height: 'var(--control-height-sm)',
                paddingLeft: '34px',
                fontSize: 'var(--text-sm)',
                border: '2px solid var(--surface-card)',
              }}
            />
          </div>

          <a href="/compose" style={{ textDecoration: 'none' }}>
            <Button variant="primary" size="sm">
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <line x1="7" y1="1" x2="7" y2="13" />
                <line x1="1" y1="7" x2="13" y2="7" />
              </svg>
              Compose
            </Button>
          </a>
        </div>
      </div>

      {/* Select all bar (when items are present) */}
      {data && data.posts.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            marginBottom: '8px',
          }}
        >
          <input
            type="checkbox"
            className="post-checkbox"
            checked={
              selectedIds.length > 0 &&
              selectedIds.length === data.posts.length
            }
            ref={(el) => {
              if (el) {
                el.indeterminate =
                  selectedIds.length > 0 &&
                  selectedIds.length < data.posts.length;
              }
            }}
            onChange={handleSelectAll}
            aria-label="Select all posts"
          />
          <span
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--stone-500)',
            }}
          >
            {selectedIds.length > 0
              ? `${selectedIds.length} of ${data.posts.length} selected`
              : `${data.total} post${data.total !== 1 ? 's' : ''}`}
          </span>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div
          style={{
            padding: '10px 16px',
            background: 'var(--color-error-bg)',
            border: 'none',
            borderRadius: 'var(--radius-md)',
            marginBottom: '12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span
            style={{
              fontSize: 'var(--text-sm)',
              color: '#991B1B',
            }}
          >
            {error}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setActionError(null);
              mutatePosts(undefined, { revalidate: true });
            }}
          >
            Retry
          </Button>
        </div>
      )}

      {/* Loading state */}
      {loading && !data && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '64px 0',
            gap: '12px',
          }}
        >
          <Spinner size="lg" />
          <span
            style={{
              fontSize: 'var(--text-sm)',
              color: 'var(--stone-400)',
            }}
          >
            Loading posts...
          </span>
        </div>
      )}

      {/* Empty state */}
      {!loading && data && data.posts.length === 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '64px 20px',
            gap: '16px',
          }}
        >
          <div
            style={{
              width: '64px',
              height: '64px',
              borderRadius: '50%',
              background: 'var(--stone-100)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--stone-400)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
          </div>
          <div style={{ textAlign: 'center' }}>
            <p
              style={{
                fontSize: 'var(--text-md)',
                fontWeight: 600,
                color: 'var(--stone-700)',
                marginBottom: '4px',
              }}
            >
              No posts found
            </p>
            <p
              style={{
                fontSize: 'var(--text-sm)',
                color: 'var(--stone-400)',
                lineHeight: 'var(--leading-relaxed)',
              }}
            >
              {status || debouncedSearch
                ? 'Try adjusting your filters or search query.'
                : 'Create your first post to get started.'}
            </p>
          </div>
          <a href="/compose" style={{ textDecoration: 'none' }}>
            <Button variant="primary" size="sm">
              Compose a Post
            </Button>
          </a>
        </div>
      )}

      {/* Post list */}
      {data && data.posts.length > 0 && (
        <div
          className="stacked-cards"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0',
            opacity: loading ? 0.6 : 1,
            transition: 'opacity var(--transition-fast)',
            position: 'relative',
          }}
        >
          {loading && (
            <div
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                zIndex: 10,
              }}
            >
              <Spinner size="md" />
            </div>
          )}

          {data.posts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              selected={selectedIds.includes(post.id)}
              onSelect={handleSelect}
              onAction={handleCardAction}
              viewerCanPublish={viewerCanPublish}
              viewerCanApprove={viewerCanApprove}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {data && data.totalPages > 1 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: '4px',
            marginTop: '8px',
            background: 'var(--stone-100)',
            borderRadius: 'var(--radius-lg)',
            padding: '4px',
            width: 'fit-content',
            marginLeft: 'auto',
          }}
        >
          <PaginationButton
            label="Previous"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="9 2 4 7 9 12" />
            </svg>
          </PaginationButton>

          {pageNumbers().map((p, i) =>
            p === -1 ? (
              <span
                key={`ellipsis-${i}`}
                style={{
                  width: '32px',
                  textAlign: 'center',
                  fontSize: 'var(--text-sm)',
                  color: 'var(--stone-400)',
                }}
              >
                ...
              </span>
            ) : (
              <PaginationButton
                key={p}
                label={`Page ${p}`}
                active={p === page}
                onClick={() => setPage(p)}
              >
                {p}
              </PaginationButton>
            ),
          )}

          <PaginationButton
            label="Next"
            disabled={page >= (data?.totalPages ?? 1)}
            onClick={() => setPage(page + 1)}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="5 2 10 7 5 12" />
            </svg>
          </PaginationButton>
        </div>
      )}

      {/* Bulk actions toolbar */}
      <BulkActions
        selectedIds={selectedIds}
        selectedStatuses={data?.posts.filter((p) => selectedIds.includes(p.id)).map((p) => p.status)}
        onAction={handleBulkAction}
        onClear={() => setSelectedIds([])}
      />

      {/* Action confirmation dialog */}
      <Dialog
        open={confirmAction !== null}
        onClose={() => setConfirmAction(null)}
        title={
          confirmAction?.action === 'delete'
            ? 'Delete Post'
            : confirmAction?.action === 'approve'
              ? 'Approve Post'
              : confirmAction?.action === 'reject'
                ? 'Reject Post'
            : confirmAction?.action === 'publish'
              ? 'Publish'
              : confirmAction?.action === 'fb-story'
                  ? 'Post to Facebook Story'
                  : confirmAction?.action === 'ig-story'
                    ? 'Post to Instagram Story'
                    : 'Retry Failed'
        }
        description={
          confirmAction?.action === 'delete'
            ? 'Are you sure you want to delete this post? This action cannot be undone.'
            : confirmAction?.action === 'approve'
              ? 'This releases the post to publish at its scheduled time (or immediately if that time has passed).'
              : confirmAction?.action === 'reject'
                ? 'The post returns to drafts and the author is notified with your reason.'
            : confirmAction?.action === 'publish'
              ? 'This will immediately publish the post to all selected platforms.'
                : confirmAction?.action === 'fb-story'
                  ? 'This will publish the first media as a Facebook Story (disappears after 24h).'
                  : confirmAction?.action === 'ig-story'
                    ? 'This will publish the first media as an Instagram Story (disappears after 24h).'
                    : 'This will retry publishing to all failed platforms.'
        }
        size="sm"
      >
        {confirmAction?.action === 'reject' && (
          <textarea
            className="input"
            placeholder="Reason (optional), shown to the author"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={3}
            style={{ width: '100%', resize: 'vertical', fontSize: 'var(--text-sm)', marginTop: '4px' }}
          />
        )}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '8px',
            marginTop: '8px',
          }}
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setConfirmAction(null)}
          >
            Cancel
          </Button>
          <Button
            variant={confirmAction?.action === 'delete' || confirmAction?.action === 'reject' ? 'danger' : 'primary'}
            size="sm"
            loading={actionLoading}
            onClick={executeAction}
          >
            {confirmAction?.action === 'delete'
              ? 'Delete'
              : confirmAction?.action === 'approve'
                ? 'Approve'
                : confirmAction?.action === 'reject'
                  ? 'Reject'
              : confirmAction?.action === 'publish'
                ? 'Publish'
                : confirmAction?.action === 'fb-story' || confirmAction?.action === 'ig-story'
                    ? 'Post Story'
                    : 'Retry'}
          </Button>
        </div>
      </Dialog>

      {/* Detail panel dialog */}
      <Dialog
        open={detailPostId !== null}
        onClose={() => setDetailPostId(null)}
        title="Post Details"
        size="lg"
      >
        {detailPostId !== null && <PostDetail postId={detailPostId} />}
      </Dialog>
    </div>
  );
}

// ---- Pagination button ----

function PaginationButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const style: CSSProperties = {
    minWidth: '32px',
    height: '32px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '8px',
    fontSize: 'var(--text-sm)',
    fontWeight: active ? 600 : 500,
    color: active
      ? 'var(--accent-500)'
      : disabled
        ? 'var(--stone-300)'
        : 'var(--stone-500)',
    background: active ? '#fff' : 'transparent',
    boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
    cursor: disabled ? 'default' : 'pointer',
    transition: 'all var(--transition-fast)',
    border: 'none',
    padding: '0 6px',
    opacity: disabled ? 0.5 : 1,
  };

  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      style={style}
      onMouseOver={(e) => {
        if (!active && !disabled) {
          e.currentTarget.style.background = 'var(--stone-150)';
        }
      }}
      onMouseOut={(e) => {
        if (!active && !disabled) {
          e.currentTarget.style.background = 'transparent';
        }
      }}
    >
      {children}
    </button>
  );
}
