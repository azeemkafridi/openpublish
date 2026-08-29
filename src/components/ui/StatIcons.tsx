/**
 * Shared stat-card icon set — one visual language across the app:
 * 20×20 grid, 1.75px strokes, round caps/joins, and softly rounded corners
 * (rx ≥ 2) on every container shape. Add new stat icons here rather than
 * inlining one-off SVGs in components, so the style stays consistent.
 */

const base = {
  width: 20,
  height: 20,
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const StatIcons = {
  published: (
    <svg {...base}>
      <circle cx="10" cy="10" r="7.25" />
      <path d="M6.75 10.25l2.25 2.25 4.25-4.75" />
    </svg>
  ),
  scheduled: (
    <svg {...base}>
      <circle cx="10" cy="10" r="7.25" />
      <path d="M10 6.25V10l2.75 2" />
    </svg>
  ),
  failed: (
    <svg {...base}>
      <circle cx="10" cy="10" r="7.25" />
      <path d="M10 6.5v4" />
      <circle cx="10" cy="13.5" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  ),
  total: (
    <svg {...base}>
      <rect x="3" y="3" width="14" height="14" rx="3.5" />
      <path d="M6.5 8h7M6.5 12h4.5" />
    </svg>
  ),
  channels: (
    <svg {...base}>
      <rect x="3" y="3" width="6" height="6" rx="2" />
      <rect x="11" y="3" width="6" height="6" rx="2" />
      <rect x="3" y="11" width="6" height="6" rx="2" />
      <rect x="11" y="11" width="6" height="6" rx="2" />
    </svg>
  ),
  impressions: (
    <svg {...base}>
      <path d="M2.75 10S5.75 5.25 10 5.25 17.25 10 17.25 10 14.25 14.75 10 14.75 2.75 10 2.75 10z" />
      <circle cx="10" cy="10" r="2.25" />
    </svg>
  ),
  likes: (
    <svg {...base}>
      <path d="M10 16.5S3.25 12.5 3.25 7.9c0-2.4 1.8-4.15 3.9-4.15 1.2 0 2.2.55 2.85 1.4.65-.85 1.65-1.4 2.85-1.4 2.1 0 3.9 1.75 3.9 4.15 0 4.6-6.75 8.6-6.75 8.6z" />
    </svg>
  ),
  comments: (
    <svg {...base}>
      <path d="M3.25 6.5a2.75 2.75 0 012.75-2.75h8A2.75 2.75 0 0116.75 6.5v4a2.75 2.75 0 01-2.75 2.75H9.5L6 16v-2.75A2.75 2.75 0 013.25 10.5v-4z" />
    </svg>
  ),
  shares: (
    <svg {...base}>
      <circle cx="14.5" cy="5" r="2.25" />
      <circle cx="5.5" cy="10" r="2.25" />
      <circle cx="14.5" cy="15" r="2.25" />
      <path d="M7.5 9l5-3M7.5 11l5 3" />
    </svg>
  ),
  reach: (
    <svg {...base}>
      <circle cx="10" cy="10" r="7.25" />
      <circle cx="10" cy="10" r="3.75" />
      <circle cx="10" cy="10" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  ),
  saves: (
    <svg {...base}>
      <path d="M6 3.25h8c.97 0 1.75.78 1.75 1.75v11.25L10 13.25l-5.75 3V5c0-.97.78-1.75 1.75-1.75z" />
    </svg>
  ),
  videoViews: (
    <svg {...base}>
      <rect x="3" y="3.5" width="14" height="13" rx="3.5" />
      <path d="M8.5 7.5l4 2.5-4 2.5z" />
    </svg>
  ),
  clicks: (
    <svg {...base}>
      <path d="M4.25 3.75l3.5 12 2.15-4.85 4.85-2.15z" />
      <path d="M10.5 11.5l4 4" />
    </svg>
  ),
};
