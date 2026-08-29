import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createLogger } from '../logger';
import * as local from './local-store';

const logger = createLogger('r2');

// Resolve env: import.meta.env may exist but lack non-PUBLIC vars at runtime,
// so check it first then fall back to process.env for each variable.
function getEnv(key: string, fallback = ''): string {
  const meta = typeof import.meta !== 'undefined' && import.meta.env ? (import.meta.env as Record<string, string>)[key] : undefined;
  return meta || process.env[key] || fallback;
}
const R2_ACCESS_KEY_ID = getEnv('R2_ACCESS_KEY_ID');
const R2_SECRET_ACCESS_KEY = getEnv('R2_SECRET_ACCESS_KEY');
const R2_ENDPOINT = getEnv('R2_ENDPOINT');
const R2_BUCKET = getEnv('R2_BUCKET', 'openpublish');
const R2_PUBLIC_URL = getEnv('R2_PUBLIC_URL', '');

/**
 * Storage backend selection:
 *   STORAGE=s3    — S3-compatible object storage (R2, S3, MinIO). Requires
 *                   R2_ENDPOINT + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY.
 *   STORAGE=local — files under MEDIA_DIR (default ./uploads), served from
 *                   /uploads by the app itself. The default when no S3
 *                   endpoint is configured.
 */
export function storageMode(): 'local' | 's3' {
  const explicit = getEnv('STORAGE');
  if (explicit === 'local' || explicit === 's3') return explicit;
  return R2_ACCESS_KEY_ID && R2_ENDPOINT ? 's3' : 'local';
}
const LOCAL = storageMode() === 'local';

if (LOCAL) {
  logger.info({ mediaDir: local.MEDIA_DIR }, 'Local media storage active');
} else {
  logger.info(
    { accessKeyId: R2_ACCESS_KEY_ID.slice(0, 8) + '...', endpoint: R2_ENDPOINT, bucket: R2_BUCKET },
    'S3 storage client initialized',
  );
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

export async function uploadToR2(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const start = Date.now();
  logger.info({ key, size: body.length, contentType }, 'Uploading to R2...');
  if (LOCAL) return local.localUpload(key, body, contentType);

  const timeoutMs = 60_000; // 60s timeout
  const uploadPromise = s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`R2 upload timed out after ${timeoutMs / 1000}s for key: ${key}`)), timeoutMs),
  );

  await Promise.race([uploadPromise, timeoutPromise]);
  logger.info({ key, size: body.length, durationMs: Date.now() - start }, 'Uploaded to R2');
}

export async function deleteFromR2(key: string): Promise<void> {
  if (LOCAL) return local.localDelete(key);
  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
      }),
    );
    logger.info({ key }, 'Deleted from R2');
  } catch (error) {
    logger.warn({ key, error }, 'Failed to delete from R2');
  }
}

export async function deleteMultipleFromR2(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  if (LOCAL) {
    for (const key of keys) await local.localDelete(key);
    return;
  }

  // S3 DeleteObjects supports max 1000 keys per request
  const batches: string[][] = [];
  for (let i = 0; i < keys.length; i += 1000) {
    batches.push(keys.slice(i, i + 1000));
  }

  for (const batch of batches) {
    try {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: R2_BUCKET,
          Delete: {
            Objects: batch.map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      );
      logger.info({ count: batch.length }, 'Batch deleted from R2');
    } catch (error) {
      logger.warn({ error, count: batch.length }, 'Batch delete from R2 failed');
    }
  }
}

/**
 * Stream an R2 object straight to a local file. Peak memory is one stream
 * chunk, regardless of object size — use this for anything that can be a
 * video. `downloadFromR2` below buffers the WHOLE object into the heap
 * (~2x the file size at peak, chunk array + concat) and must stay reserved
 * for small objects.
 */
export async function downloadFromR2ToFile(key: string, destPath: string): Promise<void> {
  if (LOCAL) return local.localDownloadToFile(key, destPath);
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
    }),
  );

  const stream = response.Body;
  if (!stream) throw new Error(`Empty response for R2 key: ${key}`);

  await pipeline(stream as NodeJS.ReadableStream, createWriteStream(destPath));
}

export async function downloadFromR2(key: string): Promise<Buffer> {
  if (LOCAL) return local.localDownload(key);
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
    }),
  );

  const stream = response.Body;
  if (!stream) throw new Error(`Empty response for R2 key: ${key}`);

  // Convert readable stream to buffer
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function getR2PublicUrl(key: string): string {
  if (LOCAL || !R2_PUBLIC_URL) return local.localPublicUrl(key);
  return `${R2_PUBLIC_URL}/${key}`;
}

/**
 * Generate a presigned PUT URL so the browser can upload a blob straight to R2,
 * skipping the SSR relay. `contentType` is baked into the signature, so the
 * client's PUT MUST send a matching `Content-Type` header. We deliberately do
 * NOT sign Content-Length — XHR can't always reproduce it exactly — so size is
 * enforced by the quota check at presign and re-verified (HEAD) at finalize.
 */
