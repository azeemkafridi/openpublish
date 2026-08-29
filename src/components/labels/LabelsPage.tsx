import { useState } from 'react';
import { PostList } from '../posts/PostList';
import { Dialog } from '../ui/Dialog';
import { Spinner } from '../ui/Spinner';
import { ApiError, parseApiError, type ApiErrorData } from '../ui/ApiError';
import { useApi } from '@lib/swr';
import { LabelDropdown } from './LabelDropdown';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Label {
  id: number;
  name: string;
  color: string;
}

/* ------------------------------------------------------------------ */
/*  Preset colours (same as LabelSelector)                             */
/* ------------------------------------------------------------------ */

const PRESET_COLORS = [
  '#EF4444', // red
  '#F59E0B', // amber
  '#10B981', // emerald
  '#3B82F6', // blue
  '#8B5CF6', // violet
  '#EC4899', // pink
];

/* ------------------------------------------------------------------ */
/*  Icons                                                              */
/* ------------------------------------------------------------------ */

const PencilIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 1.5l2.5 2.5L4.5 12H2v-2.5L10 1.5z" />
  </svg>
);

const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="2 4 12 4" />
    <path d="M4.5 4V2.5a1 1 0 011-1h3a1 1 0 011 1V4" />
    <path d="M3.5 4l.5 8a1 1 0 001 1h4a1 1 0 001-1l.5-8" />
  </svg>
);

const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="7" y1="2" x2="7" y2="12" />
    <line x1="2" y1="7" x2="12" y2="7" />
  </svg>
);

