import { useState } from 'react';
import { useApi } from '@lib/swr';
import { PlatformIcon } from '../channels/PlatformIcon';
import type { Platform } from '../compose/PostPreview';

/**
 * Every recurring schedule in the workspace, listed on the Repeat Posts page.
 *
 * The post list below this section only shows POSTS carrying a
 * recurringScheduleId — the template post the composer creates, plus each
 * occurrence once it fires. A schedule created through the API/MCP
 * (`POST /api/schedules` with a contentTemplate) has no post at all until its
 * first run, so before this section existed it was invisible everywhere in
 * the product while still counting against quota and still publishing. This
 * is the management surface: see, pause/resume, and delete every schedule,
 * however it was created.
 */

interface Schedule {
  id: number;
  name: string;
  frequency: string;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  timeOfDay: string;
  timezone: string | null;
  channelIds: number[] | null;
  contentTemplate: string | null;
  isActive: boolean | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

interface Channel {
  id: number;
  platform: string;
  accountName: string;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function cadenceLabel(s: Schedule): string {
  const time = s.timeOfDay;
  switch (s.frequency) {
    case 'daily': return `Daily at ${time}`;
    case 'weekly': return `Weekly on ${DAY_NAMES[s.dayOfWeek ?? 1]} at ${time}`;
    case 'biweekly': return `Every 2 weeks on ${DAY_NAMES[s.dayOfWeek ?? 1]} at ${time}`;
    case 'monthly': return `Monthly on day ${s.dayOfMonth ?? 1} at ${time}`;
    default: return `${s.frequency} at ${time}`;
  }
}

const COLLAPSED_COUNT = 5;

export function RepeatSchedulesList() {
  const { data, mutate } = useApi<Schedule[]>('/api/schedules');
  const { data: channelsData } = useApi<Channel[] | { channels?: Channel[] }>('/api/channels');
  const [expanded, setExpanded] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const schedules = Array.isArray(data) ? data : [];
  // Nothing to manage — the page keeps its existing look rather than showing
  // an empty box above the empty post list.
  if (schedules.length === 0) return null;

  const channels: Channel[] = Array.isArray(channelsData)
    ? channelsData
    : channelsData?.channels ?? [];
  const channelById = new Map(channels.map((c) => [c.id, c]));

  const shown = expanded ? schedules : schedules.slice(0, COLLAPSED_COUNT);
  const activeCount = schedules.filter((s) => s.isActive !== false).length;

  async function toggleActive(s: Schedule) {
    setBusyId(s.id);
    setError(null);
    try {
      const res = await fetch(`/api/schedules/${s.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: s.isActive === false }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Update failed');
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(s: Schedule) {
    if (!window.confirm(`Delete the repeat schedule "${s.name}"? Posts it already published are kept; no future occurrences will be created.`)) return;
    setBusyId(s.id);
    setError(null);
    try {
      const res = await fetch(`/api/schedules/${s.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Delete failed');
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="card" style={styles.card}>
      <div style={styles.head}>
        <span style={styles.title}>
          Schedules{' '}
          <span style={styles.count}>
            {activeCount} active{activeCount !== schedules.length ? ` · ${schedules.length - activeCount} paused` : ''}
          </span>
        </span>
      </div>

      {error && <p style={styles.error}>{error}</p>}

      <div>
        {shown.map((s, i) => {
          const paused = s.isActive === false;
          const scheduleChannels = (s.channelIds ?? [])
            .map((id) => channelById.get(id))
            .filter(Boolean) as Channel[];
          return (
            <div key={s.id} style={{ ...styles.row, borderTop: i === 0 ? 'none' : '1px solid var(--stone-100)', opacity: paused ? 0.6 : 1 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={styles.nameLine}>
                  <span style={styles.name}>{s.name}</span>
                  {paused && <span style={styles.pausedBadge}>Paused</span>}
                </div>
                <div style={styles.metaLine}>
                  <span>{cadenceLabel(s)}{s.timezone && s.timezone !== 'UTC' ? ` (${s.timezone})` : ''}</span>
                  {!paused && s.nextRunAt && (
                    <span>
                      · next{' '}
                      {new Date(s.nextRunAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                </div>
                {scheduleChannels.length > 0 && (
                  <div style={styles.channelLine}>
                    {scheduleChannels.map((c) => (
                      <span key={c.id} style={styles.channelChip} title={c.accountName}>
                        <PlatformIcon platform={c.platform as Platform} size="xs" />
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div style={styles.actions}>
                <button
                  onClick={() => toggleActive(s)}
                  disabled={busyId === s.id}
                  className="btn btn-ghost btn-sm"
                  title={paused ? 'Resume — the next occurrence is recalculated from now' : 'Pause — no occurrences are created while paused'}
                >
                  {paused ? 'Resume' : 'Pause'}
                </button>
                <button
                  onClick={() => remove(s)}
                  disabled={busyId === s.id}
                  className="btn btn-ghost btn-sm"
                  style={{ color: 'var(--color-error-text)' }}
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {schedules.length > COLLAPSED_COUNT && (
        <button onClick={() => setExpanded(!expanded)} style={styles.expandBtn}>
          {expanded ? 'Show fewer' : `Show all ${schedules.length} schedules`}
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    padding: '16px',
    marginBottom: '16px',
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '4px',
  },
  title: {
    fontSize: 'var(--text-sm)',
    fontWeight: 600,
    color: 'var(--stone-800)',
  },
  count: {
    fontSize: 'var(--text-xs)',
    fontWeight: 500,
    color: 'var(--stone-400)',
    marginLeft: '6px',
  },
  error: {
    fontSize: 'var(--text-sm)',
    color: 'var(--color-error-text)',
    margin: '8px 0',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px 0',
  },
  nameLine: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minWidth: 0,
  },
  name: {
    fontSize: 'var(--text-sm)',
    fontWeight: 600,
    color: 'var(--stone-800)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  pausedBadge: {
    fontSize: '10px',
    fontWeight: 700,
    color: 'var(--stone-500)',
    background: 'var(--stone-100)',
    borderRadius: 'var(--radius-pill)',
    padding: '2px 8px',
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
    flexShrink: 0,
  },
  metaLine: {
    display: 'flex',
    gap: '4px',
    flexWrap: 'wrap',
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-500)',
    marginTop: '2px',
  },
  channelLine: {
    display: 'flex',
    gap: '4px',
    marginTop: '6px',
    flexWrap: 'wrap',
  },
  channelChip: {
    display: 'inline-flex',
  },
  actions: {
    display: 'flex',
    gap: '4px',
    flexShrink: 0,
  },
  expandBtn: {
    marginTop: '4px',
    padding: 0,
    background: 'transparent',
    border: 'none',
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    color: 'var(--accent-500)',
    cursor: 'pointer',
  },
};
