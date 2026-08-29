import { useMemo, useState, useRef } from 'react';

/**
 * GitHub-style posting-activity heatmap: one row per day of the selected range,
 * 24 hour cells per row. Cell intensity scales with how many posts were
 * published in that local-time hour; hovering shows the exact count and slot.
 *
 * Timestamps arrive as raw ISO strings and are bucketed here, in the browser,
 * so the grid reflects the viewer's local timezone.
 */

interface PostingHeatmapProps {
  publishedTimes: string[];
  from: string; // YYYY-MM-DD (inclusive)
  to: string;   // YYYY-MM-DD (inclusive)
  /** Card heading rendered inline so the legend can sit beside it (top-right). */
  title?: string;
}

/** Local YYYY-MM-DD for a Date (NOT toISOString, which would shift the day in non-UTC zones). */
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDayLabel(dateKey: string): string {
  const d = new Date(`${dateKey}T12:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatHourRange(hour: number): string {
  const pad = (h: number) => `${String(h).padStart(2, '0')}:00`;
  return `${pad(hour)}–${pad((hour + 1) % 24)}`;
}

export function PostingHeatmap({ publishedTimes, from, to, title = 'Posting Activity' }: PostingHeatmapProps) {
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hovered, setHovered] = useState<{ day: string; hour: number } | null>(null);

  const { days, counts, maxCount, total } = useMemo(() => {
    // Day rows for the whole selected range (chronological), even empty ones —
    // the empty rows are part of the picture, like GitHub's empty squares.
    const days: string[] = [];
    const start = new Date(`${from}T12:00:00`);
    const end = new Date(`${to}T12:00:00`);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      days.push(localDateKey(d));
      if (days.length >= 31) break; // range is server-clamped to 30 days; hard safety cap
    }

    const counts = new Map<string, number>();
    let total = 0;
    for (const ts of publishedTimes) {
      const t = new Date(ts);
      if (isNaN(t.getTime())) continue;
      const key = `${localDateKey(t)}:${t.getHours()}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total++;
    }
    const maxCount = Math.max(1, ...counts.values());
    return { days, counts, maxCount, total };
  }, [publishedTimes, from, to]);

  if (total === 0) {
    return (
      <>
        <h3 style={styles.title}>{title}</h3>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-400)', margin: 0 }}>
          No published posts in this period yet.
        </p>
      </>
    );
  }

  // GitHub-style intensity buckets: 0 + four levels relative to the busiest cell.
  const opacityFor = (count: number): number => {
    if (count === 0) return 0;
    const ratio = count / maxCount;
    if (ratio <= 0.25) return 0.3;
    if (ratio <= 0.5) return 0.55;
    if (ratio <= 0.75) return 0.8;
    return 1;
  };

  const hours = Array.from({ length: 24 }, (_, h) => h);

  return (
    <div>
      {/* Header: title left, intensity legend + timezone note top-right */}
      <div style={styles.header}>
        <h3 style={styles.title}>{title}</h3>
        <div style={styles.legendStack}>
          <span style={styles.legendLabel}>Times shown in your local timezone</span>
          <div style={styles.legend}>
            <span style={styles.legendLabel}>Less</span>
            {[0, 0.3, 0.55, 0.8, 1].map((op) => (
              <span
                key={op}
                style={{
                  ...styles.legendSwatch,
                  background: op === 0 ? 'var(--stone-100)' : 'var(--color-success)',
                  opacity: op === 0 ? 1 : op,
                }}
              />
            ))}
            <span style={styles.legendLabel}>More</span>
          </div>
        </div>
      </div>

    <div style={{ overflowX: 'auto' }}>
      <div style={{ minWidth: '520px' }}>
        {/* Hour axis (every 3h) */}
        <div style={styles.row}>
          <span style={styles.dayLabel} />
          {hours.map((h) => (
            <span key={h} style={styles.hourLabel}>
              {h % 3 === 0 ? h : ''}
            </span>
          ))}
        </div>

        {days.map((day) => (
          <div key={day} style={styles.row}>
            <span style={styles.dayLabel}>{formatDayLabel(day)}</span>
            {hours.map((hour) => {
              const count = counts.get(`${day}:${hour}`) ?? 0;
              const isHovered = hovered?.day === day && hovered?.hour === hour;
              return (
                <div
                  key={hour}
                  data-testid={`heatmap-cell-${day}-${hour}`}
                  aria-label={`${count} post${count === 1 ? '' : 's'} on ${formatDayLabel(day)}, ${formatHourRange(hour)}`}
                  style={{
                    ...styles.cell,
                    boxShadow: isHovered ? 'inset 0 0 0 1.5px var(--stone-500)' : undefined,
                  }}
                  onMouseEnter={() => {
                    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
                    setHovered({ day, hour });
                  }}
                  onMouseLeave={() => {
                    hoverTimer.current = setTimeout(() => setHovered(null), 150);
                  }}
                >
                  <div
                    style={{
                      ...styles.cellFill,
                      background: count === 0 ? 'var(--stone-100)' : 'var(--color-success)',
                      opacity: count === 0 ? 1 : opacityFor(count),
                    }}
                  />
                  {isHovered && (
                    <div style={styles.tooltip} data-testid="heatmap-tooltip">
                      <span style={{ fontWeight: 600 }}>
                        {count} post{count === 1 ? '' : 's'}
                      </span>
                      <span style={{ color: 'var(--stone-400)', fontSize: 'var(--text-xs)' }}>
                        {formatDayLabel(day)}, {formatHourRange(hour)}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '3px',
    marginBottom: '3px',
  },
  dayLabel: {
    width: '52px',
    flexShrink: 0,
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-500)',
    textAlign: 'right',
    paddingRight: '6px',
    lineHeight: 1,
  },
  // Hour labels and cells share the same flex sizing so the axis stays aligned
  // while the grid stretches to the full card width.
  hourLabel: {
    flex: '1 1 0',
    minWidth: '14px',
    fontSize: '10px',
    color: 'var(--stone-400)',
    textAlign: 'center',
    lineHeight: 1,
  },
  cell: {
    position: 'relative',
    flex: '1 1 0',
    minWidth: '14px',
    height: '16px',
    borderRadius: '3px',
    cursor: 'default',
  },
  cellFill: {
    position: 'absolute',
    inset: 0,
    borderRadius: '3px',
    transition: 'opacity 150ms ease',
  },
  tooltip: {
    position: 'absolute',
    bottom: 'calc(100% + 6px)',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '2px',
    padding: '6px 10px',
    background: 'var(--stone-900)',
    color: 'var(--stone-50)',
    fontSize: 'var(--text-sm)',
    borderRadius: 'var(--radius-sm)',
    whiteSpace: 'nowrap',
    zIndex: 10,
    pointerEvents: 'none',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: '8px',
    marginBottom: '16px',
  },
  title: {
    fontSize: 'var(--text-lg)',
    fontFamily: 'var(--font-display)',
    color: 'var(--stone-900)',
    margin: 0,
  },
  legendStack: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '6px',
  },
  legend: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  legendSwatch: {
    width: '12px',
    height: '12px',
    borderRadius: '3px',
    flexShrink: 0,
  },
  legendLabel: {
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-400)',
  },
};
