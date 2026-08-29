import { useState, useRef, useEffect } from 'react';
import { PlatformIcon } from './PlatformIcon';
import { Badge } from '../ui/Badge';
import { platformDisplayName } from '@lib/platforms/types';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface Channel {
  id: string;
  platform: string;
  accountName: string;
  accountId: string;
  accountType?: string;
  profileImage: string | null;
  isActive: boolean;
  needsReconnect?: boolean;
  tokenStatus?: 'valid' | 'expiring_soon' | 'expired';
  autoRenews?: boolean; // holds a refresh credential — token renews itself, no hard expiry
  tokenExpiresAt: string | null; // ISO date
  metadata?: Record<string, unknown> | null;
  /**
   * Whether THIS channel may publish right now — the `PLATFORM_<NAME>` switch
   * narrowed by any variant flag matching its accountType (LinkedIn company
   * pages are gated separately from personal profiles). A perfectly healthy
   * channel can be unable to publish, with its posts held; server-supplied so
   * the reason is accurate. Absent on older API responses — treat as available.
   */
  platformAvailable?: boolean;
  platformState?: 'on' | 'connect_off' | 'off';
  platformMessage?: string | null;
}

export interface ChannelCardProps {
  channel: Channel;
  onDisconnect: (id: string) => void;
  onRefresh: () => void;
  compact?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function getExpiryInfo(channel: Channel): {
  label: string;
  variant: 'success' | 'warning' | 'error';
} {
  // Prefer the server-computed status: it knows whether the channel holds a refresh
  // credential. tokenExpiresAt is only the ACCESS token expiry (1 hour for Google),
  // so counting it down for auto-renewing channels made healthy connections look
  // permanently "expiring soon".
  if (channel.tokenStatus) {
    if (channel.tokenStatus === 'expired') return { label: 'Expired', variant: 'error' };
    if (channel.autoRenews) return { label: 'Auto-renews', variant: 'success' };
    if (channel.tokenStatus === 'expiring_soon') {
      const days = channel.tokenExpiresAt
        ? Math.max(0, Math.floor((new Date(channel.tokenExpiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
        : 0;
      return { label: `Expires in ${days}d`, variant: 'warning' };
    }
    return { label: 'No expiry', variant: 'success' };
  }

  // Fallback for callers that haven't been updated to pass tokenStatus.
  if (!channel.tokenExpiresAt) return { label: 'No expiry', variant: 'success' };
  const diffMs = new Date(channel.tokenExpiresAt).getTime() - Date.now();
  if (diffMs <= 0) return { label: 'Expired', variant: 'error' };
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days < 7) return { label: `Expires in ${days}d`, variant: 'warning' };
  return { label: `Expires in ${days}d`, variant: 'success' };
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ChannelCard({ channel, onDisconnect, onRefresh, compact = false }: ChannelCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthResult, setHealthResult] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const expiry = getExpiryInfo(channel);

  // Determine overall status. needsReconnect (the platform rejected the token)
  // outranks the time-based expiry — a channel can read "not expired" by the
  // clock yet have a revoked token (e.g. Facebook never sets an expiry).
  const statusVariant: 'success' | 'warning' | 'error' = !channel.isActive
    ? 'error'
    : channel.needsReconnect
      ? 'error'
      : expiry.variant;

  const statusLabel = !channel.isActive
    ? 'Inactive'
    : channel.needsReconnect
      ? 'Reconnect'
      : expiry.variant === 'error'
        ? 'Expired'
        : expiry.variant === 'warning'
          ? 'Expiring Soon'
          : 'Connected';

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setConfirmDisconnect(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  /* ---- Actions ---- */

  async function handleHealthCheck() {
    setHealthLoading(true);
    setHealthResult(null);
    try {
      const res = await fetch(`/api/channels/${channel.id}/health`);
      if (!res.ok) throw new Error('Health check failed');
      const data = await res.json();
      setHealthResult(data.valid ? 'Token is valid' : 'Token is invalid');
    } catch {
      setHealthResult('Check failed');
    } finally {
      setHealthLoading(false);
      setTimeout(() => setHealthResult(null), 4000);
    }
    setMenuOpen(false);
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      const res = await fetch(`/api/channels/${channel.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error('Disconnect failed');
      onDisconnect(channel.id);
    } catch {
      setDisconnecting(false);
    }
    setMenuOpen(false);
    setConfirmDisconnect(false);
  }

  /* ---- Render ---- */

  // Compact mode for sidebar
  if (compact) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '10px 12px',
          borderRadius: '10px',
          background: 'var(--surface-card)',
          opacity: disconnecting ? 0.5 : 1,
        }}
      >
        <PlatformIcon platform={channel.platform} size="sm" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              fontSize: 'var(--text-sm)',
              fontWeight: 500,
              color: 'var(--stone-800)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {channel.accountName}
          </p>
        </div>
        <div
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background:
              statusVariant === 'success'
                ? 'var(--color-success)'
                : statusVariant === 'warning'
                  ? 'var(--color-warning)'
                  : 'var(--color-error)',
            flexShrink: 0,
          }}
          title={statusLabel}
        />
      </div>
    );
  }

  return (
    <div
      className="card"
      style={{
        padding: '20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        position: 'relative',
        opacity: disconnecting ? 0.5 : 1,
        transition: 'opacity var(--transition-base)',
      }}
    >
      {/* Top row: icon + info + menu */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
        <PlatformIcon platform={channel.platform} size="lg" />

        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              fontWeight: 600,
              fontSize: 'var(--text-md)',
              color: 'var(--stone-900)',
              lineHeight: 1.3,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {channel.accountName}
          </p>
          <p
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--stone-500)',
              marginTop: '2px',
            }}
          >
            {platformDisplayName(channel.platform)}
          </p>
        </div>

        {/* Three-dot menu */}
        <div ref={menuRef} style={{ position: 'relative' }}>
          <button
            className="btn btn-ghost"
            onClick={() => {
              setMenuOpen((v) => !v);
              setConfirmDisconnect(false);
            }}
            aria-label="Channel actions"
            style={{ padding: '4px 6px', borderRadius: 'var(--radius-sm)' }}
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
                border: 'none',
                borderRadius: 'var(--radius-lg)',
                boxShadow: 'var(--shadow-lg)',
                minWidth: '180px',
                zIndex: 100,
                padding: '4px',
                animation: 'fadeInUp 160ms ease both',
              }}
            >
              {!confirmDisconnect ? (
                <>
                  <button
                    onClick={handleHealthCheck}
                    disabled={healthLoading}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      width: '100%',
                      padding: '5px 14px',
                      fontSize: 'var(--text-sm)',
                      color: 'var(--stone-700)',
                      background: 'transparent',
                      borderRadius: '8px',
                      textAlign: 'left',
                      transition: 'background var(--transition-fast)',
                    }}
                    onMouseOver={(e) =>
                      (e.currentTarget.style.background = '#FFFFFF')
                    }
                    onMouseOut={(e) =>
                      (e.currentTarget.style.background = 'transparent')
                    }
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 14 14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M7 1v2M7 11v2M1 7h2M11 7h2M2.75 2.75l1.42 1.42M9.83 9.83l1.42 1.42M11.25 2.75l-1.42 1.42M4.17 9.83l-1.42 1.42" />
                    </svg>
                    {healthLoading ? 'Checking...' : 'Check Health'}
                  </button>
                  <button
                    onClick={() => setConfirmDisconnect(true)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      width: '100%',
                      padding: '5px 14px',
                      fontSize: 'var(--text-sm)',
                      color: 'var(--color-error)',
                      background: 'transparent',
                      borderRadius: '8px',
                      textAlign: 'left',
                      transition: 'background var(--transition-fast)',
                    }}
                    onMouseOver={(e) =>
                      (e.currentTarget.style.background = 'var(--color-error-bg)')
                    }
                    onMouseOut={(e) =>
                      (e.currentTarget.style.background = 'transparent')
                    }
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 14 14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="1" y1="1" x2="13" y2="13" />
                      <line x1="13" y1="1" x2="1" y2="13" />
                    </svg>
                    Disconnect
                  </button>
                </>
              ) : (
                <div style={{ padding: '14px' }}>
                  <p
                    style={{
                      fontSize: 'var(--text-sm)',
                      color: 'var(--stone-700)',
                      fontWeight: 500,
                      marginBottom: '4px',
                    }}
                  >
                    Disconnect this channel?
                  </p>
                  <p
                    style={{
                      fontSize: 'var(--text-xs)',
                      color: 'var(--stone-500)',
                      marginBottom: '12px',
                      lineHeight: 1.4,
                    }}
                  >
                    Scheduled posts for this account will fail.
                  </p>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        setConfirmDisconnect(false);
                        setMenuOpen(false);
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      className="btn btn-sm"
                      style={{
                        background: 'var(--color-error)',
                        color: '#fff',
                        boxShadow: '0 1px 2px rgba(239,68,68,0.3)',
                      }}
                      onClick={handleDisconnect}
                      disabled={disconnecting}
                    >
                      {disconnecting ? 'Removing...' : 'Disconnect'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Status + expiry row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
        }}
      >
        <Badge variant={statusVariant} dot>
          {statusLabel}
        </Badge>

        {(channel.autoRenews || channel.tokenExpiresAt) && (
          <span
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--stone-400)',
            }}
          >
            {expiry.label}
          </span>
        )}
      </div>

      {/* Health check result toast */}
      {healthResult && (
        <div
          style={{
            fontSize: 'var(--text-xs)',
            padding: '6px 10px',
            borderRadius: 'var(--radius-md)',
            background: healthResult === 'Token is valid'
              ? 'var(--color-success-bg)'
              : 'var(--color-warning-bg)',
            color: healthResult === 'Token is valid' ? '#065F46' : '#92400E',
            animation: 'fadeInUp 200ms ease both',
          }}
        >
          {healthResult}
        </div>
      )}
    </div>
  );
}
