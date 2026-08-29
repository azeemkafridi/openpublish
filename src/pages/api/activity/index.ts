import type { APIRoute } from 'astro';
import { db } from '@lib/db';
import { activityLogs, posts, mediaFiles as mediaFilesTable } from '@lib/db/schema';
import { eq, ne, and, or, desc, count, inArray, isNull, type SQL } from 'drizzle-orm';
import { getMediaPublicUrl } from '@lib/media/upload';

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export const GET: APIRoute = async ({ locals, url }) => {
  const { user, organizationId } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const action = url.searchParams.get('action');
  const resource = url.searchParams.get('resource');
  const offset = (page - 1) * limit;

  const conditions: (SQL | undefined)[] = [eq(activityLogs.organizationId, organizationId)];

  if (action) {
    conditions.push(eq(activityLogs.action, action));
  }
  if (resource) {
    conditions.push(eq(activityLogs.resource, resource));
  } else {
    // Client-side ux.* beacons (page views, failed submits — see
    // src/pages/api/events.ts) share this table but are telemetry, not user
    // actions: without this filter they'd drown the Overview "recent activity"
    // widget. Still reachable with an explicit ?resource=ux.
    conditions.push(or(isNull(activityLogs.resource), ne(activityLogs.resource, 'ux')));
  }

  const whereClause = and(...conditions);

  const [items, [{ total }]] = await Promise.all([
    db
      .select()
      .from(activityLogs)
      .where(whereClause)
      .orderBy(desc(activityLogs.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(activityLogs).where(whereClause),
  ]);

  // Enrich post-related activities with thumbnail from the first media file
  const postIds = items
    .filter((a) => a.resource === 'post' && a.resourceId)
    .map((a) => Number(a.resourceId))
    .filter((id) => !Number.isNaN(id));

  let thumbnailMap = new Map<number, { url: string; mimeType: string }>();

  if (postIds.length > 0) {
    const postRows = await db
      .select({ id: posts.id, mediaFiles: posts.mediaFiles })
      .from(posts)
      .where(inArray(posts.id, [...new Set(postIds)]));

    // Collect first media file ID from each post
    const mediaIdToPostId = new Map<number, number>();
    for (const p of postRows) {
      const raw = Array.isArray(p.mediaFiles) ? p.mediaFiles : [];
      if (raw.length === 0) continue;
      const first = raw[0];
      const mediaId = typeof first === 'number' ? first : typeof first === 'object' && (first as any)?.id ? (first as any).id : Number(first);
      if (!Number.isNaN(mediaId)) {
        mediaIdToPostId.set(mediaId, p.id);
      }
    }

    if (mediaIdToPostId.size > 0) {
      const mediaRows = await db
        .select()
        .from(mediaFilesTable)
        .where(inArray(mediaFilesTable.id, [...mediaIdToPostId.keys()]));

      for (const f of mediaRows) {
        const postId = mediaIdToPostId.get(f.id);
        if (postId === undefined) continue;
        // Only images may fall back to the original — for a video the
        // "original" is the whole media file, which the client's <img> makes
        // Safari download and decode (memory kill). No thumbnail → no image.
        const isImage = (f.mimeType || '').startsWith('image/');
        const thumbPath = f.thumbnailPath || (isImage ? f.originalPath : null);
        if (!thumbPath) continue;
        thumbnailMap.set(postId, {
          url: getMediaPublicUrl(thumbPath),
          mimeType: f.mimeType || 'image/jpeg',
        });
      }
    }
  }

  const enriched = items.map((item) => {
    const postId = item.resource === 'post' && item.resourceId ? Number(item.resourceId) : null;
    const thumb = postId ? thumbnailMap.get(postId) : undefined;
    return {
      ...item,
      ...(thumb ? { thumbnail: thumb } : {}),
    };
  });

  return json({
    activities: enriched,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  }, 200, { 'Cache-Control': 'private, max-age=15' });
};
