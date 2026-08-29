/**
 * Which stored derivative to show, per display size.
 *
 * Two rules this encodes, both of which caused real bugs:
 *
 * 1. **Never put a video's `originalUrl` in an `<img>`.** Videos have no
 *    intrinsic image; before poster generation existed the UI fell back to the
 *    original, so the browser downloaded an entire mp4 to render a 48px tile.
 *    That is what got Safari to kill the Overview page for memory.
 * 2. **Match the derivative to the box.** A 160px thumbnail stretched across a
 *    600px lightbox is visibly soft, and a 4000px original decoded into a 48px
 *    tile costs ~48MB of bitmap. Ask for the size you're rendering at.
 */

export interface MediaLike {
  mimeType?: string | null;
  originalUrl?: string | null;
  thumbnailUrl?: string | null;
  previewUrl?: string | null;
  largeUrl?: string | null;
  isOriginalDeleted?: boolean | null;
}

/**
 * - `thumb`   — list rows, cards, avatars (≤80px)
 * - `preview` — grids, uploader tiles (≤300px)
 * - `large`   — composer previews, analytics panes, lightboxes (≤600px)
 * - `full`    — the user explicitly opened this one item; best available
 */
export type MediaSize = 'thumb' | 'preview' | 'large' | 'full';

const isVideo = (m: MediaLike) => !!m.mimeType?.startsWith('video');

/**
 * Best still image for the given size, or null when there is nothing safe to
 * show (a video whose poster hasn't been generated). Callers render their
 * placeholder on null — never the original.
 */
export function mediaImageUrl(media: MediaLike | null | undefined, size: MediaSize): string | null {
  if (!media) return null;
  const { thumbnailUrl, previewUrl, largeUrl, originalUrl } = media;

  // A video's only still is a generated poster. No poster → no image.
  if (isVideo(media)) {
    switch (size) {
      case 'thumb':
        return thumbnailUrl || previewUrl || largeUrl || null;
      case 'preview':
        return previewUrl || largeUrl || thumbnailUrl || null;
      default:
        return largeUrl || previewUrl || thumbnailUrl || null;
    }
  }

  // Images may fall back to the original, but only where the byte cost is
  // justified: `full` means the user opened this single item deliberately.
  const original = media.isOriginalDeleted ? null : originalUrl || null;
  switch (size) {
    case 'thumb':
      return thumbnailUrl || previewUrl || largeUrl || original || null;
    case 'preview':
      return previewUrl || thumbnailUrl || largeUrl || original || null;
    case 'large':
      // Every derivative before the original — inline panes can hold several of
      // these at once, and a full-res decode is exactly what this module exists
      // to avoid. A legacy row with only a thumbnail renders soft until the
      // backfill lands; that is the intended trade.
      return largeUrl || previewUrl || thumbnailUrl || original || null;
    case 'full':
      return original || largeUrl || previewUrl || thumbnailUrl || null;
  }
}

/**
 * Source for a `<video>` element: always the real file. Returns null once the
 * original has been swept, where only the poster survives.
 */
export function mediaVideoUrl(media: MediaLike | null | undefined): string | null {
  if (!media || !isVideo(media) || media.isOriginalDeleted) return null;
  return media.originalUrl || null;
}

/**
 * Poster attribute for a `<video>` — shows a frame before playback starts
 * instead of a black rectangle.
 */
export function mediaPosterUrl(media: MediaLike | null | undefined): string | undefined {
  if (!media || !isVideo(media)) return undefined;
  return mediaImageUrl(media, 'large') ?? undefined;
}

/**
 * What to hand a lightbox for one media item.
 *
 * The subtlety: a swept video (original deleted, poster kept) must be presented
 * as an IMAGE. Passing the poster URL with a `video/*` mimeType puts a .webp
 * into a `<video src>` and the user gets an empty player.
 */
export function resolvePreviewSource(media: MediaLike | null | undefined): {
  url: string;
  posterUrl?: string;
  mimeType: string;
  isPreviewOnly: boolean;
} {
  if (!media) return { url: '', mimeType: 'image/jpeg', isPreviewOnly: false };

  if (isVideo(media)) {
    const playable = mediaVideoUrl(media);
    if (playable) {
      return {
        url: playable,
        posterUrl: mediaPosterUrl(media),
        mimeType: media.mimeType || 'video/mp4',
        isPreviewOnly: false,
      };
    }
    // Original gone — show the poster still, flagged as preview-only.
    return {
      url: mediaImageUrl(media, 'large') ?? '',
      mimeType: 'image/webp',
      isPreviewOnly: true,
    };
  }

  return {
    url: mediaImageUrl(media, 'full') ?? '',
    mimeType: media.mimeType || 'image/jpeg',
    isPreviewOnly: !!media.isOriginalDeleted,
  };
}
