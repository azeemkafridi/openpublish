import { sql, eq } from 'drizzle-orm';
import { db } from '../db';
import { posts } from '../db/schema';

/**
 * Outcome of the "First Comment" auto-reply, recorded per platform so the post
 * detail view can show what the app actually did on the user's behalf.
 *
 * Stored inside `posts.platform_specific._firstCommentResults` (jsonb) rather
 * than its own column — no migration, and it lives next to `_firstComment`,
 * the text it came from.
 */
export type FirstCommentResult = {
  status: 'posted' | 'failed';
  error?: string;
  /** ISO timestamp of the attempt. */
  at: string;
};

export type FirstCommentResults = Record<string, FirstCommentResult>;

/**
 * Merge one platform's first-comment outcome into the post's jsonb blob.
 *
 * Written with `jsonb_set` so two platforms finishing at the same time can't
 * clobber each other the way a read-modify-write in JS would. `jsonb_set` only
 * creates the *last* path segment, so the `||` seeds the parent object first
 * when it isn't there yet.
 */
export async function recordFirstCommentResult(
  postId: number,
  platform: string,
  result: FirstCommentResult,
): Promise<void> {
  await db
    .update(posts)
    .set({
      platformSpecific: sql`jsonb_set(
        COALESCE(${posts.platformSpecific}, '{}'::jsonb) || jsonb_build_object(
          '_firstCommentResults',
          COALESCE(${posts.platformSpecific} -> '_firstCommentResults', '{}'::jsonb)
        ),
        ARRAY['_firstCommentResults', ${platform}],
        ${JSON.stringify(result)}::jsonb,
        true
      )`,
    })
    .where(eq(posts.id, postId));
}
