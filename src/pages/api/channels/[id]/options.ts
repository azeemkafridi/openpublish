import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { decrypt } from '@/lib/auth/crypto';
import { PinterestHandler } from '@/lib/platforms/pinterest';
import { RedditHandler } from '@/lib/platforms/reddit';
import { DiscordHandler } from '@/lib/platforms/discord';
import { TikTokHandler } from '@/lib/platforms/tiktok';
import { TumblrHandler } from '@/lib/platforms/tumblr';

const YT_API = 'https://www.googleapis.com/youtube/v3';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const GET: APIRoute = async ({ locals, params, url }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const id = Number(params.id);
  if (!id || isNaN(id)) return json({ error: 'Invalid channel ID' }, 400);

  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, id), eq(channels.organizationId, locals.auth.organizationId)))
    .limit(1);

  if (!channel) return json({ error: 'Channel not found' }, 404);
  if (!channel.accessToken) return json({ error: 'No access token for this channel' }, 400);

  try {
    const accessToken = decrypt(channel.accessToken);

    switch (channel.platform) {
      case 'pinterest': {
        const handler = new PinterestHandler();
        const boards = await handler.getBoards(accessToken);
        return json({ type: 'boards', items: boards });
      }

      case 'reddit': {
        const handler = new RedditHandler();
        // ?subreddit=<name> returns that subreddit's post flairs; otherwise ?q=
        // searches subreddits by name. One helper route, two lookups.
        const subreddit = url.searchParams.get('subreddit');
        if (subreddit) {
          const flairs = await handler.getFlairs(accessToken, subreddit);
          return json({ type: 'flairs', items: flairs });
        }
        const q = url.searchParams.get('q') || '';
        const items = await handler.searchSubreddits(accessToken, q);
        return json({ type: 'subreddits', items });
      }

      case 'tumblr': {
        // A Tumblr account usually owns several blogs; the composer picks which
        // one a post goes to (stored as platformSpecific.blogName).
        const blogs = await new TumblrHandler().getBlogs(accessToken);
        return json({ type: 'blogs', items: blogs });
      }

      case 'discord': {
        // Discord lists channels with the GLOBAL bot token (not the OAuth token);
        // the guild id is stored as the channel's accountId.
        const items = await new DiscordHandler().listGuildChannels(channel.accountId);
        return json({ type: 'channels', items });
      }

      case 'youtube': {
        const playlists: { id: string; name: string }[] = [];
        let pageToken = '';
        do {
          const params = new URLSearchParams({
            part: 'snippet',
            mine: 'true',
            maxResults: '50',
            ...(pageToken ? { pageToken } : {}),
          });
          const res = await fetch(`${YT_API}/playlists?${params.toString()}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (!res.ok) {
            return json({ error: 'Could not load playlists from YouTube.' }, 502);
          }
          const data = await res.json() as {
            items?: Array<{ id: string; snippet: { title: string } }>;
            nextPageToken?: string;
          };
          if (data.items) {
            for (const item of data.items) {
              playlists.push({ id: item.id, name: item.snippet.title });
            }
          }
          pageToken = data.nextPageToken || '';
        } while (pageToken);
        return json({ type: 'playlists', items: playlists });
      }

      case 'tiktok': {
        // TikTok Content Sharing Guidelines: creator info must be queried fresh
        // whenever the "Post to TikTok" UI renders (nickname, allowed privacy
        // levels, disabled interactions, max video duration).
        const info = await new TikTokHandler().getCreatorInfo(accessToken);
        return json({ type: 'creator_info', info });
      }

      default:
        return json({ type: null, items: [] });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    // Surface TikTok's "stop posting, try later" guidance verbatim.
    if (message.startsWith('TikTok')) return json({ error: message }, 502);
    return json({ error: 'Could not load options. Please try again.' }, 500);
  }
};
