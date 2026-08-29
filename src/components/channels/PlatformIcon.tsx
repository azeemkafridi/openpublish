import { PLATFORM_DISPLAY_NAMES, PLATFORM_BRAND_COLORS, platformDisplayName } from '@lib/platforms/types';

export type Platform =
  | 'facebook'
  | 'instagram'
  | 'x'
  | 'tiktok'
  | 'youtube'
  | 'threads'
  | 'bluesky'
  | 'pinterest'
  | 'gmb'
  | 'linkedin'
  | 'mastodon'
  | 'reddit'
  | 'discord'
  | 'telegram'
  | 'tumblr'
  | 'snapchat';

export interface PlatformIconProps {
  platform: Platform | string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  /** Force a rounded-square container (radius-md) instead of the size default (xs/sm are circles). */
  square?: boolean;
}

/** Brand accents, canonical in lib/platforms/types.ts. */
export const PLATFORM_COLORS: Record<string, string> = PLATFORM_BRAND_COLORS;

/**
 * Re-export of the canonical display names so icon call sites don't need a
 * second import. This used to be its own literal — one of seven copies.
 */
export const PLATFORM_LABELS = PLATFORM_DISPLAY_NAMES;

// Platform-icon container sizes. The inner icon never renders below 20px so the YouTube
// logo (and every other brand icon) meets the 20dp minimum required by the YouTube
// Branding Guidelines and API Services Developer Policy III.F.
const SIZE_MAP: Record<string, number> = {
  xs: 32,
  sm: 34,
  md: 40,
  lg: 48,
};

const ICON_SIZE_MAP: Record<string, number> = {
  xs: 20,
  sm: 22,
  md: 24,
  lg: 28,
};

// Outer radius on the container; the icon img itself has no radius.
const BORDER_RADIUS_MAP: Record<string, string> = {
  xs: '50%',
  sm: '50%',
  md: '9px',
  lg: '6px',
};

// Light background colors for each platform
const PLATFORM_BG_COLORS: Record<string, string> = {
  facebook: 'rgba(24, 119, 242, 0.1)',
  instagram: 'rgba(228, 64, 95, 0.1)',
  x: 'rgba(0, 0, 0, 0.06)',
  tiktok: 'rgba(0, 0, 0, 0.06)',
  youtube: 'rgba(255, 0, 0, 0.08)',
  threads: 'rgba(0, 0, 0, 0.06)',
  bluesky: 'rgba(0, 133, 255, 0.1)',
  pinterest: 'rgba(230, 0, 35, 0.08)',
  gmb: 'rgba(66, 133, 244, 0.1)',
  linkedin: 'rgba(10, 102, 194, 0.1)',
  mastodon: 'rgba(99, 100, 255, 0.1)',
  reddit: 'rgba(255, 69, 0, 0.1)',
  discord: 'rgba(88, 101, 242, 0.1)',
  telegram: 'rgba(38, 165, 228, 0.1)',
  tumblr: 'rgba(0, 25, 53, 0.08)',
  snapchat: 'rgba(255, 252, 0, 0.25)',
};

export function PlatformIcon({ platform, size = 'md', square = false }: PlatformIconProps) {
  const key = platform.toLowerCase();
  const px = SIZE_MAP[size];
  const iconSize = ICON_SIZE_MAP[size];
  const borderRadius = square ? 'var(--radius-md)' : BORDER_RADIUS_MAP[size];
  const bgColor = PLATFORM_BG_COLORS[key] ?? 'rgba(0, 0, 0, 0.05)';

  return (
    <div
      style={{
        width: px,
        height: px,
        borderRadius,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        background: bgColor,
      }}
      title={platformDisplayName(key)}
    >
      <img
        src={`/assets/platforms/${key}.svg`}
        alt={platformDisplayName(key)}
        width={iconSize}
        height={iconSize}
        style={{ display: 'block' }}
      />
    </div>
  );
}

/**
 * Compact row of brand-colored dots — the same platform indicator used in the analytics
 * overview (ChannelBreakdown). Used in post rows/lists (not previews) to stay clean when a
 * post spans several platforms. Each dot carries the platform name as a tooltip.
 */
export function PlatformDots({
  platforms,
  max = 4,
  size = 9,
}: {
  platforms: Array<Platform | string>;
  max?: number;
  size?: number;
}) {
  const shown = platforms.slice(0, max);
  const extra = platforms.length - shown.length;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
      {shown.map((p, i) => {
        const key = String(p).toLowerCase();
        return (
          <span
            key={i}
            title={platformDisplayName(key)}
            aria-label={platformDisplayName(key)}
            style={{
              width: size,
              height: size,
              borderRadius: '50%',
              background: PLATFORM_COLORS[key] ?? 'var(--stone-400)',
              flexShrink: 0,
            }}
          />
        );
      })}
      {extra > 0 && (
        <span style={{ fontSize: '10px', color: 'var(--stone-400)', fontWeight: 600 }}>+{extra}</span>
      )}
    </span>
  );
}
