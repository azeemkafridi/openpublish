import { useState, useEffect } from 'react';
import { PlatformIcon, PLATFORM_COLORS } from '../channels/PlatformIcon';
import { PLATFORM_CHAR_LIMITS } from '@lib/platforms/validation';
import { platformDisplayName, type PlatformName } from '@lib/platforms/types';

interface ComposeState {
  content: string;
  platforms: string[];
  format?: string;
  mediaCount?: number;
}

interface PlatformInfo {
  platform: PlatformName;
  label: string;
  color: string;
  maxChars: number;
  imageMax: string | null;
  videoMax: string | null;
  mediaCount: string;
  formats: string;
}

/**
 * Media facts only. The label, brand colour and character limit are NOT repeated
 * here — they come from the shared maps below, because this table used to hold
 * its own copy of all three and a platform added to the app simply never
 * appeared in this reference panel.
 *
 * Keyed by platform and required to cover every one of them (pinned by
 * tests/unit/compose/post-format-coverage.test.ts).
 */
const PLATFORM_MEDIA: Record<PlatformName, Omit<PlatformInfo, 'platform' | 'label' | 'color' | 'maxChars'>> = {
  x:         { imageMax: '5 MB',  videoMax: '512 MB', mediaCount: '4 img / 1 vid',  formats: 'jpg, png, gif, mp4' },
  threads:   { imageMax: '8 MB',  videoMax: '500 MB', mediaCount: '20',             formats: 'jpg, png, webp, mp4' },
  bluesky:   { imageMax: '1 MB',  videoMax: '100 MB', mediaCount: '4 img / 1 vid',  formats: 'jpg, png, webp, mp4' },
  instagram: { imageMax: '8 MB',  videoMax: '1 GB',   mediaCount: '10',             formats: 'jpg, mp4' },
  facebook:  { imageMax: '10 MB', videoMax: '2 GB',   mediaCount: '10 img / 1 vid', formats: 'jpg, png, gif, mp4' },
  tiktok:    { imageMax: '20 MB', videoMax: '4 GB',   mediaCount: '35 img / 1 vid', formats: 'jpg, webp, mp4' },
  pinterest: { imageMax: '20 MB', videoMax: '2 GB',   mediaCount: '5 img / 1 vid',  formats: 'jpg, png, mp4, mov' },
  youtube:   { imageMax: null,    videoMax: '128 GB', mediaCount: '1 video',        formats: 'mp4, mov, avi, webm' },
  gmb:       { imageMax: '5 MB',  videoMax: null,     mediaCount: '1 image',        formats: 'jpg, png' },
  linkedin:  { imageMax: '10 MB', videoMax: '500 MB', mediaCount: '20 img / 1 vid', formats: 'jpg, png, gif, mp4' },
  mastodon:  { imageMax: '16 MB', videoMax: '99 MB',  mediaCount: '4 img / 1 vid',  formats: 'jpg, png, webp, avif, gif, mp4' },
  reddit:    { imageMax: '20 MB', videoMax: '1 GB',   mediaCount: '1 img or 1 vid', formats: 'jpg, png, gif, mp4' },
  discord:   { imageMax: '25 MB', videoMax: '25 MB',  mediaCount: '10 mixed',       formats: 'jpg, png, gif, webp, mp4, mov' },
  telegram:  { imageMax: '10 MB', videoMax: '50 MB',  mediaCount: '10 mixed',       formats: 'jpg, png, webp, mp4' },
  tumblr:    { imageMax: '20 MB', videoMax: '100 MB', mediaCount: '30 img / 1 vid', formats: 'jpg, png, gif, webp, mp4' },
  snapchat:  { imageMax: '20 MB', videoMax: '1 GB', mediaCount: '1 per post', formats: 'jpg, png, mp4' },
};

/** Display order — text-first platforms first, then media-first ones. */
const PLATFORM_ORDER: PlatformName[] = [
  'x', 'threads', 'bluesky', 'mastodon', 'instagram', 'facebook', 'tiktok',
  'pinterest', 'youtube', 'gmb', 'linkedin', 'reddit', 'discord', 'telegram', 'tumblr', 'snapchat',
];

export const PLATFORM_SPECS: PlatformInfo[] = PLATFORM_ORDER.map((platform) => ({
  platform,
  label: platformDisplayName(platform),
  color: PLATFORM_COLORS[platform],
  maxChars: PLATFORM_CHAR_LIMITS[platform],
  ...PLATFORM_MEDIA[platform],
}));

const TIPS = [
  'Bluesky has the smallest image limit (1 MB). Compress before uploading.',
  "X, Bluesky, and Facebook don't allow mixing images and videos in one post.",
  'Instagram API only accepts JPEG images. PNGs will be converted automatically.',
];

