import { useState, useEffect, useRef } from 'react';
import { Spinner } from '@components/ui/Spinner';
import { PlatformIcon } from '@components/channels/PlatformIcon';
import { useApi } from '@lib/swr';
import { platformDisplayName } from '@lib/platforms/types';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type Platform =
  | 'facebook'
  | 'instagram'
  | 'x'
  | 'tiktok'
  | 'youtube'
  | 'threads'
  | 'bluesky'
  | 'pinterest'
  | 'gmb'
  | 'linkedin'
  | 'mastodon'
  | 'reddit'
  | 'discord'
  | 'telegram'
  | 'tumblr'
  | 'snapchat';

export interface Channel {
  id: number;
  platform: Platform;
  accountName: string;
  avatarUrl?: string;
}

export interface SelectedChannel {
  channelId: number;
  platform: Platform;
}

export interface ChannelSet {
  id: number;
  name: string;
  channelIds: number[];
}

export interface ChannelSelectorProps {
  selectedChannels: SelectedChannel[];
  onChange: (channels: SelectedChannel[]) => void;
  disabledPlatforms?: Platform[];
  formatLabel?: string;
  activeChannelId?: number | null;
  onChannelClick?: (channelId: number) => void;
  onAllClick?: () => void;
  platformsWithOverrides?: Set<string>;
  channelWarnings?: Map<number, string[]>;
  /** Which edge to anchor the dropdown to. Use 'right' when the trigger sits near the viewport's right edge. */
  align?: 'left' | 'right';
}

/* ------------------------------------------------------------------ */
/*  Icons                                                              */
/* ------------------------------------------------------------------ */

