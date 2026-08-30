import { useState, useRef, useEffect, useCallback, type CSSProperties, type ChangeEvent } from 'react';
import { mediaImageUrl } from '@lib/media/display';
import type { Platform } from './ChannelSelector';
import type { MediaFile } from './MediaUploader';
import { Dialog } from '@components/ui/Dialog';
import { Button } from '@components/ui/Button';
import { Spinner } from '@components/ui/Spinner';
import { uploadMediaFile } from '@lib/media/upload-client';
import { platformLength } from '@lib/url';
import { PLATFORM_CHAR_LIMITS } from '@lib/platforms/validation';
import { THREAD_PLATFORMS } from '@lib/platforms/thread-support';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ThreadPart {
  content: string;
  mediaFileIds: number[];
}

interface ThreadEditorProps {
  parts: ThreadPart[];
  onChange: (parts: ThreadPart[]) => void;
  charLimit: number | null;
  platforms: Platform[];
  allMediaFiles?: MediaFile[];
  onMediaUploaded?: (file: MediaFile) => void;
  maxMediaPerPart?: number;
  acceptTypes?: ('image' | 'video')[];
}

/* ------------------------------------------------------------------ */
/*  Character limits per platform (used to compute tightest limit)     */
/* ------------------------------------------------------------------ */

/**
 * Derived from the server's authoritative table rather than retyped, so a limit
 * change (or a new threading platform) can't leave this copy behind. Mastodon
 * was missing here for exactly that reason, which made a Mastodon-only thread
 * render with no limit at all.
 */
const CHAR_LIMITS: Record<string, number | null> = Object.fromEntries(
  THREAD_PLATFORMS.map((p) => [p, PLATFORM_CHAR_LIMITS[p]]),
);

