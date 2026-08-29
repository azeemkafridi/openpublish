import { useState, useEffect, useCallback, useRef } from 'react';
import { useApi } from '@lib/swr';
import { track } from '@lib/track';
import { type Channel } from './ChannelCard';
import { PlatformIcon, type Platform } from './PlatformIcon';
import { Dialog } from '../ui/Dialog';
import { Spinner } from '../ui/Spinner';
import { ApiError, parseApiError, type ApiErrorData } from '../ui/ApiError';

/* ------------------------------------------------------------------ */
/*  Platform data                                                      */
/* ------------------------------------------------------------------ */

interface PlatformOption {
  key: Platform;
  name: string;
  description: string;
  bg: string;        // card background
  accent: string;    // text accent for connected badge / CTA
  comingSoon?: boolean;
}

/** Connect-grid cards. MUST list every platform in ALL_PLATFORMS — this is an
 *  array, so tsc cannot enforce that; the platform-list-drift test does. */
export const PLATFORMS: PlatformOption[] = [
  { key: 'facebook',  name: 'Facebook',        description: 'Pages',                      bg: '#EFF6FF',  accent: '#1877F2' },
  { key: 'instagram', name: 'Instagram',        description: 'Accounts', bg: '#FDF2F8', accent: '#E4405F' },
  { key: 'x',         name: 'X (Twitter)',       description: 'Posts and threads',          bg: '#F5F5F5',  accent: '#292524' },
  { key: 'tiktok',    name: 'TikTok',           description: 'Videos and carousels',       bg: '#F0FDFA',  accent: '#0D9488' },
  { key: 'youtube',   name: 'YouTube',          description: 'Videos and shorts',          bg: '#FEF2F2',  accent: '#DC2626' },
  { key: 'threads',   name: 'Threads',          description: 'Text and media',             bg: '#F5F5F4',  accent: '#44403C' },
  { key: 'bluesky',   name: 'Bluesky',          description: 'AT Protocol',                bg: '#EFF6FF',  accent: '#0085FF' },
  { key: 'pinterest', name: 'Pinterest',        description: 'Pins and boards',            bg: '#FEF2F2',  accent: '#E60023' },
  { key: 'gmb',       name: 'Google Business',  description: 'Business Profile updates',   bg: '#EFF6FF',  accent: '#4285F4' },
  { key: 'linkedin',  name: 'LinkedIn',         description: 'Profiles and pages',         bg: '#EFF6FF',  accent: '#0A66C2' },
  { key: 'mastodon',  name: 'Mastodon',         description: 'Fediverse posts',            bg: '#F3F0FF',  accent: '#6364FF' },
  { key: 'reddit',    name: 'Reddit',           description: 'Subreddit posts',            bg: '#FFF7ED',  accent: '#FF4500' },
  { key: 'discord',   name: 'Discord',          description: 'Server channel messages',    bg: '#EEF0FE',  accent: '#5865F2' },
  { key: 'telegram',  name: 'Telegram',         description: 'Channel and group posts',    bg: '#E8F6FD',  accent: '#26A5E4' },
  { key: 'tumblr',    name: 'Tumblr',           description: 'Blog posts',                 bg: '#EEF1F5',  accent: '#001935' },
  { key: 'snapchat',  name: 'Snapchat',         description: 'Stories and Spotlight',      bg: '#FFFBD6',  accent: '#57530A' },
];

/* ------------------------------------------------------------------ */
/*  Account row menu                                                   */
/* ------------------------------------------------------------------ */

