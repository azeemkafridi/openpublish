import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { postPlatforms, posts, channels } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { getPlatformHandler } from '@/lib/platforms/registry';
import '@/lib/platforms/init';
import type { ChannelData, PlatformName, EngagementData } from '@/lib/platforms/types';
import { decrypt } from '@/lib/auth/crypto';
import { cached } from '@/lib/cache';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=30' },
  });
}

type PlatformEngagement = {
  platform: PlatformName;
  /** The connected account/Page the content was read from — shown in the UI. */
  accountName: string | null;
  platformPostId: string | null;
  platformUrl: string | null;
  engagement: EngagementData | null;
  error?: string;
};

export const GET: APIRoute = async ({ locals, params, url }) => {
  const { user, organizationId } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const postId = Number(params.id);
  if (!postId) return json({ error: 'Invalid post ID' }, 400);

  const commentsLimit = clampInt(url.searchParams.get('commentsLimit'), 25, 1, 100);
  const reactionsLimit = clampInt(url.searchParams.get('reactionsLimit'), 25, 1, 100);
  // The analytics preview fetches this on every post selection, and each call
  // fans out to one live platform read per connected channel. Cache briefly so
  // clicking down the list doesn't burn read quota; the Refresh control sends
  // `force=1` to bypass.
  const force = url.searchParams.get('force') === '1';

  const [post] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.id, postId), eq(posts.organizationId, organizationId)));

  if (!post) return json({ error: 'Post not found' }, 404);

  const rows = await db
    .select({
      ppId: postPlatforms.id,
      platform: postPlatforms.platform,
      platformPostId: postPlatforms.platformPostId,
      platformUrl: postPlatforms.platformUrl,
      channelId: channels.id,
      accountId: channels.accountId,
      accountName: channels.accountName,
      accountType: channels.accountType,
      accessToken: channels.accessToken,
      refreshToken: channels.refreshToken,
      metadata: channels.metadata,
    })
    .from(postPlatforms)
    .innerJoin(channels, eq(channels.id, postPlatforms.channelId))
    .where(eq(postPlatforms.postId, postId));

  const cacheKey = `cache:engagement:${organizationId}:${postId}:${commentsLimit}:${reactionsLimit}`;
  const compute = async (): Promise<PlatformEngagement[]> => Promise.all(
    rows.map(async (row): Promise<PlatformEngagement> => {
      if (!row.platformPostId || !row.accessToken) {
        return {
          platform: row.platform as PlatformName,
          accountName: row.accountName ?? null,
          platformPostId: row.platformPostId,
          platformUrl: row.platformUrl,
          engagement: null,
          // A published row with no stored token is NOT "never published" — the
          // channel needs reconnecting. Both used to return a bare null, so the
          // UI rendered the same silence for a live post as for an unpublished
          // one and gave the user nothing to act on.
          ...(row.platformPostId
            ? { error: 'This channel is disconnected. Reconnect it on the Channels page to read comments.' }
            : {}),
        };
      }
      try {
        const handler = getPlatformHandler(row.platform as PlatformName);
        const channelData: ChannelData = {
          id: row.channelId,
          platform: row.platform as PlatformName,
          accountId: row.accountId,
          accountName: row.accountName,
          accountType: row.accountType || undefined,
          accessToken: decrypt(row.accessToken),
          refreshToken: row.refreshToken ? decrypt(row.refreshToken) : undefined,
          metadata: row.metadata as Record<string, unknown> | undefined,
          organizationId,
        };
        const engagement = await handler.getPostEngagement(channelData, row.platformPostId, {
          commentsLimit,
          reactionsLimit,
          platformUrl: row.platformUrl,
        });
        return {
          platform: row.platform as PlatformName,
          accountName: row.accountName ?? null,
          platformPostId: row.platformPostId,
          platformUrl: row.platformUrl,
          engagement,
        };
      } catch (error) {
        console.error('engagement fetch failed for platform', row.platform, error);
        return {
          platform: row.platform as PlatformName,
          accountName: row.accountName ?? null,
          platformPostId: row.platformPostId,
          platformUrl: row.platformUrl,
          engagement: null,
          error: 'Could not load engagement for this platform.',
        };
      }
    }),
  );

  const platforms = force ? await compute() : await cached(cacheKey, 60, compute);

  return json({ postId, platforms });
};

function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = raw == null ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}