export function getThreadCharLimit(platforms: Platform[]): number | null {
  const limits = platforms
    .map((p) => CHAR_LIMITS[p])
    .filter((l): l is number => l !== null && l !== undefined);
  return limits.length > 0 ? Math.min(...limits) : null;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ThreadEditor({
  parts,
  onChange,
  charLimit,
  platforms,
  allMediaFiles,
  onMediaUploaded,
  maxMediaPerPart = 4,
  acceptTypes,
}: ThreadEditorProps) {
  const textareaRefs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Shared media picker state
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPartIndex, setPickerPartIndex] = useState<number | null>(null);
  const [libraryItems, setLibraryItems] = useState<any[]>([]);
  const [libraryRawCount, setLibraryRawCount] = useState(0); // items before the type filter — lets the empty state explain *why*
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [librarySelected, setLibrarySelected] = useState<Set<number>>(new Set());
  const [librarySearch, setLibrarySearch] = useState('');
  const [dialogUploading, setDialogUploading] = useState(false);
  const dialogFileInputRef = useRef<HTMLInputElement | null>(null);

  const allowImage = !acceptTypes || acceptTypes.includes('image');
  const allowVideo = !acceptTypes || acceptTypes.includes('video');
  const dialogAcceptAttr = [allowImage && 'image/*', allowVideo && 'video/*'].filter(Boolean).join(',');

  const updatePart = useCallback((index: number, content: string) => {
    const updated = [...parts];
    updated[index] = { ...updated[index], content };
    onChange(updated);
  }, [parts, onChange]);

  const updatePartMediaIds = useCallback((index: number, mediaFileIds: number[]) => {
    const updated = [...parts];
    updated[index] = { ...updated[index], mediaFileIds };
    onChange(updated);
  }, [parts, onChange]);

  const addPart = useCallback(() => {
    onChange([...parts, { content: '', mediaFileIds: [] }]);
    setTimeout(() => {
      const refs = textareaRefs.current;
      refs[refs.length - 1]?.focus();
    }, 50);
  }, [parts, onChange]);

  const removePart = useCallback((index: number) => {
    if (parts.length <= 2) return;
    const updated = parts.filter((_, i) => i !== index);
    onChange(updated);
  }, [parts, onChange]);

  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    if (dragIndex === null || dragIndex === dropIndex) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }
    const updated = [...parts];
    const [moved] = updated.splice(dragIndex, 1);
    updated.splice(dropIndex, 0, moved);
    onChange(updated);
    setDragIndex(null);
    setDragOverIndex(null);
  }, [dragIndex, parts, onChange]);

  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setDragOverIndex(null);
  }, []);

  // Resolve media files for each part from the pool
  const mediaPool = allMediaFiles ?? [];
  const mediaByIdMap = new Map(mediaPool.map((f) => [f.id, f]));

  // Media picker functions
  const openPicker = useCallback(async (partIndex: number) => {
    setPickerPartIndex(partIndex);
    setPickerOpen(true);
    setLibrarySelected(new Set());
    setLibrarySearch('');
    setLibraryLoading(true);
    try {
      const res = await fetch('/api/media?limit=50');
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json();
      const rawList = Array.isArray(data) ? data : Array.isArray(data?.files) ? data.files : [];
      setLibraryRawCount(rawList.length);
      const filtered = rawList.filter((raw: any) => {
        const mime = raw.mimeType ?? raw.mime_type ?? '';
        if (allowImage && mime.startsWith('image')) return true;
        if (allowVideo && mime.startsWith('video')) return true;
        return false;
      });
      setLibraryItems(filtered);
    } catch {
      setLibraryItems([]);
      setLibraryRawCount(0);
    } finally {
      setLibraryLoading(false);
    }
  }, [allowImage, allowVideo]);

  const toggleLibraryItem = (id: number) => {
    if (pickerPartIndex === null) return;
    const part = parts[pickerPartIndex];
    if (!part) return;
    const currentCount = part.mediaFileIds.length;

    setLibrarySelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        if (currentCount + next.size + 1 > maxMediaPerPart) return prev;
        next.add(id);
      }
      return next;
    });
  };

  const confirmLibrarySelection = () => {
    if (pickerPartIndex === null) return;
    const part = parts[pickerPartIndex];
    if (!part) return;

    const existingIds = new Set(part.mediaFileIds);
    const newFiles: MediaFile[] = [];
    const newIds: number[] = [];

    for (const raw of libraryItems) {
      if (librarySelected.has(raw.id) && !existingIds.has(raw.id)) {
        newIds.push(raw.id);
        newFiles.push({
          id: raw.id,
          originalPath: raw.originalUrl ?? raw.originalPath ?? '',
          thumbnailPath: raw.thumbnailUrl ?? raw.thumbnailPath ?? '',
          fileName: raw.fileName ?? raw.file_name ?? '',
          mimeType: raw.mimeType ?? raw.mime_type ?? '',
          sizeBytes: raw.sizeBytes ?? raw.size_bytes ?? 0,
          width: raw.width ?? 0,
          height: raw.height ?? 0,
          duration: raw.duration ?? undefined,
        });
      }
    }

    if (newIds.length > 0) {
      for (const f of newFiles) {
        onMediaUploaded?.(f);
      }
      updatePartMediaIds(pickerPartIndex, [...part.mediaFileIds, ...newIds]);
    }
    setPickerOpen(false);
  };

  // Upload inside the picker dialog
  const handleDialogUpload = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0 || pickerPartIndex === null) return;
    const part = parts[pickerPartIndex];
    if (!part) return;

    const remaining = maxMediaPerPart - part.mediaFileIds.length;
    if (remaining <= 0) return;

    const validFiles = Array.from(files)
      .filter((f) => {
        if (f.type.startsWith('image/') && allowImage) return true;
        if (f.type.startsWith('video/') && allowVideo) return true;
        return false;
      })
      .slice(0, remaining);

    for (const file of validFiles) {
      setDialogUploading(true);
      try {
        const raw = await uploadMediaFile(file);
        setLibraryItems((prev) => [raw, ...prev]);
        setLibrarySelected((prev) => new Set(prev).add(raw.id));
      } catch {
        // silently fail
      } finally {
        setDialogUploading(false);
      }
    }
  }, [pickerPartIndex, parts, maxMediaPerPart, allowImage, allowVideo]);

  return (
    <div style={s.container}>
      {parts.map((part, index) => {
        const partMediaFiles = part.mediaFileIds
          .map((id) => mediaByIdMap.get(id))
          .filter((f): f is MediaFile => !!f);

        return (
          <ThreadPartRow
            key={index}
            index={index}
            part={part}
            total={parts.length}
            charLimit={charLimit}
            weightPlatform={platforms.includes('x') ? 'x' : ''}
            isLast={index === parts.length - 1}
            isDragging={dragIndex === index}
            isDragOver={dragOverIndex === index && dragIndex !== index}
            textareaRef={(el) => { textareaRefs.current[index] = el; }}
            onContentChange={(content) => updatePart(index, content)}
            onMediaIdsChange={(ids) => updatePartMediaIds(index, ids)}
            onRemove={() => removePart(index)}
            onDragStart={() => handleDragStart(index)}
            onDragOver={(e) => handleDragOver(e, index)}
            onDrop={(e) => handleDrop(e, index)}
            onDragEnd={handleDragEnd}
            mediaFiles={partMediaFiles}
            maxMedia={maxMediaPerPart}
            onOpenPicker={() => openPicker(index)}
          />
        );
      })}

      {/* Add part button */}
      <button
        type="button"
        onClick={addPart}
        style={s.addButton}
        onMouseOver={(e) => {
          e.currentTarget.style.background = 'var(--stone-100)';
          e.currentTarget.style.borderColor = 'var(--stone-300)';
        }}
        onMouseOut={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.borderColor = 'var(--stone-200)';
        }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <line x1="7" y1="3" x2="7" y2="11" />
          <line x1="3" y1="7" x2="11" y2="7" />
        </svg>
        Add part
      </button>

      {/* Shared media picker dialog */}
      <Dialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Add Media"
        description={`Add files to part ${pickerPartIndex !== null ? pickerPartIndex + 1 : ''}. Upload or pick from your library.`}
        size="lg"
      >
        {/* Upload zone inside dialog */}
        <div
          onClick={() => dialogFileInputRef.current?.click()}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '14px 16px',
            borderRadius: 'var(--radius-md)',
            border: '2px dashed var(--stone-200)',
            background: 'var(--stone-50)',
            cursor: 'pointer',
            marginBottom: '16px',
            transition: 'border-color 150ms, background 150ms',
          }}
          onMouseOver={(e) => {
            e.currentTarget.style.borderColor = 'var(--accent-400)';
            e.currentTarget.style.background = 'var(--accent-50, #F7F7F8)';
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.borderColor = 'var(--stone-200)';
            e.currentTarget.style.background = 'var(--stone-50)';
          }}
        >
          {dialogUploading ? (
            <Spinner size="sm" />
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--stone-400)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          )}
          <div>
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--stone-700)' }}>
              Upload from device
            </span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', marginLeft: '8px' }}>
              {allowImage && allowVideo ? 'Images & videos' : allowVideo ? 'Videos' : 'Images'}
            </span>
          </div>
          <input
            ref={dialogFileInputRef}
            type="file"
            accept={dialogAcceptAttr}
            multiple={maxMediaPerPart > 1}
            onChange={(e) => { handleDialogUpload(e.target.files); e.target.value = ''; }}
            style={{ display: 'none' }}
          />
        </div>

        {/* Divider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
          <div style={{ flex: 1, height: '1px', background: 'var(--stone-150, var(--stone-100))' }} />
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', fontWeight: 500 }}>or pick from library</span>
          <div style={{ flex: 1, height: '1px', background: 'var(--stone-150, var(--stone-100))' }} />
        </div>

        {libraryLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}>
            <Spinner size="lg" />
          </div>
        ) : libraryItems.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--stone-400)', fontSize: 'var(--text-sm)' }}>
            {libraryRawCount > 0 ? (
              <>
                Your library has {libraryRawCount} file{libraryRawCount > 1 ? 's' : ''}, but{' '}
                {allowVideo && !allowImage
                  ? 'this format accepts videos only, so your images are hidden.'
                  : allowImage && !allowVideo
                    ? 'this format accepts images only. Switch to the Video format to attach a video.'
                    : 'none are compatible with this format.'}
              </>
            ) : (
              'No media files in your library yet.'
            )}
          </div>
        ) : (
          <>
            {/* Search */}
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', marginBottom: '12px' }}>
              <svg
                width="14" height="14" viewBox="0 0 16 16" fill="none"
                stroke="var(--stone-400)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                style={{ position: 'absolute', left: '10px', pointerEvents: 'none' }}
              >
                <circle cx="7" cy="7" r="5" />
                <line x1="11" y1="11" x2="14" y2="14" />
              </svg>
              <input
                type="text"
                className="input"
                placeholder="Search files..."
                value={librarySearch}
                onChange={(e) => setLibrarySearch(e.target.value)}
                style={{
                  paddingLeft: '32px',
                  width: '100%',
                  height: 'var(--control-height-sm)',
                  fontSize: 'var(--text-sm)',
                  border: '2px solid var(--surface-card)',
                }}
              />
            </div>

            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
              gap: '10px',
              maxHeight: '300px',
              overflowY: 'auto',
              padding: '4px',
            }}>
              {libraryItems.filter((raw) => {
                if (!librarySearch) return true;
                const name = (raw.fileName ?? raw.file_name ?? '').toLowerCase();
                return name.includes(librarySearch.toLowerCase());
              }).map((raw) => {
                const partIds = pickerPartIndex !== null ? parts[pickerPartIndex]?.mediaFileIds ?? [] : [];
                const isAlreadyAttached = partIds.includes(raw.id);
                const isOriginalDeleted = raw.isOriginalDeleted ?? raw.is_original_deleted ?? false;
                const isDisabled = isAlreadyAttached || isOriginalDeleted;
                const isSelected = librarySelected.has(raw.id);
                const mime = raw.mimeType ?? raw.mime_type ?? '';
                const isVideo = mime.startsWith('video');
                const displayUrl = mediaImageUrl({
                  mimeType: mime,
                  thumbnailUrl: raw.thumbnailUrl ?? raw.thumbnailPath,
                  previewUrl: raw.previewUrl ?? raw.preview_url,
                  largeUrl: raw.largeUrl ?? raw.large_url,
                  originalUrl: raw.originalUrl ?? raw.originalPath,
                  isOriginalDeleted,
                }, 'preview') ?? '';

                return (
                  <div
                    key={raw.id}
                    onClick={() => { if (!isDisabled) toggleLibraryItem(raw.id); }}
                    style={{
                      position: 'relative',
                      borderRadius: 'var(--radius-md)',
                      overflow: 'hidden',
                      cursor: isDisabled ? 'default' : 'pointer',
                      opacity: isDisabled ? 0.4 : 1,
                      outline: isSelected ? '2px solid var(--accent-500)' : '2px solid transparent',
                      transition: 'outline 150ms ease, opacity 150ms ease',
                    }}
                  >
                    <div style={{
                      position: 'relative',
                      width: '100%',
                      aspectRatio: '1',
                      background: 'var(--stone-100)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                    }}>
                      {displayUrl ? (
                        <img src={displayUrl} alt={raw.fileName ?? ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
                      ) : (
                        <svg width="28" height="28" viewBox="0 0 32 32" fill="none" stroke="var(--stone-300)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="4" y="4" width="24" height="24" rx="4" />
                          {isVideo ? <polygon points="13 11 21 16 13 21" /> : <circle cx="16" cy="16" r="5" />}
                        </svg>
                      )}
                      {isVideo && displayUrl && (
                        <div style={{ position: 'absolute', top: '6px', left: '6px', display: 'flex', alignItems: 'center', gap: '3px', padding: '2px 6px', borderRadius: 'var(--radius-pill)', background: 'rgba(0,0,0,0.5)', color: '#fff', fontSize: '9px', fontWeight: 600 }}>
                          <svg width="8" height="8" viewBox="0 0 8 8" fill="#fff"><polygon points="2 1 7 4 2 7" /></svg>
                          Video
                        </div>
                      )}
                      {isSelected && (
                        <div style={{ position: 'absolute', top: '6px', right: '6px', width: '22px', height: '22px', borderRadius: '50%', background: 'var(--accent-500)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="2.5 6 5 8.5 9.5 3.5" />
                          </svg>
                        </div>
                      )}
                      {isAlreadyAttached && (
                        <div style={{ position: 'absolute', bottom: '6px', right: '6px', display: 'flex', alignItems: 'center', gap: '3px', padding: '2px 6px', borderRadius: 'var(--radius-pill)', background: 'rgba(0,0,0,0.5)', color: '#fff', fontSize: '9px', fontWeight: 600, whiteSpace: 'nowrap' }}>
                          Added
                        </div>
                      )}
                      {!isAlreadyAttached && isOriginalDeleted && (
                        <div style={{ position: 'absolute', bottom: '6px', right: '6px', display: 'flex', alignItems: 'center', gap: '3px', padding: '2px 6px', borderRadius: 'var(--radius-pill)', background: 'rgba(239, 68, 68, 0.85)', color: '#fff', fontSize: '9px', fontWeight: 600, whiteSpace: 'nowrap' }}>
                          Deleted
                        </div>
                      )}
                    </div>
                    <div style={{ padding: '6px 8px' }}>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-600)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {raw.fileName ?? 'Untitled'}
                      </div>
                      <div style={{ fontSize: '10px', color: 'var(--stone-400)' }}>
                        {formatBytes(raw.sizeBytes ?? 0)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '16px', borderTop: '1px solid var(--stone-100)', position: 'sticky', bottom: 0, background: 'var(--accent-50, #fff)', zIndex: 2, padding: '16px' }}>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-500)' }}>
                {librarySelected.size} selected
              </span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <Button variant="secondary" size="sm" onClick={() => setPickerOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={librarySelected.size === 0}
                  onClick={confirmLibrarySelection}
                >
                  Add Selected
                </Button>
              </div>
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Thread Part Row                                                    */
/* ------------------------------------------------------------------ */

function ThreadPartRow({
  index,
  part,
  total,
  charLimit,
  weightPlatform,
  isLast,
  isDragging,
  isDragOver,
  textareaRef,
  onContentChange,
  onMediaIdsChange,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  mediaFiles,
  maxMedia,
  onOpenPicker,
}: {
  index: number;
  part: ThreadPart;
  total: number;
  charLimit: number | null;
  weightPlatform: string;
  isLast: boolean;
  isDragging: boolean;
  isDragOver: boolean;
  textareaRef: (el: HTMLTextAreaElement | null) => void;
  onContentChange: (content: string) => void;
  onMediaIdsChange: (ids: number[]) => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  mediaFiles: MediaFile[];
  maxMedia: number;
  onOpenPicker: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const partLength = platformLength(part.content, weightPlatform);
  const isOverLimit = charLimit !== null && partLength > charLimit;
  const atMediaLimit = mediaFiles.length >= maxMedia;

  // Auto-grow textarea
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(ta.scrollHeight, 60)}px`;
  }, [part.content]);

  const removeMedia = (fileId: number) => {
    onMediaIdsChange(part.mediaFileIds.filter((id) => id !== fileId));
  };

  return (
    <div
      style={{
        ...s.partRow,
        opacity: isDragging ? 0.4 : 1,
        transition: 'opacity 150ms',
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* Drop indicator line */}
      {isDragOver && (
        <div style={s.dropIndicator} />
      )}

      {/* Left gutter: drag handle + number + connector line */}
      <div
        style={s.gutter}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(index));
          onDragStart();
        }}
        onDragEnd={onDragEnd}
      >
        <div
          style={{
            ...s.partNumber,
            background: focused ? 'var(--accent-500)' : 'var(--stone-100)',
            color: focused ? '#fff' : 'var(--stone-600)',
            cursor: 'grab',
          }}
          title="Drag to reorder"
        >
          {index + 1}
        </div>
        {!isLast && <div style={s.connector} />}
      </div>

      {/* Content area */}
      <div style={{
        ...s.partContent,
        boxShadow: isDragOver
          ? '0 0 0 2px rgba(250,129,18,0.25)'
          : focused
            ? '0 0 0 2px rgba(250,129,18,0.15)'
            : 'none',
      }}>
        <textarea
          ref={(el) => {
            taRef.current = el;
            textareaRef(el);
          }}
          value={part.content}
          onChange={(e) => onContentChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={index === 0 ? 'Start your thread...' : 'Continue...'}
          style={s.textarea}
        />

        {/* Media cells: + Add cell followed by thumbnails */}
        {(mediaFiles.length > 0 || !atMediaLimit) && (
          <div style={s.mediaCells}>
            {/* + Add cell */}
            {!atMediaLimit && (
              <button
                type="button"
                onClick={onOpenPicker}
                style={s.addMediaCell}
                onMouseOver={(e) => {
                  e.currentTarget.style.borderColor = 'var(--accent-400)';
                  e.currentTarget.style.color = 'var(--accent-500)';
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.borderColor = 'var(--stone-250, var(--stone-200))';
                  e.currentTarget.style.color = 'var(--stone-400)';
                }}
                title={`Add media (${mediaFiles.length}/${maxMedia})`}
              >
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <line x1="8" y1="4" x2="8" y2="12" />
                  <line x1="4" y1="8" x2="12" y2="8" />
                </svg>
              </button>
            )}

            {/* Thumbnail cells */}
            {mediaFiles.map((file) => (
              <div key={file.id} style={s.mediaCell}>
                {(file.mimeType ?? '').startsWith('image') ? (
                  <img
                    src={file.thumbnailPath || file.originalPath}
                    alt={file.fileName}
                    style={s.mediaCellImg}
                  />
                ) : (
                  <div style={s.mediaCellVideo}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="rgba(255,255,255,0.9)" stroke="none">
                      <polygon points="6,4 12,8 6,12" />
                    </svg>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removeMedia(file.id)}
                  style={s.mediaCellRemove}
                  title="Remove"
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="1.5" y1="1.5" x2="6.5" y2="6.5" />
                    <line x1="6.5" y1="1.5" x2="1.5" y2="6.5" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Bottom bar: char count + media icon + remove */}
        <div style={s.partFooter}>
          {charLimit !== null && part.content.length > 0 && (
            <span style={{
              fontSize: 'var(--text-xs)',
              color: isOverLimit ? 'var(--color-error)' : 'var(--stone-400)',
              fontWeight: isOverLimit ? 600 : 400,
              fontVariantNumeric: 'tabular-nums',
            }}>
              {partLength} / {charLimit}
            </span>
          )}
          <div style={{ flex: 1 }} />

          {atMediaLimit && mediaFiles.length > 0 && (
            <span style={{ fontSize: '10px', color: 'var(--stone-400)' }}>
              {mediaFiles.length}/{maxMedia}
            </span>
          )}

          {total > 2 && (
            <button
              type="button"
              onClick={onRemove}
              style={s.removeButton}
              title="Remove this part"
              onMouseOver={(e) => { e.currentTarget.style.color = 'var(--color-error)'; }}
              onMouseOut={(e) => { e.currentTarget.style.color = 'var(--stone-400)'; }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="3" y1="7" x2="11" y2="7" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const CELL_SIZE = 56;

const s: Record<string, CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
    padding: '16px',
  },

  partRow: {
    display: 'flex',
    gap: '12px',
    minHeight: '80px',
    position: 'relative',
  },

  dropIndicator: {
    position: 'absolute',
    top: '-2px',
    left: '36px',
    right: '0',
    height: '3px',
    borderRadius: '2px',
    background: 'var(--accent-500)',
    zIndex: 2,
    pointerEvents: 'none',
  },

  gutter: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    width: '24px',
    flexShrink: 0,
  },

  partNumber: {
    width: '22px',
    height: '22px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '11px',
    fontWeight: 600,
    flexShrink: 0,
    transition: 'all 150ms',
  },

  connector: {
    width: '2px',
    flex: 1,
    background: 'var(--stone-200)',
    marginTop: '6px',
    marginBottom: '6px',
    borderRadius: '1px',
  },

  partContent: {
    flex: 1,
    border: 'none',
    borderRadius: 'var(--radius-md)',
    padding: '10px 14px 6px',
    marginBottom: '8px',
    background: 'var(--surface-main)',
    transition: 'box-shadow 150ms',
  },

  textarea: {
    width: '100%',
    minHeight: '60px',
    border: 'none',
    outline: 'none',
    resize: 'none',
    fontFamily: 'var(--font-body)',
    fontSize: 'var(--text-md)',
    fontWeight: 500,
    lineHeight: 'var(--leading-relaxed)',
    color: 'var(--stone-800)',
    background: 'transparent',
  },

  /* Cell-based media strip */
  mediaCells: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '8px',
    paddingTop: '8px',
    paddingBottom: '4px',
  },

  addMediaCell: {
    width: `${CELL_SIZE}px`,
    height: `${CELL_SIZE}px`,
    borderRadius: '8px',
    border: '2px dashed var(--stone-250, var(--stone-200))',
    background: 'none',
    color: 'var(--stone-400)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: 'border-color 150ms, color 150ms',
    padding: 0,
  },

  mediaCell: {
    position: 'relative' as const,
    width: `${CELL_SIZE}px`,
    height: `${CELL_SIZE}px`,
    borderRadius: '8px',
    overflow: 'hidden',
    background: 'var(--stone-100)',
  },

  mediaCellImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover' as const,
  },

  mediaCellVideo: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--stone-200)',
  },

  mediaCellRemove: {
    position: 'absolute' as const,
    top: '3px',
    right: '3px',
    width: '16px',
    height: '16px',
    borderRadius: '50%',
    background: 'rgba(0,0,0,0.55)',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    border: 'none',
    padding: 0,
  },

  partFooter: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    paddingTop: '4px',
  },

  removeButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    border: 'none',
    background: 'none',
    color: 'var(--stone-400)',
    cursor: 'pointer',
    borderRadius: 'var(--radius-sm)',
    transition: 'color 150ms',
  },

  addButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '8px 16px',
    marginLeft: 'auto',
    border: '1px dashed var(--stone-200)',
    borderRadius: 'var(--radius-md)',
    background: 'transparent',
    color: 'var(--stone-500)',
    fontSize: 'var(--text-sm)',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 150ms',
    alignSelf: 'flex-end',
  },
};
