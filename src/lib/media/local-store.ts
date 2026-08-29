/**
 * Local-disk storage backend. Active when STORAGE=local (or when no S3/R2
 * endpoint is configured — see storageMode() in r2.ts). Objects live under
 * MEDIA_DIR (default ./uploads) keyed exactly like S3 keys, so every call
 * site keeps working against the same key strings.
 *
 * "Presigned" URLs in this mode are app routes: uploads PUT to
 * /api/media/local-put (session-authenticated by the middleware) and public
 * reads GET /uploads/<key> (served by src/pages/uploads/[...path].ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLogger } from '../logger';

const logger = createLogger('local-store');

export const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || './uploads');

function baseUrl(): string {
  return (process.env.BASE_URL || 'http://localhost:4321').replace(/\/$/, '');
}

/** Resolve a storage key to an absolute path, refusing traversal. */
export function localKeyPath(key: string): string {
  const clean = key.replace(/^\/+/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9/_.@-]*$/.test(clean) || clean.includes('..')) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  const abs = path.join(MEDIA_DIR, clean);
  if (!abs.startsWith(MEDIA_DIR + path.sep)) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  return abs;
}

function metaPath(key: string): string {
  return localKeyPath(key) + '.meta.json';
}

export async function localUpload(key: string, body: Buffer, contentType: string): Promise<void> {
  const dest = localKeyPath(key);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.writeFile(dest, body);
  await fs.promises.writeFile(metaPath(key), JSON.stringify({ contentType }));
  logger.info({ key, size: body.length }, 'Stored locally');
}

export async function localDelete(key: string): Promise<void> {
  try {
    await fs.promises.unlink(localKeyPath(key));
    await fs.promises.unlink(metaPath(key)).catch(() => {});
    logger.info({ key }, 'Deleted local object');
  } catch (error) {
    logger.warn({ key, error }, 'Failed to delete local object');
  }
}

export async function localDownloadToFile(key: string, destPath: string): Promise<void> {
  await fs.promises.copyFile(localKeyPath(key), destPath);
}

export async function localDownload(key: string): Promise<Buffer> {
  return fs.promises.readFile(localKeyPath(key));
}

export function localPublicUrl(key: string): string {
  return `${baseUrl()}/uploads/${key.replace(/^\/+/, '')}`;
}

/** Session-authenticated in-app upload target (see api/media/local-put.ts). */
export function localUploadUrl(key: string): string {
  return `${baseUrl()}/api/media/local-put?key=${encodeURIComponent(key)}`;
}

export async function localHead(
  key: string,
): Promise<{ contentType: string | undefined; contentLength: number } | null> {
  try {
    const stat = await fs.promises.stat(localKeyPath(key));
    let contentType: string | undefined;
    try {
      contentType = JSON.parse(await fs.promises.readFile(metaPath(key), 'utf8')).contentType;
    } catch {
      /* no sidecar — old file or direct copy */
    }
    return { contentType, contentLength: stat.size };
  } catch {
    return null;
  }
}

export async function localRange(key: string, endInclusive: number): Promise<Buffer | null> {
  try {
    const buf = await fs.promises.readFile(localKeyPath(key));
    return buf.subarray(0, endInclusive + 1);
  } catch {
    return null;
  }
}

export async function localTail(key: string, bytes: number): Promise<Buffer | null> {
  try {
    const buf = await fs.promises.readFile(localKeyPath(key));
    return buf.subarray(Math.max(0, buf.length - bytes));
  } catch {
    return null;
  }
}

/* ---- Multipart emulation: parts land as sibling files, complete concatenates ---- */

export async function localCreateMultipart(key: string, contentType: string): Promise<string> {
  const uploadId = randomBytes(12).toString('hex');
  const dest = localKeyPath(key);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.writeFile(metaPath(key), JSON.stringify({ contentType, uploadId }));
  return uploadId;
}

export function localPartKey(key: string, uploadId: string, partNumber: number): string {
  return `${key}.${uploadId}.part${partNumber}`;
}

export function localPartUploadUrl(key: string, uploadId: string, partNumber: number): string {
  return localUploadUrl(localPartKey(key, uploadId, partNumber));
}

export async function localCompleteMultipart(
  key: string,
  uploadId: string,
  parts: Array<{ partNumber: number; etag: string }>,
): Promise<void> {
  const dest = localKeyPath(key);
  const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  const out = fs.createWriteStream(dest);
  try {
    for (const p of ordered) {
      const partPath = localKeyPath(localPartKey(key, uploadId, p.partNumber));
      await new Promise<void>((resolve, reject) => {
        const read = fs.createReadStream(partPath);
        read.on('error', reject);
        read.on('end', resolve);
        read.pipe(out, { end: false });
      });
    }
  } finally {
    out.end();
  }
  for (const p of ordered) {
    await fs.promises.unlink(localKeyPath(localPartKey(key, uploadId, p.partNumber))).catch(() => {});
    await fs.promises.unlink(metaPath(localPartKey(key, uploadId, p.partNumber))).catch(() => {});
  }
}

export async function localAbortMultipart(key: string, uploadId: string): Promise<void> {
  const dir = path.dirname(localKeyPath(key));
  const base = path.basename(localKeyPath(key));
  try {
    const entries = await fs.promises.readdir(dir);
    for (const e of entries) {
      if (e.startsWith(`${base}.${uploadId}.part`)) {
        await fs.promises.unlink(path.join(dir, e)).catch(() => {});
      }
    }
  } catch {
    /* directory may not exist */
  }
}
