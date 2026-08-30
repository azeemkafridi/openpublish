import { useState, useEffect } from 'react';
import { useApi } from '@lib/swr';
import { PLATFORM_CHAR_LIMITS } from '@lib/platforms/validation';
import { PLATFORM_DISPLAY_NAMES } from '@lib/platforms/types';
import { PostsBarChart } from '../analytics/PostsBarChart';
import type { CSSProperties, ReactNode } from 'react';
import type { PlatformName } from '@lib/platforms/types';

interface QuotaData {
  plan: string;
  limits: {
    channels: number;
    postsPerDay: number;
    postsPerMonth: number;
    maxPendingScheduled: number;
    mediaStorageMB: number;
    apiKeys: number;
    recurringSchedules: number;
    maxLabels: number;
  };
  usage: {
    apiKeys: number;
    postsToday: number;
    postsThisMonth: number;
    channels: number;
  };
}

interface ApiKey {
  id: string;
  isActive: boolean;
}

function fmtLimit(v: number): string {
  if (v === -1) return 'Unlimited';
  if (v === 0) return 'Not available';
  return v.toLocaleString();
}

export default function ApiOverview() {
  const [baseUrl, setBaseUrl] = useState('http://localhost:4321');
  useEffect(() => { setBaseUrl(window.location.origin); }, []);

  const apiDisabled = false; // self-hosted: API access is always available
  const { data: keyData, isLoading: keysLoading } = useApi<ApiKey[]>(apiDisabled ? null : '/api/api-keys');
  const { data: usageData } = useApi<{ today: number; limit: number; plan: string; perKey: Array<{ id: number; name: string; today: number }> }>(apiDisabled ? null : '/api/api-keys/usage');
  const keys = Array.isArray(keyData) ? keyData : [];
  const hasActiveKeys = keys.some((k) => k.isActive);
  const showGettingStarted = !apiDisabled && (keysLoading || !hasActiveKeys);

  // Compute last used from most recent key activity
  const lastUsedLabel = (() => {
    const dates = keys.map((k: any) => k.lastUsedAt).filter(Boolean);
    if (dates.length === 0) return 'Never';
    const latest = new Date(Math.max(...dates.map((d: string) => new Date(d).getTime())));
    const diff = Date.now() - latest.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  })();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Top bar: docs link always visible */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '-8px' }}>
        <a href="/docs" style={s.docsLink}>
          View full API reference
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 3h6v6" />
            <path d="M11 3L3 11" />
          </svg>
        </a>
      </div>

      {/* Quick start — show when no active keys and API is available */}
      {showGettingStarted && <div className="card">
        <h2 style={s.heading}>Getting Started</h2>
        <p style={s.desc}>
          Use the openPublish API to create posts, manage channels, upload media, and view analytics programmatically.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '16px' }}>
          <ApiStep num={1} title="Create an API key" desc="Scroll down to generate a key. Copy it immediately, as it's only shown once." done={hasActiveKeys} />
          <ApiStep num={2} title="Authenticate requests" done={hasActiveKeys}>
            <div style={s.stepDesc}>
              Add your key to the <code style={s.code}>Authorization</code> header:
            </div>
            <div style={s.codeBlock}>
              <code>Authorization: Bearer bp_your_key_here</code>
            </div>
          </ApiStep>
          <ApiStep num={3} title="Make your first request" done={false}>
            <div style={s.codeBlock}>
              <code>curl {baseUrl}/api/posts \{'\n'}  -H "Authorization: Bearer bp_your_key_here"</code>
            </div>
          </ApiStep>
        </div>

      </div>}

      {/* Usage stats — only for plans with API access */}
      {!apiDisabled && (
        <div
          className="r-stats-grid"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px' }}
        >
          <ApiStatCard
            label="Active Keys"
            value={keys.filter((k) => k.isActive).length}
            suffix="/ ∞"
            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 9h.01M15 15a6 6 0 100-12 6 6 0 000 12zM9.05 9.81c-.03-.27-.05-.54-.05-.81m.12.6L3.47 16.53a.5.5 0 00-.14.15c-.05.09-.09.18-.1.29 0 .11 0 .24 0 .48v1.74c0 .56 0 .84.11 1.05.1.19.25.34.44.44.21.11.49.11 1.05.11h1.74c.24 0 .37 0 .48-.03a.9.9 0 00.29-.1.5.5 0 00.15-.14l5.12-5.11" /></svg>}
          />
          <ApiStatCard
            label="Calls Today"
            value={usageData?.today ?? 0}
            suffix={`/ ${usageData?.limit === -1 ? '∞' : (usageData?.limit ?? '...')}`}
            icon={<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 14V4" /><path d="M7 14V8" /><path d="M11 14V6" /><path d="M15 14V2" /></svg>}
          />
          <ApiStatCard
            label="Last Used"
            value={lastUsedLabel}
            icon={<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="9" r="7" /><polyline points="9 5 9 9 12 11" /></svg>}
          />
          <ApiStatCard
            label="Status"
            value={hasActiveKeys ? 'Active' : 'Inactive'}
            icon={<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="9" r="7" /><path d="M6.5 9l2 2 3.5-3.5" /></svg>}
          />
        </div>
      )}

      {/* API Usage History Chart */}
      {!apiDisabled && hasActiveKeys && <ApiUsageChart />}

    </div>
  );
}

