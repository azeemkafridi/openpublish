import { useLayoutEffect, useRef, useState } from 'react';
import { platformDisplayName } from '@lib/platforms/types';

/**
 * The one bar chart for "posts per day" — extracted from the Overview page's
 * PostsOverTime so the Analytics page renders the exact same chart instead of
 * its own variant. Purely presentational: callers supply the byDay data and
 * the date range; missing days are filled with zero-bars so the axis is
 * continuous.
 */

export interface PostsBarChartDay {
  date: string; // YYYY-MM-DD
  count: number;
  platforms?: Record<string, number>;
}

export interface PostsBarChartProps {
  data: PostsBarChartDay[];
  from: string; // YYYY-MM-DD inclusive
  to: string;   // YYYY-MM-DD inclusive
  /**
   * What one bar counts. Defaults to posts; the Developer page reuses this
   * exact chart for API calls so the two pages don't drift apart visually.
   */
  unit?: { one: string; many: string };
  /** Safety cap on the number of bars — the posts range is server-clamped to 30 days. */
  maxDays?: number;
}

function formatShort(date: string): string {
  return new Date(date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function PostsBarChart({ data, from, to, unit, maxDays = 31 }: PostsBarChartProps) {
  const unitOne = unit?.one ?? 'post';
  const unitMany = unit?.many ?? 'posts';
  const [hoveredDay, setHoveredDay] = useState<PostsBarChartDay | null>(null);
  // Bar anchor, relative to the chart's own position:relative container:
  // x = bar center, yTop = bar top, yBottom = bar bottom.
  const [anchor, setAnchor] = useState<{ x: number; yTop: number; yBottom: number }>({ x: 0, yTop: 0, yBottom: 0 });
  // Final placement after measuring the tooltip against the viewport.
  const [placement, setPlacement] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // The tooltip is rendered hidden at the anchor first, then measured and
  // clamped so it never clips at the viewport edges: clamp horizontally, and
  // flip below the bar when there is not enough room above it.
  useLayoutEffect(() => {
    if (!hoveredDay || !tooltipRef.current || !containerRef.current) {
      setPlacement(null);
      return;
    }
    const tip = tooltipRef.current.getBoundingClientRect();
    const container = containerRef.current.getBoundingClientRect();
    const margin = 8;
    const half = tip.width / 2;
    const minX = margin - container.left + half;
    const maxX = window.innerWidth - margin - container.left - half;
    const x = Math.min(Math.max(anchor.x, minX), Math.max(minX, maxX));
    const spaceAbove = container.top + anchor.yTop; // viewport px above the bar top
    const below = spaceAbove < tip.height + margin * 2;
    const y = below ? anchor.yBottom + margin : anchor.yTop - margin;
    setPlacement({ x, y, below });
  }, [hoveredDay, anchor]);

  // Fill missing days with 0 so every day of the range gets a bar
  const dayMap = new Map((data ?? []).map((d) => [d.date, d]));
  const allDays: PostsBarChartDay[] = [];
  const start = new Date(from + 'T12:00:00');
  const end = new Date(to + 'T12:00:00');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${day}`;
    allDays.push(dayMap.get(dateStr) || { date: dateStr, count: 0, platforms: {} });
    if (allDays.length >= maxDays) break;
  }

  if (allDays.length === 0) {
    return (
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-400)', margin: 0 }}>
        No data available for the selected period.
      </p>
    );
  }

  const maxCount = Math.max(...allDays.map((d) => d.count), 1);
  const midIdx = Math.floor((allDays.length - 1) / 2);

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: '140px' }}>
        {allDays.map((day) => {
          const pct = (day.count / maxCount) * 100;
          return (
            <div
              key={day.date}
              data-testid={`posts-bar-${day.date}`}
              style={{
                flex: 1,
                height: `${Math.max(pct, day.count > 0 ? 6 : 2)}%`,
                background: day.count > 0 ? 'var(--accent-400)' : 'var(--stone-100)',
                borderRadius: '2px 2px 0 0',
                cursor: day.count > 0 ? 'pointer' : 'default',
                minWidth: 0,
                transition: 'opacity 150ms',
                opacity: hoveredDay && hoveredDay.date !== day.date ? 0.5 : 1,
              }}
              onMouseEnter={(e) => {
                if (day.count > 0) {
                  setHoveredDay(day);
                  const rect = e.currentTarget.getBoundingClientRect();
                  const container = containerRef.current?.getBoundingClientRect()
                    ?? e.currentTarget.parentElement!.getBoundingClientRect();
                  setAnchor({
                    x: rect.left - container.left + rect.width / 2,
                    yTop: rect.top - container.top,
                    yBottom: rect.bottom - container.top,
                  });
                }
              }}
              onMouseLeave={() => setHoveredDay(null)}
            />
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px' }}>
        <span style={axisLabelStyle}>{formatShort(allDays[0].date)}</span>
        {allDays.length > 2 && <span style={axisLabelStyle}>{formatShort(allDays[midIdx].date)}</span>}
        {allDays.length > 1 && <span style={axisLabelStyle}>{formatShort(allDays[allDays.length - 1].date)}</span>}
      </div>

      {/* Tooltip */}
      {hoveredDay && (
        <div
          ref={tooltipRef}
          data-testid="posts-bar-tooltip"
          style={{
            position: 'absolute',
            left: placement?.x ?? anchor.x,
            top: placement?.y ?? anchor.yTop,
            transform: placement?.below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
            visibility: placement ? 'visible' : 'hidden',
            background: 'var(--stone-900)',
            color: 'var(--stone-50)',
            padding: '8px 12px',
            borderRadius: 'var(--radius-sm)',
            fontSize: '12px',
            fontFamily: 'var(--font-numeric)',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 10,
            boxShadow: 'var(--shadow-md)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: '4px' }}>
            {new Date(hoveredDay.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
            {': '}{hoveredDay.count.toLocaleString()} {hoveredDay.count === 1 ? unitOne : unitMany}
          </div>
          {Object.entries(hoveredDay.platforms ?? {}).length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {Object.entries(hoveredDay.platforms!)
                .sort(([, a], [, b]) => b - a)
                .map(([platform, cnt]) => (
                  <div key={platform} style={{ color: 'var(--stone-300)', fontSize: '11px' }}>
                    {platformDisplayName(platform)}: {cnt} published
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const axisLabelStyle: React.CSSProperties = {
  fontSize: '11px',
  color: 'var(--stone-400)',
  fontFamily: 'var(--font-numeric)',
};
