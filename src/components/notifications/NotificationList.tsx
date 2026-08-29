import { useState, useMemo, useRef, useEffect } from 'react';
import { PlatformIcon } from '@/components/channels/PlatformIcon';
import { PlatformBadge } from '@/components/channels/PlatformBadge';
import { useApi } from '@lib/swr';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface NotificationData {
  postId?: number;
  platform?: string;
  channelId?: number;
  thumbnailUrl?: string;
  contentSnippet?: string;
  accountName?: string;
}

interface Notification {
  id: string;
  title: string;
  message: string;
  type: 'success' | 'error' | 'info' | 'warning';
  read: boolean;
  createdAt: string;
  data?: NotificationData;
  organizationId?: number;
  organizationName?: string;
}

type Filter = 'all' | 'unread' | 'success' | 'error' | 'warning' | 'info';

const PAGE_SIZE = 20;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function mapNotificationType(rawType: string): 'success' | 'error' | 'info' | 'warning' {
  switch (rawType) {
    case 'post_published': return 'success';
    case 'post_failed': return 'error';
    case 'token_expiring':
    case 'token_expired': return 'warning';
    default: return 'info';
  }
}

function timeAgo(iso: string): string {
  const now = Date.now();
  const past = new Date(iso).getTime();
  const diffMs = now - past;

  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return 'just now';

  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;

  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

const STATUS_LABELS: Record<string, { label: string; color: string; bg: string; dot: string }> = {
  success: { label: 'Published', color: '#065F46', bg: '#ECFDF5', dot: '#10B981' },
  error:   { label: 'Failed',    color: '#991B1B', bg: '#FEF2F2', dot: '#EF4444' },
  warning: { label: 'Warning',   color: '#92400E', bg: '#FFFBEB', dot: '#F59E0B' },
  info:    { label: 'Info',      color: '#57534E', bg: '#F5F3F0', dot: '#A8A29E' },
};

// No 'Published' (success) filter: the app doesn't create success notifications —
// a successful publish is the expected outcome and already visible in the queue.
const TYPE_FILTERS: Array<{ value: Filter; label: string; dot: string }> = [
  { value: 'error',   label: 'Failed',   dot: '#EF4444' },
  { value: 'warning', label: 'Warning',  dot: '#F59E0B' },
];

/* ------------------------------------------------------------------ */
/*  Icon Components                                                    */
/* ------------------------------------------------------------------ */

function TypeIcon({ type }: { type: string }) {
  const style: Record<string, { color: string; bg: string }> = {
    success: { color: '#16A34A', bg: '#F0FDF4' },
    error:   { color: '#DC2626', bg: '#FEF2F2' },
    info:    { color: '#78716C', bg: '#F5F5F4' },
    warning: { color: '#D97706', bg: '#FFFBEB' },
  };
  const s = style[type] ?? style.info;

  return (
    <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: s.bg, color: s.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      {type === 'success' && (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 8l3 3 6-6" />
        </svg>
      )}
      {type === 'error' && (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="8" cy="8" r="5.5" />
          <line x1="8" y1="5" x2="8" y2="9" />
          <circle cx="8" cy="11" r="0.5" fill="currentColor" />
        </svg>
      )}
      {type === 'info' && (
        <img src="/assets/logo.svg" alt="" width="16" height="16" style={{ display: 'block' }} />
      )}
      {type === 'warning' && (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M8 3l5.5 9.5H2.5L8 3z" />
          <line x1="8" y1="7" x2="8" y2="9.5" />
          <circle cx="8" cy="11" r="0.5" fill="currentColor" />
        </svg>
      )}
    </div>
  );
}

function NotifIcon({ notif }: { notif: Notification }) {
  const [imgError, setImgError] = useState(false);

  // Thumbnail image (with error fallback)
  if (notif.data?.thumbnailUrl && !imgError) {
    return (
      <img
        src={notif.data.thumbnailUrl}
        alt=""
        onError={() => setImgError(true)}
        style={{
          width: '36px',
          height: '36px',
          borderRadius: '8px',
          objectFit: 'cover',
          flexShrink: 0,
          background: '#F5F5F4',
        }}
      />
    );
  }

  // Platform icon
  if (notif.data?.platform) {
    return <PlatformIcon platform={notif.data.platform} size="md" />;
  }

  // Text-only post fallback
  if (notif.data?.contentSnippet) {
    return (
      <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: '#F5F5F4', color: '#78716C', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <rect x="2" y="2" width="12" height="12" rx="2" />
          <line x1="5" y1="5.5" x2="11" y2="5.5" />
          <line x1="5" y1="8" x2="9" y2="8" />
          <line x1="5" y1="10.5" x2="7" y2="10.5" />
        </svg>
      </div>
    );
  }

  // Fallback type icon
  return <TypeIcon type={notif.type} />;
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

export default function NotificationList() {
  const [extraNotifs, setExtraNotifs] = useState<Notification[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [orgFilter, setOrgFilter] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [markingAll, setMarkingAll] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);

  /* --- Fetch first page via SWR --- */
  const { data: _rawNotifs, error: _notifErr, isLoading: loading, mutate: mutateNotifs } = useApi<any>(
    `/api/notifications?limit=${PAGE_SIZE}&offset=0`,
  );
  const error = _notifErr?.message ?? null;
  const _firstPage: Notification[] = useMemo(() => {
    if (!_rawNotifs) return [];
    const list = Array.isArray(_rawNotifs) ? _rawNotifs : _rawNotifs.notifications ?? [];
    return list.map((n: any) => ({ ...n, type: mapNotificationType(n.type), read: n.read ?? n.isRead ?? false }));
  }, [_rawNotifs]);
  const notifications = useMemo(() => [..._firstPage, ...extraNotifs], [_firstPage, extraNotifs]);

  /* --- Derived org list --- */
  const orgList = (() => {
    const map = new Map<number, string>();
    for (const n of notifications) {
      if (n.organizationId && n.organizationName) {
        map.set(n.organizationId, n.organizationName);
      }
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  })();

  /* --- Filter --- */
  const isTypeFilter = ['success', 'error', 'warning', 'info'].includes(filter);
  const filtered = notifications
    .filter((n) => filter === 'unread' ? !n.read : isTypeFilter ? n.type === filter : true)
    .filter((n) => orgFilter ? n.organizationId === orgFilter : true);

  /* --- Mark single read --- */
  async function handleMarkRead(id: string) {
    try {
      await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
      });
      mutateNotifs(undefined, { revalidate: true });
      setExtraNotifs((prev) =>
        prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
      );
    } catch {
      // fail silently
    }
  }

  /* --- Mark all read --- */
  async function handleMarkAllRead() {
    // `{ all: true }` — server-side. Sending the ids of the fetched page marked
    // only what was on screen, so "Mark all read" left every older unread
    // notification unread while the button reported success.
    if (unreadCount === 0) return;

    setMarkingAll(true);
    try {
      await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      mutateNotifs(undefined, { revalidate: true });
      setExtraNotifs((prev) =>
        prev.map((n) => ({ ...n, read: true })),
      );
    } catch {
      // fail silently
    } finally {
      setMarkingAll(false);
    }
  }

  /* --- Load more --- */
  const [loadingMore, setLoadingMore] = useState(false);
  async function handleLoadMore() {
    const nextPage = page + 1;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/notifications?limit=${PAGE_SIZE}&offset=${nextPage * PAGE_SIZE}`);
      if (!res.ok) throw new Error('Failed to load');
      const raw = await res.json();
      const list: Notification[] = (Array.isArray(raw) ? raw : raw.notifications ?? []).map((n: any) => ({
        ...n,
        type: mapNotificationType(n.type),
        read: n.read ?? n.isRead ?? false,
      }));
      if (list.length < PAGE_SIZE) setHasMore(false);
      setExtraNotifs((prev) => [...prev, ...list]);
      setPage(nextPage);
    } catch {
      // fail silently
    } finally {
      setLoadingMore(false);
    }
  }

  /* --- Delete all notifications --- */
  async function handleDeleteAll() {
    if (notifications.length === 0) return;
    setDeletingAll(true);
    try {
      await fetch('/api/notifications', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      mutateNotifs(undefined, { revalidate: true });
      setExtraNotifs([]);
    } catch {
      // fail silently
    } finally {
      setDeletingAll(false);
    }
  }

  /* --- Delete notification --- */
  async function handleDelete(id: string) {
    try {
      await fetch('/api/notifications', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
      });
      mutateNotifs(undefined, { revalidate: true });
      setExtraNotifs((prev) => prev.filter((n) => n.id !== id));
    } catch {
      // fail silently
    }
  }

  // Server-side total, not a count of the current page.
  const unreadCount: number = _rawNotifs?.unreadTotal ?? notifications.filter((n) => !n.read).length;

  return (
    <div>
      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>

      {/* Toolbar */}
      <div style={styles.toolbar}>
        <div style={styles.filterButtons}>
          <button
            className={filter === 'all' && !orgFilter ? 'btn btn-active btn-sm' : 'btn btn-ghost btn-sm'}
            onClick={() => { setFilter('all'); setOrgFilter(null); }}
          >
            All
          </button>
          <button
            className={filter === 'unread' ? 'btn btn-active btn-sm' : 'btn btn-ghost btn-sm'}
            onClick={() => { setFilter('unread'); setOrgFilter(null); }}
          >
            Unread
            {unreadCount > 0 && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: '18px',
                  height: '18px',
                  padding: '0 5px',
                  marginLeft: '6px',
                  background: 'var(--color-error-bg)',
                  color: 'var(--color-error)',
                  fontSize: '10px',
                  fontWeight: 700,
                  borderRadius: 'var(--radius-pill)',
                }}
              >
                {unreadCount}
              </span>
            )}
          </button>

          {/* Type filters */}
          <span style={{ width: '1px', height: '16px', background: 'var(--stone-200)', margin: '0 4px' }} />
          {TYPE_FILTERS.map((tf) => (
            <button
              key={tf.value}
              className={filter === tf.value ? 'btn btn-active btn-sm' : 'btn btn-ghost btn-sm'}
              onClick={() => { setFilter(filter === tf.value ? 'all' : tf.value); setOrgFilter(null); }}
              style={{ gap: '5px' }}
            >
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: tf.dot, flexShrink: 0 }} />
              {tf.label}
            </button>
          ))}

          {/* Org filters */}
          {orgList.length > 1 && (
            <>
              <span style={{ width: '1px', height: '16px', background: 'var(--stone-200)', margin: '0 4px' }} />
              {orgList.map((org) => (
                <button
                  key={org.id}
                  className={orgFilter === org.id ? 'btn btn-active btn-sm' : 'btn btn-ghost btn-sm'}
                  onClick={() => { setFilter('all'); setOrgFilter(orgFilter === org.id ? null : org.id); }}
                >
                  {org.name}
                </button>
              ))}
            </>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          {unreadCount > 0 && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleMarkAllRead}
              disabled={markingAll}
            >
              {markingAll ? 'Marking...' : 'Mark all as read'}
            </button>
          )}
          {notifications.length > 0 && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleDeleteAll}
              disabled={deletingAll}
              style={{ color: 'var(--color-error)' }}
            >
              {deletingAll ? 'Deleting...' : 'Delete all'}
            </button>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="card" style={{ padding: '24px', textAlign: 'center', marginTop: '16px' }}>
          <p style={{ color: 'var(--color-error)', fontWeight: 500, marginBottom: '8px' }}>
            {error}
          </p>
          <button className="btn btn-secondary btn-sm" onClick={() => mutateNotifs()}>
            Retry
          </button>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="stacked-cards" style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '0' }}>
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="card" style={{ padding: '16px', display: 'flex', gap: '12px' }}>
              <div style={{ ...shimmer, width: '36px', height: '36px', borderRadius: '8px' }} />
              <div style={{ flex: 1 }}>
                <div style={{ ...shimmer, width: '60%', height: '14px', marginBottom: '8px' }} />
                <div style={{ ...shimmer, width: '90%', height: '12px', marginBottom: '6px' }} />
                <div style={{ ...shimmer, width: '30%', height: '10px' }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && filtered.length === 0 && (
        <div className="card" style={styles.emptyCard}>
          <svg
            width="40"
            height="40"
            viewBox="0 0 40 40"
            fill="none"
            stroke="var(--stone-300)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M28 14a8 8 0 00-16 0c0 9-4 12-4 12h24s-4-3-4-12" />
            <path d="M22.5 32a3 3 0 01-5 0" />
          </svg>
          <p style={{ fontSize: 'var(--text-md)', fontWeight: 500, color: 'var(--stone-600)' }}>
            {filter === 'unread' ? 'No unread notifications' : orgFilter ? 'No notifications for this workspace' : 'No notifications yet'}
          </p>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-400)' }}>
            {filter === 'unread'
              ? 'You are all caught up.'
              : 'Notifications about your posts and channels will appear here.'}
          </p>
        </div>
      )}

      {/* Notification list */}
      {!loading && filtered.length > 0 && (
        <div style={styles.list}>
          {filtered.map((notif) => (
            <div
              key={notif.id}
              className="card"
              onClick={() => {
                if (!notif.read) handleMarkRead(notif.id);
                if (notif.type === 'error' && notif.data?.postId) {
                  window.location.href = `/compose?repost=${notif.data.postId}`;
                }
              }}
              style={{
                padding: '16px',
                display: 'flex',
                alignItems: 'flex-start',
                gap: '14px',
                cursor: (notif.type === 'error' && notif.data?.postId) || !notif.read ? 'pointer' : 'default',
                opacity: notif.read ? 0.65 : 1,
                transition: 'opacity var(--transition-base)',
              }}
            >
              <NotifIcon notif={notif} />

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={styles.notifHeader}>
                  <p
                    style={{
                      fontSize: 'var(--text-sm)',
                      fontWeight: notif.read ? 500 : 600,
                      color: 'var(--stone-800)',
                      lineHeight: 1.3,
                    }}
                  >
                    {notif.title}
                  </p>
                  {!notif.read && (
                    <span
                      style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        background: 'var(--accent-500)',
                        flexShrink: 0,
                      }}
                    />
                  )}
                </div>

                <p
                  style={{
                    fontSize: 'var(--text-sm)',
                    color: 'var(--stone-600)',
                    lineHeight: 1.5,
                    marginTop: '4px',
                  }}
                >
                  {notif.message}
                </p>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
                  <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>
                    {timeAgo(notif.createdAt)}
                  </p>
                  {(() => {
                    const sl = STATUS_LABELS[notif.type];
                    if (!sl) return null;
                    return (
                      <span style={{ fontSize: '10px', fontWeight: 600, color: sl.color, background: sl.bg, padding: '1px 6px', borderRadius: '4px', whiteSpace: 'nowrap' as const }}>
                        {sl.label}
                      </span>
                    );
                  })()}
                  {notif.data?.platform && <PlatformBadge platform={notif.data.platform} />}
                  {notif.organizationName && (
                    <span style={styles.orgTag}>
                      {notif.organizationName}
                    </span>
                  )}
                </div>
              </div>

              {/* Actions menu */}
              <NotifMenu
                notifId={notif.id}
                hasRetry={notif.type === 'error' && !!notif.data?.postId}
                postId={notif.data?.postId}
                onDelete={handleDelete}
              />
            </div>
          ))}

          {/* Pagination / load more */}
          {hasMore && filter === 'all' && (
            <div style={{ textAlign: 'center', paddingTop: '8px' }}>
              <button className="btn btn-secondary btn-sm" onClick={handleLoadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading...' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Notification action menu                                           */
/* ------------------------------------------------------------------ */

function NotifMenu({ notifId, hasRetry, postId, onDelete }: {
  notifId: string;
  hasRetry: boolean;
  postId?: number;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '4px',
          borderRadius: '4px',
          color: 'var(--stone-400)',
          display: 'flex',
          alignItems: 'center',
        }}
        title="Actions"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="8" cy="3" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="8" cy="13" r="1.5" />
        </svg>
      </button>
      {open && (
        <div style={{
          position: 'absolute',
          top: '100%',
          right: 0,
          marginTop: '6px',
          background: 'var(--surface-main, #fff)',
          border: '1px solid var(--stone-200)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-xl)',
          zIndex: 'var(--z-dropdown)' as any,
          minWidth: '150px',
          overflow: 'hidden',
          animation: 'fadeInUp 160ms ease both',
        }}>
          {hasRetry && postId && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                window.location.href = `/compose?repost=${postId}`;
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                width: '100%',
                padding: '8px 12px',
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                fontSize: 'var(--text-xs)',
                fontWeight: 500,
                color: 'var(--stone-700)',
                textAlign: 'left',
              }}
              onMouseOver={(e) => (e.currentTarget.style.background = 'var(--stone-50)')}
              onMouseOut={(e) => (e.currentTarget.style.background = 'none')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
              </svg>
              Edit & Retry
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onDelete(notifId);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              padding: '8px 12px',
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              fontSize: 'var(--text-xs)',
              fontWeight: 500,
              color: '#EF4444',
              textAlign: 'left',
            }}
            onMouseOver={(e) => (e.currentTarget.style.background = 'var(--stone-50)')}
            onMouseOut={(e) => (e.currentTarget.style.background = 'none')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
            </svg>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const styles: Record<string, React.CSSProperties> = {
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    marginBottom: '16px',
  },
  filterButtons: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexWrap: 'wrap',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    marginTop: '16px',
  },
  notifHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
  },
  emptyCard: {
    padding: '48px',
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '8px',
    marginTop: '16px',
  },
  orgTag: {
    fontSize: '10px',
    fontWeight: 500,
    color: '#6D28D9',
    background: '#F5F3FF',
    padding: '1px 6px',
    borderRadius: '4px',
    whiteSpace: 'nowrap' as const,
  },
};
