/**
 * Best-effort public profile URL for a connected channel, by platform.
 *
 * Handle-based platforms use accountName; ID-based ones (Facebook page, YouTube
 * channel) use accountId. Returns null where what we store doesn't map to a reliable
 * public URL (LinkedIn vanity/urn, Google Business, Mastodon instance) — callers
 * should render the handle as plain text in that case.
 */
/**
 * Bare handle for an accountName that may or may not carry a leading '@'.
 *
 * We store TikTok handles WITH the '@' (32 of 36 production channels) and X
 * handles inconsistently, so any URL that interpolates accountName must strip
 * it first — otherwise you get tiktok.com/@@surah.pk, which 404s. Use this at
 * every such site rather than re-deriving it.
 */
export function bareHandle(accountName: string | null | undefined): string {
  return (accountName ?? '').trim().replace(/^@+/, '');
}

export function channelProfileUrl(
  platform: string,
  accountName: string | null,
  accountId: string | null,
): string | null {
  const handle = bareHandle(accountName);
  switch (platform) {
    case 'x':         return handle ? `https://x.com/${handle}` : null;
    case 'tiktok':    return handle ? `https://www.tiktok.com/@${handle}` : null;
    case 'instagram': return handle ? `https://www.instagram.com/${handle}` : null;
    case 'threads':   return handle ? `https://www.threads.net/@${handle}` : null;
    case 'bluesky':   return handle ? `https://bsky.app/profile/${handle}` : null;
    case 'pinterest': return handle ? `https://www.pinterest.com/${handle}` : null;
    case 'youtube':   return accountId ? `https://www.youtube.com/channel/${accountId}` : null;
    case 'facebook':  return accountId ? `https://www.facebook.com/${accountId}` : null;
    // Reddit stores the bare username (from /api/v1/me `name`); strip a leading
    // "u/" as well as "@" since channels are commonly named "u/someone".
    case 'reddit':    { const u = handle.replace(/^u\//i, ''); return u ? `https://www.reddit.com/user/${u}` : null; }
    // Tumblr keys everything off the blog NAME, which is accountId — accountName
    // holds the blog's display title and does not resolve as a subdomain.
    case 'tumblr':    return accountId ? `https://${accountId}.tumblr.com/` : null;
    // Snapchat channels store the opaque public-profile UUID, not the username,
    // so no public URL can be derived from what we keep.
    case 'snapchat':  return null;
    // linkedin / gmb / mastodon: no reliable public URL from the handle/id we store.
    // discord: servers have no public profile page at all.
    // telegram: accountId is the numeric chat id and accountName the chat title;
    //   a t.me link needs the @username, which only exists for public chats and
    //   lives in channel metadata rather than these two columns.
    default:          return null;
  }
}
