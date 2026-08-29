import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useQueryState } from '@lib/useQueryState';
import { mutate } from 'swr';

const AnalyticsDashboard = lazy(() => import('./AnalyticsDashboard'));
const PostAnalyticsTable = lazy(() => import('./PostAnalyticsTable'));
const AccountAnalytics = lazy(() => import('./AccountAnalytics'));

type Tab = 'overview' | 'posts' | 'channels';

const tabs: { key: Tab; label: string; icon: ReactNode }[] = [
  {
    key: 'overview',
    label: 'Overview',
    icon: (
      <svg width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="5" height="7" rx="1" />
        <rect x="11" y="2" width="5" height="4" rx="1" />
        <rect x="2" y="12" width="5" height="4" rx="1" />
        <rect x="11" y="9" width="5" height="7" rx="1" />
      </svg>
    ),
  },
  {
    key: 'posts',
    label: 'Posts',
    icon: (
      <svg width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="3" y1="5" x2="15" y2="5" />
        <line x1="3" y1="9" x2="15" y2="9" />
        <line x1="3" y1="13" x2="11" y2="13" />
      </svg>
    ),
  },
  {
    key: 'channels',
    label: 'Channels',
    icon: (
      <svg width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 14l3-4 3 2 3-5 3 3" />
        <line x1="3" y1="15" x2="15" y2="15" />
      </svg>
    ),
  },
];

export default function AnalyticsPage() {
  const [tab, setTab] = useQueryState<Tab>('tab', 'overview');
  const [syncing, setSyncing] = useState(false);

  // A `?post=<id>` deep-link always refers to a specific post, so it must land on
  // the Posts tab even if the linking surface forgot to add `&tab=posts`. Without
  // this, such links open Overview and the post looks "missing". Runs once on mount.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('post') && params.get('tab') !== 'posts') {
      setTab('posts');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-trigger metrics sync on first mount. The endpoint is throttled (5 min),
  // so re-mounts and tab switches are cheap. Background metrics-sync cron was
  // removed — this is the only path that refreshes platform metrics.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/analytics/refresh', { method: 'POST' });
        if (!res.ok) return;
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (body?.status === 'queued') {
          setSyncing(true);
          // Give the worker a few seconds, then revalidate the analytics endpoints.
          // SWR will refetch any mounted /api/analytics/* hooks.
          setTimeout(() => {
            if (cancelled) return;
            mutate((key) => typeof key === 'string' && key.startsWith('/api/analytics/'), undefined, { revalidate: true });
            setSyncing(false);
          }, 8000);
        }
      } catch {
        /* ignore — analytics still renders from DB */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div>
      {/* Tab bar + sync indicator */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '4px', flexWrap: 'wrap' }}>
        <div style={styles.tabBar}>
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              style={{
                ...styles.tab,
                ...(tab === t.key ? styles.tabActive : {}),
              }}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
        {syncing && (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: 'var(--text-xs)',
            color: 'var(--stone-500)',
          }}>
            <span style={{
              width: '10px',
              height: '10px',
              border: '2px solid var(--stone-300)',
              borderTopColor: 'var(--accent-500)',
              borderRadius: '50%',
              display: 'inline-block',
              animation: 'spin 0.7s linear infinite',
            }} />
            Syncing latest metrics…
          </span>
        )}
      </div>

      {/* Content */}
      <Suspense fallback={
        <div className="card" style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ color: 'var(--stone-400)', fontSize: 'var(--text-sm)' }}>Loading...</p>
        </div>
      }>
        {tab === 'overview' && <AnalyticsDashboard />}
        {tab === 'posts' && <PostAnalyticsTable />}
        {tab === 'channels' && <AccountAnalytics />}
      </Suspense>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  tabBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '4px',
    background: 'var(--stone-100)',
    borderRadius: 'var(--radius-lg)',
    width: 'fit-content',
  },
  tab: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '7px 16px',
    borderRadius: '8px',
    border: 'none',
    background: 'transparent',
    fontSize: 'var(--text-sm)',
    fontWeight: 500,
    color: 'var(--stone-500)',
    cursor: 'pointer',
    transition: 'all 150ms ease',
    whiteSpace: 'nowrap' as const,
  },
  tabActive: {
    background: '#fff',
    color: 'var(--stone-900)',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  },
};
