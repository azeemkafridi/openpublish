import { useState, type CSSProperties } from 'react';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

export interface BulkActionsProps {
  selectedIds: number[];
  /** Statuses of the selected posts — used to show/hide context-aware actions */
  selectedStatuses?: string[];
  onAction: (action: string) => void;
  onClear: () => void;
}

export function BulkActions({ selectedIds, selectedStatuses, onAction, onClear }: BulkActionsProps) {
  const [showDelete, setShowDelete] = useState(false);
  const [showReschedule, setShowReschedule] = useState(false);
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [rescheduleTime, setRescheduleTime] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const count = selectedIds.length;
  if (count === 0) return null;

  // Context-aware visibility — fall back to showing both if statuses aren't provided
  const canRetry = selectedStatuses
    ? selectedStatuses.some((s) => s === 'failed' || s === 'partial')
    : true;
  const canReschedule = selectedStatuses
    ? selectedStatuses.some((s) => s === 'draft' || s === 'scheduled')
    : true;

  async function executeBulk(action: string, extra?: Record<string, unknown>) {
    setLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        action,
        postIds: selectedIds,
        ...extra,
      };
      const res = await fetch('/api/posts/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message || `Bulk ${action} failed`);
      }
      setShowDelete(false);
      setShowReschedule(false);
      onAction(action);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  const barStyle: CSSProperties = {
    position: 'sticky',
    bottom: 0,
    left: 0,
    right: 0,
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px 20px',
    background: 'var(--surface-main)',
    borderTop: 'none',
    boxShadow: '0 -4px 20px rgba(28, 25, 23, 0.08)',
    zIndex: 'var(--z-sticky)' as any,
    animation: 'fadeInUp 200ms ease both',
  };

  return (
    <>
      <div style={barStyle}>
        <span
          style={{
            fontSize: 'var(--text-sm)',
            fontWeight: 600,
            color: 'var(--stone-700)',
            whiteSpace: 'nowrap',
          }}
        >
          {count} selected
        </span>

        <div style={{ display: 'flex', gap: '8px', flex: 1 }}>
          <Button
            variant="danger"
            size="sm"
            onClick={() => setShowDelete(true)}
          >
            Delete Selected
          </Button>

          {canRetry && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => executeBulk('retry')}
              loading={loading}
            >
              Retry Failed
            </Button>
          )}

          {canReschedule && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowReschedule(true)}
            >
              Reschedule
            </Button>
          )}
        </div>

        <button
          type="button"
          onClick={onClear}
          style={{
            fontSize: 'var(--text-xs)',
            color: 'var(--stone-500)',
            textDecoration: 'underline',
            cursor: 'pointer',
          }}
          onMouseOver={(e) => (e.currentTarget.style.color = 'var(--stone-700)')}
          onMouseOut={(e) => (e.currentTarget.style.color = 'var(--stone-500)')}
        >
          Clear selection
        </button>
      </div>

      {/* Delete confirmation dialog */}
      <Dialog
        open={showDelete}
        onClose={() => {
          setShowDelete(false);
          setError(null);
        }}
        title="Delete Posts"
        description={`Are you sure you want to delete ${count} post${count > 1 ? 's' : ''}? This action cannot be undone.`}
        size="sm"
      >
        {error && (
          <p
            style={{
              fontSize: 'var(--text-sm)',
              color: 'var(--color-error)',
              marginBottom: '12px',
            }}
          >
            {error}
          </p>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setShowDelete(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            loading={loading}
            onClick={() => executeBulk('delete')}
          >
            Delete {count} post{count > 1 ? 's' : ''}
          </Button>
        </div>
      </Dialog>

      {/* Reschedule dialog */}
      <Dialog
        open={showReschedule}
        onClose={() => {
          setShowReschedule(false);
          setError(null);
        }}
        title="Reschedule Posts"
        description={`Choose a new date and time for ${count} post${count > 1 ? 's' : ''}.`}
        size="sm"
      >
        <div
          style={{
            display: 'flex',
            gap: '10px',
            marginBottom: '16px',
          }}
        >
          <div style={{ flex: 1 }}>
            <label
              className="label"
              htmlFor="bulk-reschedule-date"
            >
              Date
            </label>
            <input
              id="bulk-reschedule-date"
              type="date"
              className="input"
              value={rescheduleDate}
              onChange={(e) => setRescheduleDate(e.target.value)}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label
              className="label"
              htmlFor="bulk-reschedule-time"
            >
              Time
            </label>
            <input
              id="bulk-reschedule-time"
              type="time"
              className="input"
              value={rescheduleTime}
              onChange={(e) => setRescheduleTime(e.target.value)}
            />
          </div>
        </div>

        {error && (
          <p
            style={{
              fontSize: 'var(--text-sm)',
              color: 'var(--color-error)',
              marginBottom: '12px',
            }}
          >
            {error}
          </p>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setShowReschedule(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={loading}
            disabled={!rescheduleDate || !rescheduleTime}
            onClick={() => {
              if (!rescheduleDate || !rescheduleTime) return;
              const scheduledAt = new Date(`${rescheduleDate}T${rescheduleTime}`).toISOString();
              executeBulk('reschedule', { scheduledAt });
            }}
          >
            Reschedule
          </Button>
        </div>
      </Dialog>
    </>
  );
}
