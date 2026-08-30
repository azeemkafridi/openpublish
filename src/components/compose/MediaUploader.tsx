import { useState, useRef, useCallback, useEffect, type DragEvent, type ChangeEvent } from 'react';
import { mediaImageUrl } from '@lib/media/display';
import { createPortal } from 'react-dom';
import { Spinner } from '@components/ui/Spinner';
import { Dialog } from '@components/ui/Dialog';
import { Button } from '@components/ui/Button';
import { uploadMediaFile } from '@lib/media/upload-client';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface MediaFile {
  id: number;
  originalPath: string;
  thumbnailPath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  duration?: number;
}

interface UploadingFile {
  localId: string;
  fileName: string;
  status: 'uploading' | 'done' | 'error';
  progress: number;
  error?: string;
}

export interface MediaUploaderProps {
  mediaFiles: MediaFile[];
  onChange: (files: MediaFile[] | ((prev: MediaFile[]) => MediaFile[])) => void;
  maxFiles?: number;
  acceptTypes?: ('image' | 'video')[];
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function shortMime(mime: string): string {
  const sub = mime.split('/')[1] ?? mime;
  return sub.toUpperCase();
}

let nextLocalId = 0;

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const DEFAULT_MAX_FILES = 10;

export function MediaUploader({ mediaFiles, onChange, maxFiles, acceptTypes }: MediaUploaderProps) {
  const MAX_FILES = maxFiles ?? DEFAULT_MAX_FILES;
  const allowImage = !acceptTypes || acceptTypes.includes('image');
  const allowVideo = !acceptTypes || acceptTypes.includes('video');
  const acceptAttr = [allowImage && 'image/*', allowVideo && 'video/*'].filter(Boolean).join(',');
  const [uploading, setUploading] = useState<UploadingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /* ---- Thumbnail drag-to-reorder ---- */
  const dragSrcIdx = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const onThumbDragStart = (idx: number) => {
    dragSrcIdx.current = idx;
  };
  const onThumbDragOver = (e: DragEvent, idx: number) => {
    e.preventDefault();
    // Only handle reorder drags (no files from outside)
    if (dragSrcIdx.current === null) return;
    setDragOverIdx(idx);
  };
  const onThumbDrop = (e: DragEvent, idx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const from = dragSrcIdx.current;
    if (from === null || from === idx) {
      dragSrcIdx.current = null;
      setDragOverIdx(null);
      return;
    }
    const reordered = [...mediaFiles];
    const [item] = reordered.splice(from, 1);
    reordered.splice(idx, 0, item);
    onChange(reordered);
    dragSrcIdx.current = null;
    setDragOverIdx(null);
  };
  const onThumbDragEnd = () => {
    dragSrcIdx.current = null;
    setDragOverIdx(null);
  };

  const uploadFile = useCallback(
    async (file: File) => {
      const localId = `upload-${++nextLocalId}`;
      const entry: UploadingFile = { localId, fileName: file.name, status: 'uploading', progress: 0 };

      setUploading((prev) => [...prev, entry]);

      try {
        const raw = await uploadMediaFile(file, {
          onProgress: (progress) =>
            setUploading((prev) => prev.map((u) => (u.localId === localId ? { ...u, progress } : u))),
        });

        const media: MediaFile = {
          id: raw.id,
          originalPath: raw.originalUrl ?? '',
          thumbnailPath: raw.thumbnailUrl ?? '',
          fileName: raw.fileName,
          mimeType: raw.mimeType,
          sizeBytes: raw.sizeBytes,
          width: raw.width ?? 0,
          height: raw.height ?? 0,
          duration: raw.duration ?? undefined,
        };

        // Append via a functional update so multiple files uploading at once each
        // compose against the latest list. A plain onChange([...mediaFiles, media])
        // would capture the same snapshot in every concurrent call and the last
        // completion would clobber the rest (silently dropping attached files).
        onChange((prev) => [...prev, media]);

        // Mark done
        setUploading((prev) =>
          prev.map((u) => (u.localId === localId ? { ...u, status: 'done', progress: 100 } : u)),
        );

        // Remove from uploading list after brief delay
        setTimeout(() => {
          setUploading((prev) => prev.filter((u) => u.localId !== localId));
        }, 600);
      } catch (err: any) {
        setUploading((prev) =>
          prev.map((u) =>
            u.localId === localId
              ? { ...u, status: 'error', error: err.message ?? 'Upload failed' }
              : u,
          ),
        );
      }
    },
    [onChange],
  );

  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      const remaining = MAX_FILES - mediaFiles.length;
      if (remaining <= 0) return;
      const arr = Array.from(files)
        .filter((f) => {
          if (f.type.startsWith('image/') && allowImage) return true;
          if (f.type.startsWith('video/') && allowVideo) return true;
          return false;
        })
        .slice(0, remaining);
      arr.forEach((f) => uploadFile(f));
    },
    [mediaFiles.length, uploadFile, allowImage, allowVideo],
  );

  /* ---- Drag & Drop ---- */

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    setDragging(true);
  };
  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    // Only handle external file drops, not internal reorder drags
    if (dragSrcIdx.current !== null) return;
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  };

  /* ---- File input ---- */

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) handleFiles(e.target.files);
    e.target.value = '';
  };

  const removeFile = (id: number) => {
    onChange(mediaFiles.filter((f) => f.id !== id));
  };

  const dismissError = (localId: string) => {
    setUploading((prev) => prev.filter((u) => u.localId !== localId));
  };

  /* ---- Library picker ---- */
  const [showLibrary, setShowLibrary] = useState(false);
  const [libraryItems, setLibraryItems] = useState<any[]>([]);
  const [libraryRawCount, setLibraryRawCount] = useState(0); // items before the type filter — lets the empty state explain *why* it's empty
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [librarySelected, setLibrarySelected] = useState<Set<number>>(new Set());
  const [librarySearch, setLibrarySearch] = useState('');
  const [dialogUploading, setDialogUploading] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!lightboxUrl) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightboxUrl(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxUrl]);
  const dialogFileInputRef = useRef<HTMLInputElement | null>(null);

  const openLibrary = useCallback(async () => {
    setShowLibrary(true);
    setLibrarySelected(new Set());
    setLibrarySearch('');
    setLibraryLoading(true);
    try {
      const res = await fetch('/api/media?limit=50');
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json();
      const rawList = Array.isArray(data) ? data : Array.isArray(data?.files) ? data.files : [];
      setLibraryRawCount(rawList.length);
      // Filter by acceptTypes
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
    setLibrarySelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        // Respect max files limit
        const alreadyAttached = mediaFiles.filter((f) => libraryItems.some((li) => li.id === f.id)).length;
        const wouldBeTotal = mediaFiles.length - alreadyAttached + next.size + 1;
        if (MAX_FILES > 0 && wouldBeTotal > MAX_FILES) return prev;
        next.add(id);
      }
      return next;
    });
  };

  const confirmLibrarySelection = () => {
    const existingIds = new Set(mediaFiles.map((f) => f.id));
    const newFiles: MediaFile[] = [];
    for (const raw of libraryItems) {
      if (librarySelected.has(raw.id) && !existingIds.has(raw.id)) {
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
    if (newFiles.length > 0) {
      onChange([...mediaFiles, ...newFiles]);
    }
    setShowLibrary(false);
  };

  const handleDialogUpload = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const remaining = MAX_FILES - mediaFiles.length;
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
  }, [mediaFiles, MAX_FILES, allowImage, allowVideo]);

  const atLimit = MAX_FILES > 0 && mediaFiles.length >= MAX_FILES;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <label className="label" style={{ marginBottom: 0 }}>
          Media
        </label>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>
          {allowImage && allowVideo ? 'Images and videos' : allowVideo ? 'Videos only' : 'Images only'}
        </span>
      </div>

      {/* Drop zone */}
      {!atLimit && (
        <div
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            minHeight: '207px',
            padding: '28px 16px',
            borderRadius: 4,
            border: 'none',
            background: dragging ? 'var(--accent-50)' : 'var(--stone-100)',
            cursor: 'pointer',
            transition: 'all var(--transition-base)',
          }}
        >
          {/* Upload icon */}
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke={dragging ? 'var(--accent-500)' : 'var(--stone-400)'}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <span
            style={{
              fontSize: 'var(--text-sm)',
              color: dragging ? 'var(--accent-600)' : 'var(--stone-500)',
              fontWeight: 'var(--weight-medium)' as any,
            }}
          >
            Drop files or click to upload
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openLibrary();
            }}
            style={{
              marginTop: '4px',
              fontSize: 'var(--text-xs)',
              fontWeight: 500,
              color: 'var(--accent-600)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              textDecoration: 'underline',
              textUnderlineOffset: '2px',
            }}
          >
            or pick from Library
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={acceptAttr}
            multiple
            onChange={onFileChange}
            style={{ display: 'none' }}
          />
        </div>
      )}

      {atLimit && (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-warning-bg)',
            fontSize: 'var(--text-xs)',
            color: '#92400E',
          }}
        >
          Maximum of {MAX_FILES} files reached.
        </div>
      )}

      {/* Uploading indicators */}
      {uploading.map((u) => (
        <div
          key={u.localId}
          style={{
            position: 'relative',
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 12px',
            borderRadius: 'var(--radius-md)',
            border: 'none',
            background: u.status === 'error' ? 'var(--color-error-bg)' : 'var(--surface-card)',
            fontSize: 'var(--text-sm)',
          }}
        >
          {u.status === 'uploading' && <Spinner size="sm" />}
          {u.status === 'done' && (
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="var(--color-success)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="3 8 6.5 11.5 13 4.5" />
            </svg>
          )}
          {u.status === 'error' && (
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="var(--color-error)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          )}
          <span style={{ flex: 1, color: u.status === 'error' ? '#991B1B' : 'var(--stone-700)', minWidth: 0 }}>
            {u.status === 'error' && u.error ? (
              <>
                <span style={{ fontWeight: 500 }}>{u.error}</span>
                <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: '#B91C1C', marginTop: '2px' }}>{u.fileName}</span>
              </>
            ) : u.fileName}
          </span>
          {u.status === 'uploading' && (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', fontVariantNumeric: 'tabular-nums' }}>
              {u.progress}%
            </span>
          )}
          {u.status === 'error' && (
            <button
              type="button"
              onClick={() => dismissError(u.localId)}
              style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--color-error)',
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              Dismiss
            </button>
          )}
          {/* Progress bar */}
          {u.status !== 'error' && (
            <div
              style={{
                position: 'absolute',
                left: 0,
                bottom: 0,
                height: '2px',
                width: `${u.progress}%`,
                background: 'var(--accent-500)',
                transition: 'width var(--transition-base)',
              }}
            />
          )}
        </div>
      ))}

      {/* Thumbnails of uploaded files */}
      {mediaFiles.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
          {mediaFiles.map((file, idx) => (
            <div
              key={file.id}
              draggable
              onDragStart={() => onThumbDragStart(idx)}
              onDragOver={(e) => onThumbDragOver(e, idx)}
              onDrop={(e) => onThumbDrop(e, idx)}
              onDragEnd={onThumbDragEnd}
              style={{
                position: 'relative',
                width: '96px',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                cursor: 'grab',
                opacity: dragSrcIdx.current === idx ? 0.4 : 1,
                transition: 'opacity 150ms, transform 150ms',
                transform: dragOverIdx === idx ? 'scale(1.05)' : 'none',
              }}
            >
              {/* Drop indicator */}
              {dragOverIdx === idx && dragSrcIdx.current !== null && dragSrcIdx.current !== idx && (
                <div style={{
                  position: 'absolute',
                  left: '-6px',
                  top: 0,
                  bottom: '28px',
                  width: '3px',
                  borderRadius: '2px',
                  background: 'var(--accent-500)',
                  zIndex: 3,
                }} />
              )}
              {/* Thumbnail */}
              <div
                style={{
                  width: '96px',
                  height: '96px',
                  borderRadius: 'var(--radius-md)',
                  overflow: 'hidden',
                  border: 'none',
                  background: 'var(--stone-100)',
                  position: 'relative',
                }}
              >
                {/* Order badge */}
                {mediaFiles.length > 1 && (
                  <span style={{
                    position: 'absolute',
                    top: '4px',
                    left: '4px',
                    width: '18px',
                    height: '18px',
                    borderRadius: '50%',
                    background: 'rgba(0,0,0,0.55)',
                    color: '#fff',
                    fontSize: '10px',
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 2,
                    lineHeight: 1,
                  }}>{idx + 1}</span>
                )}
                {(file.mimeType ?? '').startsWith('image') ? (
                  <img
                    src={file.thumbnailPath || file.originalPath}
                    alt={file.fileName}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : file.thumbnailPath ? (
                  <img
                    src={file.thumbnailPath}
                    alt={file.fileName}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <>
                    <video
                      src={file.originalPath}
                      muted
                      playsInline
                      preload="metadata"
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                    {/* Play icon overlay */}
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'rgba(0,0,0,0.2)',
                      }}
                    >
                      <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="rgba(255,255,255,0.9)"
                        stroke="none"
                      >
                        <polygon points="8,5 19,12 8,19" />
                      </svg>
                    </div>
                  </>
                )}

                {/* Remove button */}
                <button
                  type="button"
                  onClick={() => removeFile(file.id)}
                  style={{
                    position: 'absolute',
                    top: '4px',
                    right: '4px',
                    width: '20px',
                    height: '20px',
                    borderRadius: '50%',
                    background: 'rgba(0,0,0,0.55)',
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    fontSize: '12px',
                    lineHeight: 1,
                    border: 'none',
                  }}
                  title="Remove"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="#fff"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <line x1="2" y1="2" x2="10" y2="10" />
                    <line x1="10" y1="2" x2="2" y2="10" />
                  </svg>
                </button>

                {/* Zoom — view the full image (mirrors the remove button exactly) */}
                {(file.mimeType ?? '').startsWith('image') && (
                  <button
                    type="button"
                    onClick={() => setLightboxUrl(file.originalPath)}
                    title="View full image"
                    aria-label="View full image"
                    style={{
                      position: 'absolute',
                      top: '28px',
                      right: '4px',
                      width: '20px',
                      height: '20px',
                      borderRadius: '50%',
                      background: 'rgba(0,0,0,0.55)',
                      color: '#fff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'zoom-in',
                      fontSize: '12px',
                      lineHeight: 1,
                      border: 'none',
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="5" cy="5" r="3.25" />
                      <line x1="7.7" y1="7.7" x2="10.5" y2="10.5" />
                    </svg>
                  </button>
                )}
              </div>

              {/* File info */}
              <span
                style={{
                  fontSize: 'var(--text-xs)',
                  color: 'var(--stone-600)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={file.fileName}
              >
                {file.fileName}
              </span>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>
                {formatBytes(file.sizeBytes)} &middot; {shortMime(file.mimeType ?? 'unknown')}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Library picker dialog */}
      <Dialog
        open={showLibrary}
        onClose={() => setShowLibrary(false)}
        title="Add Media"
        description="Upload or pick from your library."
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
            accept={acceptAttr}
            multiple
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
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="var(--stone-400)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
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

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
                gap: '12px',
                maxHeight: '340px',
                overflowY: 'auto',
                padding: '4px',
              }}
            >
              {libraryItems.filter((raw) => {
                if (!librarySearch) return true;
                const name = (raw.fileName ?? raw.file_name ?? '').toLowerCase();
                return name.includes(librarySearch.toLowerCase());
              }).map((raw) => {
                const isAlreadyAttached = mediaFiles.some((f) => f.id === raw.id);
                const isOriginalDeleted = raw.isOriginalDeleted ?? raw.is_original_deleted ?? false;
                const isDisabled = isAlreadyAttached || isOriginalDeleted;
                const isSelected = librarySelected.has(raw.id);
                const mime = raw.mimeType ?? raw.mime_type ?? '';
                const isVideo = mime.startsWith('video');
                // Never the original for video — that's the whole media file.
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
                    onClick={() => {
                      if (!isDisabled) toggleLibraryItem(raw.id);
                    }}
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
                    <div
                      style={{
                        position: 'relative',
                        width: '100%',
                        aspectRatio: '1',
                        background: 'var(--stone-100)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        overflow: 'hidden',
                      }}
                    >
                      {displayUrl ? (
                        <img
                          src={displayUrl}
                          alt={raw.fileName ?? ''}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          loading="lazy"
                        />
                      ) : (
                        <svg width="28" height="28" viewBox="0 0 32 32" fill="none" stroke="var(--stone-300)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="4" y="4" width="24" height="24" rx="4" />
                          {isVideo ? <polygon points="13 11 21 16 13 21" /> : <circle cx="16" cy="16" r="5" />}
                        </svg>
                      )}

                      {/* Video indicator */}
                      {isVideo && displayUrl && (
                        <div style={{ position: 'absolute', top: '6px', left: '6px', display: 'flex', alignItems: 'center', gap: '3px', padding: '2px 6px', borderRadius: 'var(--radius-pill)', background: 'rgba(0,0,0,0.5)', color: '#fff', fontSize: '9px', fontWeight: 600 }}>
                          <svg width="8" height="8" viewBox="0 0 8 8" fill="#fff"><polygon points="2 1 7 4 2 7" /></svg>
                          Video
                        </div>
                      )}

                      {/* Selection checkmark */}
                      {isSelected && (
                        <div style={{ position: 'absolute', top: '6px', right: '6px', width: '22px', height: '22px', borderRadius: '50%', background: 'var(--accent-500)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="2.5 6 5 8.5 9.5 3.5" />
                          </svg>
                        </div>
                      )}

                      {/* Already attached badge */}
                      {isAlreadyAttached && (
                        <div style={{ position: 'absolute', bottom: '6px', right: '6px', display: 'flex', alignItems: 'center', gap: '3px', padding: '2px 6px', borderRadius: 'var(--radius-pill)', background: 'rgba(0,0,0,0.5)', color: '#fff', fontSize: '9px', fontWeight: 600, whiteSpace: 'nowrap' }}>
                          Added
                        </div>
                      )}
                      {/* Original deleted badge */}
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
                <Button variant="secondary" size="sm" onClick={() => setShowLibrary(false)}>
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

      {/* Full-image lightbox (click backdrop / ✕ / Esc to close) */}
      {lightboxUrl && createPortal(
        <div
          onClick={() => setLightboxUrl(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', cursor: 'zoom-out' }}
        >
          <img
            src={lightboxUrl}
            alt=""
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: 'var(--radius-md)', boxShadow: '0 20px 60px -10px rgba(0,0,0,0.5)' }}
          />
          <button
            type="button"
            onClick={() => setLightboxUrl(null)}
            aria-label="Close"
            style={{ position: 'fixed', top: '20px', right: '24px', width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(0,0,0,0.6)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}
          >
            ✕
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