/* ------------------------------------------------------------------ */
/*  Color swatch picker                                                */
/* ------------------------------------------------------------------ */

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
      {PRESET_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          style={{
            width: '28px',
            height: '28px',
            borderRadius: '50%',
            background: c,
            border: value === c ? '2.5px solid var(--stone-800)' : '2.5px solid transparent',
            cursor: 'pointer',
            transition: 'border-color var(--transition-fast)',
            flexShrink: 0,
          }}
          title={c}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function LabelsPage() {
  // Label data
  const { data: _labelData, error: _labelError, isLoading: loading, mutate: mutateLabels } = useApi<Label[] | { labels?: Label[] }>('/api/labels');
  const labels = Array.isArray(_labelData) ? _labelData : _labelData?.labels ?? [];
  const error = _labelError?.message ?? null;

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(PRESET_COLORS[3]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<ApiErrorData | null>(null);

  // Edit dialog
  const [editingLabel, setEditingLabel] = useState<Label | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<ApiErrorData | null>(null);

  // Delete dialog
  const [deletingLabel, setDeletingLabel] = useState<Label | null>(null);
  const [deletePostCount, setDeletePostCount] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Filter state for querying posts
  const [selectedLabelIds, setSelectedLabelIds] = useState<number[]>([]);
  const [labelMode, setLabelMode] = useState<'or' | 'and'>('or');

  /* ---- Create ---- */

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch('/api/labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), color: newColor }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setCreateError(parseApiError(body, 'Failed to create label'));
        return;
      }
      await res.json();
      mutateLabels(undefined, { revalidate: true });
      setNewName('');
      setNewColor(PRESET_COLORS[3]);
      setShowCreate(false);
    } catch (err: any) {
      setCreateError({ message: err.message || 'Something went wrong. Please try again.' });
    } finally {
      setCreating(false);
    }
  };

  /* ---- Edit ---- */

  const openEdit = (label: Label) => {
    setEditingLabel(label);
    setEditName(label.name);
    setEditColor(label.color);
    setEditError(null);
  };

  const handleSaveEdit = async () => {
    if (!editingLabel || !editName.trim()) return;
    setSaving(true);
    setEditError(null);
    try {
      const res = await fetch(`/api/labels/${editingLabel.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName.trim(), color: editColor }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setEditError(parseApiError(body, 'Failed to update label'));
        return;
      }
      await res.json();
      mutateLabels(undefined, { revalidate: true });
      setEditingLabel(null);
    } catch (err: any) {
      setEditError({ message: err.message || 'Something went wrong. Please try again.' });
    } finally {
      setSaving(false);
    }
  };

  /* ---- Delete ---- */

  const openDelete = async (label: Label) => {
    setDeletingLabel(label);
    setDeletePostCount(null);
    try {
      const res = await fetch(`/api/posts?labelId=${label.id}&limit=1`);
      if (res.ok) {
        const data = await res.json();
        setDeletePostCount(data.total ?? 0);
      }
    } catch {
      // silently fail — just don't show count
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingLabel) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/labels/${deletingLabel.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
      if (!res.ok) throw new Error('Failed to delete label');
      mutateLabels(undefined, { revalidate: true });
      setSelectedLabelIds((prev) => prev.filter((id) => id !== deletingLabel.id));
      setDeletingLabel(null);
    } catch {
      // keep dialog open on error
    } finally {
      setDeleting(false);
    }
  };

  /* ---- Render ---- */

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '80px 0' }}>
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="card" style={{ padding: '40px', textAlign: 'center' }}>
        <p style={{ color: 'var(--color-error)', marginBottom: '12px' }}>{error}</p>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => mutateLabels()}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>

      {/* ============================================================ */}
      {/*  Section A: Label Management                                  */}
      {/* ============================================================ */}

      <section>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          <h2 style={{ fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--stone-900)', margin: 0 }}>
            Your Labels
          </h2>
          {!showCreate && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setShowCreate(true)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <PlusIcon />
              Create Label
            </button>
          )}
        </div>

        {/* Label cards */}
        {labels.length === 0 && !showCreate && (
          <div
            className="card"
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '12px',
              padding: '48px 20px',
              textAlign: 'center',
            }}
          >
            <svg width="40" height="40" viewBox="0 0 18 18" fill="none" stroke="var(--stone-300)" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 3.5A1.5 1.5 0 013.5 2h4.586a1.5 1.5 0 011.06.44l6.354 6.353a1.5 1.5 0 010 2.121l-4.586 4.586a1.5 1.5 0 01-2.121 0L2.44 9.147A1.5 1.5 0 012 8.086V3.5z" />
              <circle cx="5.5" cy="5.5" r="1" />
            </svg>
            <p style={{ fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--stone-700)' }}>No labels yet</p>
            <p style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-400)' }}>
              Create labels to organize and filter your posts.
            </p>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setShowCreate(true)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}
            >
              <PlusIcon />
              Create your first label
            </button>
          </div>
        )}

        {labels.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {labels.map((label) => (
              <div
                key={label.id}
                className="card"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '12px 16px',
                }}
              >
                {/* Color dot */}
                <span
                  style={{
                    width: '12px',
                    height: '12px',
                    borderRadius: '50%',
                    background: label.color,
                    flexShrink: 0,
                  }}
                />

                {/* Name */}
                <span style={{ flex: 1, fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--stone-800)' }}>
                  {label.name}
                </span>

                {/* Color badge */}
                <span
                  style={{
                    fontSize: 'var(--text-xs)',
                    color: 'var(--stone-400)',
                    fontFamily: 'var(--font-numeric)', fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {label.color}
                </span>

                {/* Edit button */}
                <button
                  type="button"
                  onClick={() => openEdit(label)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '32px',
                    height: '32px',
                    borderRadius: 'var(--radius-md)',
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--stone-400)',
                    cursor: 'pointer',
                    transition: 'all var(--transition-fast)',
                  }}
                  title="Edit label"
                  onMouseOver={(e) => {
                    e.currentTarget.style.background = 'var(--stone-100)';
                    e.currentTarget.style.color = 'var(--stone-600)';
                  }}
                  onMouseOut={(e) => {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = 'var(--stone-400)';
                  }}
                >
                  <PencilIcon />
                </button>

                {/* Delete button */}
                <button
                  type="button"
                  onClick={() => openDelete(label)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '32px',
                    height: '32px',
                    borderRadius: 'var(--radius-md)',
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--stone-400)',
                    cursor: 'pointer',
                    transition: 'all var(--transition-fast)',
                  }}
                  title="Delete label"
                  onMouseOver={(e) => {
                    e.currentTarget.style.background = 'var(--color-error-bg, #FEF2F2)';
                    e.currentTarget.style.color = 'var(--color-error, #EF4444)';
                  }}
                  onMouseOut={(e) => {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = 'var(--stone-400)';
                  }}
                >
                  <TrashIcon />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Create label inline form */}
        {showCreate && (
          <div
            className="card"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
              padding: '16px 20px',
              marginTop: labels.length > 0 ? '10px' : '0',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '12px', flexWrap: 'wrap' }}>
              {/* Name input */}
              <div style={{ flex: '1 1 180px' }}>
                <label
                  style={{
                    display: 'block',
                    fontSize: 'var(--text-xs)',
                    fontWeight: 500,
                    color: 'var(--stone-500)',
                    marginBottom: '6px',
                  }}
                >
                  Label Name
                </label>
                <input
                  className="input"
                  type="text"
                  placeholder="e.g. Marketing, Product, Urgent"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                  style={{ fontSize: 'var(--text-sm)', height: 'var(--control-height-sm)', padding: '0 12px', width: '100%' }}
                  autoFocus
                />
              </div>

              {/* Color picker */}
              <div>
                <label
                  style={{
                    display: 'block',
                    fontSize: 'var(--text-xs)',
                    fontWeight: 500,
                    color: 'var(--stone-500)',
                    marginBottom: '6px',
                  }}
                >
                  Color
                </label>
                <ColorPicker value={newColor} onChange={setNewColor} />
              </div>
            </div>

            {createError && <ApiError error={createError} />}

            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!newName.trim() || creating}
                onClick={handleCreate}
                style={{ minWidth: '70px' }}
              >
                {creating ? 'Adding...' : 'Add Label'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => { setShowCreate(false); setCreateError(null); setNewName(''); }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ============================================================ */}
      {/*  Section B: Filter Posts by Labels                            */}
      {/* ============================================================ */}

      {labels.length > 0 && (
        <section>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <h2 style={{ fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--stone-900)', margin: 0 }}>
              Filter Posts by Labels
            </h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <LabelDropdown labelType="post" selectedIds={selectedLabelIds} onChange={setSelectedLabelIds} />
            </div>
          </div>

          {/* AND/OR toggle */}
          {selectedLabelIds.length >= 2 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                padding: '4px',
                background: 'var(--stone-100)',
                borderRadius: 'var(--radius-lg)',
                marginBottom: '20px',
              }}
            >
              <button
                type="button"
                onClick={() => setLabelMode('or')}
                style={{
                  padding: '5px 12px',
                  borderRadius: '8px',
                  border: 'none',
                  background: labelMode === 'or' ? '#fff' : 'transparent',
                  fontSize: 'var(--text-xs)',
                  fontWeight: labelMode === 'or' ? 600 : 500,
                  color: labelMode === 'or' ? 'var(--stone-900)' : 'var(--stone-500)',
                  cursor: 'pointer',
                  transition: 'all 150ms ease',
                  boxShadow: labelMode === 'or' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                }}
              >
                Any (OR)
              </button>
              <button
                type="button"
                onClick={() => setLabelMode('and')}
                style={{
                  padding: '5px 12px',
                  borderRadius: '8px',
                  border: 'none',
                  background: labelMode === 'and' ? '#fff' : 'transparent',
                  fontSize: 'var(--text-xs)',
                  fontWeight: labelMode === 'and' ? 600 : 500,
                  color: labelMode === 'and' ? 'var(--stone-900)' : 'var(--stone-500)',
                  cursor: 'pointer',
                  transition: 'all 150ms ease',
                  boxShadow: labelMode === 'and' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                }}
              >
                All (AND)
              </button>
            </div>
          )}

          {/* Post list or hint */}
          {selectedLabelIds.length > 0 ? (
            <PostList
              key={selectedLabelIds.join(',') + '-' + labelMode}
              labelIds={selectedLabelIds}
              labelMode={labelMode}
            />
          ) : (
            <div
              className="card"
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '8px',
                padding: '48px 20px',
                textAlign: 'center',
              }}
            >
              <svg width="32" height="32" viewBox="0 0 18 18" fill="none" stroke="var(--stone-300)" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="5.5" />
                <line x1="12" y1="12" x2="16" y2="16" />
              </svg>
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-400)' }}>
                Select one or more labels above to filter posts.
              </p>
            </div>
          )}
        </section>
      )}

      {/* ============================================================ */}
      {/*  Edit Label Dialog                                            */}
      {/* ============================================================ */}

      <Dialog
        open={editingLabel !== null}
        onClose={() => setEditingLabel(null)}
        title="Edit Label"
        size="sm"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <label
              style={{
                display: 'block',
                fontSize: 'var(--text-xs)',
                fontWeight: 500,
                color: 'var(--stone-500)',
                marginBottom: '6px',
              }}
            >
              Name
            </label>
            <input
              className="input"
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSaveEdit()}
              style={{ fontSize: 'var(--text-sm)', height: 'var(--control-height-sm)', padding: '0 12px', width: '100%' }}
              autoFocus
            />
          </div>

          <div>
            <label
              style={{
                display: 'block',
                fontSize: 'var(--text-xs)',
                fontWeight: 500,
                color: 'var(--stone-500)',
                marginBottom: '8px',
              }}
            >
              Color
            </label>
            <ColorPicker value={editColor} onChange={setEditColor} />
          </div>

          {editError && <ApiError error={editError} />}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditingLabel(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={!editName.trim() || saving}
              onClick={handleSaveEdit}
              style={{ minWidth: '60px' }}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </Dialog>

      {/* ============================================================ */}
      {/*  Delete Label Dialog                                          */}
      {/* ============================================================ */}

      <Dialog
        open={deletingLabel !== null}
        onClose={() => setDeletingLabel(null)}
        title="Delete Label"
        description={
          deletingLabel
            ? `Are you sure you want to delete "${deletingLabel.name}"?${
                deletePostCount !== null
                  ? ` This label is used on ${deletePostCount} post${deletePostCount !== 1 ? 's' : ''}. The posts themselves will not be deleted.`
                  : ''
              }`
            : ''
        }
        size="sm"
      >
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setDeletingLabel(null)}>
            Cancel
          </button>
          <button
            className="btn btn-sm"
            disabled={deleting}
            onClick={handleConfirmDelete}
            style={{
              background: 'var(--color-error, #EF4444)',
              color: '#fff',
              border: 'none',
              minWidth: '70px',
            }}
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </Dialog>
    </div>
  );
}
