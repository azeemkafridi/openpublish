import type { ReactNode } from 'react';

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

interface Props {
  impressions?: number;
  likes?: number;
  comments?: number;
  shares?: number;
}

/** Subtle inline badge showing views/likes/comments/shares on published post cards */
export function MetricsBadge({ impressions, likes, comments, shares }: Props) {
  // No values at all → metrics never synced → render nothing. All-zero but
  // defined → synced, genuinely zero → show "0 views" so the user can tell
  // "no engagement" apart from "not synced yet".
  const allUndefined = impressions === undefined && likes === undefined && comments === undefined && shares === undefined;
  if (allUndefined) return null;
  const allZero = !impressions && !likes && !comments && !shares;

  const items: { icon: ReactNode; value: number; label: string }[] = [];

  if (impressions || allZero) items.push({
    label: 'views',
    value: impressions ?? 0,
    icon: <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 6s2-3.5 5-3.5S11 6 11 6s-2 3.5-5 3.5S1 6 1 6z" /><circle cx="6" cy="6" r="1.5" /></svg>,
  });
  if (likes) items.push({
    label: 'likes',
    value: likes,
    icon: <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 10.5S1 7.5 1 4.5C1 2.84 2.34 1.5 4 1.5c.97 0 1.7.46 2 1 .3-.54 1.03-1 2-1 1.66 0 3 1.34 3 3C11 7.5 6 10.5 6 10.5z" /></svg>,
  });
  if (comments) items.push({
    label: 'comments',
    value: comments,
    icon: <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 3a2 2 0 012-2h6a2 2 0 012 2v4a2 2 0 01-2 2H5l-2.5 2V9H3a2 2 0 01-2-2V3z" /></svg>,
  });
  if (shares) items.push({
    label: 'shares',
    value: shares,
    icon: <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="3" r="1.5" /><circle cx="3" cy="6" r="1.5" /><circle cx="9" cy="9" r="1.5" /><path d="M4.3 5.2l3.4-1.4M4.3 6.8l3.4 1.4" /></svg>,
  });

  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px',
      fontSize: '11px',
      color: 'var(--stone-400)',
      fontWeight: 500,
    }}>
      {items.map((item) => (
        <span key={item.label} style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }} title={`${item.value.toLocaleString()} ${item.label}`}>
          {item.icon}
          {formatCompact(item.value)}
        </span>
      ))}
    </div>
  );
}
