import type { ReactNode, CSSProperties } from 'react';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

// Default icons for pre-configured empty states
const icons = {
  analytics: (
    // Ascending pill bars on a baseline — thick rounded strokes so it reads at 48px,
    // instead of the old hairline bars floating inside a box.
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 32v-4" />
      <path d="M24 32V18" />
      <path d="M34 32V10" />
      <path d="M8 40h32" />
    </svg>
  ),
  reports: (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 6h18l12 12v24a4 4 0 01-4 4H12a4 4 0 01-4-4V10a4 4 0 014-4z" />
      <polyline points="30,6 30,18 42,18" />
      <line x1="16" y1="26" x2="32" y2="26" />
      <line x1="16" y1="34" x2="26" y2="34" />
    </svg>
  ),
  media: (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="10" width="36" height="28" rx="4" />
      <circle cx="16" cy="22" r="4" />
      <polyline points="42,30 32,20 14,38" />
    </svg>
  ),
};

const iconWrapperStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '80px',
  height: '80px',
  borderRadius: 'var(--radius-xl)',
  background: 'var(--surface-lavender)',
  color: 'var(--accent-500)',
  marginBottom: '24px',
};

const buttonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '8px',
  height: 'var(--control-height-md)',
  padding: '0 20px',
  fontSize: 'var(--text-sm)',
  fontWeight: 500,
  borderRadius: 'var(--radius-pill)',
  background: 'var(--stone-900)',
  color: 'white',
  textDecoration: 'none',
  cursor: 'pointer',
  border: 'none',
  transition: 'all var(--transition-base)',
};

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '60px 24px',
        maxWidth: '400px',
        margin: '0 auto',
      }}
    >
      {icon && (
        <div style={iconWrapperStyle}>
          {icon}
        </div>
      )}
      <h4
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'var(--text-lg)',
          fontWeight: 600,
          color: 'var(--stone-800)',
          marginBottom: '8px',
        }}
      >
        {title}
      </h4>
      {description && (
        <p
          style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--stone-500)',
            lineHeight: 'var(--leading-relaxed)',
            maxWidth: '340px',
            marginBottom: action ? '20px' : '0',
          }}
        >
          {description}
        </p>
      )}
      {action && <div>{action}</div>}
    </div>
  );
}

// Pre-configured empty states for common use cases
export function AnalyticsEmptyState() {
  return (
    <EmptyState
      icon={icons.analytics}
      title="No analytics data yet"
      description="Start publishing content to see your performance metrics and engagement trends."
      action={
        <a href="/compose" style={buttonStyle}>
          Create your first post
        </a>
      }
    />
  );
}

export function ReportsEmptyState() {
  return (
    <EmptyState
      icon={icons.reports}
      title="No reports available"
      description="Reports are generated based on your publishing activity. Start posting to generate insights."
      action={
        <a href="/overview" style={buttonStyle}>
          Go to Overview
        </a>
      }
    />
  );
}

export function MediaEmptyState({ onUpload }: { onUpload?: () => void }) {
  return (
    <EmptyState
      icon={icons.media}
      title="No media uploaded"
      description="Upload images and videos to use in your posts. Supported formats: JPG, PNG, GIF, MP4."
      action={
        onUpload ? (
          <button type="button" onClick={onUpload} style={buttonStyle}>
            Upload media
          </button>
        ) : undefined
      }
    />
  );
}
