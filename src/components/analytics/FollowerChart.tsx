import { useState } from 'react';

export interface FollowerChartProps {
  data: { date: string; followers: number }[];
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export function FollowerChart({ data }: FollowerChartProps) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  if (!data || data.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '200px' }}>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-400)' }}>
          No follower data available yet.
        </p>
      </div>
    );
  }

  const sliced = data.slice(-30);
  const values = sliced.map((d) => d.followers);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const rawRange = maxVal - minVal || 1;
  // Ensure minimum Y range of 5% of the max value so small changes don't look dramatic
  const minRange = Math.max(rawRange, maxVal * 0.05, 10);
  const midpoint = (minVal + maxVal) / 2;
  const yMin = Math.max(0, Math.floor(midpoint - minRange / 2));
  const yMax = Math.ceil(midpoint + minRange / 2);
  const yRange = yMax - yMin || 1;

  const W = 600;
  const H = 200;
  const PX = 40; // left padding for y-axis labels
  const PY = 10; // top/bottom padding
  const chartW = W - PX - 10;
  const chartH = H - PY * 2;

  const points = sliced.map((d, i) => {
    const x = PX + (sliced.length === 1 ? chartW / 2 : (i / (sliced.length - 1)) * chartW);
    const y = PY + chartH - ((d.followers - yMin) / yRange) * chartH;
    return { x, y, ...d };
  });

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const areaPath = `${linePath} L${points[points.length - 1].x},${PY + chartH} L${points[0].x},${PY + chartH} Z`;

  // Y-axis labels
  const yLabels = [yMax, yMin + yRange / 2, yMin].map((v) => ({
    value: Math.round(v),
    y: PY + chartH - ((v - yMin) / yRange) * chartH,
  }));

  // Compute change
  const first = sliced[0]?.followers ?? 0;
  const last = sliced[sliced.length - 1]?.followers ?? 0;
  const change = last - first;

  return (
    <div>
      {/* Summary */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '12px' }}>
        <span style={{ fontSize: 'var(--text-2xl)', fontWeight: 700, color: 'var(--stone-900)', fontFamily: 'var(--font-display)' }}>
          {formatNumber(last)}
        </span>
        {change !== 0 && (
          <span style={{
            fontSize: 'var(--text-sm)',
            fontWeight: 500,
            color: change > 0 ? 'var(--color-success)' : 'var(--color-error)',
          }}>
            {change > 0 ? '+' : ''}{formatNumber(change)}
          </span>
        )}
      </div>

      {/* Chart */}
      <div style={{ position: 'relative' }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }}>
          {/* Grid lines */}
          {yLabels.map((yl, i) => (
            <line
              key={i}
              x1={PX}
              y1={yl.y}
              x2={W - 10}
              y2={yl.y}
              stroke="var(--stone-100)"
              strokeWidth="1"
              strokeDasharray="4,4"
            />
          ))}

          {/* Y-axis labels */}
          {yLabels.map((yl, i) => (
            <text
              key={i}
              x={PX - 6}
              y={yl.y + 4}
              textAnchor="end"
              fontSize="10"
              fill="var(--stone-400)"
            >
              {formatNumber(yl.value)}
            </text>
          ))}

          {/* Area fill */}
          <path d={areaPath} fill="var(--accent-100)" opacity="0.5" />

          {/* Line */}
          <path d={linePath} fill="none" stroke="var(--accent-500)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

          {/* Data points */}
          {points.map((p, i) => (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={hoveredIdx === i ? 5 : 3}
              fill={hoveredIdx === i ? 'var(--accent-600)' : 'var(--accent-500)'}
              stroke="#fff"
              strokeWidth="2"
              style={{ cursor: 'pointer', transition: 'r 150ms' }}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
            />
          ))}

          {/* Hover hitboxes */}
          {points.map((p, i) => (
            <rect
              key={`hit-${i}`}
              x={p.x - (chartW / sliced.length) / 2}
              y={PY}
              width={chartW / sliced.length}
              height={chartH}
              fill="transparent"
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
            />
          ))}
        </svg>

        {/* Tooltip */}
        {hoveredIdx !== null && points[hoveredIdx] && (
          <div style={{
            position: 'absolute',
            left: `${(points[hoveredIdx].x / W) * 100}%`,
            top: `${(points[hoveredIdx].y / H) * 100 - 14}%`,
            transform: 'translate(-50%, -100%)',
            background: 'var(--stone-800)',
            color: '#fff',
            padding: '4px 10px',
            borderRadius: 'var(--radius-md)',
            fontSize: '11px',
            fontWeight: 500,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 10,
          }}>
            {formatShortDate(points[hoveredIdx].date)}: {formatNumber(points[hoveredIdx].followers)}
          </div>
        )}
      </div>

      {/* X-axis labels */}
      <div style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: `${(PX / W) * 100}%`, paddingRight: '2%', marginTop: '4px' }}>
        {sliced.length > 1 && (
          <>
            <span style={{ fontSize: '10px', color: 'var(--stone-400)' }}>{formatShortDate(sliced[0].date)}</span>
            <span style={{ fontSize: '10px', color: 'var(--stone-400)' }}>{formatShortDate(sliced[sliced.length - 1].date)}</span>
          </>
        )}
      </div>
    </div>
  );
}
