import type { ReactNode } from 'react';

export interface StatCardProps {
  label: string;
  value: number | string;
  color: 'green' | 'purple' | 'red' | 'blue';
  icon?: ReactNode;
  trend?: string;
}

function parseTrend(trend: string): 'positive' | 'negative' | 'neutral' {
  if (trend.startsWith('+')) return 'positive';
  if (trend.startsWith('-')) return 'negative';
  return 'neutral';
}

const TREND_COLORS: Record<string, string> = {
  positive: '#10B981',
  negative: '#EF4444',
  neutral: '#7A7060',
};

export function StatCard({ label, value, icon, trend }: StatCardProps) {
  const trendDir = trend ? parseTrend(trend) : null;

  return (
    <div
      style={{
        background: '#FFFFFF',
        borderRadius: 'var(--radius-lg)',
        padding: '20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        border: '2px solid var(--surface-card)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
        }}
      >
        {icon && (
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '36px',
              height: '36px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--stone-150)',
              color: 'var(--stone-500)',
              flexShrink: 0,
            }}
          >
            {icon}
          </span>
        )}

        <span
          style={{
            fontSize: 'var(--text-sm)',
            fontWeight: 500,
            color: '#78716C',
          }}
        >
          {label}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'flex-end',
          gap: '8px',
        }}
      >
        <span
          style={{
            fontSize: '42px',
            fontWeight: 400,
            fontFamily: 'var(--font-display)',
            color: '#3e3e3e',
            lineHeight: 1,
          }}
        >
          {typeof value === 'number' ? value.toLocaleString() : value}
        </span>

        {trend && trendDir && (
          <span
            style={{
              fontSize: 'var(--text-xs)',
              fontWeight: 600,
              color: TREND_COLORS[trendDir],
            }}
          >
            {trend}
          </span>
        )}
      </div>
    </div>
  );
}
