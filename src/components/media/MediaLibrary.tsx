import { useState, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { mediaImageUrl, resolvePreviewSource, type MediaLike } from '@lib/media/display';
import { useApi } from '@lib/swr';
import { Spinner } from '../ui/Spinner';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { MediaPreview } from '../ui/MediaPreview';
import { useQueryState } from '@lib/useQueryState';
import { LabelDropdown, type Label as MediaLabel } from '../labels/LabelDropdown';
import { uploadMediaFile } from '@lib/media/upload-client';

/** MediaLibrary carries its own snake_case shape — adapt it for the URL picker. */
function asMediaLike(item: {
  type?: 'image' | 'video';
  url?: string;
  thumbnail_url?: string;
  preview_url?: string;
  large_url?: string;
  is_original_deleted?: boolean;
} | null | undefined): MediaLike {
  return {
    mimeType: item?.type === 'video' ? 'video/mp4' : 'image/jpeg',
    originalUrl: item?.url,
    thumbnailUrl: item?.thumbnail_url,
    previewUrl: item?.preview_url,
    largeUrl: item?.large_url,
    isOriginalDeleted: item?.is_original_deleted,
  };
}

interface MediaItem {
  id: string;
  filename: string;
  url: string;
  thumbnail_url?: string;
  preview_url?: string;
  large_url?: string;
  type: 'image' | 'video';
  size: number;
  width?: number;
  height?: number;
  is_original_deleted?: boolean;
  created_at: string;
  labels: MediaLabel[];
}

type FilterType = 'all' | 'image' | 'video';

interface UploadProgress {
  localId: string;
  fileName: string;
  progress: number;
  status: 'uploading' | 'error';
  error?: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

const FILTER_CHIPS: Array<{ label: string; value: FilterType }> = [
  { label: 'All', value: 'all' },
  { label: 'Images', value: 'image' },
  { label: 'Videos', value: 'video' },
];

export default function MediaLibrary() {
  const [filter, setFilterParam] = useQueryState<FilterType>('type', 'all');
  const [deleteTarget, setDeleteTarget] = useState<MediaItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const uploadIdRef = useRef(0);
  const [previewTarget, setPreviewTarget] = useState<MediaItem | null>(null);
  // A swept video keeps only its poster — resolvePreviewSource presents that as
  // an image so the poster URL never lands inside a <video src>.
  const libraryPreview = resolvePreviewSource(asMediaLike(previewTarget));
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedLabelIds, setSelectedLabelIds] = useState<number[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(search);
    }, 350);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [search]);

  // Server-driven pagination. The API caps limit at 100, so the library used
  // to show at most 100 files (and a count stuck at 100) no matter how many
  // exist — pages accumulate here and `total` comes from the API.
  const [pageNum, setPageNum] = useState(1);
  const [loadedPages, setLoadedPages] = useState<Map<number, MediaItem[]>>(new Map());

  const _mediaParams = new URLSearchParams();
  _mediaParams.set('limit', '100');
  _mediaParams.set('page', String(pageNum));
  if (debouncedSearch) _mediaParams.set('search', debouncedSearch);
  if (selectedLabelIds.length > 0) _mediaParams.set('labelIds', selectedLabelIds.join(','));
  // Type filtering is server-side — client-side filtering only covered the
  // fetched page, silently hiding matches beyond it.
  if (filter !== 'all') _mediaParams.set('type', filter);
  const { data: _rawMedia, error: _mediaErr, isLoading: loading, mutate: mutateMedia } = useApi<any>(
    `/api/media?${_mediaParams}`,
  );
  const total: number | null = typeof _rawMedia?.total === 'number' ? _rawMedia.total : null;
  const [actionError, setActionError] = useState<string | null>(null);
  const error = actionError ?? _mediaErr?.message ?? null;

  // Any filter change restarts the listing from page 1.
  const filterKey = `${debouncedSearch}|${selectedLabelIds.join(',')}|${filter}`;
  useEffect(() => {
    setPageNum(1);
    setLoadedPages(new Map());
  }, [filterKey]);

  function setFilter(next: FilterType) {
    setFilterParam(next);
  }

  const media: MediaItem[] = useMemo(() => {
    if (!_rawMedia) return [];
    const rawList = Array.isArray(_rawMedia) ? _rawMedia : Array.isArray(_rawMedia?.files) ? _rawMedia.files : Array.isArray(_rawMedia?.media) ? _rawMedia.media : [];
    return rawList.map((raw: any) => ({
      id: String(raw.id ?? raw._id ?? ''),
      filename: raw.filename ?? raw.fileName ?? raw.file_name ?? '',
      url: raw.url ?? raw.originalUrl ?? raw.original_url ?? '',
      thumbnail_url: raw.thumbnail_url ?? raw.thumbnailUrl ?? undefined,
      preview_url: raw.preview_url ?? raw.previewUrl ?? undefined,
      large_url: raw.large_url ?? raw.largeUrl ?? undefined,
      type: (raw.type ?? ((raw.mimeType ?? raw.mime_type ?? '').startsWith('video') ? 'video' : 'image')) as 'image' | 'video',
      size: raw.size ?? raw.sizeBytes ?? raw.size_bytes ?? 0,
      width: raw.width,
      height: raw.height,
      is_original_deleted: raw.is_original_deleted ?? raw.isOriginalDeleted ?? false,
      created_at: raw.created_at ?? raw.createdAt ?? '',
      labels: raw.labels ?? [],
    }));
  }, [_rawMedia]);

  // Stash the fetched page, then flatten every loaded page in order.
  useEffect(() => {
    if (!_rawMedia) return;
    setLoadedPages((prev) => {
      const next = new Map(prev);
      next.set(pageNum, media);
      return next;
    });
  }, [_rawMedia]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredMedia = useMemo(() => {
    const seen = new Set<string>();
    const out: MediaItem[] = [];
    for (const key of [...loadedPages.keys()].sort((a, b) => a - b)) {
      for (const item of loadedPages.get(key)!) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          out.push(item);
        }
      }
    }
    return out;
  }, [loadedPages]);
  const hasMore = total !== null && filteredMedia.length < total;

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setActionError(null);

    // Compress + upload each file directly to storage with live progress.
    await Promise.all(
      Array.from(files).map(async (file) => {
        const localId = `up-${++uploadIdRef.current}`;
        setUploads((prev) => [...prev, { localId, fileName: file.name, progress: 0, status: 'uploading' }]);
        try {
          await uploadMediaFile(file, {
            onProgress: (progress) =>
              setUploads((prev) => prev.map((u) => (u.localId === localId ? { ...u, progress } : u))),
          });
          setUploads((prev) => prev.filter((u) => u.localId !== localId));
        } catch (err: any) {
          setUploads((prev) =>
            prev.map((u) => (u.localId === localId ? { ...u, status: 'error', error: err.message ?? 'Upload failed' } : u)),
          );
        }
      }),
    );

    setPageNum(1);
    setLoadedPages(new Map());
    mutateMedia(undefined, { revalidate: true });
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  const isUploading = uploads.some((u) => u.status === 'uploading');
  const dismissUpload = (localId: string) => setUploads((prev) => prev.filter((u) => u.localId !== localId));

  async function deleteMedia(id: string) {
    setDeleting(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/media/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
      if (!res.ok) throw new Error('Failed to delete media');
      setDeleteTarget(null);
      setPageNum(1);
      setLoadedPages(new Map());
      mutateMedia(undefined, { revalidate: true });
    } catch (err: any) {
      setActionError(err.message ?? 'Failed to delete');
    } finally {
      setDeleting(false);
    }
  }

  // Label management for preview dialog
  const [previewLabels, setPreviewLabels] = useState<number[]>([]);
  const [savingLabels, setSavingLabels] = useState(false);

  useEffect(() => {
    if (previewTarget) {
      setPreviewLabels(previewTarget.labels.map((l) => l.id));
    }
  }, [previewTarget]);

  const previewLabelsChanged = useMemo(() => {
    if (!previewTarget) return false;
    const current = new Set(previewTarget.labels.map((l) => l.id));
    if (current.size !== previewLabels.length) return true;
    return previewLabels.some((id) => !current.has(id));
  }, [previewTarget, previewLabels]);

  async function saveMediaLabels() {
    if (!previewTarget) return;
    setSavingLabels(true);
    try {
      const res = await fetch(`/api/media/${previewTarget.id}/labels`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labelIds: previewLabels }),
      });
      if (!res.ok) throw new Error('Failed to save labels');
      mutateMedia(undefined, { revalidate: true });
      setPreviewTarget(null);
    } catch (err: any) {
      setActionError(err.message ?? 'Failed to save labels');
    } finally {
      setSavingLabels(false);
    }
  }

  // -- Styles --

  const toolbarStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '20px',
    flexWrap: 'wrap',
    gap: '12px',
  };

  const filterRowStyle: CSSProperties = {
    display: 'flex',
    gap: '4px',
  };

  const gridStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: '16px',
  };

  const mediaCardStyle: CSSProperties = {
    borderRadius: 'var(--radius-lg)',
    background: 'var(--surface-card)',
    overflow: 'hidden',
    transition: 'background var(--transition-base)',
  };

  const thumbnailContainerStyle: CSSProperties = {
    width: '100%',
    aspectRatio: '4 / 3',
    background: 'var(--stone-100)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
  };

  const thumbnailStyle: CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  };

  const cardInfoStyle: CSSProperties = {
    padding: '10px 12px',
  };

  const filenameStyle: CSSProperties = {
    fontSize: 'var(--text-sm)',
    fontWeight: 500,
    color: 'var(--stone-700)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    marginBottom: '4px',
  };

  const metaStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
  };

  const sizeStyle: CSSProperties = {
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-400)',
  };

  const typeBadgeStyle = (type: string): CSSProperties => ({
    fontSize: '10px',
    fontWeight: 600,
    padding: '2px 6px',
    borderRadius: 'var(--radius-pill)',
    background: type === 'video' ? 'var(--color-info-bg)' : 'var(--color-success-bg)',
    color: type === 'video' ? '#1E40AF' : '#065F46',
    textTransform: 'uppercase',
    letterSpacing: 'var(--tracking-wider)',
  });

  const deletedIndicatorStyle: CSSProperties = {
    position: 'absolute',
    top: '8px',
    left: '8px',
    fontSize: '10px',
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 'var(--radius-pill)',
    background: 'rgba(239, 68, 68, 0.9)',
    color: '#FFFFFF',
  };

  const deleteOverlayBtnStyle: CSSProperties = {
    position: 'absolute',
    top: '8px',
    right: '8px',
    width: '28px',
    height: '28px',
    borderRadius: 'var(--radius-md)',
    background: 'rgba(28, 25, 23, 0.6)',
    color: '#FFFFFF',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    opacity: 0,
    transition: 'opacity var(--transition-fast), color var(--transition-fast)',
  };

  const videoOverlayStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  };

  // Only show full-page spinner on initial load (no data yet)
  if (loading && media.length === 0 && !debouncedSearch) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div style={{ animation: 'fadeInUp 500ms cubic-bezier(0.4, 0, 0.2, 1) both' }}>
      {/* Error */}
      {error && (
        <div style={{
          padding: '12px 16px',
          background: 'var(--color-error-bg)',
          color: '#991B1B',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--text-sm)',
          marginBottom: '16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            style={{ color: '#991B1B', fontWeight: 600, cursor: 'pointer', fontSize: 'var(--text-xs)' }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div style={toolbarStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          {/* Search */}
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
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
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ paddingLeft: '32px', width: '220px', height: 'var(--control-height-sm)', fontSize: 'var(--text-sm)', border: '2px solid var(--surface-card)' }}
            />
          </div>

          {/* Type Filters */}
          <div style={filterRowStyle}>
            {FILTER_CHIPS.map((chip) => (
              <button
                key={chip.value}
                type="button"
                className={filter === chip.value ? 'btn btn-active btn-sm' : 'btn btn-ghost btn-sm'}
                onClick={() => setFilter(chip.value)}
              >
                {chip.label}
                {filter === chip.value && total !== null && ` (${total})`}
              </button>
            ))}
          </div>

          <LabelDropdown labelType="media" selectedIds={selectedLabelIds} onChange={setSelectedLabelIds} />
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*"
            multiple
            onChange={(e) => handleUpload(e.target.files)}
            style={{ display: 'none' }}
          />
          <Button
            variant="primary"
            size="sm"
            loading={isUploading}
            onClick={() => fileInputRef.current?.click()}
            icon={
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="7" y1="2" x2="7" y2="12" />
                <line x1="2" y1="7" x2="12" y2="7" />
              </svg>
            }
          >
            Upload
          </Button>
        </div>
      </div>

      {/* Uploads in progress */}
      {uploads.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
          {uploads.map((u) => (
            <div
              key={u.localId}
              style={{
                position: 'relative',
                overflow: 'hidden',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '10px 14px',
                borderRadius: 'var(--radius-md)',
                background: u.status === 'error' ? 'var(--color-error-bg)' : 'var(--surface-card)',
                fontSize: 'var(--text-sm)',
              }}
            >
              {u.status === 'uploading' ? (
                <Spinner size="sm" />
              ) : (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--color-error)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="4" y1="4" x2="12" y2="12" />
                  <line x1="12" y1="4" x2="4" y2="12" />
                </svg>
              )}
              <span style={{ flex: 1, minWidth: 0, color: u.status === 'error' ? '#991B1B' : 'var(--stone-700)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {u.status === 'error' ? (u.error ?? 'Upload failed') : u.fileName}
              </span>
              {u.status === 'uploading' && (
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', fontVariantNumeric: 'tabular-nums' }}>{u.progress}%</span>
              )}
              {u.status === 'error' && (
                <button type="button" onClick={() => dismissUpload(u.localId)} style={{ fontSize: 'var(--text-xs)', color: 'var(--color-error)', cursor: 'pointer', textDecoration: 'underline' }}>
                  Dismiss
                </button>
              )}
              {u.status === 'uploading' && (
                <div style={{ position: 'absolute', left: 0, bottom: 0, height: '2px', width: `${u.progress}%`, background: 'var(--accent-500)', transition: 'width var(--transition-base)' }} />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Grid */}
      {filteredMedia.length === 0 ? (
        <div style={{
          padding: '80px 32px',
          textAlign: 'center',
          background: 'var(--surface-card)',
          borderRadius: 'var(--radius-lg)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '16px',
        }}>
          <div style={{
            width: '80px',
            height: '80px',
            borderRadius: '50%',
            background: 'var(--stone-100)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <svg
              width="36"
              height="36"
              viewBox="0 0 40 40"
              fill="none"
              stroke="var(--stone-400)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="4" y="6" width="32" height="28" rx="4" />
              <circle cx="15" cy="17" r="4" />
              <polyline points="36 28 26 18 12 34" />
            </svg>
          </div>
          <div>
            <p style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--stone-700)', marginBottom: '4px' }}>
              {filter === 'all' ? 'No media files yet' : `No ${filter}s found`}
            </p>
            <p style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-400)', lineHeight: 'var(--leading-relaxed)' }}>
              {filter === 'all'
                ? 'Upload images and videos to use in your posts.'
                : 'Try changing the filter or upload new files.'}
            </p>
          </div>
          {filter === 'all' && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              }
            >
              Upload Media
            </Button>
          )}
        </div>
      ) : (
        <div className="r-media-grid" style={gridStyle}>
          {filteredMedia.map((item) => (
            <div
              key={item.id}
              style={{ ...mediaCardStyle, cursor: 'pointer' }}
              onClick={() => setPreviewTarget(item)}
              onMouseOver={(e) => {
                e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
                e.currentTarget.style.borderColor = 'var(--border-default)';
                const delBtn = e.currentTarget.querySelector<HTMLElement>('[data-delete-btn]');
                if (delBtn) delBtn.style.opacity = '1';
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.boxShadow = 'var(--shadow-xs)';
                e.currentTarget.style.borderColor = 'var(--border-subtle)';
                const delBtn = e.currentTarget.querySelector<HTMLElement>('[data-delete-btn]');
                if (delBtn) delBtn.style.opacity = '0';
              }}
            >
              {/* Thumbnail */}
              <div style={thumbnailContainerStyle}>
                {item.type === 'image' && mediaImageUrl(asMediaLike(item), 'preview') ? (
                  <img
                    src={mediaImageUrl(asMediaLike(item), 'preview')!}
                    alt={item.filename}
                    style={thumbnailStyle}
                    loading="lazy"
                  />
                ) : (
                  <>
                    {mediaImageUrl(asMediaLike(item), 'preview') ? (
                      <img
                        src={mediaImageUrl(asMediaLike(item), 'preview')!}
                        alt={item.filename}
                        style={thumbnailStyle}
                        loading="lazy"
                      />
                    ) : (
                      <svg
                        width="32"
                        height="32"
                        viewBox="0 0 32 32"
                        fill="none"
                        stroke="var(--stone-300)"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <rect x="4" y="4" width="24" height="24" rx="4" />
                        <polygon points="13 11 21 16 13 21" />
                      </svg>
                    )}
                    <div style={videoOverlayStyle}>
                      <div style={{
                        width: '36px',
                        height: '36px',
                        borderRadius: '50%',
                        background: 'rgba(0,0,0,0.5)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}>
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="#FFFFFF">
                          <polygon points="4 2 12 7 4 12" />
                        </svg>
                      </div>
                    </div>
                  </>
                )}

                {item.is_original_deleted && (
                  <span style={deletedIndicatorStyle}>Original deleted</span>
                )}

                {/* Delete button overlay */}
                <button
                  type="button"
                  data-delete-btn
                  style={deleteOverlayBtnStyle}
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteTarget(item);
                  }}
                  onMouseOver={(e) => (e.currentTarget.style.color = 'var(--color-error)')}
                  onMouseOut={(e) => (e.currentTarget.style.color = '#FFFFFF')}
                  aria-label={`Delete ${item.filename}`}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1.5 3.5h11" />
                    <path d="M4.5 3.5V2.5a1 1 0 011-1h3a1 1 0 011 1v1" />
                    <path d="M11 3.5l-.5 8a1 1 0 01-1 1h-5a1 1 0 01-1-1l-.5-8" />
                    <line x1="5.5" y1="6" x2="5.5" y2="10" />
                    <line x1="8.5" y1="6" x2="8.5" y2="10" />
                  </svg>
                </button>
              </div>

              {/* Info */}
              <div style={cardInfoStyle}>
                <div style={filenameStyle} title={item.filename}>
                  {item.filename}
                </div>
                <div style={metaStyle}>
                  <span style={sizeStyle}>{formatFileSize(item.size)}</span>
                  <span style={typeBadgeStyle(item.type)}>{item.type}</span>
                </div>
                {/* Label dots */}
                {item.labels.length > 0 && (
                  <div style={{ display: 'flex', gap: '4px', marginTop: '6px', flexWrap: 'wrap' }}>
                    {item.labels.map((lbl) => (
                      <span
                        key={lbl.id}
                        title={lbl.name}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          padding: '1px 6px',
                          borderRadius: 'var(--radius-pill)',
                          background: `${lbl.color}15`,
                          fontSize: '10px',
                          color: lbl.color,
                          fontWeight: 500,
                        }}
                      >
                        <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: lbl.color, flexShrink: 0 }} />
                        {lbl.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Load more — the API pages at 100; total is the real library size */}
      {hasMore && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: '20px' }}>
          <Button
            variant="secondary"
            size="sm"
            loading={loading}
            onClick={() => setPageNum((p) => p + 1)}
          >
            Load more ({filteredMedia.length} of {total})
          </Button>
        </div>
      )}

      {/* Delete Confirmation */}
      <Dialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete Media"
        description={`Are you sure you want to delete "${deleteTarget?.filename}"? This action cannot be undone. Posts using this media will no longer display it.`}
        size="sm"
      >
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '8px' }}>
          <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={deleting}
            onClick={() => deleteTarget && deleteMedia(deleteTarget.id)}
          >
            Delete
          </Button>
        </div>
      </Dialog>

      {/* Preview Dialog */}
      <MediaPreview
        open={!!previewTarget}
        onClose={() => setPreviewTarget(null)}
        url={libraryPreview.url}
        posterUrl={libraryPreview.posterUrl}
        mimeType={libraryPreview.mimeType}
        fileName={previewTarget?.filename}
        width={previewTarget?.width}
        height={previewTarget?.height}
        sizeBytes={previewTarget?.size}
        createdAt={previewTarget?.created_at}
        isPreviewOnly={libraryPreview.isPreviewOnly}
      >
        {/* Labels section */}
        <div style={{ borderTop: '1px solid var(--stone-100)', paddingTop: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <LabelDropdown labelType="media" selectedIds={previewLabels} onChange={setPreviewLabels} triggerLabel="Add or remove labels" />
            {previewLabelsChanged && (
              <button type="button" className="btn btn-primary btn-sm" disabled={savingLabels} onClick={saveMediaLabels}>
                {savingLabels ? 'Saving...' : 'Save'}
              </button>
            )}
          </div>
        </div>
      </MediaPreview>
    </div>
  );
}
