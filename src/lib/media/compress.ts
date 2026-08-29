/**
 * Client-side media preparation, run before a direct-to-R2 upload.
 *
 * Still images are re-encoded to WebP (quality ~0.8, longest edge capped at
 * 2048px) off the main thread when possible, falling back to the main thread,
 * then to the original bytes if anything goes wrong. We never upsize and never
 * keep a result that came out larger than the source. Videos and GIFs upload
 * as-is (GIF re-encoding would drop animation); for videos we read dimensions +
 * duration best-effort so the library can show them.
 */

const MAX_EDGE = 2048;
const QUALITY = 0.8;
const COMPRESS_TIMEOUT_MS = 30_000;

export interface PreparedUpload {
  blob: Blob;
  mimeType: string;
  fileName: string;
  width: number;
  height: number;
  duration?: number;
}

/** Scale (w, h) down so the longest edge is at most maxEdge. Never upsizes. */
export function fitWithin(w: number, h: number, maxEdge: number): { width: number; height: number } {
  if (w <= maxEdge && h <= maxEdge) return { width: w, height: h };
  const scale = maxEdge / Math.max(w, h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export async function prepareForUpload(file: File): Promise<PreparedUpload> {
  // Videos, GIFs, and non-images upload untouched — videos are out of scope for
  // client compression, and re-encoding a GIF via canvas would drop animation.
  // (The server backfills image dimensions when generating the thumbnail; there
  // is no server-side probe for videos, so measure them here or the columns
  // stay NULL forever.)
  if (!file.type.startsWith('image/') || file.type === 'image/gif') {
    if (file.type.startsWith('video/')) {
      const meta = await readVideoMetadata(file);
      return { blob: file, mimeType: file.type, fileName: file.name, width: meta.width, height: meta.height, duration: meta.duration };
    }
    return { blob: file, mimeType: file.type, fileName: file.name, width: 0, height: 0 };
  }

  try {
    const result = await compressImage(file, MAX_EDGE, QUALITY);
    // Keep the compressed result only if it actually saved bytes.
    if (result && result.blob.size < file.size) {
      return { blob: result.blob, mimeType: 'image/webp', fileName: file.name, width: result.width, height: result.height };
    }
    // No gain — upload the original, but reuse the dimensions we just measured.
    return {
      blob: file,
      mimeType: file.type,
      fileName: file.name,
      width: result?.width ?? 0,
      height: result?.height ?? 0,
    };
  } catch {
    // Decode/encode unsupported (or failed) — upload the original. The server
    // backfills image dimensions when it generates the thumbnail.
    return { blob: file, mimeType: file.type, fileName: file.name, width: 0, height: 0 };
  }
}

/* ------------------------------------------------------------------ */
/*  Video metadata (dimensions + duration via a detached <video>)      */
/* ------------------------------------------------------------------ */

const VIDEO_META_TIMEOUT_MS = 10_000;

async function readVideoMetadata(file: File): Promise<{ width: number; height: number; duration?: number }> {
  if (typeof document === 'undefined') return { width: 0, height: 0 };
  if (typeof URL.createObjectURL !== 'function') return { width: 0, height: 0 };
  const probe = document.createElement('video');
  // canPlayType('') means the environment can't decode it (also true in jsdom,
  // which never fires media events) — bail instead of waiting out the timer.
  if (!probe.canPlayType || probe.canPlayType(file.type) === '') return { width: 0, height: 0 };
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve) => {
      const video = probe;
      video.preload = 'metadata';
      const timer = setTimeout(() => finish(), VIDEO_META_TIMEOUT_MS);
      const finish = () => {
        clearTimeout(timer);
        const duration = Number.isFinite(video.duration) ? Math.round(video.duration) : undefined;
        resolve({ width: video.videoWidth || 0, height: video.videoHeight || 0, duration });
        video.src = '';
      };
      video.onloadedmetadata = finish;
      video.onerror = () => finish();
      video.src = url;
    });
  } catch {
    return { width: 0, height: 0 };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ------------------------------------------------------------------ */
/*  Worker pool (one reusable worker)                                  */
/* ------------------------------------------------------------------ */

let worker: Worker | null = null;
let workerUnavailable = false;
let nextId = 0;
const pending = new Map<number, { resolve: (v: CompressResult) => void; reject: (e: Error) => void }>();

interface CompressResult {
  blob: Blob;
  width: number;
  height: number;
}

function getWorker(): Worker | null {
  if (workerUnavailable) return null;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    workerUnavailable = true;
    return null;
  }
  if (!worker) {
    try {
      worker = new Worker(new URL('./compress-worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent) => {
        const { id, blob, width, height, error } = e.data ?? {};
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        if (error) p.reject(new Error(error));
        else p.resolve({ blob, width, height });
      };
      worker.onerror = () => {
        // A worker-level failure rejects everything in flight; future calls fall
        // back to the main thread.
        workerUnavailable = true;
        for (const [, p] of pending) p.reject(new Error('compression worker error'));
        pending.clear();
        worker = null;
      };
    } catch {
      workerUnavailable = true;
      worker = null;
    }
  }
  return worker;
}

async function compressImage(file: Blob, maxEdge: number, quality: number): Promise<CompressResult | null> {
  const w = getWorker();
  if (w) {
    return new Promise<CompressResult>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error('compression timed out'));
      }, COMPRESS_TIMEOUT_MS);
      const done = (fn: (v: any) => void) => (v: any) => {
        clearTimeout(timer);
        fn(v);
      };
      pending.set(id, { resolve: done(resolve), reject: done(reject) });
      w.postMessage({ id, file, maxEdge, quality });
    }).catch(() => compressOnMainThread(file, maxEdge, quality));
  }
  return compressOnMainThread(file, maxEdge, quality);
}

async function compressOnMainThread(file: Blob, maxEdge: number, quality: number): Promise<CompressResult | null> {
  let source: CanvasImageSource;
  let srcW: number;
  let srcH: number;

  if (typeof createImageBitmap === 'function') {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    source = bmp;
    srcW = bmp.width;
    srcH = bmp.height;
  } else {
    const img = await loadHtmlImage(file);
    source = img;
    srcW = img.naturalWidth;
    srcH = img.naturalHeight;
  }

  const { width, height } = fitWithin(srcW, srcH, maxEdge);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', quality));
    if (!blob) return null;
    return { blob, width, height };
  } finally {
    if ('close' in source && typeof (source as ImageBitmap).close === 'function') {
      (source as ImageBitmap).close();
    }
    // Drop the backing store rather than waiting for GC. Safari holds
    // width*height*4 bytes per canvas until collection, so a bulk upload of
    // large images otherwise keeps hundreds of MB of dead canvases alive.
    // The early-return paths above leak both of these without the finally.
    canvas.width = 0;
    canvas.height = 0;
  }
}

function loadHtmlImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const cleanup = () => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
    };
    // Safety net: if neither load nor error ever fires, fall back rather than hang.
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('image decode timed out'));
    }, COMPRESS_TIMEOUT_MS);
    img.onload = () => {
      cleanup();
      resolve(img);
    };
    img.onerror = () => {
      cleanup();
      reject(new Error('image decode failed'));
    };
    img.src = url;
  });
}
