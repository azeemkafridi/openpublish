import { platformDisplayName, PLATFORM_BRAND_COLORS } from '@lib/platforms/types';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ChannelBreakdownProps {
  data: { platform: string; count: number }[];
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Brand accents, canonical in lib/platforms/types.ts. The literal here stopped
 * at linkedin, so mastodon and the four newest platforms all charted grey. */
const PLATFORM_COLORS: Record<string, string> = PLATFORM_BRAND_COLORS;

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ChannelBreakdown({ data }: ChannelBreakdownProps) {
  if (!data || !Array.isArray(data) || data.length === 0) {
    return (
      <div style={styles.empty}>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-400)' }}>
          No channel data available.
        </p>
      </div>
    );
  }

  // Sort descending by count
  const sorted = [...data].sort((a, b) => b.count - a.count);
  const maxCount = Math.max(...sorted.map((d) => d.count), 1);
  const total = sorted.reduce((s, d) => s + d.count, 0);

  return (
    <div style={styles.wrapper}>
      {sorted.map((item) => {
        const key = item.platform.toLowerCase();
        const color = PLATFORM_COLORS[key] ?? 'var(--stone-500)';
        const displayName = platformDisplayName(key);
        const widthPct = (item.count / maxCount) * 100;
        const pct = total > 0 ? Math.round((item.count / total) * 100) : 0;

        return (
          <div key={item.platform} style={styles.row}>
            {/* Platform label */}
            <div style={styles.labelCol}>
              <span
                style={{
                  width: '10px',
                  height: '10px',
                  borderRadius: '50%',
                  background: color,
                  flexShrink: 0,
                }}
              />
              <span style={styles.platformName}>{displayName}</span>
            </div>

            {/* Single bar: fill is proportional to the busiest platform, with the post count
                inline-left and the share % inline-right. minWidth guarantees both labels always
                fit (with a gap) even when the proportional width would be tiny. */}
            <div style={styles.barTrack}>
              <div
                style={{
                  ...styles.barFill,
                  width: `${widthPct}%`,
                  background: color,
                }}
              >
                <span style={styles.barCount}>
                  {item.count}
                  <span style={styles.barUnit}> {item.count === 1 ? 'post' : 'posts'}</span>
                </span>
                <span style={styles.barPct}>{pct}%</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    padding: '4px 0',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  labelCol: {
    width: '140px',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  platformName: {
    fontSize: 'var(--text-sm)',
    color: 'var(--stone-700)',
    fontWeight: 500,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  barTrack: {
    flex: 1,
    height: '28px',
    // No gray track background; the fill is right-anchored so the bar grows right→left.
    display: 'flex',
    justifyContent: 'flex-end',
    borderRadius: 'var(--radius-sm)',
    overflow: 'hidden',
    minWidth: 0,
  },
  barFill: {
    height: '100%',
    // Floor so the count (left) and % (right) always fit inside the bar with a gap, even when
    // the proportional width would otherwise be tiny. maxWidth keeps the full bar inside the track.
    minWidth: '132px',
    maxWidth: '100%',
    flexShrink: 0,
    borderRadius: 'var(--radius-sm)',
    transition: 'width 400ms ease',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
    padding: '0 10px',
    color: '#fff',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
  },
  barCount: {
    fontSize: 'var(--text-sm)',
    fontWeight: 700,
  },
  barUnit: {
    fontWeight: 400,
    opacity: 0.85,
    fontSize: 'var(--text-xs)',
  },
  barPct: {
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    opacity: 0.92,
  },
  empty: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '160px',
  },
};