function AccountMenu({
  channel,
  onAddAnother,
  onDisconnect,
  onReauthorize,
}: {
  channel: Channel;
  onAddAnother: () => void;
  onDisconnect: (id: string) => void;
  onReauthorize: (platform: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [metricsEnabled, setMetricsEnabled] = useState<boolean>(
    () => (channel.metadata as Record<string, unknown> | null | undefined)?.metricsSyncEnabled === true,
  );
  const [metricsSaving, setMetricsSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // X is the only platform that bills for analytics reads, so its metrics sync is opt-in.
  // Toggling persists to channel.metadata; the worker then syncs at most once per 7 days.
  async function toggleMetricsSync() {
    const next = !metricsEnabled;
    setMetricsSaving(true);
    try {
      const res = await fetch(`/api/channels/${channel.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metricsSyncEnabled: next }),
      });
      if (res.ok) setMetricsEnabled(next);
    } catch {
      /* leave the toggle as-is on failure */
    } finally {
      setMetricsSaving(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirmDelete(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/channels/${channel.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
      if (!res.ok) throw new Error('Failed');
      onDisconnect(channel.id);
    } catch {
      setDeleting(false);
    }
    setOpen(false);
    setConfirmDelete(false);
  }

  const menuItemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
    padding: '8px 14px',
    fontSize: 'var(--text-sm)',
    color: 'var(--stone-700)',
    background: 'transparent',
    borderRadius: '8px',
    textAlign: 'left',
    cursor: 'pointer',
    border: 'none',
    transition: 'background var(--transition-fast)',
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => { setOpen(v => !v); setConfirmDelete(false); }}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '28px',
          height: '28px',
          borderRadius: 'var(--radius-md)',
          background: 'transparent',
          border: 'none',
          color: 'var(--stone-400)',
          cursor: 'pointer',
          transition: 'background var(--transition-fast)',
        }}
        onMouseOver={e => (e.currentTarget.style.background = 'var(--stone-100)')}
        onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
        aria-label="Account actions"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
          <circle cx="7" cy="2.5" r="1.2" />
          <circle cx="7" cy="7" r="1.2" />
          <circle cx="7" cy="11.5" r="1.2" />
        </svg>
      </button>

      {open && (
        <div style={{
          position: 'absolute',
          top: '100%',
          right: 0,
          marginTop: '4px',
          background: 'var(--surface-main)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: '0 4px 24px rgba(0,0,0,0.12)',
          minWidth: '180px',
          zIndex: 100,
          padding: '4px',
          animation: 'fadeInUp 120ms ease both',
        }}>
          {!confirmDelete ? (
            <>
              <button
                style={menuItemStyle}
                onClick={() => { onReauthorize(channel.platform); setOpen(false); }}
                onMouseOver={e => (e.currentTarget.style.background = 'var(--stone-50)')}
                onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 7a5 5 0 019.33-2.5" />
                  <polyline points="12,2 12,5 9,5" />
                  <path d="M12 7a5 5 0 01-9.33 2.5" />
                  <polyline points="2,12 2,9 5,9" />
                </svg>
                Reauthorize
              </button>
              <button
                style={menuItemStyle}
                onClick={() => { onAddAnother(); setOpen(false); }}
                onMouseOver={e => (e.currentTarget.style.background = 'var(--stone-50)')}
                onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="7" y1="3" x2="7" y2="11" />
                  <line x1="3" y1="7" x2="11" y2="7" />
                </svg>
                Add another
              </button>
              {channel.platform === 'x' && (
                <>
                  <button
                    style={menuItemStyle}
                    onClick={toggleMetricsSync}
                    disabled={metricsSaving}
                    onMouseOver={e => (e.currentTarget.style.background = 'var(--stone-50)')}
                    onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
                    title="X charges for analytics reads, so they sync at most once a week"
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="2" y1="11.5" x2="2" y2="7" />
                      <line x1="7" y1="11.5" x2="7" y2="2.5" />
                      <line x1="12" y1="11.5" x2="12" y2="5.5" />
                    </svg>
                    {/* Just "Analytics": the row is a toggle with its own
                        ON/OFF badge beside it, so the verb was describing what
                        the switch does rather than naming the thing. */}
                    <span style={{ flex: 1 }}>Analytics</span>
                    <span style={{
                      fontSize: '10px',
                      fontWeight: 700,
                      padding: '1px 7px',
                      borderRadius: 'var(--radius-pill)',
                      background: metricsEnabled ? 'var(--color-success-bg)' : 'var(--stone-100)',
                      color: metricsEnabled ? '#065F46' : 'var(--stone-500)',
                    }}>
                      {metricsSaving ? '…' : metricsEnabled ? 'ON' : 'OFF'}
                    </span>
                  </button>
                  <p style={{ fontSize: '10px', color: 'var(--stone-400)', padding: '0 14px 6px', margin: 0, lineHeight: 1.3 }}>
                    Uses X API read credits · refreshes weekly
                  </p>
                </>
              )}
              <div style={{ height: '1px', background: 'var(--stone-100)', margin: '4px 8px' }} />
              <button
                style={{ ...menuItemStyle, color: 'var(--color-error)' }}
                onClick={() => setConfirmDelete(true)}
                onMouseOver={e => (e.currentTarget.style.background = 'var(--color-error-bg)')}
                onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="2 4 12 4" />
                  <path d="M5 4V2.5a.5.5 0 01.5-.5h3a.5.5 0 01.5.5V4" />
                  <path d="M3 4l.8 8a1 1 0 001 .9h4.4a1 1 0 001-.9L11 4" />
                </svg>
                Remove
              </button>
            </>
          ) : (
            <div style={{ padding: '12px' }}>
              <p style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--stone-700)', marginBottom: '4px' }}>
                Remove this account?
              </p>
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-500)', marginBottom: '12px', lineHeight: 1.4 }}>
                Scheduled posts for this account will fail.
              </p>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn btn-ghost btn-sm" onClick={() => { setConfirmDelete(false); setOpen(false); }}>
                  Cancel
                </button>
                <button
                  className="btn btn-sm"
                  style={{ background: 'var(--color-error)', color: '#fff' }}
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  {deleting ? 'Removing...' : 'Remove'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

// Facebook SDK types
declare global {
  interface Window {
    fbAsyncInit?: () => void;
    FB?: {
      init: (params: { appId: string; cookie: boolean; xfbml: boolean; version: string }) => void;
      login: (
        callback: (response: { status: string; authResponse?: { accessToken: string; userID: string } }) => void,
        options: { scope?: string; return_scopes?: boolean; auth_type?: string; config_id?: string },
      ) => void;
      api: (path: string, params: Record<string, any>, callback: (response: any) => void) => void;
    };
  }
}

/**
 * Server-resolved availability for one platform (see lib/platforms/availability.ts).
 * `off` = kill switch (hidden; connected channels read-only, posts held).
 * `connect_off` = new connections paused, existing channels keep publishing.
 */
export interface PlatformAvailabilityView {
  state: 'on' | 'connect_off' | 'off';
  reason: 'enabled' | 'flag_connect_off' | 'flag_off' | 'unconfigured';
  canConnect: boolean;
  canPublish: boolean;
  message: string | null;
  /** Set when this describes a sub-platform variant — the channel accountType. */
  variant?: string;
}

const FULLY_AVAILABLE: PlatformAvailabilityView = {
  state: 'on',
  reason: 'enabled',
  canConnect: true,
  canPublish: true,
  message: null,
};

/**
 * Turn the `?error=` value into something a user can act on.
 *
 * Two kinds of value arrive here. Our own callback failures are already written
 * for humans ("… is not available on the Free plan"), so they pass through
 * untouched. The provider's own OAuth error codes are not — they arrive as bare
 * snake_case slugs straight off the query string, which read as noise.
 */
function describeOAuthError(raw: string): string {
  const known: Record<string, string> = {
    access_denied: 'You declined the permission request, so nothing was connected.',
    user_denied: 'You declined the permission request, so nothing was connected.',
    user_cancelled_login: 'The connection was cancelled before it finished.',
    user_cancelled_authorize: 'The connection was cancelled before it finished.',
    consent_required: 'The permission request was not completed, so nothing was connected.',
    invalid_scope: 'This app is missing a permission it needs. Please contact support.',
    server_error: 'The provider had a temporary problem. Please try again in a moment.',
    temporarily_unavailable:
      'The provider is temporarily unavailable. Please try again in a moment.',
  };
  return known[raw] ?? raw;
}

export function ChannelList({
  hiddenPlatforms = [],
  platformAvailability = {},
  variantAvailability = {},
}: {
  hiddenPlatforms?: string[];
  platformAvailability?: Record<string, PlatformAvailabilityView>;
  /** `{ platform: { accountType: availability } }` — e.g. LinkedIn company pages. */
  variantAvailability?: Record<string, Record<string, PlatformAvailabilityView>>;
} = {}) {
  const hiddenPlatformSet = new Set(hiddenPlatforms);
  const availabilityFor = (key: string): PlatformAvailabilityView =>
    platformAvailability[key] ?? FULLY_AVAILABLE;

  // LinkedIn company pages ride a separate LinkedIn app (Community Management
  // API) with its own approval, so they get their own gate. Personal-profile
  // connect is unaffected by this being paused.
  const liPagesAvail = variantAvailability.linkedin?.organization ?? FULLY_AVAILABLE;
  const { data: _channelData, error: _channelError, isLoading: loading, mutate: mutateChannels } = useApi<Channel[] | { channels?: Channel[] }>('/api/channels');
  const channels = Array.isArray(_channelData) ? _channelData : _channelData?.channels ?? [];
  const error = _channelError?.message ?? null;
  const { data: _usageData } = useApi<{ plan?: string }>('/api/quotas/usage');
  const userPlan = _usageData?.plan ?? null;

  // Connection state
  const [connectingPlatform, setConnectingPlatform] = useState<Platform | null>(null);
  const [connectLoading, setConnectLoading] = useState(false);
  const [connectError, setConnectError] = useState<ApiErrorData | null>(null);

  // Channel-limit errors get a modal instead of the inline red line at the
  // bottom of the grid (which sat below the fold and was routinely missed).
  // Reuses the shared Dialog + the ChannelSlotPurchase buy button, so the slot
  // can be bought without leaving the page.
  const [quotaError, setQuotaError] = useState<ApiErrorData | null>(null);
  const showConnectError = useCallback((err: ApiErrorData) => {
    if (err.addon === 'channel_slot') {
      setQuotaError(err);
    } else {
      setConnectError(err);
    }
  }, []);

  // Outcome of an OAuth round-trip, read from the query string the callback
  // redirects to (`?connected=…&account=…` or `?error=…`).
  const [callbackNotice, setCallbackNotice] =
    useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  // Bluesky credential dialog
  const [bskyDialogOpen, setBskyDialogOpen] = useState(false);
  const [bskyIdentifier, setBskyIdentifier] = useState('');
  const [bskyPassword, setBskyPassword] = useState('');
  const [bskyPdsUrl, setBskyPdsUrl] = useState('');
  const [bskyLoading, setBskyLoading] = useState(false);

  // Mastodon instance dialog
  const [mastodonDialogOpen, setMastodonDialogOpen] = useState(false);
  const [mastodonInstance, setMastodonInstance] = useState('');
  const [mastodonLoading, setMastodonLoading] = useState(false);

  // Telegram credentials dialog
  const [tgDialogOpen, setTgDialogOpen] = useState(false);
  const [tgBotToken, setTgBotToken] = useState('');
  const [tgChatId, setTgChatId] = useState('');
  const [tgLoading, setTgLoading] = useState(false);

  // Facebook page picker
  const [fbPages, setFbPages] = useState<Array<{ id: string; name: string; access_token: string; picture?: { data?: { url?: string } } }>>([]);
  const [fbPageDialogOpen, setFbPageDialogOpen] = useState(false);
  const [fbUserToken, setFbUserToken] = useState('');
  const [fbSaving, setFbSaving] = useState(false);

  // LinkedIn page picker
  const [liOrgs, setLiOrgs] = useState<Array<{ id: string; name: string; logoUrl?: string }>>([]);
  const [liOrgDialogOpen, setLiOrgDialogOpen] = useState(false);
  const [liLoading, setLiLoading] = useState(false);
  const [liSaving, setLiSaving] = useState(false);
  const [liSession, setLiSession] = useState<string | null>(null);

  /* ---- Fetch channels (via SWR) ---- */

  /* ---- Handlers ---- */

  function handleDisconnect(id: string) {
    // Remove the channel from the list — no revalidation needed since the DELETE already succeeded
    mutateChannels((cur: any) => {
      const arr = Array.isArray(cur) ? cur : cur?.channels ?? [];
      const filtered = arr.filter((c: any) => String(c.id) !== String(id));
      return Array.isArray(cur) ? filtered : { ...cur, channels: filtered };
    }, { revalidate: false });
  }

  async function handlePlatformClick(platform: Platform) {
    track('connect_platform_clicked', { platform });

    if (platform === 'bluesky') {
      setBskyDialogOpen(true);
      return;
    }

    if (platform === 'mastodon') {
      setMastodonDialogOpen(true);
      return;
    }

    if (platform === 'telegram') {
      setTgDialogOpen(true);
      return;
    }

    if (platform === 'facebook') {
      handleFacebookConnect();
      return;
    }

    setConnectingPlatform(platform);
    setConnectLoading(true);
    setConnectError(null);

    try {
      const res = await fetch(`/api/channels/connect/${platform}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        track('connect_start_failed', { platform, status: res.status });
        showConnectError(parseApiError(data, 'Failed to get auth URL'));
        setConnectLoading(false);
        setConnectingPlatform(null);
        return;
      }

      if (data.url || data.authUrl) {
        window.location.href = data.url || data.authUrl;
      } else {
        throw new Error('No auth URL returned');
      }
    } catch (err) {
      track('connect_start_failed', { platform, message: err instanceof Error ? err.message : 'unknown' });
      setConnectError({ message: err instanceof Error ? err.message : 'Connection failed' });
      setConnectLoading(false);
      setConnectingPlatform(null);
    }
  }

  async function handleBskySubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!bskyIdentifier.trim() || !bskyPassword.trim()) return;

    setBskyLoading(true);
    setConnectError(null);

    try {
      const res = await fetch('/api/channels/connect/bluesky', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: bskyIdentifier.trim(),
          appPassword: bskyPassword.trim(),
          ...(bskyPdsUrl.trim() ? { pdsUrl: bskyPdsUrl.trim() } : {}),
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showConnectError(parseApiError(data, 'Failed to connect Bluesky'));
        setBskyLoading(false);
        return;
      }

      setBskyDialogOpen(false);
      setBskyIdentifier('');
      setBskyPassword('');
      setBskyPdsUrl('');
      const fresh = await fetch('/api/channels', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
      if (fresh) mutateChannels(fresh, { revalidate: false });
    } catch (err) {
      setConnectError({ message: err instanceof Error ? err.message : 'Connection failed' });
    } finally {
      setBskyLoading(false);
    }
  }

  async function handleTelegramSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!tgBotToken.trim() || !tgChatId.trim()) return;

    setTgLoading(true);
    setConnectError(null);

    try {
      const res = await fetch('/api/channels/connect/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          botToken: tgBotToken.trim(),
          chatId: tgChatId.trim(),
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showConnectError(parseApiError(data, 'Failed to connect Telegram'));
        setTgLoading(false);
        return;
      }

      setTgDialogOpen(false);
      setTgBotToken('');
      setTgChatId('');
      const fresh = await fetch('/api/channels', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
      if (fresh) mutateChannels(fresh, { revalidate: false });
    } catch (err) {
      setConnectError({ message: err instanceof Error ? err.message : 'Connection failed' });
    } finally {
      setTgLoading(false);
    }
  }

  async function handleMastodonSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!mastodonInstance.trim()) return;

    setMastodonLoading(true);
    setConnectError(null);

    try {
      const res = await fetch('/api/channels/connect/mastodon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceUrl: mastodonInstance.trim() }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        showConnectError(parseApiError(data, 'Failed to connect Mastodon'));
        setMastodonLoading(false);
        return;
      }

      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error('No auth URL returned');
      }
    } catch (err) {
      setConnectError({ message: err instanceof Error ? err.message : 'Connection failed' });
      setMastodonLoading(false);
    }
  }

  /* ---- Facebook SDK flow ---- */

  function loadFacebookSDK(appId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (window.FB) {
        // Re-init with our app ID in case SDK was loaded by another widget
        window.FB.init({ appId, cookie: true, xfbml: true, version: 'v24.0' });
        resolve();
        return;
      }
      // Give up after 10s so a failed/blocked SDK load surfaces an error
      // instead of leaving the connect flow hanging forever.
      const timeout = setTimeout(() => {
        clearInterval(poll);
        reject(new Error('Facebook SDK took too long to load. Check your ad blocker and try again.'));
      }, 10_000);
      const settle = () => {
        clearTimeout(timeout);
        clearInterval(poll);
        window.FB!.init({ appId, cookie: true, xfbml: true, version: 'v24.0' });
        resolve();
      };
      window.fbAsyncInit = settle;
      // If the script tag already exists (a previous attempt is mid-load), our
      // fbAsyncInit above may have replaced one that already fired — poll for
      // window.FB as a fallback so this promise always settles.
      const poll = setInterval(() => {
        if (window.FB) settle();
      }, 100);
      if (document.getElementById('facebook-jssdk')) {
        return;
      }
      const script = document.createElement('script');
      script.id = 'facebook-jssdk';
      script.src = 'https://connect.facebook.net/en_US/sdk.js';
      script.async = true;
      script.defer = true;
      script.onerror = () => {
        clearTimeout(timeout);
        clearInterval(poll);
        reject(new Error('Failed to load Facebook SDK'));
      };
      document.body.appendChild(script);
    });
  }

  // Preload the FB SDK + app config as soon as the page mounts, so clicking
  // "Connect" can call FB.login() synchronously within the click gesture.
  // (A popup opened after an await loses the trusted-gesture flag and gets
  // silently blocked — the cause of intermittent "nothing happens" reports.)
  const fbConfigRef = useRef<{ appId: string; configId?: string } | null>(null);
  useEffect(() => {
    if (hiddenPlatformSet.has('facebook')) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/channels/connect/facebook');
        if (!res.ok) return; // plan-gated or unconfigured — on-demand path will surface it
        const data = await res.json();
        if (cancelled || !data.appId) return;
        fbConfigRef.current = { appId: data.appId, configId: data.configId };
        await loadFacebookSDK(data.appId);
      } catch {
        // Preload is best-effort; handleFacebookConnect falls back to on-demand load.
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function fbLoginOptions(configData: { configId?: string }) {
    // config_id uses Facebook Login for Business; fallback to scope-based login
    return configData.configId
      ? { config_id: configData.configId }
      : {
          // pages_read_user_content is required to read USER-generated content on
          // a Page — the comments and reactions the engagement pane lists.
          // pages_read_engagement only covers content the Page itself posted, so
          // without this the /{post-id}/comments and /reactions reads that back
          // the whole engagement feature are unauthorized.
          scope: 'public_profile,pages_show_list,pages_manage_posts,pages_manage_engagement,pages_read_engagement,pages_read_user_content,business_management',
          return_scopes: true,
        };
  }

  async function handleFacebookConnect() {
    setConnectingPlatform('facebook');
    setConnectLoading(true);
    setConnectError(null);

    try {
      let configData = fbConfigRef.current;

      // Slow path: preload didn't finish — fetch config + SDK now. The popup
      // may be blocked on this attempt; the blocked-popup check below catches it.
      if (!configData || !window.FB) {
        const configRes = await fetch('/api/channels/connect/facebook');
        const fetched = await configRes.json();
        if (!fetched.appId) {
          throw new Error('Facebook App ID not configured');
        }
        configData = { appId: fetched.appId, configId: fetched.configId };
        fbConfigRef.current = configData;
        await loadFacebookSDK(fetched.appId);
      }

      const loginStartedAt = Date.now();
      window.FB!.login(
        (loginResponse) => {
          if (loginResponse.status !== 'connected' || !loginResponse.authResponse?.accessToken) {
            // A blocked popup makes FB.login invoke the callback almost
            // instantly with a non-connected status — a real user cancel
            // takes at least a second or two.
            const blocked = Date.now() - loginStartedAt < 500;
            setConnectError({
              message: blocked
                ? 'Your browser blocked the Facebook popup. Allow popups for this site (or just click Connect again).'
                : 'Facebook login was cancelled.',
            });
            setConnectLoading(false);
            setConnectingPlatform(null);
            return;
          }

          const userToken = loginResponse.authResponse.accessToken;
          setFbUserToken(userToken);

          // Step 1: Try /me/accounts (works when user has direct page admin role)
          window.FB!.api(
            '/me/accounts',
            { fields: 'id,name,access_token,picture' },
            (pagesRes: any) => {
              if (pagesRes.data?.length > 0) {
                handleFacebookPagesResult(pagesRes.data, userToken);
                return;
              }

              // Step 2: Try business-owned pages (for Business Portfolio managed pages)
              window.FB!.api(
                '/me/businesses',
                { fields: 'id,name' },
                (bizRes: any) => {
                  if (!bizRes.data?.length) {
                    fbConnectError('No Facebook Pages found. Make sure your account manages at least one Facebook Page.');
                    return;
                  }

                  let pending = bizRes.data.length;
                  const allPages: any[] = [];

                  for (const biz of bizRes.data) {
                    window.FB!.api(
                      `/${biz.id}/owned_pages`,
                      { fields: 'id,name,access_token,picture' },
                      (ownedRes: any) => {
                        if (ownedRes.data?.length) {
                          allPages.push(...ownedRes.data);
                        }

                        pending--;
                        if (pending > 0) return;

                        // Pages with tokens can be saved directly
                        const withToken = allPages.filter((p: any) => p.access_token);
                        if (withToken.length > 0) {
                          handleFacebookPagesResult(withToken, userToken);
                          return;
                        }

                        // Pages found but no tokens — user lacks direct page admin role
                        if (allPages.length > 0) {
                          fbConnectError(
                            `Found page "${allPages[0].name}" but cannot get an access token. ` +
                            'You need direct admin access to the page. Go to business.facebook.com \u2192 ' +
                            'Settings \u2192 People \u2192 your name \u2192 Assets \u2192 Pages \u2192 ' +
                            'add the page with Full Control, then try again.',
                          );
                          return;
                        }

                        fbConnectError('No Facebook Pages found in your Business Portfolio.');
                      },
                    );
                  }
                },
              );
            },
          );
        },
        fbLoginOptions(configData),
      );
    } catch (err) {
      setConnectError({ message: err instanceof Error ? err.message : 'Connection failed' });
      setConnectLoading(false);
      setConnectingPlatform(null);
    }
  }

  function fbConnectError(message: string) {
    setConnectLoading(false);
    setConnectingPlatform(null);
    setConnectError({ message });
  }

  function handleFacebookPagesResult(
    pages: Array<{ id: string; name: string; access_token?: string; picture?: { data?: { url?: string } } }>,
    userToken: string,
  ) {
    setConnectLoading(false);
    if (pages.length === 1) {
      saveFacebookPage(pages[0], userToken);
    } else {
      setFbPages(pages as typeof fbPages);
      setFbPageDialogOpen(true);
    }
  }

  async function saveFacebookPage(
    page: { id: string; name: string; access_token?: string },
    userToken: string,
  ) {
    setFbSaving(true);
    setConnectError(null);

    try {
      const res = await fetch('/api/channels/connect/facebook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userAccessToken: userToken,
          pageId: page.id,
          pageName: page.name,
          pageAccessToken: page.access_token || '',
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showConnectError(parseApiError(data, 'Failed to save Facebook page'));
        setFbSaving(false);
        return;
      }

      setFbPageDialogOpen(false);
      setFbPages([]);
      setFbUserToken('');
      setConnectingPlatform(null);
      // Fetch fresh channel list directly to bypass SWR dedup
      const fresh = await fetch('/api/channels', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
      if (fresh) mutateChannels(fresh, { revalidate: false });
    } catch (err) {
      setConnectError({ message: err instanceof Error ? err.message : 'Failed to save page' });
    } finally {
      setFbSaving(false);
    }
  }

  /* ---- LinkedIn company page flow ---- */

  // Company pages authenticate against the separate Community Management app (App B),
  // so connecting one is a full OAuth redirect rather than reusing a personal token.
  function connectLinkedInPage() {
    window.location.href = '/api/channels/connect/linkedin?mode=page&redirect=true';
  }

  // After the page OAuth round-trip, LinkedIn sends the user back to /channels with a
  // one-time session key. Open the picker and load the orgs they administer.
  const loadLinkedInPageOrgs = useCallback(async (sessionKey: string) => {
    setLiSession(sessionKey);
    setLiOrgDialogOpen(true);
    setLiLoading(true);
    setConnectError(null);

    try {
      const res = await fetch(`/api/channels/linkedin/page-orgs?session=${encodeURIComponent(sessionKey)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showConnectError(parseApiError(data, 'Failed to load LinkedIn organizations'));
        return;
      }
      setLiOrgs(data.items ?? []);
    } catch (err) {
      setConnectError({ message: err instanceof Error ? err.message : 'Failed to load organizations' });
    } finally {
      setLiLoading(false);
    }
  }, []);

  /**
   * Surface the OAuth callback's outcome.
   *
   * `/auth/callback/[platform]` finishes every attempt by redirecting here with
   * either `?connected=<platform>&account=<name>` or `?error=<message>`. Until
   * this existed, the page read only `linkedin_page_session` and dropped both
   * on the floor: a user who was denied — an unapproved app, a plan limit, a
   * cancelled consent screen — came back to an unchanged Channels page with no
   * indication anything had happened, and retried the same dead end. (Prod logs
   * for 2026-07-31 show one user doing exactly that five times against
   * Instagram.)
   *
   * The params are stripped afterwards so a refresh doesn't replay a stale
   * notice.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connectedPlatform = params.get('connected');
    const errorMessage = params.get('error');
    if (!connectedPlatform && !errorMessage) return;

    if (connectedPlatform) {
      track('oauth_connect_result', { platform: connectedPlatform, ok: true });
      const label =
        PLATFORMS.find((p) => p.key === connectedPlatform)?.name ?? connectedPlatform;
      const account = params.get('account');
      setCallbackNotice({
        kind: 'success',
        text: account ? `${label} connected: ${account}` : `${label} connected.`,
      });
      // The list was fetched before the redirect landed, so it does not yet
      // contain the new channel.
      mutateChannels();
    } else {
      track('oauth_connect_result', { ok: false, error: errorMessage });
      // A quota rejection from the OAuth callback (user picked a new account
      // mid-flow while at the limit) gets the same slot dialog as the
      // pre-redirect wall instead of a banner.
      if (errorMessage!.includes('reached the channel limit')) {
        setQuotaError({ message: errorMessage!, addon: 'channel_slot' });
      } else {
        setCallbackNotice({ kind: 'error', text: describeOAuthError(errorMessage!) });
      }
    }

    params.delete('connected');
    params.delete('account');
    params.delete('error');
    const qs = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  }, [mutateChannels]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionKey = params.get('linkedin_page_session');
    if (sessionKey) {
      loadLinkedInPageOrgs(sessionKey);
      // Strip the key from the URL so a refresh doesn't re-trigger the picker.
      params.delete('linkedin_page_session');
      const qs = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    }
  }, [loadLinkedInPageOrgs]);

  async function saveLinkedInPage(org: { id: string; name: string }) {
    if (!liSession) return;

    setLiSaving(true);
    setConnectError(null);

    try {
      const res = await fetch('/api/channels/connect-linkedin-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: liSession,
          organizationId: org.id,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showConnectError(parseApiError(data, 'Failed to connect LinkedIn page'));
        setLiSaving(false);
        return;
      }

      setLiOrgDialogOpen(false);
      setLiOrgs([]);
      setLiSession(null);
      const fresh = await fetch('/api/channels', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
      if (fresh) mutateChannels(fresh, { revalidate: false });
    } catch (err) {
      setConnectError({ message: err instanceof Error ? err.message : 'Failed to connect page' });
    } finally {
      setLiSaving(false);
    }
  }

  // Group channels by platform
  const channelsByPlatform = new Map<string, Channel[]>();
  for (const ch of channels) {
    const list = channelsByPlatform.get(ch.platform) ?? [];
    list.push(ch);
    channelsByPlatform.set(ch.platform, list);
  }

  /* ---- Loading state ---- */

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '80px 0', gap: '12px', color: 'var(--stone-400)' }}>
        <Spinner size="md" />
        <span style={{ fontSize: 'var(--text-sm)' }}>Loading channels...</span>
      </div>
    );
  }

  /* ---- Error state ---- */

  if (error) {
    return (
      <div className="card" style={{ padding: '32px', textAlign: 'center' }}>
        <p style={{ fontSize: 'var(--text-md)', fontWeight: 500, color: 'var(--color-error)', marginBottom: '8px' }}>
          Failed to load channels
        </p>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-500)', marginBottom: '16px' }}>{error}</p>
        <button className="btn btn-secondary" onClick={() => mutateChannels()}>Try Again</button>
      </div>
    );
  }

  /* ---- Main view ---- */

  return (
    <div>
      {callbackNotice && (
        <div
          role="status"
          aria-live="polite"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '10px',
            padding: '12px 14px',
            marginBottom: '16px',
            borderRadius: 'var(--radius-md)',
            fontSize: 'var(--text-sm)',
            background:
              callbackNotice.kind === 'success'
                ? 'var(--color-success-bg)'
                : 'var(--color-error-bg)',
            border: `1px solid ${
              callbackNotice.kind === 'success'
                ? 'var(--color-success-border)'
                : 'var(--color-error-border)'
            }`,
            color:
              callbackNotice.kind === 'success'
                ? 'var(--color-success-text)'
                : 'var(--color-error-text)',
          }}
        >
          <span style={{ flex: 1 }}>{callbackNotice.text}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setCallbackNotice(null)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'inherit',
              padding: 0,
              lineHeight: 1,
              fontSize: 'var(--text-md)',
            }}
          >
            ×
          </button>
        </div>
      )}
      <div className="r-channel-grid" style={styles.grid}>
        {PLATFORMS.map((platform) => {
          const connected = channelsByPlatform.get(platform.key) ?? [];
          // Hide platforms whose app credentials aren't configured yet — but only
          // when there are no existing accounts, so connected channels stay manageable.
          if (hiddenPlatformSet.has(platform.key) && connected.length === 0) return null;
          const isConnecting = connectingPlatform === platform.key && connectLoading;
          const hasAccounts = connected.length > 0;
          // Server-computed status — auto-renewing channels never "expire" by the clock.
          const hasExpired = connected.some(
            (ch) => ch.needsReconnect || ch.tokenStatus === 'expired',
          );
          const isSoon = !!platform.comingSoon && !hasAccounts;
          const isExcluded = platform.key === 'x' && userPlan === 'free';
          // Availability flags: `connect_off` blocks new connections but leaves
          // existing channels working; `off` also halts publishing (posts held).
          const avail = availabilityFor(platform.key);
          const connectPaused = !avail.canConnect && !isExcluded && !isSoon;
          const publishHalted = !avail.canPublish;

          // When company pages can't be connected, the card simply describes
          // what it does offer. We deliberately don't tell customers pages are
          // "paused" or "pending review" — it advertises a gap and dates
          // itself; "Personal profiles" is just the truth about what they get.
          const description =
            platform.key === 'linkedin' && !liPagesAvail.canConnect
              ? 'Personal profiles only'
              : platform.description;

          return (
            <div key={platform.key} style={{ ...styles.card, ...(isSoon ? styles.cardComingSoon : {}), ...(isExcluded ? styles.cardExcluded : {}) }}>
              {/* Card header: icon + name + action */}
              <div style={styles.cardHeader}>
                <div style={isSoon || isExcluded ? { opacity: 0.4, filter: 'grayscale(1)' } : undefined}>
                  <PlatformIcon platform={platform.key} size="lg" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h4 style={{ ...styles.platformName, ...(isSoon || isExcluded ? { color: 'var(--stone-400)' } : {}) }}>{platform.name}</h4>
                  <p style={styles.platformDesc}>
                    {isExcluded ? 'Requires Pro plan' : description}
                  </p>
                </div>
                {isExcluded ? (
                  <a
                    href="/pricing"
                    style={{
                      ...styles.connectBtn,
                      background: 'var(--stone-200)',
                      color: 'var(--stone-600)',
                      textDecoration: 'none',
                      pointerEvents: 'auto' as const,
                    }}
                  >
                    Upgrade
                  </a>
                ) : isSoon ? (
                  <span style={styles.comingSoonBadge}>Coming soon</span>
                ) : publishHalted && hasAccounts ? (
                  <span style={{ ...styles.connectedBadge, color: 'var(--color-warning)', background: 'var(--color-warning-bg)' }}>
                    <span style={{ ...styles.connectedDot, background: 'var(--color-warning)' }} />
                    Unavailable
                  </span>
                ) : hasAccounts ? (
                  <span style={{ ...styles.connectedBadge, color: hasExpired ? 'var(--color-error)' : platform.accent, background: hasExpired ? 'var(--color-error-bg)' : `${platform.accent}14` }}>
                    <span style={{ ...styles.connectedDot, background: hasExpired ? 'var(--color-error)' : platform.accent }} />
                    {hasExpired ? 'Expired' : 'Connected'}
                  </span>
                ) : connectPaused ? (
                  <span style={styles.comingSoonBadge}>Paused</span>
                ) : (
                  <button
                    onClick={() => handlePlatformClick(platform.key)}
                    disabled={connectLoading}
                    style={{
                      ...styles.connectBtn,
                      background: platform.accent,
                      opacity: connectLoading && !isConnecting ? 0.5 : 1,
                    }}
                  >
                    {isConnecting ? 'Connecting...' : 'Connect'}
                  </button>
                )}
              </div>

              {/* Why this platform is paused/unavailable — server-supplied copy so
                  the reason (pending approval vs outage) is accurate. */}
              {avail.message && (connectPaused || publishHalted) && (
                <p
                  style={{
                    marginTop: '10px',
                    marginBottom: '10px',
                    fontSize: 'var(--text-sm)',
                    lineHeight: 1.4,
                    color: 'var(--color-warning-text)',
                    background: 'var(--color-warning-bg)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '8px 10px',
                  }}
                >
                  {avail.message}
                </p>
              )}

              {/* LinkedIn: offer company-page connect even before a personal profile exists.
                  Hidden entirely when pages can't be connected — the card header
                  reads "Personal profiles" instead, with no explanation of what's
                  missing (see `description` above). */}
              {platform.key === 'linkedin' && !hasAccounts && !isExcluded && !isSoon && !connectPaused && liPagesAvail.canConnect && (
                <button
                  onClick={connectLinkedInPage}
                  disabled={connectLoading}
                  style={{
                    marginTop: '10px',
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    color: platform.accent,
                    fontSize: 'var(--text-sm)',
                    fontWeight: 500,
                    cursor: connectLoading ? 'wait' : 'pointer',
                    textDecoration: 'underline',
                    textUnderlineOffset: '2px',
                  }}
                >
                  or connect a Company Page
                </button>
              )}

              {/* Connected accounts section — faded platform color */}
              {hasAccounts && (
                <div style={{ ...styles.accountSection, background: platform.bg }}>
                  {connected.map((ch) => {
                    const isActive = ch.isActive;
                    const needsReconnect = !!ch.needsReconnect;
                    const isExpired = ch.tokenStatus === 'expired';
                    // A healthy channel can still be barred from publishing —
                    // its platform, or just its account type (LinkedIn company
                    // pages), is switched off and its posts are being held.
                    // Server-resolved per channel, so a paused variant shows
                    // here while its siblings on the same card stay green.
                    const heldByPlatform = ch.platformAvailable === false;
                    const dotColor = !isActive || needsReconnect || isExpired
                      ? 'var(--color-error)'
                      : heldByPlatform
                        ? 'var(--color-warning)'
                        : 'var(--color-success)';
                    const dotTitle = !isActive
                      ? 'Inactive'
                      : needsReconnect
                        ? 'Reconnect needed'
                        : isExpired
                          ? 'Expired'
                          : heldByPlatform
                            ? ch.platformMessage || 'Temporarily unavailable. Posts are on hold.'
                            : 'Active';
                    return (
                      <div key={ch.id} style={styles.accountRow}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
                          <p style={styles.accountName}>{ch.accountName}</p>
                          <span
                            style={{
                              ...styles.statusDot,
                              background: dotColor,
                            }}
                            title={dotTitle}
                          />
                          {heldByPlatform && (
                            <span
                              title={dotTitle}
                              style={{
                                flexShrink: 0,
                                fontSize: 'var(--text-xs)',
                                fontWeight: 500,
                                color: 'var(--color-warning-text)',
                                background: 'var(--color-warning-bg)',
                                borderRadius: 'var(--radius-sm)',
                                padding: '1px 6px',
                              }}
                            >
                              On hold
                            </span>
                          )}
                        </div>

                        <AccountMenu
                          channel={ch}
                          onAddAnother={() => handlePlatformClick(platform.key)}
                          onDisconnect={handleDisconnect}
                          onReauthorize={(p) => handlePlatformClick(p as Platform)}
                        />
                      </div>
                    );
                  })}

                  {/* LinkedIn: add company page button */}
                  {platform.key === 'linkedin' && liPagesAvail.canConnect && (
                    <button
                      onClick={connectLinkedInPage}
                      disabled={connectLoading}
                      style={{ ...styles.addAnotherBtn, color: platform.accent }}
                      onMouseOver={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.7)')}
                      onMouseOut={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.5)')}
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="2" width="10" height="10" rx="2" />
                        <line x1="7" y1="5" x2="7" y2="9" />
                        <line x1="5" y1="7" x2="9" y2="7" />
                      </svg>
                      Connect Company Page
                    </button>
                  )}

                  <button
                    onClick={() => handlePlatformClick(platform.key)}
                    disabled={connectLoading}
                    style={{ ...styles.addAnotherBtn, color: platform.accent }}
                    onMouseOver={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.7)')}
                    onMouseOut={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.5)')}
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="7" y1="3" x2="7" y2="11" />
                      <line x1="3" y1="7" x2="11" y2="7" />
                    </svg>
                    Add another account
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {connectError && <ApiError error={connectError} style={{ marginTop: '16px' }} />}

      {/* Channel-limit wall — modal, so it can't hide below the fold. */}
      <Dialog
        open={!!quotaError}
        onClose={() => setQuotaError(null)}
        title="Channel limit reached"
        size="sm"
      >
        <p
          style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--stone-600)',
            lineHeight: 'var(--leading-relaxed)',
            margin: 0,
          }}
        >
          {quotaError?.message}
          {quotaError?.hint ? ` ${quotaError.hint}` : ''}
        </p>
      </Dialog>

      {/* Bluesky credentials dialog */}
      <Dialog
        open={bskyDialogOpen}
        onClose={() => {
          setBskyDialogOpen(false);
          setBskyIdentifier('');
          setBskyPassword('');
          setBskyPdsUrl('');
          setConnectError(null);
        }}
        title="Connect Bluesky"
        description="Enter your handle and an app password to connect."
        size="sm"
      >
        <form onSubmit={handleBskySubmit}>
          <div style={{ marginBottom: '14px' }}>
            <label className="label" htmlFor="bsky-identifier">Handle or DID</label>
            <input
              id="bsky-identifier"
              className="input"
              type="text"
              placeholder="yourname.bsky.social"
              value={bskyIdentifier}
              onChange={(e) => setBskyIdentifier(e.target.value)}
              autoFocus
            />
          </div>

          <div style={{ marginBottom: '20px' }}>
            <label className="label" htmlFor="bsky-password">App Password</label>
            <input
              id="bsky-password"
              className="input"
              type="password"
              placeholder="xxxx-xxxx-xxxx-xxxx"
              value={bskyPassword}
              onChange={(e) => setBskyPassword(e.target.value)}
            />
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', marginTop: '6px', lineHeight: 1.4 }}>
              Generate an app password at Settings &rarr; Privacy and Security &rarr; App Passwords on bsky.app
            </p>
          </div>

          <div style={{ marginBottom: '20px' }}>
            <label className="label" htmlFor="bsky-pds-url">PDS URL <span style={{ color: 'var(--stone-400)', fontWeight: 400 }}>(optional)</span></label>
            <input
              id="bsky-pds-url"
              className="input"
              type="text"
              placeholder="https://bsky.social"
              value={bskyPdsUrl}
              onChange={(e) => setBskyPdsUrl(e.target.value)}
            />
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', marginTop: '6px', lineHeight: 1.4 }}>
              Leave blank for bsky.social. Only change if you use a self-hosted PDS.
            </p>
          </div>

          {connectError && <ApiError error={connectError} style={{ marginBottom: '14px' }} />}

          <button
            type="submit"
            className="btn btn-primary"
            disabled={bskyLoading || !bskyIdentifier.trim() || !bskyPassword.trim()}
            style={{ width: '100%' }}
          >
            {bskyLoading ? 'Connecting...' : 'Connect Bluesky'}
          </button>
        </form>
      </Dialog>

      {/* Mastodon instance dialog */}
      <Dialog
        open={mastodonDialogOpen}
        onClose={() => {
          setMastodonDialogOpen(false);
          setMastodonInstance('');
          setConnectError(null);
        }}
        title="Connect Mastodon"
        description="Enter your Mastodon instance URL to connect."
        size="sm"
      >
        <form onSubmit={handleMastodonSubmit}>
          <div style={{ marginBottom: '20px' }}>
            <label className="label" htmlFor="mastodon-instance">Instance URL</label>
            <input
              id="mastodon-instance"
              className="input"
              type="text"
              placeholder="mastodon.social"
              value={mastodonInstance}
              onChange={(e) => setMastodonInstance(e.target.value)}
              autoFocus
            />
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', marginTop: '6px', lineHeight: 1.4 }}>
              Enter the domain of your Mastodon instance (e.g., mastodon.social, fosstodon.org)
            </p>
          </div>

          {connectError && <ApiError error={connectError} style={{ marginBottom: '14px' }} />}

          <button
            type="submit"
            className="btn btn-primary"
            disabled={mastodonLoading || !mastodonInstance.trim()}
            style={{ width: '100%' }}
          >
            {mastodonLoading ? 'Connecting...' : 'Connect Mastodon'}
          </button>
        </form>
      </Dialog>

      {/* Telegram credentials dialog */}
      <Dialog
        open={tgDialogOpen}
        onClose={() => {
          setTgDialogOpen(false);
          setTgBotToken('');
          setTgChatId('');
          setConnectError(null);
        }}
        title="Connect Telegram"
        description="Connect a Telegram bot to post to a channel or group."
        size="sm"
      >
        <form onSubmit={handleTelegramSubmit}>
          <div style={{ marginBottom: '14px' }}>
            <label className="label" htmlFor="tg-bot-token">Bot Token</label>
            <input
              id="tg-bot-token"
              className="input"
              type="password"
              placeholder="123456789:ABCdef..."
              value={tgBotToken}
              onChange={(e) => setTgBotToken(e.target.value)}
              autoFocus
            />
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', marginTop: '6px', lineHeight: 1.4 }}>
              Create a bot with @BotFather on Telegram, then paste the token it gives you.
            </p>
          </div>

          <div style={{ marginBottom: '20px' }}>
            <label className="label" htmlFor="tg-chat-id">Channel or Chat</label>
            <input
              id="tg-chat-id"
              className="input"
              type="text"
              placeholder="@yourchannel or -1001234567890"
              value={tgChatId}
              onChange={(e) => setTgChatId(e.target.value)}
            />
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', marginTop: '6px', lineHeight: 1.4 }}>
              Add the bot to your channel or group as an admin, then enter the public username (the @ is optional) or the numeric chat id.
            </p>
          </div>

          {connectError && <ApiError error={connectError} style={{ marginBottom: '14px' }} />}

          <button
            type="submit"
            className="btn btn-primary"
            disabled={tgLoading || !tgBotToken.trim() || !tgChatId.trim()}
            style={{ width: '100%' }}
          >
            {tgLoading ? 'Connecting...' : 'Connect Telegram'}
          </button>
        </form>
      </Dialog>

      {/* Facebook page picker dialog */}
      <Dialog
        open={fbPageDialogOpen}
        onClose={() => {
          setFbPageDialogOpen(false);
          setFbPages([]);
          setFbUserToken('');
          setConnectingPlatform(null);
          setConnectError(null);
        }}
        title="Select a Facebook Page"
        description="Choose which page you want to connect."
        size="sm"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {fbPages.map((page) => (
            <button
              key={page.id}
              onClick={() => saveFacebookPage(page, fbUserToken)}
              disabled={fbSaving}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '12px',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--stone-200)',
                background: '#fff',
                cursor: fbSaving ? 'wait' : 'pointer',
                transition: 'background 120ms ease, border-color 120ms ease',
                textAlign: 'left',
                width: '100%',
              }}
              onMouseOver={(e) => {
                e.currentTarget.style.background = '#EFF6FF';
                e.currentTarget.style.borderColor = '#1877F2';
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.background = '#fff';
                e.currentTarget.style.borderColor = 'var(--stone-200)';
              }}
            >
              {page.picture?.data?.url ? (
                <img
                  src={page.picture.data.url}
                  alt=""
                  style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }}
                />
              ) : (
                <div style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  background: '#EFF6FF',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <PlatformIcon platform="facebook" size="sm" />
                </div>
              )}
              <div>
                <p style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--stone-800)', margin: 0 }}>
                  {page.name}
                </p>
                <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-500)', margin: '2px 0 0' }}>
                  Page ID: {page.id}
                </p>
              </div>
            </button>
          ))}

          {connectError && <ApiError error={connectError} style={{ marginTop: '6px' }} />}

          {fbSaving && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '12px', color: 'var(--stone-500)', fontSize: 'var(--text-sm)' }}>
              <Spinner size="sm" /> Connecting page...
            </div>
          )}
        </div>
      </Dialog>

      {/* LinkedIn page picker dialog */}
      <Dialog
        open={liOrgDialogOpen}
        onClose={() => {
          setLiOrgDialogOpen(false);
          setLiOrgs([]);
          setLiSession(null);
          setConnectError(null);
        }}
        title="Connect a LinkedIn Company Page"
        description="Select a page you administer to connect."
        size="sm"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {liLoading && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '24px', color: 'var(--stone-500)', fontSize: 'var(--text-sm)' }}>
              <Spinner size="sm" /> Loading organizations...
            </div>
          )}

          {!liLoading && liOrgs.length === 0 && !connectError && (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--stone-500)', fontSize: 'var(--text-sm)' }}>
              No LinkedIn Company Pages found. Make sure you are an administrator of at least one organization.
            </div>
          )}

          {liOrgs.map((org) => (
            <button
              key={org.id}
              onClick={() => saveLinkedInPage(org)}
              disabled={liSaving}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '12px',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--stone-200)',
                background: '#fff',
                cursor: liSaving ? 'wait' : 'pointer',
                transition: 'background 120ms ease, border-color 120ms ease',
                textAlign: 'left',
                width: '100%',
              }}
              onMouseOver={(e) => {
                e.currentTarget.style.background = '#EFF6FF';
                e.currentTarget.style.borderColor = '#0A66C2';
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.background = '#fff';
                e.currentTarget.style.borderColor = 'var(--stone-200)';
              }}
            >
              {org.logoUrl ? (
                <img
                  src={org.logoUrl}
                  alt=""
                  style={{ width: 36, height: 36, borderRadius: '6px', objectFit: 'cover' }}
                />
              ) : (
                <div style={{
                  width: 36,
                  height: 36,
                  borderRadius: '6px',
                  background: '#EFF6FF',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <PlatformIcon platform="linkedin" size="sm" />
                </div>
              )}
              <div>
                <p style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--stone-800)', margin: 0 }}>
                  {org.name}
                </p>
                <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-500)', margin: '2px 0 0' }}>
                  Company Page
                </p>
              </div>
            </button>
          ))}

          {connectError && <ApiError error={connectError} style={{ marginTop: '6px' }} />}

          {liSaving && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '12px', color: 'var(--stone-500)', fontSize: 'var(--text-sm)' }}>
              <Spinner size="sm" /> Connecting page...
            </div>
          )}
        </div>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

// Card outer radius = 16px, card padding = 10px
// Inner radius = outer - padding = 16 - 10 = 6px
const CARD_RADIUS = 16;
const CARD_PADDING = 10;
const INNER_RADIUS = CARD_RADIUS - CARD_PADDING; // 6px

const styles: Record<string, React.CSSProperties> = {
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '12px',
  },
  card: {
    background: '#fff',
    borderRadius: `${CARD_RADIUS}px`,
    padding: `${CARD_PADDING}px`,
    border: '2px solid var(--surface-card)',
  },
  cardComingSoon: {
    opacity: 0.55,
    pointerEvents: 'none' as const,
  },
  cardExcluded: {
    opacity: 0.65,
  },
  comingSoonBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '11px',
    fontWeight: 600,
    padding: '4px 12px',
    borderRadius: 'var(--radius-pill)',
    flexShrink: 0,
    color: 'var(--stone-400)',
    background: 'var(--stone-100)',
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '12px',
    marginBottom: '8px',
  },
  platformName: {
    fontSize: 'var(--text-md)',
    fontWeight: 600,
    color: 'var(--stone-900)',
    margin: 0,
    lineHeight: 1.3,
  },
  platformDesc: {
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-500)',
    margin: '2px 0 0',
    lineHeight: 1.3,
  },
  connectBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '6px 16px',
    borderRadius: 'var(--radius-pill)',
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    color: '#fff',
    border: 'none',
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'opacity 150ms ease',
  },
  connectedBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '11px',
    fontWeight: 600,
    padding: '4px 12px',
    borderRadius: 'var(--radius-pill)',
    flexShrink: 0,
  },
  connectedDot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
  },
  accountSection: {
    borderRadius: `${INNER_RADIUS}px`,
    padding: '6px',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  accountRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '8px 10px',
    borderRadius: `${Math.max(INNER_RADIUS - 6, 2)}px`,
    transition: 'background var(--transition-fast)',
  },
  accountName: {
    fontSize: 'var(--text-sm)',
    fontWeight: 500,
    color: 'var(--stone-800)',
    margin: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  statusDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  addAnotherBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 10px',
    borderRadius: `${Math.max(INNER_RADIUS - 6, 2)}px`,
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    background: 'rgba(255,255,255,0.5)',
    border: 'none',
    cursor: 'pointer',
    transition: 'background var(--transition-fast)',
  },
};
