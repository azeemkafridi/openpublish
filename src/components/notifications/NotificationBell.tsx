import { useState, useEffect, useMemo, useRef } from 'react';
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

const TYPE_COLORS: Record<string, string> = {
  success: 'var(--color-success)',
  error: 'var(--color-error)',
  info: 'var(--color-info)',
  warning: 'var(--color-warning)',
};

const STATUS_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  success: { label: 'Published', color: '#065F46', bg: '#ECFDF5' },
  error:   { label: 'Failed',    color: '#991B1B', bg: '#FEF2F2' },
  warning: { label: 'Warning',   color: '#92400E', bg: '#FFFBEB' },
  info:    { label: 'Info',      color: '#57534E', bg: '#F5F3F0' },
};

const TYPE_ICON_STYLES: Record<string, { color: string; bg: string }> = {
  success: { color: '#16A34A', bg: '#F0FDF4' },
  error:   { color: '#DC2626', bg: '#FEF2F2' },
  info:    { color: '#78716C', bg: '#F5F5F4' },
  warning: { color: '#D97706', bg: '#FFFBEB' },
};

/* ------------------------------------------------------------------ */
/*  Icon                                                               */
/* ------------------------------------------------------------------ */

function NotifIcon({ notif }: { notif: Notification }) {
  const [imgError, setImgError] = useState(false);
  const size = 32;
  const radius = '6px';

  // Thumbnail image (with error fallback)
  if (notif.data?.thumbnailUrl && !imgError) {
    return (
      <img
        src={notif.data.thumbnailUrl}
        alt=""
        onError={() => setImgError(true)}
        style={{
          width: `${size}px`,
          height: `${size}px`,
          borderRadius: radius,
          objectFit: 'cover',
          flexShrink: 0,
          background: '#F5F5F4',
        }}
      />
    );
  }

  // Platform icon
  if (notif.data?.platform) {
    return <PlatformIcon platform={notif.data.platform} size="sm" />;
  }

  // Text document fallback
  if (notif.data?.contentSnippet) {
    return (
      <div style={{
        width: `${size}px`, height: `${size}px`, borderRadius: radius,
        background: '#F5F5F4', color: '#78716C',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <rect x="2" y="2" width="12" height="12" rx="2" />
          <line x1="5" y1="5.5" x2="11" y2="5.5" />
          <line x1="5" y1="8" x2="9" y2="8" />
          <line x1="5" y1="10.5" x2="7" y2="10.5" />
        </svg>
      </div>
    );
  }

  // Type icon fallback
  const s = TYPE_ICON_STYLES[notif.type] ?? TYPE_ICON_STYLES.info;
  return (
    <div style={{
      width: `${size}px`, height: `${size}px`, borderRadius: radius,
      background: s.bg, color: s.color,
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    }}>
      {notif.type === 'success' && (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 8l3 3 6-6" />
        </svg>
      )}
      {notif.type === 'error' && (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="8" cy="8" r="5.5" />
          <line x1="8" y1="5" x2="8" y2="9" />
          <circle cx="8" cy="11" r="0.5" fill="currentColor" />
        </svg>
      )}
      {notif.type === 'info' && (
        <img src="/assets/logo.svg" alt="" width="14" height="14" style={{ display: 'block' }} />
      )}
      {notif.type === 'warning' && (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M8 3l5.5 9.5H2.5L8 3z" />
          <line x1="8" y1="7" x2="8" y2="9.5" />
          <circle cx="8" cy="11" r="0.5" fill="currentColor" />
        </svg>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { data: _rawNotifs, mutate: mutateNotifs } = useApi<any>('/api/notifications?limit=10', { refreshInterval: 60_000 });
  const notifications: Notification[] = useMemo(() => {
    if (!_rawNotifs) return [];
    const list = Array.isArray(_rawNotifs) ? _rawNotifs : _rawNotifs.notifications ?? [];
    return list.map((n: any) => ({ ...n, type: mapNotificationType(n.type), read: n.read ?? n.isRead ?? false }));
  }, [_rawNotifs]);

  // Server-side total, not a count of the 10 rows we fetched.
  const unreadCount: number = _rawNotifs?.unreadTotal ?? notifications.filter((n) => !n.read).length;
  const hasMultipleOrgs = new Set(notifications.map((n) => n.organizationId).filter(Boolean)).size > 1;

  /* --- Close on outside click --- */
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  /* --- Revalidate on open so the dropdown never shows stale/empty data --- */
  /* (the 60s poll alone can lag a just-created notification, e.g. a publish failure) */
  useEffect(() => {
    if (open) mutateNotifs();
  }, [open, mutateNotifs]);

  /* --- Mark all read --- */
  async function handleMarkAllRead() {
    // `{ all: true }` — server-side. Sending the ids of the fetched page marked
    // only what was on screen, so "Mark all read" left every older unread
    // notification unread while the button reported success.
    if (unreadCount === 0) return;

    setLoading(true);
    try {
      await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      mutateNotifs(undefined, { revalidate: true });
    } catch {
      // fail silently
    } finally {
      setLoading(false);
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
    } catch {
      // fail silently
    }
  }

  /* --- Mark single read --- */
  async function handleMarkRead(id: string) {
    try {
      await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
        // The click navigates to /notifications right after, which would otherwise
        // abort this in-flight mark-as-read — keepalive lets it finish regardless.
        keepalive: true,
      });
      mutateNotifs(undefined, { revalidate: true });
    } catch {
      // fail silently
    }
  }

  return (
    <div ref={dropdownRef} style={{ position: 'relative' }}>
      {/* Bell button */}
      <button
        onClick={() => setOpen((v) => !v)}
        style={styles.iconBtn}
        title="Notifications"
        aria-label="Notifications"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M13.5 6.5a4.5 4.5 0 00-9 0c0 5-2.25 6.5-2.25 6.5h13.5s-2.25-1.5-2.25-6.5" />
          <path d="M10.3 15a1.5 1.5 0 01-2.6 0" />
        </svg>
        {unreadCount > 0 && (
          <span style={styles.badge} aria-label={`${unreadCount} unread`} />
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div style={styles.dropdown}>
          {/* Header */}
          <div style={styles.dropdownHeader}>
            <span style={styles.dropdownTitle}>Notifications</span>
            {unreadCount > 0 && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleMarkAllRead}
                disabled={loading}
                style={{ fontSize: 'var(--text-xs)', padding: '4px 8px' }}
              >
                Mark all read
              </button>
            )}
          </div>

          {/* Notification list */}
          <div style={styles.dropdownList}>
            {notifications.length === 0 ? (
              <div style={styles.emptyState}>
                <p style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-400)' }}>
                  No notifications
                </p>
              </div>
            ) : (
              notifications.map((notif) => (
                <button
                  key={notif.id}
                  style={{
                    ...styles.notifItem,
                    background: notif.read ? 'transparent' : 'var(--stone-50)',
                  }}
                  onClick={() => {
                    if (!notif.read) handleMarkRead(notif.id);
                    setOpen(false);
                    // From the popover, clicking a notification opens the full
                    // Notifications page — not the post/compose. Per-notification
                    // actions (Retry, Delete) live in the ⋯ menu.
                    window.location.href = '/notifications';
                  }}
                  onMouseOver={(e) =>
                    (e.currentTarget.style.background = 'var(--stone-100)')
                  }
                  onMouseOut={(e) =>
                    (e.currentTarget.style.background = notif.read ? 'transparent' : 'var(--stone-50)')
                  }
                >
                  <NotifIcon notif={notif} />
                  <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                    <p
                      style={{
                        fontSize: 'var(--text-sm)',
                        fontWeight: notif.read ? 400 : 600,
                        color: 'var(--stone-800)',
                        lineHeight: 1.3,
                      }}
                    >
                      {notif.title}
                    </p>
                    <p
                      style={{
                        fontSize: 'var(--text-xs)',
                        color: 'var(--stone-500)',
                        marginTop: '2px',
                        lineHeight: 1.4,
                      }}
                    >
                      {truncate(notif.message, 60)}
                    </p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px', flexWrap: 'wrap' }}>
                      <p style={{ fontSize: '10px', color: 'var(--stone-400)' }}>
                        {timeAgo(notif.createdAt)}
                      </p>
                      {(() => {
                        const sl = STATUS_LABELS[notif.type];
                        if (!sl) return null;
                        return (
                          <span style={{ fontSize: '9px', fontWeight: 600, color: sl.color, background: sl.bg, padding: '0px 5px', borderRadius: '3px' }}>
                            {sl.label}
                          </span>
                        );
                      })()}
                      {notif.data?.platform && <PlatformBadge platform={notif.data.platform} size="sm" />}
                      {notif.organizationName && (
                        <span style={{ fontSize: '9px', fontWeight: 500, color: '#6D28D9', background: '#F5F3FF', padding: '0px 5px', borderRadius: '3px' }}>
                          {notif.organizationName}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Actions menu */}
                  <NotifPopoverMenu
                    notifId={String(notif.id)}
                    hasRetry={notif.type === 'error' && !!notif.data?.postId}
                    postId={notif.data?.postId}
                    onDelete={handleDelete}
                    onClose={() => setOpen(false)}
                  />
                </button>
              ))
            )}
          </div>

          {/* Footer */}
          <div style={styles.dropdownFooter}>
            <a
              href="/notifications"
              className="btn btn-sm"
              style={{
                width: '100%',
                justifyContent: 'center',
                fontSize: 'var(--text-xs)',
                background: 'var(--stone-100)',
                color: 'var(--stone-600)',
              }}
            >
              View all notifications
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Popover action menu                                                */
/* ------------------------------------------------------------------ */

function NotifPopoverMenu({ notifId, hasRetry, postId, onDelete, onClose }: {
  notifId: string;
  hasRetry: boolean;
  postId?: number;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <span
        role="button"
        onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
        style={{ padding: '4px', color: 'var(--stone-400)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
        title="Actions"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="8" cy="3" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="8" cy="13" r="1.5" />
        </svg>
      </span>
      {menuOpen && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: '6px',
          background: 'var(--surface-main, #fff)', border: '1px solid var(--stone-200)',
          borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-xl)',
          zIndex: 'var(--z-dropdown)' as any, minWidth: '150px', overflow: 'hidden',
          animation: 'fadeInUp 160ms ease both',
        }}>
          {hasRetry && postId && (
            <button
              onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onClose(); window.location.href = `/compose?repost=${postId}`; }}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 'var(--text-xs)', fontWeight: 500, color: 'var(--stone-700)', textAlign: 'left' }}
              onMouseOver={(e) => (e.currentTarget.style.background = 'var(--stone-50)')}
              onMouseOut={(e) => (e.currentTarget.style.background = 'none')}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg>
              Retry
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDelete(notifId); }}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 'var(--text-xs)', fontWeight: 500, color: '#EF4444', textAlign: 'left' }}
            onMouseOver={(e) => (e.currentTarget.style.background = 'var(--stone-50)')}
            onMouseOut={(e) => (e.currentTarget.style.background = 'none')}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
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
  iconBtn: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    borderRadius: '10px',
    color: '#78716C',
    cursor: 'pointer',
    transition: 'all 150ms ease',
    border: 'none',
    background: 'none',
  },
  badge: {
    position: 'absolute',
    top: '7px',
    right: '7px',
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    background: '#EF4444',
    border: 'none',
  },
  dropdown: {
    position: 'absolute',
    top: '100%',
    right: 0,
    marginTop: '6px',
    width: '360px',
    background: 'var(--surface-main)',
    border: '1px solid var(--stone-200)',
    borderRadius: 'var(--radius-lg)',
    boxShadow: 'var(--shadow-xl)',
    zIndex: 'var(--z-dropdown)' as any,
    overflow: 'visible',
    animation: 'fadeInUp 160ms ease both',
  },
  dropdownHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px',
  },
  dropdownTitle: {
    fontSize: 'var(--text-md)',
    fontWeight: 600,
    color: 'var(--stone-800)',
  },
  dropdownList: {
    maxHeight: '360px',
    overflowY: 'auto',
    padding: '8px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  notifItem: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    width: '100%',
    padding: '10px',
    border: 'none',
    cursor: 'pointer',
    transition: 'background var(--transition-fast)',
    borderRadius: '10px',
  },
  emptyState: {
    padding: '32px',
    textAlign: 'center',
  },
  dropdownFooter: {
    padding: '8px',
  },
};
