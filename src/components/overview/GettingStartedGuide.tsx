import { useState } from 'react';
import { useApi } from '@lib/swr';

interface Props {
  channelCount: number;
  postCount: number;
  scheduledCount: number;
}

interface Step {
  label: string;
  description: string;
  href: string;
  cta: string;
}

const STORAGE_KEY = 'getting-started-dismissed';

const steps: Step[] = [
  {
    label: 'Connect a channel',
    description: 'Link your social media accounts to start publishing.',
    href: '/channels',
    cta: 'Connect',
  },
  {
    label: 'Create your first post',
    description: 'Write and publish content across your channels.',
    href: '/compose',
    cta: 'Compose',
  },
  {
    label: 'Schedule content',
    description: 'Plan posts ahead of time for consistent publishing.',
    href: '/compose',
    cta: 'Schedule',
  },
  {
    label: 'Set up repeat posts',
    description: 'Automatically repost content daily, weekly, or monthly.',
    href: '/repeat-posts',
    cta: 'Repeat',
  },
];

export default function GettingStartedGuide({ channelCount, postCount, scheduledCount }: Props) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const { data: _schedData } = useApi<any[] | { schedules?: any[] }>('/api/schedules');
  const hasRecurring = _schedData === undefined
    ? null
    : (Array.isArray(_schedData) ? _schedData : _schedData?.schedules ?? []).length > 0;
  const [hiding, setHiding] = useState(false);

  if (dismissed) return null;
  if (hasRecurring === null) return null; // still loading

  const completed = [
    channelCount > 0,
    postCount > 0,
    scheduledCount > 0,
    hasRecurring,
  ];
  const completedCount = completed.filter(Boolean).length;

  // Auto-hide when all done
  if (completedCount === steps.length) return null;

  function handleDismiss() {
    setHiding(true);
    setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, 'true');
      } catch { /* ignore */ }
      setDismissed(true);
    }, 250);
  }

  const progress = completedCount / steps.length;

  return (
    <div
      style={{
        ...styles.container,
        ...(hiding ? styles.containerHiding : {}),
      }}
      className="animate-fade-in-up"
    >
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={styles.headerIcon}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 1v2M8 13v2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M1 8h2M13 8h2M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" />
            </svg>
          </span>
          <h3 style={styles.title}>Getting Started</h3>
          <span style={styles.progressLabel}>{completedCount} of {steps.length}</span>
        </div>
        <button
          onClick={handleDismiss}
          style={styles.dismissBtn}
          title="Dismiss getting started guide"
          aria-label="Dismiss"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="3" y1="3" x2="11" y2="11" />
            <line x1="11" y1="3" x2="3" y2="11" />
          </svg>
        </button>
      </div>

      {/* Progress bar */}
      <div style={styles.progressTrack}>
        <div
          style={{
            ...styles.progressFill,
            width: `${progress * 100}%`,
          }}
        />
      </div>

      {/* Steps */}
      <div style={styles.stepsList}>
        {steps.map((step, i) => {
          const done = completed[i];
          return (
            <div key={i} style={styles.stepRow}>
              <span style={done ? styles.checkDone : styles.checkPending}>
                {done ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="2.5,6 5,8.5 9.5,3.5" />
                  </svg>
                ) : (
                  <span style={styles.stepNumber}>{i + 1}</span>
                )}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{
                  ...styles.stepLabel,
                  color: done ? '#A8A29E' : '#292524',
                }}>
                  {step.label}
                </p>
                <p style={{
                  ...styles.stepDesc,
                  color: done ? '#D6D3D1' : '#78716C',
                }}>
                  {step.description}
                </p>
              </div>
              {!done && (
                <a href={step.href} style={styles.stepCta}>
                  {step.cta}
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4.5 2.5l4 3.5-4 3.5" />
                  </svg>
                </a>
              )}
              {done && (
                <span style={styles.doneLabel}>Done</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: '#FFFFFF',
    borderRadius: 'var(--radius-lg)',
    border: 'none',
    padding: 0,
    marginBottom: '4px',
    transition: 'opacity 250ms ease, transform 250ms ease',
  },
  containerHiding: {
    opacity: 0,
    transform: 'translateY(-8px)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '14px',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  headerIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    borderRadius: 'var(--radius-md)',
    background: '#FFF7ED',
    color: 'var(--accent-500)',
    flexShrink: 0,
  },
  title: {
    fontSize: '14px',
    fontWeight: 600,
    color: '#292524',
    margin: 0,
  },
  progressLabel: {
    fontSize: '12px',
    fontWeight: 500,
    color: '#A8A29E',
  },
  dismissBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    borderRadius: 'var(--radius-md)',
    border: 'none',
    background: 'none',
    color: '#A8A29E',
    cursor: 'pointer',
    transition: 'background 150ms ease, color 150ms ease',
  },
  progressTrack: {
    width: '100%',
    height: '4px',
    borderRadius: '2px',
    background: '#F5F5F4',
    marginBottom: '18px',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: '2px',
    background: 'var(--accent-500)',
    transition: 'width 400ms cubic-bezier(0.4, 0, 0.2, 1)',
  },
  stepsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  stepRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '10px 12px',
    borderRadius: '10px',
    transition: 'background 150ms ease',
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
  checkPending: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '22px',
    height: '22px',
    borderRadius: '50%',
    border: 'none',
    background: 'none',
    flexShrink: 0,
  },
  stepNumber: {
    fontSize: '11px',
    fontWeight: 600,
    color: '#A8A29E',
    lineHeight: 1,
  },
  stepLabel: {
    fontSize: '13px',
    fontWeight: 500,
    margin: 0,
    lineHeight: 1.3,
  },
  stepDesc: {
    fontSize: '12px',
    fontWeight: 400,
    margin: '2px 0 0 0',
    lineHeight: 1.3,
  },
  stepCta: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '12px',
    fontWeight: 500,
    color: 'var(--accent-500)',
    textDecoration: 'none',
    flexShrink: 0,
    transition: 'opacity 150ms ease',
  },
  doneLabel: {
    fontSize: '12px',
    fontWeight: 500,
    color: '#A8A29E',
    flexShrink: 0,
  },
};