const icons = {
  plus: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="8" y1="3" x2="8" y2="13" />
      <line x1="3" y1="8" x2="13" y2="8" />
    </svg>
  ),
  check: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 8 6.5 11.5 13 4.5" />
    </svg>
  ),
  chevronDown: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 6 8 10 12 6" />
    </svg>
  ),
  x: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="12" y1="4" x2="4" y2="12" />
      <line x1="4" y1="4" x2="12" y2="12" />
    </svg>
  ),
  globe: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" />
      <ellipse cx="8" cy="8" rx="2.5" ry="6" />
      <line x1="2" y1="8" x2="14" y2="8" />
    </svg>
  ),
  grid: (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  ),
  pencil: (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.5 1.5l3 3L5 14H2v-3z" />
      <line x1="9" y1="4" x2="12" y2="7" />
    </svg>
  ),
  trash: (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="2.5 4.5 13.5 4.5" />
      <path d="M5 4.5V3a1 1 0 011-1h4a1 1 0 011 1v1.5" />
      <path d="M4 4.5l.5 9a1 1 0 001 1h5a1 1 0 001-1l.5-9" />
    </svg>
  ),
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ChannelSelector({ selectedChannels, onChange, disabledPlatforms = [], formatLabel, activeChannelId, onChannelClick, onAllClick, platformsWithOverrides, channelWarnings, align = 'left' }: ChannelSelectorProps) {
  const { data: _channelData, error: _channelError, isLoading: loading } = useApi<Channel[] | { channels?: Channel[] }>('/api/channels');
  const channels = Array.isArray(_channelData) ? _channelData : _channelData?.channels ?? [];
  const error = _channelError?.message ?? null;
  const [isOpen, setIsOpen] = useState(false);
  // Saved channel templates — pick a group of channels once, reuse it with one click.
  const { data: _setsData, mutate: mutateSets } = useApi<ChannelSet[]>('/api/channel-sets');
  const templates = (Array.isArray(_setsData) ? _setsData : []).filter((s) => Array.isArray(s?.channelIds));
  const [naming, setNaming] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [savingSet, setSavingSet] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  const isSelected = (id: number) => selectedChannels.some((c) => c.channelId === id);

  const isDisabled = (platform: Platform) => disabledPlatforms.includes(platform);

  const toggle = (channel: Channel) => {
    if (isDisabled(channel.platform)) return;
    if (isSelected(channel.id)) {
      onChange(selectedChannels.filter((c) => c.channelId !== channel.id));
    } else {
      onChange([...selectedChannels, { channelId: channel.id, platform: channel.platform }]);
    }
  };

  const removeChannel = (channelId: number) => {
    onChange(selectedChannels.filter((c) => c.channelId !== channelId));
  };

  const getChannel = (channelId: number) => channels.find((c) => c.id === channelId);

  /** The channels a template would actually select here (existing + not format-disabled). */
  const templateChannelIds = (set: ChannelSet) =>
    set.channelIds.filter((id) => {
      const ch = channels.find((c) => c.id === id);
      return ch && !isDisabled(ch.platform);
    });

  /** The template whose selectable channels exactly match the current selection, if any. */
  const activeTemplate = templates.find((set) => {
    const ids = templateChannelIds(set);
    return (
      ids.length > 0 &&
      ids.length === selectedChannels.length &&
      ids.every((id) => selectedChannels.some((s) => s.channelId === id))
    );
  });

  /** The template currently being edited, if any. */
  const editingSet = editingId != null ? templates.find((s) => s.id === editingId) ?? null : null;
  /** While editing, the selection is the template's channel list; resolve it to Channel objects. */
  const editingChannels = editingSet
    ? (selectedChannels.map((s) => getChannel(s.channelId)).filter(Boolean) as Channel[])
    : [];

  /** Apply a template: replace the selection with its channels (skipping gone/disabled ones). */
  const applyTemplate = (set: ChannelSet) => {
    const next: SelectedChannel[] = [];
    for (const id of set.channelIds) {
      const ch = channels.find((c) => c.id === id);
      if (ch && !isDisabled(ch.platform)) next.push({ channelId: ch.id, platform: ch.platform });
    }
    if (next.length > 0) onChange(next);
  };

  const startNaming = () => {
    setSaveError(null);
    setTemplateName('');
    setNaming(true);
  };

  const saveTemplate = async () => {
    const name = templateName.trim();
    if (!name) return;
    setSavingSet(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/channel-sets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, channelIds: selectedChannels.map((c) => c.channelId) }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setSaveError((typeof data?.error === 'string' ? data.error : data?.error?.message) || 'Could not save the template.');
        return;
      }
      await mutateSets();
      setNaming(false);
      setTemplateName('');
    } finally {
      setSavingSet(false);
    }
  };

  const startEditing = (set: ChannelSet) => {
    setEditError(null);
    setConfirmDeleteId(null);
    setNaming(false);
    setEditingId(set.id);
    setEditName(set.name);
    // Pre-select the template's channels so the picker below reflects what the
    // template contains — toggling channels then "Use current selection" edits it.
    applyTemplate(set);
  };

  /**
   * Save the edited template. While editing, the picker's selection *is* the
   * template's channel list (pre-loaded on edit, mutated as the user adds/removes),
   * so we persist name + the current selection together.
   */
  const saveEdit = async (set: ChannelSet) => {
    const name = editName.trim();
    const channelIds = selectedChannels.map((c) => c.channelId);
    if (!name || channelIds.length === 0) return;
    setSavingEdit(true);
    setEditError(null);
    try {
      const body = { name, channelIds };
      const res = await fetch(`/api/channel-sets/${set.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setEditError((typeof data?.error === 'string' ? data.error : data?.error?.message) || 'Could not update the template.');
        return;
      }
      await mutateSets();
      setEditingId(null);
    } finally {
      setSavingEdit(false);
    }
  };

  const confirmDelete = async (set: ChannelSet) => {
    await fetch(`/api/channel-sets/${set.id}`, { method: 'DELETE' });
    setConfirmDeleteId(null);
    await mutateSets();
  };

  /* ---- Render ---- */

  if (loading) {
    return (
      <div style={styles.loadingState}>
        <Spinner size="sm" />
        <span>Loading channels...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.errorState}>
        {error}
      </div>
    );
  }

  return (
    <div ref={containerRef} style={styles.container}>
      {/* Selected channels row */}
      <div style={styles.selectedRow}>
        {/* "All" pill — visible when per-platform mode is available */}
        {onChannelClick && selectedChannels.length > 0 && (
          <div
            style={{
              ...styles.selectedChip,
              background: activeChannelId == null ? '#FFFFFF' : 'var(--stone-100)',
              boxShadow: activeChannelId == null ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
              opacity: activeChannelId != null ? 0.6 : 1,
              cursor: 'pointer',
            }}
            onClick={() => onAllClick?.()}
          >
            {icons.globe}
            <span style={styles.chipName}>All</span>
          </div>
        )}

        {selectedChannels.map((sel) => {
          const ch = getChannel(sel.channelId);
          if (!ch) return null;
          const isActive = activeChannelId === ch.id;
          const hasAnyActive = activeChannelId != null;
          const hasOverride = platformsWithOverrides?.has(ch.platform) ?? false;
          return (
            <div
              key={ch.id}
              style={{
                ...styles.selectedChip,
                background: isActive ? '#FFFFFF' : 'var(--stone-100)',
                boxShadow: isActive ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                opacity: hasAnyActive && !isActive ? 0.6 : 1,
                cursor: onChannelClick ? 'pointer' : 'default',
              }}
              onClick={() => onChannelClick?.(ch.id)}
            >
              <PlatformIcon platform={ch.platform} size="xs" />
              <span style={styles.chipName}>{ch.accountName}</span>
              {hasOverride && (
                <span title="Customized content" style={{ display: 'inline-flex', flexShrink: 0 }}>
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="var(--stone-400)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11.5 1.5l3 3L5 14H2v-3z" />
                    <line x1="9" y1="4" x2="12" y2="7" />
                  </svg>
                </span>
              )}
              {(channelWarnings?.get(ch.id)?.length ?? 0) > 0 && (
                <span
                  title={channelWarnings!.get(ch.id)!.join('\n')}
                  style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    background: 'var(--color-error)',
                    flexShrink: 0,
                  }}
                />
              )}
              <button
                type="button"
                title={`Remove ${ch.accountName}`}
                aria-label={`Remove ${ch.accountName}`}
                onClick={(e) => { e.stopPropagation(); removeChannel(ch.id); }}
                style={styles.chipRemove}
              >
                {icons.x}
              </button>
            </div>
          );
        })}

        {/* Add channel button */}
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          style={styles.addButton}
        >
          {icons.plus}
          <span>Select Channels</span>
          {icons.chevronDown}
        </button>
      </div>

      {/* Dropdown */}
      {isOpen && (
        <div style={{ ...styles.dropdown, ...(align === 'right' ? { left: 'auto', right: 0 } : null) }}>
          <div style={styles.dropdownHeader}>
            <span style={styles.dropdownTitle}>Channels</span>
            <span style={styles.dropdownCount}>
              {activeTemplate ? `${activeTemplate.name} · ` : ''}{selectedChannels.length} selected
            </span>
          </div>

          {/* Channel templates — save a group of channels once, reuse with one click */}
          {channels.length > 0 && (templates.length > 0 || selectedChannels.length >= 2 || editingSet) && (
            <div style={styles.setsSection}>
              <div style={styles.templatesHeader}>
                <span style={styles.templatesTitle}>{editingSet ? 'Edit template' : 'Templates'}</span>
                {!editingSet && selectedChannels.length >= 2 && !naming && (
                  <button type="button" style={styles.saveTemplateBtn} onClick={startNaming}>
                    {icons.plus}
                    Save selection
                  </button>
                )}
              </div>

              {editingSet ? (
                <div style={styles.editPanel}>
                  <input
                    className="input"
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(editingSet); if (e.key === 'Escape') { setEditingId(null); setEditError(null); } }}
                    placeholder="Template name"
                    maxLength={100}
                    aria-label={`Rename template ${editingSet.name}`}
                    style={{ width: '100%', background: 'var(--surface-main)' }}
                  />

                  {/* Channels in this template — click a chip to remove it */}
                  <div style={styles.editChannels}>
                    {editingChannels.length === 0 ? (
                      <div style={styles.editChannelsEmpty}>No channels yet. Add one from below.</div>
                    ) : (
                      editingChannels.map((ch) => (
                        <button
                          key={ch.id}
                          type="button"
                          onClick={() => removeChannel(ch.id)}
                          title={`Remove ${ch.accountName}`}
                          aria-label={`Remove ${ch.accountName} from template`}
                          style={styles.editChannelChip}
                        >
                          <PlatformIcon platform={ch.platform} size="xs" />
                          <span style={styles.chipName}>{ch.accountName}</span>
                          <span style={styles.chipRemove}>{icons.x}</span>
                        </button>
                      ))
                    )}
                  </div>

                  {editError && <div style={styles.saveError}>{editError}</div>}

                  <div style={styles.editActions}>
                    <button type="button" className="btn btn-primary btn-sm" disabled={!editName.trim() || editingChannels.length === 0 || savingEdit} onClick={() => saveEdit(editingSet)}>
                      {savingEdit ? 'Saving…' : 'Save'}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setEditingId(null); setEditError(null); setConfirmDeleteId(null); }}>Cancel</button>
                    <div style={{ flex: 1 }} />
                    {confirmDeleteId === editingSet.id ? (
                      <div style={styles.confirmRow}>
                        <button type="button" style={styles.confirmDelete} onClick={() => confirmDelete(editingSet)}>Delete?</button>
                        <button type="button" style={styles.confirmCancel} onClick={() => setConfirmDeleteId(null)}>Keep</button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Delete template ${editingSet.name}`}
                        title={`Delete template ${editingSet.name}`}
                        onClick={() => setConfirmDeleteId(editingSet.id)}
                        style={styles.editDelete}
                      >
                        {icons.trash}
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  {templates.map((set) => {
                    const isTplActive = activeTemplate?.id === set.id;
                    return (
                      <div key={set.id} style={styles.setRow}>
                        <button
                          type="button"
                          onClick={() => applyTemplate(set)}
                          title={`Select the ${set.name} template`}
                          style={{
                            ...styles.setApply,
                            background: isTplActive ? 'var(--accent-50)' : 'transparent',
                            color: isTplActive ? 'var(--accent-700)' : 'var(--stone-700)',
                            fontWeight: isTplActive ? 600 : 500,
                          }}
                          onMouseOver={(e) => { if (!isTplActive) e.currentTarget.style.background = 'var(--surface-main)'; }}
                          onMouseOut={(e) => { if (!isTplActive) e.currentTarget.style.background = 'transparent'; }}
                        >
                          <span style={{ display: 'inline-flex', color: isTplActive ? 'var(--accent-600)' : 'var(--stone-400)' }}>
                            {isTplActive ? icons.check : icons.grid}
                          </span>
                          <span style={styles.setName}>{set.name}</span>
                          <span style={styles.setCount}>{templateChannelIds(set).length || set.channelIds.length}</span>
                        </button>
                        <button
                          type="button"
                          aria-label={`Edit template ${set.name}`}
                          title={`Edit template ${set.name}`}
                          onClick={() => startEditing(set)}
                          style={styles.setEdit}
                        >
                          {icons.pencil}
                        </button>
                      </div>
                    );
                  })}

                  {naming && (
                    <div style={styles.nameRow}>
                      <input
                        className="input"
                        autoFocus
                        value={templateName}
                        onChange={(e) => setTemplateName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveTemplate(); if (e.key === 'Escape') { setNaming(false); setSaveError(null); } }}
                        placeholder="Template name"
                        maxLength={100}
                        style={styles.nameInput}
                      />
                      <button type="button" className="btn btn-primary btn-sm" disabled={!templateName.trim() || savingSet} onClick={saveTemplate}>
                        {savingSet ? 'Saving…' : 'Save'}
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setNaming(false); setSaveError(null); }}>Cancel</button>
                    </div>
                  )}
                  {saveError && <div style={styles.saveError}>{saveError}</div>}

                  {templates.length === 0 && !naming && (
                    <div style={styles.templatesHint}>Save the channels you post to most as a reusable template.</div>
                  )}
                </>
              )}
            </div>
          )}

          {/* While editing a template, the list below is the "add a channel" pool:
              only channels not already in the template, and picking one moves it up. */}
          {editingSet && (
            <div style={styles.addChannelsLabel}>Add channels</div>
          )}
          {channels.length > 0 && (
          <div style={styles.dropdownList}>
            {(editingSet ? channels.filter((ch) => !isSelected(ch.id)) : channels).map((ch) => {
              const selected = isSelected(ch.id);
              const disabled = isDisabled(ch.platform);
              return (
                <button
                  key={ch.id}
                  type="button"
                  onClick={() => toggle(ch)}
                  style={{
                    ...styles.dropdownItem,
                    background: 'transparent',
                    opacity: disabled ? 0.4 : 1,
                    cursor: disabled ? 'default' : 'pointer',
                  }}
                  onMouseOver={(e) => { if (!disabled) e.currentTarget.style.background = '#FFFFFF'; }}
                  onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <div style={styles.itemLeft}>
                    <PlatformIcon platform={ch.platform} size="sm" />
                    <div style={styles.itemInfo}>
                      <span style={styles.itemName}>{ch.accountName}</span>
                      {disabled && formatLabel ? (
                        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>
                          Doesn't support {formatLabel}
                        </span>
                      ) : (
                        <span style={styles.itemPlatform}>
                          {platformDisplayName(ch.platform)}
                        </span>
                      )}
                    </div>
                  </div>
                  {!disabled && (
                    <div style={{
                      ...styles.checkbox,
                      background: selected ? 'var(--accent-600)' : 'transparent',
                      // In the add-to-template pool every row is unselected, so
                      // show the empty checkbox outline to make it clearly tickable.
                      border: selected ? '1.5px solid var(--accent-600)' : (editingSet ? '1.5px solid var(--stone-300)' : 'none'),
                    }}>
                      {selected && (
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 8 6.5 11.5 13 4.5" />
                        </svg>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
          )}

          {channels.length === 0 && (
            <div style={{ padding: '12px', textAlign: 'center', fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>
              No channels connected yet
            </div>
          )}

          {editingSet && channels.length > 0 && channels.every((ch) => isSelected(ch.id)) && (
            <div style={{ padding: '4px 16px 12px', fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>
              Every channel is in this template.
            </div>
          )}

          {/* Connect a new channel — styled like "Add another account" on /channels */}
          <a
            href="/channels"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '11px 16px',
              borderTop: '1px solid var(--stone-200)',
              borderRadius: '0 0 var(--radius-lg) var(--radius-lg)',
              color: 'var(--accent-600)',
              fontSize: 'var(--text-sm)',
              fontWeight: 600,
              textDecoration: 'none',
              cursor: 'pointer',
            }}
            onMouseOver={(e) => (e.currentTarget.style.background = 'var(--stone-50)')}
            onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="2" width="10" height="10" rx="2" />
              <line x1="7" y1="5" x2="7" y2="9" />
              <line x1="5" y1="7" x2="9" y2="7" />
            </svg>
            Connect channels
          </a>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'relative',
  },
  loadingState: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 0',
    fontSize: 'var(--text-sm)',
    color: 'var(--stone-500)',
  },
  errorState: {
    padding: '12px 16px',
    borderRadius: 'var(--radius-md)',
    background: 'var(--color-error-bg)',
    color: 'var(--color-error)',
    fontSize: 'var(--text-sm)',
  },
  emptyState: {
    padding: '24px',
    textAlign: 'center',
    borderRadius: 'var(--radius-md)',
    border: 'none',
  },
  emptyText: {
    fontSize: 'var(--text-sm)',
    color: 'var(--stone-500)',
    marginBottom: '8px',
  },
  selectedRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '8px',
  },
  placeholder: {
    fontSize: 'var(--text-sm)',
    color: 'var(--stone-400)',
  },
  selectedChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 10px 4px 4px',
    borderRadius: 'var(--radius-pill)',
    background: 'var(--stone-100)',
    border: 'none',
    fontSize: 'var(--text-sm)',
  },
  chipName: {
    fontWeight: 500,
    color: 'var(--stone-700)',
  },
  chipRemove: {
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
    transition: 'all var(--transition-fast)',
  },
  addButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    borderRadius: 'var(--radius-pill)',
    border: 'none',
    background: 'transparent',
    color: 'var(--stone-500)',
    fontSize: 'var(--text-sm)',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all var(--transition-fast)',
  },
  dropdown: {
    position: 'absolute',
    top: 'calc(100% + 8px)',
    left: 0,
    width: '320px',
    background: 'var(--surface-main)',
    borderRadius: 'var(--radius-lg)',
    border: '1px solid var(--stone-200)',
    boxShadow: '0 10px 40px -10px rgba(0,0,0,0.15)',
    zIndex: 100,
    overflow: 'visible',
    animation: 'popoverIn 150ms ease both',
  },
  dropdownHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: 'none',
  },
  dropdownTitle: {
    fontSize: 'var(--text-sm)',
    fontWeight: 600,
    color: 'var(--stone-700)',
  },
  dropdownCount: {
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-400)',
  },
  // Horizontal rhythm: the dropdown header text sits at 16px. Rows are inset
  // 8px by the section padding and add 8px of their own padding, so their
  // text (and any active-row background) aligns at 16px without touching
  // the dropdown edges.
  setsSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: '0 8px 8px',
    borderBottom: '1px solid var(--stone-150)',
  },
  templatesHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 8px 6px',
  },
  templatesTitle: {
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: 'var(--stone-400)',
  },
  saveTemplateBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    border: 'none',
    background: 'transparent',
    color: 'var(--accent-600)',
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    cursor: 'pointer',
    padding: '2px 4px',
  },
  setRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  setApply: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flex: 1,
    minWidth: 0,
    padding: '8px',
    borderRadius: 'var(--radius-md)',
    border: 'none',
    background: 'transparent',
    color: 'var(--stone-700)',
    fontSize: 'var(--text-sm)',
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'background var(--transition-fast)',
  },
  setName: {
    fontWeight: 500,
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  setCount: {
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-400)',
    fontVariantNumeric: 'tabular-nums',
  },
  setEdit: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    borderRadius: 'var(--radius-md)',
    border: 'none',
    background: 'transparent',
    color: 'var(--stone-400)',
    cursor: 'pointer',
    padding: 0,
    flexShrink: 0,
  },
  editPanel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '10px',
    borderRadius: 'var(--radius-md)',
    background: 'var(--stone-100)',
  },
  editChannels: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
  },
  editChannelChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 8px 4px 6px',
    borderRadius: 'var(--radius-pill)',
    background: 'var(--surface-main)',
    border: 'none',
    fontSize: 'var(--text-sm)',
    cursor: 'pointer',
  },
  editChannelsEmpty: {
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-400)',
    padding: '2px 0',
  },
  addChannelsLabel: {
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: 'var(--stone-400)',
    padding: '10px 16px 2px',
  },
  editActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  editDelete: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    border: 'none',
    background: 'transparent',
    color: 'var(--color-error-text)',
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    cursor: 'pointer',
    padding: '4px 6px',
    borderRadius: 'var(--radius-md)',
  },
  confirmRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0,
  },
  confirmDelete: {
    border: 'none',
    background: 'transparent',
    color: 'var(--color-error-text)',
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    cursor: 'pointer',
    padding: '4px 6px',
  },
  confirmCancel: {
    border: 'none',
    background: 'transparent',
    color: 'var(--stone-500)',
    fontSize: 'var(--text-xs)',
    fontWeight: 500,
    cursor: 'pointer',
    padding: '4px 6px',
  },
  nameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px',
  },
  nameInput: {
    flex: 1,
    minWidth: 0,
    height: 'var(--control-height-sm)',
    fontSize: 'var(--text-sm)',
    padding: '0 12px',
    background: 'var(--stone-100)',
  },
  saveError: {
    padding: '2px 8px 6px',
    fontSize: 'var(--text-xs)',
    color: 'var(--color-error-text)',
  },
  templatesHint: {
    padding: '4px 8px 6px',
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-400)',
    lineHeight: 'var(--leading-relaxed)',
  },
  dropdownList: {
    maxHeight: '300px',
    overflowY: 'auto',
    padding: '4px',
  },
  dropdownItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    padding: '12px',
    borderRadius: '8px',
    border: 'none',
    cursor: 'pointer',
    transition: 'background var(--transition-fast)',
    textAlign: 'left',
  },
  itemLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  itemInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
  },
  itemName: {
    fontSize: 'var(--text-sm)',
    fontWeight: 500,
    color: 'var(--stone-800)',
  },
  itemPlatform: {
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-400)',
  },
  checkbox: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    borderRadius: 'var(--radius-sm)',
    border: 'none',
    transition: 'all var(--transition-fast)',
    flexShrink: 0,
  },
};