function ApiUsageChart() {
  const { data } = useApi<{ history: Array<{ date: string; count: number }> }>('/api/api-keys/usage/history?days=30');
  const history = data?.history ?? [];

  if (history.length === 0 || history.every((d) => d.count === 0)) return null;

  return (
    <div className="card" style={{ padding: '20px' }}>
      <h3 style={s.subheading}>API Calls (Last 30 Days)</h3>
      {/* The same chart component the Overview page uses, so the two never
          drift apart visually — only the tooltip's unit differs. */}
      <PostsBarChart
        data={history}
        from={history[0].date}
        to={history[history.length - 1].date}
        unit={{ one: 'call', many: 'calls' }}
      />
    </div>
  );
}

function ApiStatCard({ label, value, suffix, icon }: { label: string; value: number | string; suffix?: string; icon: ReactNode }) {
  return (
    <div className="r-api-stat-card" style={{
      background: '#FFFFFF',
      borderRadius: 'var(--radius-lg)',
      padding: '20px',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      border: '2px solid var(--surface-card)',
      minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
        <span style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: '36px', height: '36px', borderRadius: 'var(--radius-md)',
          background: 'var(--stone-150)', color: 'var(--stone-500)', flexShrink: 0,
        }}>
          {icon}
        </span>
        <span style={{ fontSize: '13px', fontWeight: 500, color: '#78716C', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'flex-end', gap: '6px', minWidth: 0 }}>
        <span className="r-api-stat-value" style={{
          fontSize: '42px', fontWeight: 400, fontFamily: 'var(--font-display)',
          color: '#3e3e3e', lineHeight: 1,
        }}>
          {typeof value === 'number' ? value.toLocaleString() : value}
        </span>
        {suffix && (
          <span style={{ fontSize: '14px', fontWeight: 400, color: '#A8A29E' }}>{suffix}</span>
        )}
      </div>
    </div>
  );
}

function ApiStep({ num, title, desc, done, children }: { num: number; title: string; desc?: string; done: boolean; children?: React.ReactNode }) {
  return (
    <div style={s.step}>
      {done ? (
        <span style={s.checkDone}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="2.5,6 5,8.5 9.5,3.5" />
          </svg>
        </span>
      ) : (
        <span style={s.stepNum}>{num}</span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ ...s.stepTitle, color: done ? '#A8A29E' : '#292524' }}>{title}</p>
        {desc && <p style={{ ...s.stepDesc, color: done ? '#D6D3D1' : '#78716C' }}>{desc}</p>}
        {!done && children}
      </div>
      {done && <span style={s.doneLabel}>Done</span>}
    </div>
  );
}


