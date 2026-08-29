/**
 * Browser-side media upload: compress → presign → direct PUT to R2 (with real
 * progress) → finalize. Shared by every uploader in the app (composer media,
 * media library, thread editor, blog editor) so they behave identically and
 * skip the slow SSR relay.
 */
import { prepareForUpload } from './compress';

export interface UploadedMedia {
  id: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  originalUrl: string;
  thumbnailUrl: string | null;
  previewUrl: string | null;
  largeUrl?: string | null;
}

export interface UploadOptions {
  /** 0–100. Fires during compression/upload and again at completion. */
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

/** Blobs above this go through the chunked multipart path (must stay ≤ the server's single-PUT cap). */
const MULTIPART_THRESHOLD = 95 * 1024 * 1024;

export async function uploadMediaFile(file: File, opts: UploadOptions = {}): Promise<UploadedMedia> {
  const { onProgress, signal } = opts;
  onProgress?.(0);

  // 1. Compress images client-side (videos/GIFs pass through).
  const prepared = await prepareForUpload(file);

  // Large files (big videos) upload chunked: each part retries independently,
  // so a network blip costs one 10MB part instead of the whole gigabyte.
  if (prepared.blob.size > MULTIPART_THRESHOLD) {
    return uploadMultipart(prepared, onProgress, signal);
  }

  // 2. Ask the server for a direct upload URL (auth + quota happen here).
  const presignRes = await fetch('/api/media/presign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: prepared.mimeType, sizeBytes: prepared.blob.size }),
    signal,
  });
  if (!presignRes.ok) throw await responseError(presignRes, 'Failed to start upload');
  const { uploadUrl, r2Key } = await presignRes.json();

  // 3. PUT the bytes straight to R2 with upload progress (fetch can't report it).
  await putWithProgress(uploadUrl, prepared.blob, prepared.mimeType, onProgress, signal);

  // 4. Record the media file (server verifies the stored object first).
  const finalizeRes = await fetch('/api/media/finalize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      r2Key,
      fileName: prepared.fileName,
      mimeType: prepared.mimeType,
      sizeBytes: prepared.blob.size,
      width: prepared.width || undefined,
      height: prepared.height || undefined,
      duration: prepared.duration || undefined,
    }),
    signal,
  });
  if (!finalizeRes.ok) throw await responseError(finalizeRes, 'Failed to finalize upload');

  const json = await finalizeRes.json();
  onProgress?.(100);
  return (json.file ?? json) as UploadedMedia;
}

interface PreparedUpload {
  blob: Blob;
  mimeType: string;
  fileName: string;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
}

const PART_RETRIES = 3;

async function uploadMultipart(
  prepared: PreparedUpload,
  onProgress: ((p: number) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<UploadedMedia> {
  const createRes = await fetch('/api/media/multipart/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: prepared.mimeType, sizeBytes: prepared.blob.size }),
    signal,
  });
  if (!createRes.ok) throw await responseError(createRes, 'Failed to start upload');
  const { r2Key, uploadId, partSize, partUrls } = await createRes.json();

  const abort = () =>
    fetch('/api/media/multipart/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ r2Key, uploadId }),
    }).catch(() => {});

  try {
    const parts: Array<{ partNumber: number; etag: string }> = [];
    const totalParts = partUrls.length;
    const partProgress = new Array<number>(totalParts).fill(0);

    const reportProgress = () => {
      if (!onProgress) return;
      const loaded = partProgress.reduce((a, b) => a + b, 0);
      onProgress(Math.min(95, Math.round((loaded / prepared.blob.size) * 95)));
    };

    // Sequential parts: browsers pipeline a single connection well, progress is
    // monotonic, and one failed part retries in isolation.
    for (let i = 0; i < totalParts; i++) {
      const chunk = prepared.blob.slice(i * partSize, Math.min((i + 1) * partSize, prepared.blob.size));

      let etag: string | null = null;
      let lastError: unknown;
      for (let attempt = 1; attempt <= PART_RETRIES; attempt++) {
        try {
          etag = await putPart(partUrls[i], chunk, (loaded) => {
            partProgress[i] = loaded;
            reportProgress();
          }, signal);
          break;
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') throw err;
          lastError = err;
          if (attempt < PART_RETRIES) await new Promise((r) => setTimeout(r, attempt * 1000));
        }
      }
      if (!etag) throw lastError instanceof Error ? lastError : new Error('Upload failed');

      partProgress[i] = chunk.size;
      reportProgress();
      parts.push({ partNumber: i + 1, etag });
    }

    const completeRes = await fetch('/api/media/multipart/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        r2Key,
        uploadId,
        parts,
        fileName: prepared.fileName,
        mimeType: prepared.mimeType,
        sizeBytes: prepared.blob.size,
        width: prepared.width || undefined,
        height: prepared.height || undefined,
        duration: prepared.duration || undefined,
      }),
      signal,
    });
    if (!completeRes.ok) throw await responseError(completeRes, 'Failed to finalize upload');

    const json = await completeRes.json();
    onProgress?.(100);
    return (json.file ?? json) as UploadedMedia;
  } catch (err) {
    void abort();
    throw err;
  }
}

/** PUT one part; resolves with its ETag (required to complete the multipart upload). */
function putPart(
  url: string,
  chunk: Blob,
  onLoaded: (loadedBytes: number) => void,
  signal: AbortSignal | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onLoaded(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader('ETag');
        if (etag) resolve(etag);
        else reject(new Error('Upload part missing ETag — check the R2 bucket CORS config exposes ETag'));
      } else {
        reject(new Error(`Upload part failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed — network error'));
    xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));

    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('Upload aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.send(chunk);
  });
}

function putWithProgress(
  url: string,
  blob: Blob,
  contentType: string,
  onProgress: ((p: number) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        // Reserve 0–95% for the transfer; finalize bumps it to 100.
        onProgress(Math.min(95, Math.round((e.loaded / e.total) * 95)));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed — network error'));
    xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));

    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('Upload aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.send(blob);
  });
}

async function responseError(res: Response, fallback: string): Promise<Error> {
  const body = await res.json().catch(() => ({} as any));
  const err = body?.error;
  const base = (typeof err === 'object' ? err?.message : err) || fallback;
  const hint = typeof err === 'object' ? err?.hint : undefined;
  return new Error(hint ? `${base} ${hint}` : base);
}