export default function ComposeSidebar() {
  const [charCount, setCharCount] = useState(0);
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);

  useEffect(() => {
    function handleUpdate(e: Event) {
      const detail = (e as CustomEvent<ComposeState>).detail;
      if (detail) {
        setCharCount(detail.content.length);
        setSelectedPlatforms(detail.platforms);
      }
    }
    window.addEventListener('compose-update', handleUpdate);
    return () => window.removeEventListener('compose-update', handleUpdate);
  }, []);

  return (
    <div style={styles.container}>
      {/* Platform Reference */}
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Platform Reference</h3>
        <div className="stagger-children r-platform-grid" style={styles.platformGrid}>
          {PLATFORM_SPECS.map((p) => {
            const isSelected = selectedPlatforms.includes(p.platform);
            const showProgress = isSelected && charCount > 0;
            const isOver = showProgress && charCount > p.maxChars;
            const remaining = p.maxChars - charCount;

            return (
              <div
                key={p.platform}
                style={{
                  ...styles.platformCard,
                  ...(isOver ? styles.platformCardOver : {}),
                  ...(selectedPlatforms.length > 0 && !isSelected ? { background: 'transparent', opacity: 0.25 } : {}),
                }}
              >
                {/* Platform identity + char info */}
                <div style={styles.cardHeader}>
                  <div style={styles.platformIdentity}>
                    <PlatformIcon platform={p.platform} size="xs" />
                    <span style={styles.platformLabel}>{p.label}</span>
                  </div>
                  {showProgress ? (
                    <span style={{
                      ...styles.charBadge,
                      color: isOver ? 'var(--color-error)' : 'var(--stone-500)',
                      background: isOver ? 'var(--color-error-bg)' : 'var(--stone-100)',
                    }}>
                      {isOver ? `-${Math.abs(remaining)}` : remaining.toLocaleString()}
                    </span>
                  ) : (
                    <span style={styles.charLimit}>{p.maxChars.toLocaleString()}</span>
                  )}
                </div>

                {/* Progress bar — only when typing */}
                {showProgress && (
                  <div style={styles.progressTrack}>
                    <div
                      style={{
                        ...styles.progressFill,
                        width: `${Math.min((charCount / p.maxChars) * 100, 100)}%`,
                        background: isOver ? 'var(--color-error)' : (charCount / p.maxChars) > 0.8 ? 'var(--color-warning)' : p.color,
                      }}
                    />
                  </div>
                )}

                {/* Media specs */}
                <div style={styles.specsRow}>
                  {p.imageMax && (
                    <span style={styles.specBadge}>
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1" y="1.5" width="8" height="7" rx="1" /><circle cx="3.5" cy="4.5" r="1" /><path d="M9 7l-3-3-4 4" /></svg>
                      {p.imageMax}
                    </span>
                  )}
                  {p.videoMax && (
                    <span style={styles.specBadge}>
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2"><polygon points="8 3 6 5 8 7" /><rect x="1" y="2.5" width="5" height="5" rx="1" /></svg>
                      {p.videoMax}
                    </span>
                  )}
                  <span style={styles.specBadge}>{p.mediaCount}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Tips */}
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Tips</h3>
        <div className="r-platform-grid" style={styles.tipsGrid}>
          {TIPS.map((tip, i) => (
            <div key={i} style={styles.tipCard}>
              <div style={styles.tipHeader}>
                <span style={styles.tipNumber}>{i + 1}</span>
                <span style={styles.tipLabel}>Tip</span>
              </div>
              <p style={styles.tipText}>{tip}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  sectionTitle: {
    fontSize: '11px',
    fontWeight: 600,
    color: 'var(--stone-500)',
    margin: 0,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },

  /* ── Platform Grid ── */
  platformGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '10px',
  },
  platformCard: {
    background: 'var(--surface-card)',
    borderRadius: '10px',
    padding: '12px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    transition: 'background 150ms ease, opacity 150ms ease',
    minWidth: 0,
  },
  platformCardOver: {
    background: 'var(--color-error-bg)',
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '6px',
  },
  platformIdentity: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
  },
  platformLabel: {
    fontSize: '12px',
    fontWeight: 500,
    color: 'var(--stone-700)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  charLimit: {
    fontSize: '11px',
    fontWeight: 500,
    fontFamily: 'var(--font-mono)',
    color: 'var(--stone-400)',
    flexShrink: 0,
  },
  charBadge: {
    fontSize: '10px',
    fontWeight: 600,
    fontFamily: 'var(--font-mono)',
    padding: '1px 6px',
    borderRadius: '4px',
    flexShrink: 0,
  },

  /* ── Progress bar ── */
  progressTrack: {
    height: '3px',
    background: 'var(--stone-150)',
    borderRadius: '2px',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: '2px',
    transition: 'width 150ms ease, background 150ms ease',
  },

  /* ── Media Specs ── */
  specsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap',
  },
  specBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    fontSize: '11px',
    color: 'var(--stone-500)',
    background: 'var(--stone-100)',
    padding: '2px 6px',
    borderRadius: '4px',
    lineHeight: 1.2,
    whiteSpace: 'nowrap',
  },

  /* ── Tips ── */
  tipsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '10px',
  },
  tipCard: {
    background: '#FFFFFF',
    borderRadius: 'var(--radius-lg)',
    padding: '20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    border: '2px solid var(--surface-card)',
  },
  tipHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  tipNumber: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    borderRadius: 'var(--radius-md)',
    background: '#F5F5F4',
    color: '#78716C',
    fontSize: '14px',
    fontWeight: 600,
    fontFamily: 'var(--font-display)',
    flexShrink: 0,
  },
  tipLabel: {
    fontSize: 'var(--text-sm)',
    fontWeight: 500,
    color: '#78716C',
  },
  tipText: {
    fontSize: '12px',
    color: 'var(--stone-500)',
    lineHeight: 1.45,
    margin: 0,
  },
};