// Styles matching the overview GettingStartedGuide pattern:
// - No explicit fontFamily on text (inherits from AppLayout)
// - Hardcoded px values matching the overview guide (13px body, 14px titles)
// - fontFamily only on code/mono elements
const s: Record<string, CSSProperties> = {
  heading: {
    fontSize: '14px',
    fontWeight: 600,
    color: '#292524',
    margin: 0,
  },
  subheading: {
    fontSize: '13px',
    fontWeight: 600,
    color: '#57534E',
    margin: '0 0 8px',
  },
  desc: {
    fontSize: '13px',
    color: '#78716C',
    margin: '4px 0 0',
    lineHeight: 1.4,
  },
  step: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '10px 12px',
    borderRadius: '10px',
  },
  stepNum: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '22px',
    height: '22px',
    borderRadius: '50%',
    background: 'var(--stone-150)',
    flexShrink: 0,
    fontSize: '11px',
    fontWeight: 600,
    color: 'var(--stone-500)',
    lineHeight: 1,
  },
  checkDone: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '22px',
    height: '22px',
    borderRadius: '50%',
    background: '#4ADE80',
    flexShrink: 0,
  },
  doneLabel: {
    fontSize: '12px',
    fontWeight: 500,
    color: '#A8A29E',
    flexShrink: 0,
  },
  stepTitle: {
    fontSize: '13px',
    fontWeight: 500,
    color: '#292524',
    margin: 0,
    lineHeight: 1.3,
  },
  stepDesc: {
    fontSize: '12px',
    fontWeight: 400,
    color: '#78716C',
    marginTop: '2px',
    lineHeight: 1.3,
  },
  code: {
    fontFamily: 'var(--font-mono, monospace)',
    fontSize: '12px',
    background: '#F5F5F4',
    padding: '2px 6px',
    borderRadius: '4px',
  },
  codeBlock: {
    fontFamily: 'var(--font-mono, monospace)',
    fontSize: '12px',
    background: '#F4F4F5',
    color: '#3F3F46',
    padding: '10px 14px',
    borderRadius: '8px',
    marginTop: '8px',
    whiteSpace: 'pre',
    overflowX: 'auto',
  },
  docsLink: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '12px',
    fontWeight: 500,
    color: 'var(--accent-500)',
    textDecoration: 'none',
    flexShrink: 0,
    marginTop: '16px',
  },
  limitTable: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  limitRow: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '12px',
    color: '#57534E',
    padding: '6px 0',
    borderBottom: '1px solid #F5F5F4',
  },
  limitValue: {
    fontWeight: 600,
    fontFamily: 'var(--font-numeric)',
    fontVariantNumeric: 'tabular-nums',
    color: '#292524',
  },
};

export function ApiLimits() {
  const apiDisabled = false; // self-hosted: API access is always available


  return (
    <div className="card">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div>
          <h3 style={s.subheading}>Rate Limits</h3>
          <div style={s.limitTable}>
            <div style={s.limitRow}><span>Auth endpoints</span><span style={s.limitValue}>10 req/min</span></div>
            <div style={s.limitRow}><span>API endpoints</span><span style={s.limitValue}>60 req/min</span></div>
            <div style={s.limitRow}><span>Media uploads</span><span style={s.limitValue}>100 MB/file · videos up to 1 GB (multipart)</span></div>
          </div>
        </div>
        <div style={{ fontSize: '12px', color: '#A8A29E', padding: '4px 0' }}>
          Plan quotas (posts, channels, storage) are on the <a href="/settings" style={{ color: 'var(--accent-500)', textDecoration: 'none', fontWeight: 500 }}>Plan &amp; Usage</a> page.
        </div>
        <div>
          <h3 style={s.subheading}>Character Limits per Platform</h3>
          <div style={s.limitTable}>
            {(Object.entries(PLATFORM_CHAR_LIMITS) as [PlatformName, number][])
              .sort(([, a], [, b]) => a - b)
              .map(([platform, limit]) => (
                <div key={platform} style={s.limitRow}>
                  <span>{PLATFORM_DISPLAY_NAMES[platform] || platform}</span>
                  <span style={s.limitValue}>{limit.toLocaleString()}</span>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
