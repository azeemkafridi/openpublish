import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useApi, mutate } from '@lib/swr';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface Label {
  id: number;
  name: string;
  color: string;
  type?: string;
}

export interface LabelDropdownProps {
  /** Which label type to fetch and create */
  labelType: 'post' | 'media';
  /** Currently selected label IDs */
  selectedIds: number[];
  /** Callback when selection changes */
  onChange: (ids: number[]) => void;
  /** Custom trigger button text (default: "Filter") */
  triggerLabel?: string;
}

/* ------------------------------------------------------------------ */
/*  Preset colours                                                     */
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
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function LabelDropdown({ labelType, selectedIds, onChange, triggerLabel = 'Filter' }: LabelDropdownProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(PRESET_COLORS[0]);
  const [creating, setCreating] = useState(false);

  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number; openUp: boolean }>({ top: 0, left: 0, openUp: false });

  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const apiUrl = `/api/labels?type=${labelType}`;
  const { data: _data, isLoading } = useApi<Label[] | { labels?: Label[] }>(apiUrl);
  const labels: Label[] = Array.isArray(_data) ? _data : _data?.labels ?? [];

  // Filtered by search
  const filtered = search.trim()
    ? labels.filter((l) => l.name.toLowerCase().includes(search.trim().toLowerCase()))
    : labels;

  // Close on outside click (check both the wrapper and the fixed popover)
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        ref.current && !ref.current.contains(target) &&
        popoverRef.current && !popoverRef.current.contains(target)
      ) {
        setOpen(false);
        setSearch('');
        setShowCreate(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Position popover relative to trigger, flip up if near bottom
  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const popoverHeight = 380;
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < popoverHeight && rect.top > popoverHeight;
    setPopoverPos({
      top: openUp ? rect.top : rect.bottom + 8,
      left: rect.left,
      openUp,
    });
  }, []);

  useLayoutEffect(() => {
    if (open) {
      updatePosition();
      // Recalculate after a frame in case layout hasn't settled (e.g. inside dialogs)
      requestAnimationFrame(updatePosition);
    }
  }, [open, updatePosition]);

  // Focus search when popover opens
  useEffect(() => {
    if (open && searchRef.current) {
      searchRef.current.focus();
    }
  }, [open]);

  // Reposition on scroll/resize while open
  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [open, updatePosition]);

  const toggle = useCallback(
    (id: number) => {
      if (selectedIds.includes(id)) {
        onChange(selectedIds.filter((x) => x !== id));
      } else {
        onChange([...selectedIds, id]);
      }
    },
    [selectedIds, onChange],
  );

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      const res = await fetch('/api/labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, color: newColor, type: labelType }),
      });
      if (!res.ok) throw new Error('Failed');
      const created = await res.json();
      // Refresh label lists
      await mutate(apiUrl);
      mutate('/api/labels');
      mutate(`/api/labels?type=post`);
      mutate(`/api/labels?type=media`);
      // Auto-select newly created label
      if (created?.id) {
        onChange([...selectedIds, created.id]);
      }
      setNewName('');
      setNewColor(PRESET_COLORS[0]);
      setShowCreate(false);
    } catch {
      // user can retry
    } finally {
      setCreating(false);
    }
  };

  // Selected label objects (for chips)
  const selectedLabels = labels.filter((l) => selectedIds.includes(l.id));

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {/* Selected chips + trigger */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' }}>
        {selectedLabels.map((lbl) => (
          <div
            key={lbl.id}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 8px 6px 10px',
              borderRadius: 'var(--radius-pill)',
              background: 'var(--stone-100)',
              border: 'none',
              fontSize: 'var(--text-sm)',
            }}
          >
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: lbl.color, flexShrink: 0 }} />
            <span style={{ fontWeight: 500, color: 'var(--stone-700)' }}>{lbl.name}</span>
            <button
              type="button"
              onClick={() => toggle(lbl.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '18px',
                height: '18px',
                borderRadius: '50%',
                border: 'none',
                background: 'transparent',
                color: 'var(--stone-400)',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="2.5" y1="2.5" x2="7.5" y2="7.5" />
                <line x1="7.5" y1="2.5" x2="2.5" y2="7.5" />
              </svg>
            </button>
          </div>
        ))}

        <button
          ref={triggerRef}
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setOpen((o) => !o)}
        >
          {isLoading ? 'Loading...' : triggerLabel}
          <svg
            width="10"
            height="10"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms ease' }}
          >
            <polyline points="3 4.5 6 7.5 9 4.5" />
          </svg>
        </button>
      </div>

      {/* Dropdown popover (portaled to body to escape overflow containers) */}
      {open && createPortal(
        <div
          ref={popoverRef}
          style={{
            position: 'fixed',
            ...(popoverPos.openUp
              ? { bottom: window.innerHeight - popoverPos.top + 8 }
              : { top: popoverPos.top }),
            left: Math.min(popoverPos.left, window.innerWidth - 330),
            width: '320px',
            background: 'var(--surface-main)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: '0 10px 40px -10px rgba(0,0,0,0.15)',
            zIndex: 10000,
            border: '1px solid var(--stone-200)',
            animation: 'popoverIn 150ms ease both',
            overflow: 'hidden',
          }}
        >
          {/* Search */}
          <div style={{ padding: '8px 8px 0' }}>
            <div style={{ position: 'relative' }}>
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="var(--stone-400)"
                strokeWidth="1.5"
                strokeLinecap="round"
                style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }}
              >
                <circle cx="6" cy="6" r="4.5" />
                <line x1="9.5" y1="9.5" x2="12.5" y2="12.5" />
              </svg>
              <input
                ref={searchRef}
                type="text"
                placeholder="Search labels..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{
                  width: '100%',
                  padding: '8px 10px 8px 32px',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--stone-200)',
                  fontSize: 'var(--text-sm)',
                  background: 'var(--surface-card)',
                  outline: 'none',
                }}
              />
            </div>
          </div>

          {/* Create label */}
          <div style={{ padding: '4px 8px' }}>
            {!showCreate ? (
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  width: '100%',
                  padding: '8px',
                  borderRadius: 'var(--radius-md)',
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--accent-600)',
                  fontSize: 'var(--text-sm)',
                  fontWeight: 500,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="7" y1="2" x2="7" y2="12" />
                  <line x1="2" y1="7" x2="12" y2="7" />
                </svg>
                Create label
              </button>
            ) : (
              <div style={{ padding: '8px', borderRadius: 'var(--radius-md)', background: 'var(--stone-50)' }}>
                <input
                  type="text"
                  placeholder="Label name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
                  style={{
                    width: '100%',
                    padding: '6px 10px',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--stone-200)',
                    fontSize: 'var(--text-sm)',
                    background: 'white',
                    outline: 'none',
                    marginBottom: '8px',
                  }}
                  autoFocus
                />
                <div style={{ display: 'flex', gap: '5px', alignItems: 'center', marginBottom: '8px' }}>
                  {PRESET_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setNewColor(c)}
                      style={{
                        width: '22px',
                        height: '22px',
                        borderRadius: '50%',
                        background: c,
                        border: newColor === c ? '2px solid var(--stone-800)' : '2px solid transparent',
                        cursor: 'pointer',
                        flexShrink: 0,
                      }}
                    />
                  ))}
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    type="button"
                    onClick={handleCreate}
                    disabled={!newName.trim() || creating}
                    style={{
                      padding: '4px 12px',
                      borderRadius: 'var(--radius-md)',
                      border: 'none',
                      background: 'var(--accent-600)',
                      color: 'white',
                      fontSize: 'var(--text-xs)',
                      fontWeight: 600,
                      cursor: 'pointer',
                      opacity: !newName.trim() || creating ? 0.5 : 1,
                    }}
                  >
                    {creating ? 'Adding...' : 'Add'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowCreate(false); setNewName(''); }}
                    style={{
                      padding: '4px 12px',
                      borderRadius: 'var(--radius-md)',
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--stone-500)',
                      fontSize: 'var(--text-xs)',
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Header: Labels + count */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 16px 2px' }}>
            <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--stone-500)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Labels</span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>{selectedIds.length} selected</span>
          </div>

          {/* Label list */}
          <div style={{ maxHeight: '240px', overflowY: 'auto', padding: '4px' }}>
            {filtered.length === 0 && (
              <div style={{ padding: '16px', textAlign: 'center', color: 'var(--stone-400)', fontSize: 'var(--text-sm)' }}>
                {search.trim() ? 'No matching labels' : 'No labels yet'}
              </div>
            )}
            {filtered.map((lbl) => {
              const selected = selectedIds.includes(lbl.id);
              return (
                <button
                  key={lbl.id}
                  type="button"
                  onClick={() => toggle(lbl.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    transition: 'background var(--transition-fast)',
                    textAlign: 'left',
                  }}
                  onMouseOver={(e) => { e.currentTarget.style.background = 'var(--stone-50)'; }}
                  onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: lbl.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--stone-800)' }}>{lbl.name}</span>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: '20px',
                      height: '20px',
                      borderRadius: 'var(--radius-sm)',
                      border: selected ? 'none' : '1.5px solid var(--stone-300)',
                      background: selected ? 'var(--accent-600)' : 'transparent',
                      transition: 'all var(--transition-fast)',
                      flexShrink: 0,
                    }}
                  >
                    {selected && (
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 8 6.5 11.5 13 4.5" />
                      </svg>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
