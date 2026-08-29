import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { mediaFiles, mediaLabels, labels } from '@/lib/db/schema';
import { eq, desc, ilike, and, inArray, sql } from 'drizzle-orm';
import { saveUploadedFile, getMediaPublicUrl } from '@/lib/media/upload';
import { logActivity } from '@/lib/activity/log';
import { checkMediaStorageQuota, getOrgPlan } from '@/lib/quotas/check';
import { quotaExceededResponse } from '@/lib/quotas/errors';
import { captureApiError } from '@/lib/errors';
import { MAX_FILE_SIZE, isAllowedMimeType, magicBytesMatch, isMp4Like, hasMp4MoovBox } from '@/lib/media/validate';

export const GET: APIRoute = async ({ locals, url }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const offset = (page - 1) * limit;
  const search = url.searchParams.get('search')?.trim();
  const labelIdsParam = url.searchParams.get('labelIds');

  const conditions = [eq(mediaFiles.organizationId, locals.auth.organizationId)];
  if (search) {
    conditions.push(ilike(mediaFiles.fileName, `%${search}%`));
  }

  // Filter by labels if provided
  let filteredMediaIds: number[] | null = null;
  if (labelIdsParam) {
    const labelIds = labelIdsParam.split(',').map(Number).filter(Boolean);
    if (labelIds.length > 0) {
      // Verify all labels belong to the current org
      const ownedLabels = await db
        .select({ id: labels.id })
        .from(labels)
        .where(and(inArray(labels.id, labelIds), eq(labels.organizationId, locals.auth.organizationId)));
      if (ownedLabels.length !== labelIds.length) {
        return json({ files: [], page, limit }, 200, { 'Cache-Control': 'private, no-store' });
      }

      const mediaWithLabels = await db
        .selectDistinct({ mediaFileId: mediaLabels.mediaFileId })
        .from(mediaLabels)
        .where(inArray(mediaLabels.labelId, labelIds));
      filteredMediaIds = mediaWithLabels.map((r) => r.mediaFileId);
      if (filteredMediaIds.length === 0) {
        return json({ files: [], page, limit }, 200, { 'Cache-Control': 'private, no-store' });
      }
      conditions.push(inArray(mediaFiles.id, filteredMediaIds));
    }
  }

  const rows = await db
    .select()
    .from(mediaFiles)
    .where(and(...conditions))
    .orderBy(desc(mediaFiles.createdAt))
    .limit(limit)
    .offset(offset);

  // Fetch labels for all returned media files
  const mediaIds = rows.map((r) => r.id);
  const allMediaLabels = mediaIds.length > 0
    ? await db
        .select({
          mediaFileId: mediaLabels.mediaFileId,
          labelId: labels.id,
          name: labels.name,
          color: labels.color,
        })
        .from(mediaLabels)
        .innerJoin(labels, eq(labels.id, mediaLabels.labelId))
        .where(inArray(mediaLabels.mediaFileId, mediaIds))
    : [];

  const labelsByMedia = new Map<number, Array<{ id: number; name: string; color: string }>>();
  for (const ml of allMediaLabels) {
    const list = labelsByMedia.get(ml.mediaFileId) || [];
    list.push({ id: ml.labelId, name: ml.name, color: ml.color ?? '#6366f1' });
    labelsByMedia.set(ml.mediaFileId, list);
  }

  const files = rows.map((file) => ({
    id: file.id,
    fileName: file.fileName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    width: file.width,
    height: file.height,
    duration: file.duration,
    isOriginalDeleted: file.isOriginalDeleted,
    originalUrl: getMediaPublicUrl(file.originalPath),
    thumbnailUrl: file.thumbnailPath ? getMediaPublicUrl(file.thumbnailPath) : null,
    previewUrl: file.previewPath ? getMediaPublicUrl(file.previewPath) : (file.thumbnailPath ? getMediaPublicUrl(file.thumbnailPath) : null),
    largeUrl: file.largePath ? getMediaPublicUrl(file.largePath) : null,
    createdAt: file.createdAt,
    labels: labelsByMedia.get(file.id) ?? [],
  }));

  return json({
    files,
    page,
    limit,
  }, 200, { 'Cache-Control': 'private, no-store' });
};

export const POST: APIRoute = async ({ locals, request }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return json({ error: 'Expected multipart/form-data' }, 400);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return json({ error: 'Failed to parse form data' }, 400);
  }

  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    return json({ error: 'Missing or invalid "file" field' }, 400);
  }

  if (file.size === 0) {
    return json({ error: 'File is empty' }, 400);
  }

  // Max file size: 100MB
  if (file.size > MAX_FILE_SIZE) {
    return json({ error: 'File too large (max 100MB)' }, 400);
  }

  // MIME type allowlist
  if (!isAllowedMimeType(file.type)) {
    return json({ error: `File type not allowed: ${file.type}` }, 400);
  }

  // Validate magic bytes match claimed MIME type
  if (typeof file.arrayBuffer === 'function') {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!magicBytesMatch(bytes.subarray(0, 12), file.type)) {
      return json({ error: 'File content does not match declared type' }, 400);
    }
    // MP4/MOV must contain a moov box — a video grabbed mid-encode passes the
    // ftyp check but fails at publish time with an opaque platform error.
    if (isMp4Like(file.type) && !hasMp4MoovBox(bytes)) {
      return json(
        { error: 'This video file is incomplete (no moov atom). It was likely still encoding or the upload was cut off. Re-export and upload again.' },
        400,
      );
    }
  }

  // Check media storage quota before uploading
  const storageQuota = await checkMediaStorageQuota(locals.auth.organizationId);
  if (!storageQuota.allowed) {
    const plan = await getOrgPlan(locals.auth.organizationId);
    return quotaExceededResponse(storageQuota, plan);
  }

  try {
    const result = await saveUploadedFile(user.id, file, locals.auth.organizationId);

    // Platform-format variants (JPEG for IG/GMB, etc.) are generated on-publish,
    // not stored at upload time — see the publish worker.

    logActivity({
      userId: user.id,
      organizationId: locals.auth.organizationId,
      action: 'media.uploaded',
      resource: 'media',
      resourceId: result.id,
      details: { fileName: result.fileName, mimeType: result.mimeType },
    });

    return json(
      {
        file: {
          id: result.id,
          fileName: result.fileName,
          mimeType: result.mimeType,
          sizeBytes: result.sizeBytes,
          width: result.width ?? null,
          height: result.height ?? null,
          duration: result.duration ?? null,
          originalUrl: getMediaPublicUrl(result.originalPath),
          thumbnailUrl: result.thumbnailPath
            ? getMediaPublicUrl(result.thumbnailPath)
            : null,
          previewUrl: result.previewPath
            ? getMediaPublicUrl(result.previewPath)
            : null,
          largeUrl: result.largePath ? getMediaPublicUrl(result.largePath) : null,
        },
      },
      201,
    );
  } catch (error) {
    captureApiError('POST /api/media', error);
    return json({ error: 'Failed to upload file' }, 500);
  }
};

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
