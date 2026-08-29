import { platformDisplayName, type PlatformName } from '@lib/platforms/types';

/**
 * Tinted platform chip (badge background + text colour).
 *
 * These are deliberately softer than the brand accents in `PLATFORM_COLORS` —
 * a chip filled with #FF0000 is unreadable. The map lived in two byte-identical
 * copies (NotificationBell and NotificationList), and both stopped at mastodon,
 * so a Reddit, Discord, Telegram or Tumblr notification rendered NO platform
 * chip at all: the components bail on a missing entry.
 *
 * Typed `Record<PlatformName, …>` so a new platform can't be omitted silently.
 *
 * Literal hex rather than CSS variables, like every other platform colour map:
 * these are brand assets and must not shift with our palette.
 */
export const PLATFORM_BADGE_COLORS: Record<PlatformName, { bg: string; color: string }> = {
  facebook:  { bg: '#EFF6FF', color: '#1877F2' },
  instagram: { bg: '#FDF2F8', color: '#E4405F' },
  x:         { bg: '#F5F5F5', color: '#292524' },
  tiktok:    { bg: '#F0FDFA', color: '#0D9488' },
  youtube:   { bg: '#FEF2F2', color: '#DC2626' },
  threads:   { bg: '#F5F5F4', color: '#44403C' },
  bluesky:   { bg: '#EFF6FF', color: '#0085FF' },
  pinterest: { bg: '#FEF2F2', color: '#E60023' },
  gmb:       { bg: '#EFF6FF', color: '#4285F4' },
  linkedin:  { bg: '#EFF6FF', color: '#0A66C2' },
  mastodon:  { bg: '#F3F0FF', color: '#6364FF' },
  reddit:    { bg: '#FFF4ED', color: '#D93A00' },
  discord:   { bg: '#F0F1FE', color: '#4752C4' },
  telegram:  { bg: '#EFF9FE', color: '#1D8CBE' },
  tumblr:    { bg: '#EEF1F5', color: '#001935' },
  snapchat:  { bg: '#FFFBCC', color: '#8A8400' },
};

/** "Google Business" is too wide for a chip; everywhere else the full name fits. */
function badgeLabel(platform: string): string {
  return platform === 'gmb' ? 'GMB' : platformDisplayName(platform);
}

export function PlatformBadge({
  platform,
  size = 'md',
}: {
  platform: string;
  size?: 'sm' | 'md';
}) {
  const colors = PLATFORM_BADGE_COLORS[platform as PlatformName];
  if (!colors) return null;
  const sm = size === 'sm';
  return (
    <span
      style={{
        fontSize: sm ? '9px' : '10px',
        fontWeight: 600,
        color: colors.color,
        background: colors.bg,
        padding: sm ? '0px 5px' : '1px 6px',
        borderRadius: sm ? '3px' : '4px',
        whiteSpace: 'nowrap',
      }}
    >
      {badgeLabel(platform)}
    </span>
  );
}
