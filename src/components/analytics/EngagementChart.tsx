interface DayData {
  date: string;
  impressions: number;
  engagements: number;
  reach?: number;
}

export function EngagementChart({ data }: { data: DayData[] }) {
  if (!data || data.length === 0) {
    return (
      <div style={{ height: '200px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--stone-400)', fontSize: 'var(--text-sm)' }}>
        No engagement data yet
      </div>
    );
  }

  // The three segments are stacked vertically into one bar per day, so the scale must be
  // the tallest stacked TOTAL (impressions + reach + engagements) — not the largest single
  // metric. Otherwise the busiest day's stack overflows the 200px plot and bleeds into the
  // cards above it.
  const maxVal = Math.max(...data.map((d) => d.impressions + (d.reach ?? 0) + d.engagements), 1);
  const barWidth = Math.max(4, Math.min(24, Math.floor(500 / data.length) - 4));

  return (
    <div>
      <div style={{ position: 'relative', height: '200px', display: 'flex', alignItems: 'flex-end', gap: '2px', padding: '0 4px', overflow: 'hidden' }}>
        {data.map((d) => {
          const impHeight = Math.max(2, (d.impressions / maxVal) * 180);
          const engHeight = Math.max(0, (d.engagements / maxVal) * 180);
          const reachHeight = d.reach ? Math.max(0, (d.reach / maxVal) * 180) : 0;
          const label = new Date(d.date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

          return (
            <div
              key={d.date}
              title={`${label}\nImpressions: ${d.impressions.toLocaleString()}${d.reach ? `\nReach: ${d.reach.toLocaleString()}` : ''}\nEngagements: ${d.engagements.toLocaleString()}`}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px', flex: 1, minWidth: 0 }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px', width: '100%' }}>
                <div
                  style={{
                    width: `${barWidth}px`,
                    height: `${impHeight}px`,
                    background: 'var(--accent-500)',
                    borderRadius: '3px 3px 0 0',
                    opacity: 0.7,
                    transition: 'opacity 150ms ease',
                  }}
                />
                {reachHeight > 0 && (
                  <div
                    style={{
                      width: `${barWidth}px`,
                      height: `${reachHeight}px`,
                      background: 'var(--accent-300)',
                      opacity: 0.5,
                    }}
                  />
                )}
                {engHeight > 0 && (
                  <div
                    style={{
                      width: `${barWidth}px`,
                      height: `${engHeight}px`,
                      background: '#6366f1',
                      borderRadius: '0 0 3px 3px',
                      opacity: 0.5,
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', marginTop: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <div style={{ width: '10px', height: '10px', borderRadius: '2px', background: 'var(--accent-500)', opacity: 0.7 }} />
          <span style={{ fontSize: '11px', color: 'var(--stone-500)' }}>Impressions</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <div style={{ width: '10px', height: '10px', borderRadius: '2px', background: 'var(--accent-300)', opacity: 0.5 }} />
          <span style={{ fontSize: '11px', color: 'var(--stone-500)' }}>Reach</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <div style={{ width: '10px', height: '10px', borderRadius: '2px', background: '#6366f1', opacity: 0.5 }} />
          <span style={{ fontSize: '11px', color: 'var(--stone-500)' }}>Engagements</span>
        </div>
      </div>
    </div>
  );
}
