import { Dialog } from './Dialog';
import type { ReactNode } from 'react';

export interface MediaPreviewProps {
  open: boolean;
  onClose: () => void;
  url: string;
  /** Frame shown before a video starts playing (generated poster). */
  posterUrl?: string;
  mimeType: string;
  fileName?: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  createdAt?: string;
  /** When true, original was deleted — renders compact horizontal layout */
  isPreviewOnly?: boolean;
  /** Slot for extra content below metadata (e.g. labels) */
  children?: ReactNode;
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1_048_576) return (bytes / 1_048_576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

function typeBadge(type: string): React.CSSProperties {
  return {
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    padding: '2px 8px',
    borderRadius: 'var(--radius-sm)',
    background: type === 'video' ? '#EEF2FF' : 'var(--accent-50, #FFF7ED)',
    color: type === 'video' ? '#6366F1' : 'var(--accent-600, #EA580C)',
  };
}

/**
 * Unified media preview dialog used across the webapp.
 *
 * Two layouts:
 * - **Original exists** (`isPreviewOnly=false`): vertical — large image top, metadata below
 * - **Original deleted** (`isPreviewOnly=true`): horizontal — smaller preview left, details right
 */
export function MediaPreview({
  open,
  onClose,
  url,
  posterUrl,
  mimeType,
  fileName,
  width,
  height,
  sizeBytes,
  createdAt,
  isPreviewOnly,
  children,
}: MediaPreviewProps) {
  const isVideo = mimeType?.startsWith('video');
  const type = isVideo ? 'video' : 'image';

  const metadata = (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
      <span style={typeBadge(type)}>{type}</span>
      {sizeBytes != null && sizeBytes > 0 && (
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-500)' }}>
          {formatFileSize(sizeBytes)}
        </span>
      )}
      {width && height && (
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-400)' }}>
          {width} &times; {height}
        </span>
      )}
      {mimeType && (
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>
          {mimeType}
        </span>
      )}
      {createdAt && (
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>
          {new Date(createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
      )}
    </div>
  );

  // Horizontal layout — preview-only (original deleted)
  if (isPreviewOnly) {
    return (
      <Dialog open={open} onClose={onClose} title={fileName || 'Preview'} size="md">
        <div style={{ display: 'flex', gap: '20px', alignItems: 'flex-start' }}>
          {/* Smaller preview on the left */}
          <div style={{ flexShrink: 0, borderRadius: 'var(--radius-md)', overflow: 'hidden', background: 'var(--stone-50)' }}>
            {isVideo ? (
              <video
                src={url}
                poster={posterUrl}
                controls
                preload="metadata"
                style={{ width: '200px', maxHeight: '200px', objectFit: 'contain', display: 'block' }}
              />
            ) : (
              <img
                src={url}
                alt={fileName || ''}
                style={{ width: '200px', maxHeight: '200px', objectFit: 'contain', display: 'block' }}
              />
            )}
          </div>

          {/* Details on the right */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{
              fontSize: 'var(--text-xs)',
              fontWeight: 600,
              color: 'var(--color-error)',
              background: 'var(--color-error-bg)',
              padding: '4px 10px',
              borderRadius: 'var(--radius-sm)',
              width: 'fit-content',
            }}>
              Original deleted
            </div>
            {fileName && (
              <p style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--stone-700)', margin: 0, wordBreak: 'break-all' }}>
                {fileName}
              </p>
            )}
            {metadata}
            {children}
          </div>
        </div>
      </Dialog>
    );
  }

  // Vertical layout — original exists (default)
  return (
    <Dialog open={open} onClose={onClose} title={fileName || 'Preview'} size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'center', background: 'var(--stone-50)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          {isVideo ? (
            <video
              src={url}
              poster={posterUrl}
              controls
              autoPlay
              preload="metadata"
              style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }}
            />
          ) : (
            <img
              src={url}
              alt={fileName || ''}
              style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }}
            />
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
          {metadata}
        </div>
        {children}
      </div>
    </Dialog>
  );
}
