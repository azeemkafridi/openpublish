import React, { useCallback, useRef, useState } from 'react';
import { Dialog } from '@components/ui/Dialog';
import { uploadMediaFile } from '@/lib/media/upload-client';

/**
 * Cover/thumbnail image picker shared by the platform option sections that
 * accept a still image alongside a video (Pinterest video-pin cover, YouTube
 * thumbnail, Reddit video thumbnail).
 *
 * The platformSpecific contract stays a plain URL string — this component is
 * only a nicer way to produce one: upload a file (it lands in the Media
 * Library, auto-tagged with a "Covers" media label) or pick an existing
 * library image. A visible URL input remains for pasting external links,
 * which is also what API callers send.
 */

interface LibraryItem {
  id: number;
  fileName: string;
  mimeType: string;
  originalUrl: string;
  thumbnailUrl?: string | null;
  previewUrl?: string | null;
  largeUrl?: string | null;
  isOriginalDeleted?: boolean | null;
}

interface CoverImagePickerProps {
  value: string;
  onChange: (url: string) => void;
  /** Placeholder for the URL input, e.g. "https://example.com/cover.jpg" */
  placeholder?: string;
}

const COVER_LABEL_NAME = 'Covers';

/**
 * Find-or-create the "Covers" media label and attach it to the uploaded file,
 * merging with any labels it already has. Organizational sugar only — a
 * failure here must never break the upload, so callers fire-and-forget.
 */
async function tagAsCover(mediaId: number): Promise<void> {
  try {
    const listRes = await fetch('/api/labels?type=media');
    if (!listRes.ok) return;
    const listJson = await listRes.json();
    const existing = (listJson.labels ?? listJson ?? []) as Array<{ id: number; name: string }>;
    let label = Array.isArray(existing)
      ? existing.find((l) => l.name.toLowerCase() === COVER_LABEL_NAME.toLowerCase())
      : undefined;

    if (!label) {
      const createRes = await fetch('/api/labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: COVER_LABEL_NAME, type: 'media' }),
      });
      if (createRes.ok) {
        const created = await createRes.json();
        label = created.label ?? created;
      } else if (createRes.status === 409) {
        // Concurrent upload created it between our list and this POST — re-read.
        const retryRes = await fetch('/api/labels?type=media');
        if (!retryRes.ok) return;
        const retryJson = await retryRes.json();
        const retryList = (retryJson.labels ?? retryJson ?? []) as Array<{ id: number; name: string }>;
        label = Array.isArray(retryList)
          ? retryList.find((l) => l.name.toLowerCase() === COVER_LABEL_NAME.toLowerCase())
          : undefined;
      } else {
        return;
      }
    }
    if (!label?.id) return;

    // PUT replaces all labels — merge with what the file already carries.
    // (GET returns a bare array of { id, name, color }.)
    const currentRes = await fetch(`/api/media/${mediaId}/labels`);
    const current = currentRes.ok ? await currentRes.json() : [];
    const currentIds: number[] = (Array.isArray(current) ? current : []).map((l: { id: number }) => l.id);
    const merged = [...new Set([...currentIds, label.id])];

    await fetch(`/api/media/${mediaId}/labels`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelIds: merged }),
    });
  } catch {
    // Tagging is best-effort; the cover URL is already set.
  }
}

export function CoverImagePicker({ value, onChange, placeholder }: CoverImagePickerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);

  const handleFile = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) {
      setUploadError('Cover must be an image.');
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const uploaded = await uploadMediaFile(file);
      onChange(uploaded.originalUrl);
      // Organizational tag in the library — never blocks the picked cover.
      void tagAsCover(uploaded.id);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, [onChange]);

  const openLibrary = useCallback(async () => {
    setShowLibrary(true);
    setLibraryLoading(true);
    try {
      const res = await fetch('/api/media?limit=50');
      const json = res.ok ? await res.json() : { files: [] };
      const files = (json.files ?? json ?? []) as LibraryItem[];
      // Images only, and skip swept originals — their originalUrl is dead.
      setLibraryItems(files.filter((f) => f.mimeType?.startsWith('image/') && !f.isOriginalDeleted));
    } catch {
      setLibraryItems([]);
    } finally {
      setLibraryLoading(false);
    }
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        {value && (
          <img
            src={value}
            alt="Cover preview"
            style={{
              width: '48px',
              height: '48px',
              objectFit: 'cover',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--stone-200)',
              flexShrink: 0,
            }}
          />
        )}
        <button
          type="button"
          className="btn btn-secondary"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
          style={{ fontSize: 'var(--text-xs)', padding: '6px 10px' }}
        >
          {uploading ? 'Uploading…' : 'Upload image'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={openLibrary}
          style={{ fontSize: 'var(--text-xs)', padding: '6px 10px' }}
        >
          From Library
        </button>
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--stone-400)', fontSize: 'var(--text-xs)', padding: '4px' }}
          >
            Remove
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = '';
          }}
        />
      </div>

      <input
        className="input"
        type="url"
        placeholder={placeholder ?? 'https://example.com/cover.jpg'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ fontSize: 'var(--text-sm)' }}
      />

      {uploadError && (
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-error)' }}>{uploadError}</span>
      )}

      <Dialog
        open={showLibrary}
        onClose={() => setShowLibrary(false)}
        title="Choose a cover image"
        description="Pick an image from your media library."
        size="lg"
      >
        {libraryLoading ? (
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>Loading media…</span>
        ) : libraryItems.length === 0 ? (
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>No images in your library yet.</span>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: '8px', maxHeight: '50vh', overflowY: 'auto' }}>
            {libraryItems.map((item) => (
              <button
                key={item.id}
                type="button"
                title={item.fileName}
                onClick={() => {
                  onChange(item.originalUrl);
                  setShowLibrary(false);
                }}
                style={{ padding: 0, border: '1px solid var(--stone-200)', borderRadius: 'var(--radius-md)', overflow: 'hidden', cursor: 'pointer', background: 'none', aspectRatio: '1' }}
              >
                <img
                  src={item.thumbnailUrl || item.previewUrl || item.largeUrl || item.originalUrl}
                  alt={item.fileName}
                  loading="lazy"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              </button>
            ))}
          </div>
        )}
      </Dialog>
    </div>
  );
}
