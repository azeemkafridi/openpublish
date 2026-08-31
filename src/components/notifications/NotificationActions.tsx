import { useState, useRef, useEffect } from 'react';
import { ConfirmDialog } from '@components/ui/ConfirmDialog';

/* ------------------------------------------------------------------ */
/*  Shared per-notification action menu (bell popover + full page).    */
/*  Actions are context-aware: failed posts get a real retry + edit,   */
/*  token warnings get a reconnect link, everything gets delete.       */
/* ------------------------------------------------------------------ */

export interface NotificationActionInput {
  /** Server-side type when preserved (post_failed, token_expired, ...). */
  rawType?: string;
  /** Client-mapped display type (success/error/warning/info). */
  uiType: string;
  data?: {
    postId?: number;
    platform?: string;
    channelId?: number;
  };
}

export interface NotificationAction {
  key: 'retry' | 'edit' | 'reconnect' | 'delete';
  label: string;
  danger?: boolean;
}

// Pure mapping, exported for tests.
export function getNotificationActions(notif: NotificationActionInput): NotificationAction[] {
  const actions: NotificationAction[] = [];
  const raw = notif.rawType;
  const isFailedPost = (raw === 'post_failed' || notif.uiType === 'error') && !!notif.data?.postId;
  const isTokenIssue = raw === 'token_expiring' || raw === 'token_expired'
    || (raw === undefined && notif.uiType === 'warning' && !!notif.data?.channelId && !notif.data?.postId);

  if (isFailedPost) {
    actions.push({ key: 'retry', label: 'Retry publish' });
    actions.push({ key: 'edit', label: 'Edit post' });
  }
  if (isTokenIssue) {
    actions.push({ key: 'reconnect', label: 'Reconnect channel' });
  }
  actions.push({ key: 'delete', label: 'Delete', danger: true });
  return actions;
}

export interface NotificationActionsProps extends NotificationActionInput {
  notifId: string;
  compact?: boolean;
  onDelete: (id: string) => void;
  /** Called before navigating away (the bell closes its popover). */
  onBeforeNavigate?: () => void;
}

type RetryState =
  | { phase: 'idle' }
  | { phase: 'busy' }
  | { phase: 'queued' }
  | { phase: 'error'; message: string };

export function NotificationActions({
  notifId,
  rawType,
  uiType,
  data,
  compact = false,
  onDelete,
  onBeforeNavigate,
}: NotificationActionsProps) {
  const [open, setOpen] = useState(false);
  const [retryState, setRetryState] = useState<RetryState>({ phase: 'idle' });
  const [confirmRepublish, setConfirmRepublish] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const actions = getNotificationActions({ rawType, uiType, data });
  const iconSize = compact ? 12 : 14;

  async function doRetry(republish: boolean) {
    if (!data?.postId) return;
    setRetryState({ phase: 'busy' });
    try {
      const res = await fetch(`/api/posts/${data.postId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(republish ? { republish: true } : {}),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setRetryState({ phase: 'queued' });
        return;
      }
      if (body?.error?.code === 'UNCONFIRMED_REQUIRES_REPUBLISH') {
        setRetryState({ phase: 'idle' });
        setConfirmRepublish(true);
        return;
      }
      setRetryState({ phase: 'error', message: body?.error?.message || 'Retry failed' });
    } catch {
      setRetryState({ phase: 'error', message: 'Network error — retry failed' });
    }
  }

  const itemStyle = (danger?: boolean): React.CSSProperties => ({
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
    color: danger ? 'var(--color-error)' : 'var(--stone-700)',
    textAlign: 'left' as const,
  });

  const hover = {
    onMouseOver: (e: React.MouseEvent<HTMLButtonElement>) =>
      (e.currentTarget.style.background = 'var(--stone-50)'),
    onMouseOut: (e: React.MouseEvent<HTMLButtonElement>) =>
      (e.currentTarget.style.background = 'none'),
  };

  const icons: Record<NotificationAction['key'], React.ReactNode> = {
    retry: (
      <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
      </svg>
    ),
    edit: (
      <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 3a2.83 2.83 0 014 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
      </svg>
    ),
    reconnect: (
      <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
      </svg>
    ),
    delete: (
      <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
      </svg>
    ),
  };

  function handleAction(key: NotificationAction['key'], e: React.MouseEvent) {
    e.stopPropagation();
    switch (key) {
      case 'retry':
        doRetry(false);
        return; // keep menu open to show progress
      case 'edit':
        setOpen(false);
        onBeforeNavigate?.();
        window.location.href = `/compose?edit=${data?.postId}`;
        return;
      case 'reconnect':
        setOpen(false);
        onBeforeNavigate?.();
        window.location.href = '/channels';
        return;
      case 'delete':
        setOpen(false);
        onDelete(notifId);
        return;
    }
  }

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <span
        role="button"
        aria-label="Notification actions"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        style={{
          padding: '4px',
          borderRadius: '4px',
          color: 'var(--stone-400)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
        }}
        title="Actions"
      >
        <svg width={compact ? 12 : 16} height={compact ? 12 : 16} viewBox="0 0 16 16" fill="currentColor">
          <circle cx="8" cy="3" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="8" cy="13" r="1.5" />
        </svg>
      </span>

      {open && (
        <div onClick={(e) => e.stopPropagation()} style={{
          position: 'absolute',
          top: '100%',
          right: 0,
          marginTop: '6px',
          background: 'var(--surface-main)',
          border: '1px solid var(--stone-200)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-xl)',
          zIndex: 'var(--z-dropdown)' as any,
          minWidth: '170px',
          overflow: 'hidden',
          animation: 'fadeInUp 160ms ease both',
        }}>
          {actions.map((action) => {
            if (action.key === 'retry') {
              const label =
                retryState.phase === 'busy' ? 'Retrying...'
                : retryState.phase === 'queued' ? 'Retry queued ✓'
                : action.label;
              return (
                <div key="retry">
                  <button
                    onClick={(e) => handleAction('retry', e)}
                    disabled={retryState.phase === 'busy' || retryState.phase === 'queued'}
                    style={{
                      ...itemStyle(),
                      ...(retryState.phase === 'queued' ? { color: 'var(--color-success)' } : {}),
                      cursor: retryState.phase === 'idle' || retryState.phase === 'error' ? 'pointer' : 'default',
                    }}
                    {...hover}
                  >
                    {icons.retry}
                    {label}
                  </button>
                  {retryState.phase === 'error' && (
                    <div style={{
                      padding: '4px 12px 8px',
                      fontSize: '10px',
                      color: 'var(--color-error)',
                      lineHeight: 1.4,
                      maxWidth: '220px',
                    }}>
                      {retryState.message}
                    </div>
                  )}
                </div>
              );
            }
            return (
              <button
                key={action.key}
                onClick={(e) => handleAction(action.key, e)}
                style={itemStyle(action.danger)}
                {...hover}
              >
                {icons[action.key]}
                {action.label}
              </button>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirmRepublish}
        title="Publish may already be live"
        message="Some platforms could not confirm whether this post published, so retrying can create a duplicate. Check the account first, then retry if it is not live."
        confirmLabel="Retry anyway"
        danger
        onConfirm={() => {
          setConfirmRepublish(false);
          doRetry(true);
        }}
        onCancel={() => setConfirmRepublish(false)}
      />
    </div>
  );
}