export async function getPresignedUploadUrl(
  key: string,
  contentType: string,
  expiresIn = 300,
): Promise<string> {
  if (LOCAL) return local.localUploadUrl(key);
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ContentType: contentType,
  });
  // Cast: @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner can resolve to separate
  // copies of @smithy/types, so S3Client isn't structurally identical to the presigner's
  // expected Client type (a private `handlers` field differs). Runtime is unaffected.
  return getSignedUrl(s3 as unknown as Parameters<typeof getSignedUrl>[0], command, { expiresIn });
}

/**
 * Presigned GET URL. Used to hand ffmpeg a streamable input so it can range-read
 * a video's header and one frame instead of us buffering the whole object
 * (`downloadFromR2` on a 1GB upload would pull 1GB into the worker's heap).
 */
export async function getPresignedDownloadUrl(key: string, expiresIn = 900): Promise<string> {
  if (LOCAL) return local.localKeyPath(key);
  const command = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
  return getSignedUrl(s3 as unknown as Parameters<typeof getSignedUrl>[0], command, { expiresIn });
}

/* ------------------------------------------------------------------ */
/*  Multipart uploads (large videos)                                    */
/* ------------------------------------------------------------------ */

/**
 * Start an S3 multipart upload and presign a PUT URL for every part. The
 * browser uploads each chunk to its own URL (retryable independently — a
 * dropped connection only costs one part, not the whole file) and then calls
 * the complete endpoint with the collected ETags.
 */
export async function createMultipartUpload(
  key: string,
  contentType: string,
): Promise<string> {
  if (LOCAL) return local.localCreateMultipart(key, contentType);
  const res = await s3.send(
    new CreateMultipartUploadCommand({ Bucket: R2_BUCKET, Key: key, ContentType: contentType }),
  );
  if (!res.UploadId) throw new Error('R2 did not return an upload id');
  return res.UploadId;
}

export async function getPresignedPartUrl(
  key: string,
  uploadId: string,
  partNumber: number,
  expiresIn = 3600,
): Promise<string> {
  if (LOCAL) return local.localPartUploadUrl(key, uploadId, partNumber);
  const command = new UploadPartCommand({
    Bucket: R2_BUCKET,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  });
  return getSignedUrl(s3 as unknown as Parameters<typeof getSignedUrl>[0], command, { expiresIn });
}

export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: Array<{ partNumber: number; etag: string }>,
): Promise<void> {
  if (LOCAL) return local.localCompleteMultipart(key, uploadId, parts);
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: R2_BUCKET,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    }),
  );
}

export async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  if (LOCAL) return local.localAbortMultipart(key, uploadId);
  try {
    await s3.send(
      new AbortMultipartUploadCommand({ Bucket: R2_BUCKET, Key: key, UploadId: uploadId }),
    );
    logger.info({ key }, 'Multipart upload aborted');
  } catch (error) {
    logger.warn({ key, error }, 'Failed to abort multipart upload');
  }
}

/**
 * HEAD an R2 object. Returns its content-type + size, or null if it doesn't
 * exist. Used at finalize to confirm the browser actually uploaded the object
 * before we trust the metadata it claims.
 */
export async function headR2Object(
  key: string,
): Promise<{ contentType: string | undefined; contentLength: number } | null> {
  if (LOCAL) return local.localHead(key);
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return { contentType: res.ContentType, contentLength: res.ContentLength ?? 0 };
  } catch {
    return null;
  }
}

/**
 * Fetch the first `endInclusive + 1` bytes of an R2 object via a ranged GET.
 * Lets finalize magic-byte-validate a stored file without downloading all of
 * it (a 100MB video only needs its first few bytes checked).
 */
export async function getR2ObjectRange(key: string, endInclusive: number): Promise<Buffer | null> {
  if (LOCAL) return local.localRange(key, endInclusive);
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: R2_BUCKET, Key: key, Range: `bytes=0-${endInclusive}` }),
    );
    const stream = res.Body;
    if (!stream) return null;
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

/**
 * Fetch the LAST `bytes` of an R2 object via a suffix ranged GET
 * (`bytes=-N`). Used by finalize's moov-atom check — the moov box of a
 * non-faststart mp4 lives at the end of the file.
 */
export async function getR2ObjectTail(key: string, bytes: number): Promise<Buffer | null> {
  if (LOCAL) return local.localTail(key, bytes);
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: R2_BUCKET, Key: key, Range: `bytes=-${bytes}` }),
    );
    const stream = res.Body;
    if (!stream) return null;
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

/**
 * Check if a stored path is a legacy local filesystem path (absolute)
 * vs an R2 key (relative like "original/filename.jpg").
 */
export function isR2Key(storedPath: string): boolean {
  return !storedPath.startsWith('/');
}
