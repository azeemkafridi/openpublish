/// <reference lib="webworker" />
/**
 * Off-main-thread image compression.
 *
 * Receives a still image, re-encodes it to WebP capped at `maxEdge`, and posts
 * back the blob + final dimensions. `createImageBitmap(..., imageOrientation:
 * 'from-image')` applies EXIF rotation so portrait phone photos aren't sideways.
 * Running here keeps the UI thread free while large images encode.
 */

interface CompressRequest {
  id: number;
  file: Blob;
  maxEdge: number;
  quality: number;
}

self.onmessage = async (e: MessageEvent<CompressRequest>) => {
  const { id, file, maxEdge, quality } = e.data;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const { width, height } = fitWithin(bitmap.width, bitmap.height, maxEdge);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
    (self as unknown as Worker).postMessage({ id, blob, width, height });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};

/** Scale (w, h) down so the longest edge is at most maxEdge. Never upsizes. */
function fitWithin(w: number, h: number, maxEdge: number): { width: number; height: number } {
  if (w <= maxEdge && h <= maxEdge) return { width: w, height: h };
  const scale = maxEdge / Math.max(w, h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export {};
