import { type CSSProperties } from 'react';

export type PostStatus =
  | 'draft'
  | 'scheduled'
  | 'published'
  | 'partial'
  | 'failed'
  | 'processing';

export interface StatusFilterProps {
  value: string | null;
  onChange: (status: string | null) => void;
  counts?: Partial<Record<PostStatus | 'all', number>>;
}

interface FilterChip {
  label: string;
  value: string | null;
  color: string;
  bg: string;
  activeBg: string;
  activeBorder: string;
  dotColor?: string; // Status indicator dot color
}

const CHIPS: FilterChip[] = [
  {
    label: 'All',
    value: null,
    color: 'var(--stone-700)',
    bg: 'transparent',
    activeBg: 'var(--stone-100)',
    activeBorder: 'var(--stone-300)',
  },
  {
    label: 'Draft',
    value: 'draft',
    color: 'var(--stone-600)',
    bg: 'transparent',
    activeBg: 'var(--stone-100)',
    activeBorder: 'var(--stone-300)',
    dotColor: 'var(--stone-400)',
  },
  {
    label: 'Scheduled',
    value: 'scheduled',
    color: '#5B21B6',
    bg: 'transparent',
    activeBg: 'var(--color-scheduled-bg)',
    activeBorder: 'var(--color-scheduled-border)',
    dotColor: 'var(--color-scheduled)',
  },
  {
    label: 'Published',
    value: 'published',
    color: '#065F46',
    bg: 'transparent',
    activeBg: 'var(--color-success-bg)',
    activeBorder: 'var(--color-success-border)',
    dotColor: 'var(--color-success)',
  },
  {
    // Uploaded to the platform, awaiting async confirmation (Instagram
    // containers, TikTok, Facebook video). Without this chip these posts
    // matched no filter but "All".
    label: 'Processing',
    value: 'processing',
    color: '#1E40AF',
    bg: 'transparent',
    activeBg: 'var(--color-info-bg)',
    activeBorder: 'var(--color-info-border)',
    dotColor: 'var(--color-info)',
  },
  {
    label: 'Partial',
    value: 'partial',
    color: '#92400E',
    bg: 'transparent',
    activeBg: 'var(--color-warning-bg)',
    activeBorder: 'var(--color-warning-border)',
    dotColor: 'var(--color-warning)',
  },
  {
    label: 'Failed',
    value: 'failed',
    color: '#991B1B',
    bg: 'transparent',
    activeBg: 'var(--color-error-bg)',
    activeBorder: 'var(--color-error-border)',
    dotColor: 'var(--color-error)',
  },
  {
    label: 'Needs Approval',
    value: 'needs_approval',
    color: '#92400E',
    bg: 'transparent',
    activeBg: 'var(--color-warning-bg)',
    activeBorder: 'var(--color-warning-border)',
    dotColor: 'var(--color-warning)',
  },
  {
    label: 'Repeat Posts',
    value: 'recurring',
    color: '#7C3AED',
    bg: 'transparent',
    activeBg: '#EDE9FE',
    activeBorder: '#C4B5FD',
    dotColor: '#7C3AED',
  },
];

export function StatusFilter({ value, onChange, counts }: StatusFilterProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexWrap: 'wrap',
      }}
    >
      {CHIPS.map((chip) => {
        const isActive =
          chip.value === value || (chip.value === null && value === null);

        const chipStyle: CSSProperties = {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px',
          padding: '6px 12px',
          borderRadius: 'var(--radius-pill)',
          fontSize: 'var(--text-xs)',
          fontWeight: isActive ? 600 : 500,
          color: isActive ? chip.color : 'var(--stone-500)',
          background: isActive ? chip.activeBg : chip.bg,
          border: 'none',
          cursor: 'pointer',
          transition: 'all var(--transition-fast)',
          whiteSpace: 'nowrap',
          lineHeight: 1,
        };

        const countKey =
          chip.value === null ? 'all' : (chip.value as PostStatus);
        const count = counts?.[countKey];

        return (
          <button
            key={chip.label}
            type="button"
            style={chipStyle}
            onClick={() => onChange(chip.value)}
            onMouseOver={(e) => {
              if (!isActive) {
                e.currentTarget.style.background = 'var(--stone-100)';
                e.currentTarget.style.borderColor = 'var(--border-default)';
              }
            }}
            onMouseOut={(e) => {
              if (!isActive) {
                e.currentTarget.style.background = chip.bg;
                e.currentTarget.style.borderColor = 'var(--border-subtle)';
              }
            }}
          >
            {chip.dotColor && (
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  background: chip.dotColor,
                  flexShrink: 0,
                }}
              />
            )}
            {chip.label}
            {count !== undefined && count > 0 && (
              <span
                style={{
                  fontSize: 'var(--text-xs)',
                  fontWeight: 600,
                  minWidth: '18px',
                  height: '18px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 'var(--radius-pill)',
                  background: isActive
                    ? 'rgba(0,0,0,0.08)'
                    : 'var(--stone-200)',
                  padding: '0 5px',
                  lineHeight: 1,
                }}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
