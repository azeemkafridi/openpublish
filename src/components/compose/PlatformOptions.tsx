import { useState, useEffect } from 'react';
import { Spinner } from '@components/ui/Spinner';
import { CoverImagePicker } from './CoverImagePicker';
import type { SelectedChannel } from './ChannelSelector';
export type { SelectedChannel } from './ChannelSelector';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface PinterestBoard {
  id: string;
  name: string;
}

export interface YouTubePlaylist {
  id: string;
  title: string;
}

export interface PlatformSpecific {
  pinterest?: {
    [channelId: number]: {
      boardId: string;
    };
    title?: string;
    description?: string;
    link?: string;
  };
  gmb?: {
    ctaType: string;
    ctaUrl: string;
    eventTitle: string;
    startDate: string;
    startTime: string;
    endDate: string;
    endTime: string;
    couponCode: string;
    redeemOnlineUrl: string;
    termsConditions: string;
  };
  youtube?: {
    title: string;
    privacyStatus: string;
    categoryId: string;
    madeForKids: boolean;
    playlistId: string;
    thumbnailUrl?: string;
  };
  tiktok?: {
    privacyLevel: string;
    disableDuet: boolean;
    disableStitch: boolean;
    disableComment: boolean;
    isAigc: boolean;
    discloseCommercial?: boolean;
    brandContentToggle: boolean;
    brandOrganicToggle: boolean;
    thumbnailTimestamp?: number;
    autoAddMusic?: boolean;
    /** From creator_info; set by TikTokSection so validation can enforce it. */
    maxVideoDurationSec?: number;
  };
  x?: {
    replySettings: string;
  };
  facebook?: {
    shareToStory?: boolean;
    /** Cover for a video or Reel. Applied on the video after it publishes. */
    thumbnailUrl?: string;
  };
  instagram?: {
    collaborators?: string;
    shareToStory?: boolean;
    trialReel?: boolean;
    graduationStrategy?: 'manual' | 'auto';
    thumbnailTimestamp?: number;
    /** Cover image for a video or Reel. Takes precedence over thumbnailTimestamp. */
    coverUrl?: string;
  };
  threads?: {
    quotePostId?: string;
  };
  reddit?: {
    [channelId: number]: {
      subreddit?: string;
      title?: string;
      type?: string;
      flairId?: string;
      thumbnailUrl?: string;
    };
  };
  discord?: {
    [channelId: number]: {
      channelId: string;
    };
  };
  tumblr?: {
    [channelId: number]: {
      blogName?: string;
      title?: string;
      tags?: string[];
      link?: string;
    };
  };
  snapchat?: {
    [channelId: number]: {
      title?: string;
      locale?: string;
      saveToProfile?: boolean;
    };
  };
}

export interface PlatformOptionsProps {
  selectedChannels: SelectedChannel[];
  platformSpecific: PlatformSpecific;
  onChange: (data: PlatformSpecific) => void;
  postTypes?: Record<string, string>;
  onPostTypeOverride?: (platform: string, postType: string) => void;
  mediaWarning?: string | null;
  /** Override the root container padding/gap — used to fit the narrow Bulk Compose sidebar. */
  containerStyle?: React.CSSProperties;
}

/** Platforms that surface extra options in <PlatformOptions> (excludes LinkedIn, which only
 *  appears with a post-type override that Bulk Compose doesn't pass). Lets callers gate a
 *  wrapper/heading without rendering an empty shell. */
export const OPTION_PLATFORMS = ['facebook', 'x', 'pinterest', 'gmb', 'youtube', 'tiktok', 'instagram', 'threads', 'reddit', 'discord', 'tumblr', 'snapchat'];

export function hasPlatformOptions(channels: SelectedChannel[]): boolean {
  return channels.some((c) => OPTION_PLATFORMS.includes(c.platform));
}

/** TikTok UX guidelines: the publish button must be greyed out (not just blocked on
 *  click) while commercial-content disclosure is on with no option selected. */
export function tiktokDisclosureIncomplete(
  selectedChannels: SelectedChannel[],
  platformSpecific: PlatformSpecific,
): boolean {
  if (!selectedChannels.some((c) => c.platform === 'tiktok')) return false;
  const tt = platformSpecific.tiktok;
  return !!tt?.discloseCommercial && !tt.brandContentToggle && !tt.brandOrganicToggle;
}

/* ------------------------------------------------------------------ */
/*  Validation                                                         */
/* ------------------------------------------------------------------ */

export function validatePlatformOptions(
  selectedChannels: SelectedChannel[],
  platformSpecific: PlatformSpecific,
  postTypes?: Record<string, string>,
  extras?: { content?: string; videoDurationSec?: number | null },
): string[] {
  const errors: string[] = [];

  const hasPinterest = selectedChannels.some((c) => c.platform === 'pinterest');
  const hasYouTube = selectedChannels.some((c) => c.platform === 'youtube');
  const hasGmb = selectedChannels.some((c) => c.platform === 'gmb');

  // Reddit: every selected Reddit channel needs a target subreddit + a post title.
  for (const c of selectedChannels.filter((c) => c.platform === 'reddit')) {
    const r = platformSpecific.reddit?.[c.channelId];
    if (!r?.subreddit?.trim()) { errors.push('Reddit: choose a subreddit.'); break; }
    if (!r?.title?.trim()) { errors.push('Reddit: a post title is required.'); break; }
  }

  // Discord: every selected Discord channel needs a target channel chosen.
  for (const c of selectedChannels.filter((c) => c.platform === 'discord')) {
    if (!platformSpecific.discord?.[c.channelId]?.channelId) {
      errors.push('Discord: choose a channel.');
      break;
    }
  }

  // Title is required for YouTube and Pinterest (shared field in Composer)
  if (hasYouTube || hasPinterest) {
    const title = platformSpecific.youtube?.title?.trim() || platformSpecific.pinterest?.title?.trim();
    if (!title) {
      errors.push('Title is required.');
    }
  }

  // TikTok UX guidelines: privacy must be chosen manually (no default), and when
  // the commercial-content toggle is on at least one disclosure option is required.
  if (selectedChannels.some((c) => c.platform === 'tiktok')) {
    const tt = platformSpecific.tiktok;
    if (!tt?.privacyLevel) {
      errors.push('TikTok: select who can view this post.');
    }
    if (tt?.discloseCommercial && !tt.brandContentToggle && !tt.brandOrganicToggle) {
      errors.push('TikTok: you enabled commercial content disclosure. Select "Your brand", "Branded content", or both.');
    }
    if (tt?.brandContentToggle && tt.privacyLevel === 'SELF_ONLY') {
      errors.push('TikTok: branded content can\'t be posted as "Only me". Choose Public or Friends visibility.');
    }
    // TikTok requires a title on every post; the caption becomes the title.
    if (extras && !extras.content?.trim()) {
      errors.push('TikTok: enter a caption. TikTok requires a title for every post.');
    }
    // Enforce the per-creator max video duration from creator_info.
    if (tt?.maxVideoDurationSec && extras?.videoDurationSec && extras.videoDurationSec > tt.maxVideoDurationSec) {
      errors.push(`TikTok: this video is ${Math.round(extras.videoDurationSec)}s, but this account allows up to ${tt.maxVideoDurationSec}s.`);
    }
  }

  // Snapchat: enforce the handler's video-duration rules at compose time so the
  // user hears about it before the publish job fails (Stories 5–60s, Spotlight 6–60s).
  if (selectedChannels.some((c) => c.platform === 'snapchat') && extras?.videoDurationSec) {
    const snapType = postTypes?.snapchat || 'story';
    const minSec = snapType === 'spotlight' ? 6 : 5;
    const d = extras.videoDurationSec;
    if (d < minSec || d > 60) {
      errors.push(
        `Snapchat: ${snapType === 'spotlight' ? 'Spotlight' : 'story'} videos must be ${minSec}–60 seconds (this video is ${Math.round(d)}s).`,
      );
    }
  }

  // GMB: CTA URL is required when CTA Type is set (except CALL which uses listing phone)
  if (hasGmb) {
    const gmb = platformSpecific.gmb;
    if (gmb?.ctaType && gmb.ctaType !== 'CALL' && !gmb.ctaUrl?.trim()) {
      errors.push('Google Business: CTA URL is required when a CTA type is selected.');
    }

    const gmbPostType = postTypes?.gmb;
    if (gmbPostType === 'event' || gmbPostType === 'offer') {
      if (!gmb?.eventTitle?.trim()) {
        errors.push(`Google Business: ${gmbPostType === 'event' ? 'Event' : 'Offer'} title is required.`);
      }
      if (!gmb?.startDate || !gmb?.endDate) {
        errors.push(`Google Business: Start and end dates are required for ${gmbPostType} posts.`);
      }
    }
  }

  return errors;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const YOUTUBE_CATEGORIES = [
  { value: '22', label: 'People & Blogs' },
  { value: '24', label: 'Entertainment' },
  { value: '28', label: 'Science & Technology' },
  { value: '26', label: 'Howto & Style' },
  { value: '27', label: 'Education' },
  { value: '10', label: 'Music' },
  { value: '20', label: 'Gaming' },
  { value: '17', label: 'Sports' },
  { value: '1', label: 'Film & Animation' },
  { value: '25', label: 'News & Politics' },
  { value: '19', label: 'Travel & Events' },
  { value: '23', label: 'Comedy' },
  { value: '2', label: 'Autos & Vehicles' },
  { value: '15', label: 'Pets & Animals' },
  { value: '29', label: 'Nonprofits & Activism' },
];

const YOUTUBE_PRIVACY = [
  { value: 'public', label: 'Public' },
  { value: 'unlisted', label: 'Unlisted' },
  { value: 'private', label: 'Private' },
];

// Human labels for the privacy levels TikTok's creator_info query can return.
// The dropdown itself only offers what the API returned for this creator — per
// TikTok's UX guidelines the options must not be hardcoded and have no default.
const TIKTOK_PRIVACY_LABELS: Record<string, string> = {
  PUBLIC_TO_EVERYONE: 'Public',
  MUTUAL_FOLLOW_FRIENDS: 'Friends',
  FOLLOWER_OF_CREATOR: 'Followers',
  SELF_ONLY: 'Only me',
};

// X "who can reply" audiences. Values are the exact enum strings the X API accepts for
// `reply_settings` on POST /2/tweets (everyone = omit the field, it's the default).
// Source: https://docs.x.com/x-api/posts/create-post
const X_REPLY_SETTINGS = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'following', label: 'Accounts you follow' },
  { value: 'verified', label: 'Verified accounts' },
  { value: 'subscribers', label: 'Your subscribers' },
  { value: 'mentionedUsers', label: 'Only accounts you mention' },
];

const GMB_CTA_TYPES = [
  { value: 'LEARN_MORE', label: 'Learn More' },
  { value: 'BOOK', label: 'Book' },
  { value: 'ORDER', label: 'Order' },
  { value: 'SHOP', label: 'Shop' },
  { value: 'SIGN_UP', label: 'Sign Up' },
  { value: 'CALL', label: 'Call' },
];

/* ------------------------------------------------------------------ */
/*  Shared label styles                                                */
/* ------------------------------------------------------------------ */

const labelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  fontSize: 'var(--text-xs)',
  color: 'var(--stone-500)',
  marginBottom: '4px',
};

const sectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  padding: '16px 20px',
  background: 'var(--stone-100)',
  borderRadius: '8px',
};

const sectionHeadingStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  fontSize: 'var(--text-sm)',
  fontWeight: 600,
  color: 'var(--stone-700)',
  margin: 0,
};

function FieldLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label style={labelStyle}>
      {children}
      {required ? (
        <span style={{ color: '#EF4444', fontWeight: 600 }}>*</span>
      ) : (
        <span style={{ color: 'var(--stone-300)', fontWeight: 400, fontSize: 'var(--text-xs)' }}>optional</span>
      )}
    </label>
  );
}

/* ------------------------------------------------------------------ */
/*  Pinterest Board Selector (sub-component)                           */
/* ------------------------------------------------------------------ */

function PinterestBoardSelector({
  channelId,
  selectedBoardId,
  onSelect,
}: {
  channelId: number;
  selectedBoardId: string;
  onSelect: (boardId: string) => void;
}) {
  const [boards, setBoards] = useState<PinterestBoard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchBoards() {
      try {
        const res = await fetch(`/api/channels/${channelId}/options`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'Failed to load boards. Try reconnecting your Pinterest account.');
        }
        const data = await res.json();
        if (!cancelled) setBoards(data.items || []);
      } catch (err: any) {
        if (!cancelled) setError(err.message ?? 'Unknown error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchBoards();
    return () => { cancelled = true; };
  }, [channelId]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Spinner size="sm" />
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>Loading boards...</span>
      </div>
    );
  }

  if (error) {
    return (
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-error)' }}>{error}</span>
    );
  }

  return (
    <div style={{ position: 'relative' }}>
      <select
        className="input"
        value={selectedBoardId}
        onChange={(e) => onSelect(e.target.value)}
        style={{
          appearance: 'none',
          paddingRight: '36px',
          cursor: 'pointer',
          fontSize: 'var(--text-sm)',
        }}
      >
        <option value="">Select a board</option>
        {boards.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="var(--stone-400)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          position: 'absolute',
          right: '12px',
          top: '50%',
          transform: 'translateY(-50%)',
          pointerEvents: 'none',
        }}
      >
        <polyline points="4 6 8 10 12 6" />
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  YouTube Playlist Selector (sub-component)                          */
/* ------------------------------------------------------------------ */

function YouTubePlaylistSelector({
  channelId,
  selectedPlaylistId,
  onSelect,
}: {
  channelId: number;
  selectedPlaylistId: string;
  onSelect: (playlistId: string) => void;
}) {
  const [playlists, setPlaylists] = useState<YouTubePlaylist[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchPlaylists() {
      try {
        const res = await fetch(`/api/channels/${channelId}/options`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'Failed to load playlists. Try reconnecting your YouTube account.');
        }
        const data = await res.json();
        if (!cancelled) setPlaylists(data.items || []);
      } catch (err: any) {
        if (!cancelled) setError(err.message ?? 'Unknown error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchPlaylists();
    return () => { cancelled = true; };
  }, [channelId]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Spinner size="sm" />
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>Loading playlists...</span>
      </div>
    );
  }

  if (error) {
    return (
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-error)' }}>{error}</span>
    );
  }

  return (
    <div style={{ position: 'relative' }}>
      <select
        className="input"
        value={selectedPlaylistId}
        onChange={(e) => onSelect(e.target.value)}
        style={{
          appearance: 'none',
          paddingRight: '36px',
          cursor: 'pointer',
          fontSize: 'var(--text-sm)',
        }}
      >
        <option value="">No playlist</option>
        {playlists.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title}
          </option>
        ))}
      </select>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--stone-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}><polyline points="4 6 8 10 12 6" /></svg>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Discord Channel Selector (sub-component)                          */
/* ------------------------------------------------------------------ */

function DiscordChannelSelector({
  channelId,
  selectedChannelId,
  onSelect,
}: {
  channelId: number;
  selectedChannelId: string;
  onSelect: (discordChannelId: string) => void;
}) {
  const [items, setItems] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/channels/${channelId}/options`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'Failed to load channels. Make sure the bot is in your server.');
        }
        const data = await res.json();
        if (!cancelled) setItems(data.items || []);
      } catch (err: any) {
        if (!cancelled) setError(err.message ?? 'Unknown error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [channelId]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Spinner size="sm" />
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>Loading channels...</span>
      </div>
    );
  }

  if (error) {
    return <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-error)' }}>{error}</span>;
  }

  return (
    <div style={{ position: 'relative' }}>
      <select
        className="input"
        value={selectedChannelId}
        onChange={(e) => onSelect(e.target.value)}
        style={{ appearance: 'none', paddingRight: '36px', cursor: 'pointer', fontSize: 'var(--text-sm)' }}
      >
        <option value="">Select a channel</option>
        {items.map((c) => (
          <option key={c.id} value={c.id}>#{c.name}</option>
        ))}
      </select>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--stone-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}><polyline points="4 6 8 10 12 6" /></svg>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tumblr blog picker (sub-component)                                */
/* ------------------------------------------------------------------ */

/**
 * A Tumblr account usually owns several blogs, so the composer picks the target
 * per post. Defaults to the blog the channel was connected as (its accountId),
 * which the handler also falls back to when nothing is selected.
 */
function TumblrBlogSelector({
  channelId,
  selectedBlog,
  onSelect,
}: {
  channelId: number;
  selectedBlog: string;
  onSelect: (blogName: string) => void;
}) {
  const [items, setItems] = useState<Array<{ id: string; name: string; title?: string; primary?: boolean }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/channels/${channelId}/options`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'Failed to load blogs');
        }
        const data = await res.json();
        if (!cancelled) setItems(data.items || []);
      } catch (err: any) {
        if (!cancelled) setError(err.message ?? 'Unknown error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [channelId]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Spinner size="sm" />
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>Loading blogs...</span>
      </div>
    );
  }

  if (error) {
    return <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-error)' }}>{error}</span>;
  }

  return (
    <div style={{ position: 'relative' }}>
      <select
        className="input"
        value={selectedBlog}
        onChange={(e) => onSelect(e.target.value)}
        style={{ appearance: 'none', paddingRight: '36px', cursor: 'pointer', fontSize: 'var(--text-sm)' }}
      >
        <option value="">Default blog</option>
        {items.map((b) => (
          <option key={b.id} value={b.id}>
            {b.title || b.name}{b.primary ? ' (primary)' : ''}
          </option>
        ))}
      </select>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--stone-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}><polyline points="4 6 8 10 12 6" /></svg>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Reddit Settings (sub-component)                                   */
/* ------------------------------------------------------------------ */

interface RedditChannelSettings {
  subreddit?: string;
  title?: string;
  type?: string;
  flairId?: string;
  thumbnailUrl?: string;
}

function RedditSettings({
  channelId,
  value,
  onPatch,
}: {
  channelId: number;
  value: RedditChannelSettings;
  onPatch: (patch: RedditChannelSettings) => void;
}) {
  const [query, setQuery] = useState(value.subreddit ?? '');
  const [results, setResults] = useState<Array<{ id: string; name: string }>>([]);
  const [showResults, setShowResults] = useState(false);
  const [flairs, setFlairs] = useState<Array<{ id: string; name: string }>>([]);

  // Debounced subreddit search (skips when the query already matches the picked one).
  useEffect(() => {
    if (!query.trim() || query === value.subreddit) { setResults([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/channels/${channelId}/options?q=${encodeURIComponent(query.trim())}`);
        const data = await res.json().catch(() => ({}));
        if (!cancelled) { setResults(data.items || []); setShowResults(true); }
      } catch { /* ignore transient search errors */ }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, channelId, value.subreddit]);

  // Load the chosen subreddit's flairs (so the flair picker only shows valid options).
  useEffect(() => {
    if (!value.subreddit) { setFlairs([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/channels/${channelId}/options?subreddit=${encodeURIComponent(value.subreddit!)}`);
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setFlairs(data.items || []);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [value.subreddit, channelId]);

  function pick(name: string) {
    setQuery(name);
    setShowResults(false);
    onPatch({ subreddit: name, flairId: '' });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ position: 'relative' }}>
        <FieldLabel required>Subreddit</FieldLabel>
        <input
          className="input"
          type="text"
          placeholder="Search subreddits..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => { if (results.length) setShowResults(true); }}
          onBlur={() => setTimeout(() => setShowResults(false), 150)}
          style={{ fontSize: 'var(--text-sm)' }}
        />
        {showResults && results.length > 0 && (
          <div style={{ position: 'absolute', zIndex: 20, top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid var(--stone-200)', borderRadius: 'var(--radius-md)', marginTop: '2px', maxHeight: '160px', overflowY: 'auto', boxShadow: 'var(--shadow-md)' }}>
            {results.map((r) => (
              <button
                key={r.id}
                type="button"
                onMouseDown={() => pick(r.name)}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-sm)', color: 'var(--stone-700)' }}
              >
                r/{r.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
        <FieldLabel required>Title</FieldLabel>
        <input
          className="input"
          type="text"
          placeholder="Post title"
          value={value.title ?? ''}
          maxLength={300}
          onChange={(e) => onPatch({ title: e.target.value })}
          style={{ fontSize: 'var(--text-sm)' }}
        />
      </div>

      <div>
        <FieldLabel>Video thumbnail</FieldLabel>
        <CoverImagePicker
          value={value.thumbnailUrl ?? ''}
          onChange={(url) => onPatch({ thumbnailUrl: url })}
          placeholder="https://example.com/thumbnail.jpg"
        />
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>
          Video posts only. Leave blank to use a frame from your video.
        </span>
      </div>

      {flairs.length > 0 && (
        <div>
          <FieldLabel>Flair</FieldLabel>
          <div style={{ position: 'relative' }}>
            <select
              className="input"
              value={value.flairId ?? ''}
              onChange={(e) => onPatch({ flairId: e.target.value })}
              style={{ appearance: 'none', paddingRight: '36px', cursor: 'pointer', fontSize: 'var(--text-sm)' }}
            >
              <option value="">No flair</option>
              {flairs.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--stone-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}><polyline points="4 6 8 10 12 6" /></svg>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  TikTok Section (sub-component)                                     */
/*                                                                     */
/*  Implements TikTok's required UX (Content Sharing Guidelines):      */
/*  fresh creator_info on render, creator nickname shown, privacy      */
/*  options from the API with no default, interactions off by default  */
/*  and greyed out when disabled in-app, commercial content disclosure */
/*  flow, and the compliance declarations.                             */
/* ------------------------------------------------------------------ */

interface TikTokCreatorInfo {
  nickname: string;
  avatarUrl: string;
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number;
}

function TikTokSection({
  channelId,
  ttData,
  onField,
  mediaWarning,
  isPhotoPost,
}: {
  channelId: number;
  ttData: NonNullable<PlatformSpecific['tiktok']>;
  onField: (field: string, value: string | boolean | number) => void;
  mediaWarning?: string | null;
  isPhotoPost: boolean;
}) {
  const [info, setInfo] = useState<TikTokCreatorInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/channels/${channelId}/options`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not load your TikTok account settings. Please try again later.');
        if (!cancelled) {
          setInfo(data.info ?? null);
          // Surface the creator's max video duration to validation.
          if (data.info?.maxVideoPostDurationSec) onField('maxVideoDurationSec', data.info.maxVideoPostDurationSec);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message ?? 'Could not load your TikTok account settings.');
          // Per TikTok's UX guidelines publishing must stop when creator_info is
          // unavailable: clearing the privacy level keeps validation blocking.
          onField('privacyLevel', '');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [channelId]);

  // Only the privacy levels TikTok returned for this creator — never a hardcoded list.
  const privacyOptions = info?.privacyLevelOptions ?? [];

  const disclosureOn = !!ttData.discloseCommercial;
  const brandedDisabled = ttData.privacyLevel === 'SELF_ONLY';
  const checkboxRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' };
  const checkboxText: React.CSSProperties = { fontSize: 'var(--text-sm)', color: 'var(--stone-700)' };

  return (
    <div style={sectionStyle}>
      <div style={sectionHeadingStyle}>
        <img src="/assets/platforms/tiktok.svg" alt="" width={20} height={20} />
        TikTok
      </div>

      {/* Creator identity — who this will be published as */}
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Spinner size="sm" />
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>Loading your TikTok account…</span>
        </div>
      ) : error ? (
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-error)' }}>{error}</span>
      ) : info ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {info.avatarUrl && (
            <img src={info.avatarUrl} alt="" width={24} height={24} style={{ borderRadius: '50%' }} />
          )}
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-700)' }}>
            Publishing to <strong>{info.nickname}</strong>
          </span>
        </div>
      ) : null}

      {mediaWarning && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 14px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-warning-bg)',
          fontSize: 'var(--text-xs)',
          color: '#92400E',
        }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="7" cy="7" r="6" />
            <line x1="7" y1="4.5" x2="7" y2="7.5" />
            <circle cx="7" cy="10" r="0.5" fill="currentColor" />
          </svg>
          {mediaWarning}
        </div>
      )}

      {!isPhotoPost && info?.maxVideoPostDurationSec ? (
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', margin: 0 }}>
          Videos on this account can be up to {Math.floor(info.maxVideoPostDurationSec / 60)} min {info.maxVideoPostDurationSec % 60 ? `${info.maxVideoPostDurationSec % 60} sec ` : ''}long.
        </p>
      ) : null}

      {/* Privacy — no default; user must pick (TikTok UX requirement) */}
      <div>
        <FieldLabel required>Who can view this post</FieldLabel>
        <div style={{ position: 'relative' }}>
          <select
            className="input"
            value={ttData.privacyLevel}
            disabled={!info}
            onChange={(e) => onField('privacyLevel', e.target.value)}
            style={{ appearance: 'none', paddingRight: '36px', cursor: 'pointer', fontSize: 'var(--text-sm)' }}
          >
            <option value="" disabled>Select privacy…</option>
            {privacyOptions.map((value) => (
              <option
                key={value}
                value={value}
                disabled={value === 'SELF_ONLY' && ttData.brandContentToggle}
              >
                {TIKTOK_PRIVACY_LABELS[value] ?? value}
                {value === 'SELF_ONLY' && ttData.brandContentToggle ? ' (unavailable for branded content)' : ''}
              </option>
            ))}
          </select>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--stone-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}><polyline points="4 6 8 10 12 6" /></svg>
        </div>
      </div>

      {/* Interactions — all off by default; greyed out when disabled in the TikTok app */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <FieldLabel>Allow users to</FieldLabel>
        <label style={{ ...checkboxRow, ...(info?.commentDisabled ? { cursor: 'not-allowed', opacity: 0.5 } : {}) }}>
          <input
            type="checkbox"
            checked={!info?.commentDisabled && !ttData.disableComment}
            disabled={!!info?.commentDisabled}
            onChange={(e) => onField('disableComment', !e.target.checked)}
            style={{ accentColor: 'var(--color-primary)' }}
          />
          <span style={checkboxText}>Comment{info?.commentDisabled ? ' (disabled in your TikTok settings)' : ''}</span>
        </label>
        {!isPhotoPost && (
          <>
            <label style={{ ...checkboxRow, ...(info?.duetDisabled ? { cursor: 'not-allowed', opacity: 0.5 } : {}) }}>
              <input
                type="checkbox"
                checked={!info?.duetDisabled && !ttData.disableDuet}
                disabled={!!info?.duetDisabled}
                onChange={(e) => onField('disableDuet', !e.target.checked)}
                style={{ accentColor: 'var(--color-primary)' }}
              />
              <span style={checkboxText}>Duet{info?.duetDisabled ? ' (disabled in your TikTok settings)' : ''}</span>
            </label>
            <label style={{ ...checkboxRow, ...(info?.stitchDisabled ? { cursor: 'not-allowed', opacity: 0.5 } : {}) }}>
              <input
                type="checkbox"
                checked={!info?.stitchDisabled && !ttData.disableStitch}
                disabled={!!info?.stitchDisabled}
                onChange={(e) => onField('disableStitch', !e.target.checked)}
                style={{ accentColor: 'var(--color-primary)' }}
              />
              <span style={checkboxText}>Stitch{info?.stitchDisabled ? ' (disabled in your TikTok settings)' : ''}</span>
            </label>
          </>
        )}
      </div>

      {/* AI-generated content label */}
      <label style={checkboxRow}>
        <input
          type="checkbox"
          checked={ttData.isAigc}
          onChange={(e) => onField('isAigc', e.target.checked)}
          style={{ accentColor: 'var(--color-primary)' }}
        />
        <span style={checkboxText}>AI-generated content</span>
      </label>

      {/* Photo posts only: TikTok picks a recommended track when this is on. Off by
          default so posts don't land with unexpected background music. */}
      {isPhotoPost && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <label style={checkboxRow}>
            <input
              type="checkbox"
              checked={!!ttData.autoAddMusic}
              onChange={(e) => onField('autoAddMusic', e.target.checked)}
              style={{ accentColor: 'var(--color-primary)' }}
            />
            <span style={checkboxText}>Add recommended music</span>
          </label>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', margin: '0 0 0 24px' }}>
            TikTok will automatically pick a track for this photo post. Leave off for no background music.
          </p>
        </div>
      )}

      {/* Commercial content disclosure (TikTok UX requirement) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <label style={checkboxRow}>
          <input
            type="checkbox"
            checked={disclosureOn}
            onChange={(e) => onField('discloseCommercial', e.target.checked)}
            style={{ accentColor: 'var(--color-primary)' }}
          />
          <span style={checkboxText}>Disclose video content</span>
        </label>
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', margin: '0 0 0 24px' }}>
          Turn on if this post promotes goods or services in exchange for something of value.
        </p>
        {disclosureOn && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginLeft: '24px' }}>
            <label style={checkboxRow}>
              <input
                type="checkbox"
                checked={ttData.brandOrganicToggle}
                onChange={(e) => onField('brandOrganicToggle', e.target.checked)}
                style={{ accentColor: 'var(--color-primary)' }}
              />
              <span style={checkboxText}>Your brand</span>
            </label>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', margin: '0 0 0 24px' }}>
              You are promoting yourself or your own business.
            </p>
            <label style={{ ...checkboxRow, ...(brandedDisabled ? { cursor: 'not-allowed', opacity: 0.5 } : {}) }}>
              <input
                type="checkbox"
                checked={ttData.brandContentToggle}
                disabled={brandedDisabled}
                onChange={(e) => onField('brandContentToggle', e.target.checked)}
                style={{ accentColor: 'var(--color-primary)' }}
              />
              <span style={checkboxText}>Branded content</span>
            </label>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', margin: '0 0 0 24px' }}>
              {brandedDisabled
                ? 'Branded content can\'t be posted as "Only me". Switch visibility to Public or Friends.'
                : 'You are promoting another brand or a third party (paid partnership).'}
            </p>
            {(ttData.brandContentToggle || ttData.brandOrganicToggle) && (
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-500)', margin: 0 }}>
                {ttData.brandContentToggle
                  ? 'Your photo/video will be labeled as "Paid partnership".'
                  : 'Your photo/video will be labeled as "Promotional content".'}
              </p>
            )}
          </div>
        )}
      </div>

      <div>
        <FieldLabel>Cover frame timestamp (seconds)</FieldLabel>
        <input
          className="input"
          type="number"
          min="0"
          step="0.1"
          placeholder="e.g. 2.5"
          value={ttData.thumbnailTimestamp ?? ''}
          // A NUMBER, not a string: the TikTok handler gates this field on
          // `typeof === 'number'`, so String(Number(v)) meant a cover set here
          // was silently dropped at publish time.
          onChange={(e) => onField('thumbnailTimestamp', e.target.value ? Number(e.target.value) : '')}
          style={{ fontSize: 'var(--text-sm)', width: '120px' }}
        />
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', margin: '4px 0 0' }}>
          Pick which frame to use as the video cover
        </p>
      </div>

      {/* Compliance declaration + processing notice (TikTok UX requirement) */}
      <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-500)', margin: 0 }}>
        By posting, you agree to TikTok's{' '}
        {ttData.brandContentToggle && (
          <>
            <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)' }}>Branded Content Policy</a>
            {' and '}
          </>
        )}
        <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)' }}>Music Usage Confirmation</a>.
      </p>
      <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', margin: 0 }}>
        After publishing, TikTok may take a few minutes to process your post before it appears on your profile.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function PlatformOptions({
  selectedChannels,
  platformSpecific,
  onChange,
  postTypes,
  onPostTypeOverride,
  mediaWarning,
  containerStyle,
}: PlatformOptionsProps) {
  const facebookChannels = selectedChannels.filter((c) => c.platform === 'facebook');
  const xChannels = selectedChannels.filter((c) => c.platform === 'x');
  const pinterestChannels = selectedChannels.filter((c) => c.platform === 'pinterest');
  const gmbChannels = selectedChannels.filter((c) => c.platform === 'gmb');
  const youtubeChannels = selectedChannels.filter((c) => c.platform === 'youtube');
  const tiktokChannels = selectedChannels.filter((c) => c.platform === 'tiktok');
  const linkedinChannels = selectedChannels.filter((c) => c.platform === 'linkedin');
  const instagramChannels = selectedChannels.filter((c) => c.platform === 'instagram');
  const threadsChannels = selectedChannels.filter((c) => c.platform === 'threads');
  const redditChannels = selectedChannels.filter((c) => c.platform === 'reddit');
  const discordChannels = selectedChannels.filter((c) => c.platform === 'discord');
  const tumblrChannels = selectedChannels.filter((c) => c.platform === 'tumblr');
  const snapchatChannels = selectedChannels.filter((c) => c.platform === 'snapchat');

  const hasFacebook = facebookChannels.length > 0;
  const hasX = xChannels.length > 0;
  const hasPinterest = pinterestChannels.length > 0;
  const hasGmb = gmbChannels.length > 0;
  const hasYouTube = youtubeChannels.length > 0;
  const hasTikTok = tiktokChannels.length > 0;
  const hasLinkedIn = linkedinChannels.length > 0;
  const hasInstagram = instagramChannels.length > 0;
  const hasThreads = threadsChannels.length > 0;
  const hasReddit = redditChannels.length > 0;
  const hasDiscord = discordChannels.length > 0;
  const hasTumblr = tumblrChannels.length > 0;
  const hasSnapchat = snapchatChannels.length > 0;

  // Show LinkedIn carousel toggle when in carousel/gallery mode
  const linkedinPostType = postTypes?.linkedin;
  const showLinkedInCarouselToggle = hasLinkedIn && (linkedinPostType === 'multi_image' || linkedinPostType === 'pdf_carousel');

  /**
   * Trial Reels exist only on the Reel post type: Instagram accepts
   * `trial_params` on the Reel container and nowhere else, so the handler
   * reads it in publishReel alone and a feed video posts as a plain Reel.
   * The control is therefore shown for the Reel type only, and a value left
   * behind by a post-type switch is cleared rather than quietly dropped at
   * publish time.
   */
  const igPostType = postTypes?.instagram;
  const showTrialReel = hasInstagram && igPostType === 'reel';
  /*
   * Co-authors work on every Instagram post type except a Story, which has no
   * co-author concept. Unknown post type keeps the field.
   */
  const showCollaborators = hasInstagram && igPostType !== 'story';

  /*
   * A cover is only read where a video plays: Instagram reads it on the
   * feed-video and Reel containers, Facebook on a video post and a Reel but
   * never a Story. An UNKNOWN post type keeps the controls, since a caller
   * that passes none would otherwise lose the capability entirely.
   */
  const showIgCover = hasInstagram
    && (igPostType === undefined || igPostType === 'reel' || igPostType === 'feed_video');
  const showFbCover = hasFacebook && postTypes?.facebook !== 'story';
  const igTrialChosen = platformSpecific.instagram?.trialReel !== undefined
    || platformSpecific.instagram?.graduationStrategy !== undefined;
  useEffect(() => {
    if (!postTypes || !hasInstagram || igPostType === 'reel' || !igTrialChosen) return;
    const { trialReel: _trialReel, graduationStrategy: _graduationStrategy, ...rest } = platformSpecific.instagram ?? {};
    onChange({ ...platformSpecific, instagram: rest });
    // Reacts to the post type changing; the clear makes igTrialChosen false,
    // so it cannot re-fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postTypes, hasInstagram, igPostType, igTrialChosen]);

  if (!hasFacebook && !hasX && !hasPinterest && !hasGmb && !hasYouTube && !hasTikTok && !showLinkedInCarouselToggle && !hasInstagram && !hasThreads && !hasReddit && !hasDiscord && !hasTumblr && !hasSnapchat) return null;

  /* ---- X handlers ---- */
  const xData = platformSpecific.x ?? { replySettings: 'everyone' };
  const handleXChange = (field: string, value: string) => {
    onChange({
      ...platformSpecific,
      x: { ...xData, [field]: value },
    });
  };

  /* ---- Pinterest handlers ---- */

  const handleBoardSelect = (channelId: number, boardId: string) => {
    const existing = platformSpecific.pinterest ?? {};
    onChange({
      ...platformSpecific,
      pinterest: {
        ...existing,
        [channelId]: { boardId },
      },
    });
  };

  const handlePinterestField = (field: string, value: string) => {
    const existing = platformSpecific.pinterest ?? {};
    onChange({
      ...platformSpecific,
      pinterest: { ...existing, [field]: value },
    });
  };

  /* ---- YouTube handlers ---- */

  const ytData = platformSpecific.youtube ?? { title: '', privacyStatus: 'public', categoryId: '22', madeForKids: false, playlistId: '' };

  const handleYtChange = (field: string, value: string | boolean) => {
    onChange({
      ...platformSpecific,
      youtube: { ...ytData, [field]: value },
    });
  };

  /* ---- TikTok handlers ---- */

  // TikTok UX guidelines: privacy has NO default (user must pick one manually) and
  // every interaction is off until the user turns it on, so the disable_* flags
  // start true. Commercial disclosure starts off.
  const ttData = platformSpecific.tiktok ?? {
    privacyLevel: '', disableDuet: true, disableStitch: true,
    disableComment: true, isAigc: false, discloseCommercial: false,
    brandContentToggle: false, brandOrganicToggle: false, autoAddMusic: false,
  };

  const handleTtChange = (field: string, value: string | boolean | number) => {
    let next = { ...ttData, [field]: value };
    // Turning the disclosure toggle off clears both disclosure options.
    if (field === 'discloseCommercial' && value === false) {
      next = { ...next, brandContentToggle: false, brandOrganicToggle: false };
    }
    onChange({
      ...platformSpecific,
      tiktok: next,
    });
  };

  /* ---- GMB handlers ---- */

  const gmbPostType = postTypes?.gmb;
  const gmbData = platformSpecific.gmb ?? {
    ctaType: '', ctaUrl: '',
    eventTitle: '', startDate: '', startTime: '', endDate: '', endTime: '',
    couponCode: '', redeemOnlineUrl: '', termsConditions: '',
  };

  const handleGmbField = (field: string, value: string) => {
    onChange({
      ...platformSpecific,
      gmb: { ...gmbData, [field]: value },
    });
  };

  const handleGmbCtaType = (ctaType: string) => {
    onChange({
      ...platformSpecific,
      gmb: { ...gmbData, ctaType },
    });
  };

  const handleGmbCtaUrl = (ctaUrl: string) => {
    onChange({
      ...platformSpecific,
      gmb: { ...gmbData, ctaUrl },
    });
  };

  /* ---- Reddit / Discord handlers ---- */

  const handleRedditPatch = (channelId: number, patch: Record<string, string>) => {
    const existing = platformSpecific.reddit ?? {};
    onChange({
      ...platformSpecific,
      reddit: { ...existing, [channelId]: { ...existing[channelId], ...patch } },
    });
  };

  const handleDiscordChannel = (channelId: number, discordChannelId: string) => {
    const existing = platformSpecific.discord ?? {};
    onChange({
      ...platformSpecific,
      discord: { ...existing, [channelId]: { channelId: discordChannelId } },
    });
  };

  /* ---- Tumblr handlers ---- */
  /* ---- Snapchat handlers ---- */
  const handleSnapchatPatch = (channelId: number, patch: Record<string, unknown>) => {
    const existing = platformSpecific.snapchat ?? {};
    onChange({
      ...platformSpecific,
      snapchat: { ...existing, [channelId]: { ...(existing[channelId] ?? {}), ...patch } },
    });
  };

  const handleTumblrPatch = (channelId: number, patch: Record<string, unknown>) => {
    const existing = platformSpecific.tumblr ?? {};
    onChange({
      ...platformSpecific,
      tumblr: { ...existing, [channelId]: { ...(existing[channelId] ?? {}), ...patch } },
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '0 20px 16px', ...containerStyle }}>
      {/* LinkedIn carousel type */}
      {showLinkedInCarouselToggle && onPostTypeOverride && (
        <div style={sectionStyle}>
          <div style={sectionHeadingStyle}>
            <img src="/assets/platforms/linkedin.svg" alt="" width={20} height={20} />
            LinkedIn
          </div>
          <div>
            <FieldLabel>Carousel type</FieldLabel>
            <div style={{ position: 'relative' }}>
              <select
                className="input"
                value={linkedinPostType === 'pdf_carousel' ? 'pdf_carousel' : 'multi_image'}
                onChange={(e) => onPostTypeOverride('linkedin', e.target.value)}
                style={{ appearance: 'none', paddingRight: '36px', cursor: 'pointer', fontSize: 'var(--text-sm)' }}
              >
                <option value="multi_image">Image Gallery</option>
                <option value="pdf_carousel">PDF Carousel</option>
              </select>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--stone-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}><polyline points="4 6 8 10 12 6" /></svg>
            </div>
          </div>
        </div>
      )}

      {/* Facebook options */}
      {hasFacebook && (
        <div style={sectionStyle}>
          <div style={sectionHeadingStyle}>
            <img src="/assets/platforms/facebook.svg" alt="" width={20} height={20} />
            Facebook
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={platformSpecific.facebook?.shareToStory ?? false}
              onChange={(e) => onChange({
                ...platformSpecific,
                facebook: { ...platformSpecific.facebook, shareToStory: e.target.checked },
              })}
            />
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-700)' }}>Also share to Story</span>
          </label>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', margin: '4px 0 0 26px' }}>
            Posts the first image or video as a Facebook Story (disappears after 24h)
          </p>

          {showFbCover && (
            <div style={{ marginTop: '12px' }}>
              <FieldLabel>Video cover</FieldLabel>
              <CoverImagePicker
                value={platformSpecific.facebook?.thumbnailUrl ?? ''}
                onChange={(url) => onChange({
                  ...platformSpecific,
                  facebook: { ...platformSpecific.facebook, thumbnailUrl: url || undefined },
                })}
                placeholder="https://example.com/cover.jpg"
              />
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>
                Videos only. Applied a moment after publishing, because Facebook accepts a
                cover once the video exists. Leave blank and Facebook picks a frame.
              </span>
            </div>
          )}
        </div>
      )}

      {/* Instagram options */}
      {hasInstagram && (
        <div style={sectionStyle}>
          <div style={sectionHeadingStyle}>
            <img src="/assets/platforms/instagram.svg" alt="" width={20} height={20} />
            Instagram
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={platformSpecific.instagram?.shareToStory ?? false}
              onChange={(e) => onChange({
                ...platformSpecific,
                instagram: { ...platformSpecific.instagram, shareToStory: e.target.checked },
              })}
            />
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-700)' }}>Also share to Story</span>
          </label>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', margin: '4px 0 0 26px' }}>
            Posts the first image or video as an Instagram Story (disappears after 24h)
          </p>
          {showCollaborators && (
          <div style={{ marginTop: '12px' }}>
            <FieldLabel>Collaborators</FieldLabel>
            <input
              className="input"
              type="text"
              placeholder="username1, username2"
              value={platformSpecific.instagram?.collaborators ?? ''}
              onChange={(e) => onChange({
                ...platformSpecific,
                instagram: { ...platformSpecific.instagram, collaborators: e.target.value },
              })}
              style={{ fontSize: 'var(--text-sm)' }}
            />
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', margin: '4px 0 0' }}>
              Comma-separated Instagram usernames (without @)
            </p>
          </div>
          )}
          {showTrialReel && (
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginTop: '12px' }}>
            <input
              type="checkbox"
              checked={platformSpecific.instagram?.trialReel ?? false}
              onChange={(e) => onChange({
                ...platformSpecific,
                instagram: { ...platformSpecific.instagram, trialReel: e.target.checked },
              })}
            />
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-700)' }}>Trial Reel</span>
          </label>
          )}
          {showTrialReel && (
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', margin: '4px 0 0 26px' }}>
            Shows the Reel to people who do not follow you, so you can see how it lands before it reaches your followers.
          </p>
          )}
          {showTrialReel && platformSpecific.instagram?.trialReel && (
            <div style={{ marginTop: '8px', marginLeft: '26px' }}>
              <FieldLabel>Graduation</FieldLabel>
              <div style={{ position: 'relative' }}>
                <select
                  className="input"
                  value={platformSpecific.instagram?.graduationStrategy ?? 'manual'}
                  onChange={(e) => onChange({
                    ...platformSpecific,
                    instagram: { ...platformSpecific.instagram, graduationStrategy: e.target.value as 'manual' | 'auto' },
                  })}
                  style={{ fontSize: 'var(--text-sm)', appearance: 'none', paddingRight: '32px' }}
                >
                  <option value="manual">Manual: you decide when to share publicly</option>
                  <option value="auto">Auto: Instagram shares based on performance</option>
                </select>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--stone-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}><polyline points="4 6 8 10 12 6" /></svg>
              </div>
            </div>
          )}
          {showIgCover && (
            <div style={{ marginTop: '12px' }}>
              <FieldLabel>Thumbnail timestamp (seconds)</FieldLabel>
              <input
                className="input"
                type="number"
                min="0"
                step="0.1"
                placeholder="e.g. 2.5"
                value={platformSpecific.instagram?.thumbnailTimestamp ?? ''}
                onChange={(e) => onChange({
                  ...platformSpecific,
                  instagram: { ...platformSpecific.instagram, thumbnailTimestamp: e.target.value ? Number(e.target.value) : undefined },
                })}
                style={{ fontSize: 'var(--text-sm)', width: '120px' }}
              />
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', margin: '4px 0 0' }}>
                Pick which frame to use as the video cover
              </p>
            </div>
          )}

          {/* A cover IMAGE beats the timestamp — Instagram accepts either, and
              sends cover_url when both are present. */}
          {showIgCover && (
            <div style={{ marginTop: '12px' }}>
              <FieldLabel>Cover image</FieldLabel>
              <CoverImagePicker
                value={platformSpecific.instagram?.coverUrl ?? ''}
                onChange={(url) => onChange({
                  ...platformSpecific,
                  instagram: { ...platformSpecific.instagram, coverUrl: url || undefined },
                })}
                placeholder="https://example.com/cover.jpg"
              />
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>
                Set this and the timestamp above is ignored.
              </span>
            </div>
          )}
        </div>
      )}

      {/* Threads options */}
      {hasThreads && (
        <div style={sectionStyle}>
          <div style={sectionHeadingStyle}>
            <img src="/assets/platforms/threads.svg" alt="" width={20} height={20} />
            Threads
          </div>
          <div>
            <FieldLabel>Quote post ID</FieldLabel>
            <input
              className="input"
              type="text"
              placeholder="Threads post ID to quote"
              value={platformSpecific.threads?.quotePostId ?? ''}
              onChange={(e) => onChange({
                ...platformSpecific,
                threads: { ...platformSpecific.threads, quotePostId: e.target.value },
              })}
              style={{ fontSize: 'var(--text-sm)' }}
            />
          </div>
        </div>
      )}

      {/* Reddit options */}
      {hasReddit && (
        <div style={sectionStyle}>
          <div style={sectionHeadingStyle}>
            <img src="/assets/platforms/reddit.svg" alt="" width={20} height={20} />
            Reddit
          </div>
          {redditChannels.map((ch) => (
            <RedditSettings
              key={ch.channelId}
              channelId={ch.channelId}
              value={platformSpecific.reddit?.[ch.channelId] ?? {}}
              onPatch={(patch) => handleRedditPatch(ch.channelId, patch as Record<string, string>)}
            />
          ))}
        </div>
      )}

      {/* Discord options */}
      {hasDiscord && (
        <div style={sectionStyle}>
          <div style={sectionHeadingStyle}>
            <img src="/assets/platforms/discord.svg" alt="" width={20} height={20} />
            Discord
          </div>
          <div>
            <FieldLabel required>Channel</FieldLabel>
            {discordChannels.map((ch) => (
              <div key={ch.channelId} style={{ marginTop: '4px' }}>
                <DiscordChannelSelector
                  channelId={ch.channelId}
                  selectedChannelId={platformSpecific.discord?.[ch.channelId]?.channelId ?? ''}
                  onSelect={(id) => handleDiscordChannel(ch.channelId, id)}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {hasSnapchat && (
        <div style={sectionStyle}>
          <div style={sectionHeadingStyle}>
            <img src="/assets/platforms/snapchat.svg" alt="" width={20} height={20} />
            Snapchat
          </div>
          {(() => {
            const snapType = postTypes?.snapchat || 'story';
            return snapchatChannels.map((ch) => {
              const sc = platformSpecific.snapchat?.[ch.channelId] ?? {};
              return (
                <div key={ch.channelId} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {snapType === 'saved_story' && (
                    <div>
                      <FieldLabel>Saved Story title</FieldLabel>
                      <input
                        className="input"
                        type="text"
                        maxLength={45}
                        value={sc.title ?? ''}
                        placeholder="Defaults to the first line of your caption"
                        onChange={(e) => handleSnapchatPatch(ch.channelId, { title: e.target.value })}
                        style={{ fontSize: 'var(--text-sm)' }}
                      />
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', marginTop: '4px' }}>
                        Max 45 characters. Saved Stories are pinned permanently to your public profile. Only the title is sent to Snapchat, not the caption.
                      </div>
                    </div>
                  )}
                  {snapType === 'spotlight' && (
                    <>
                      <div>
                        <FieldLabel>Spotlight locale</FieldLabel>
                        <input
                          className="input"
                          type="text"
                          value={sc.locale ?? ''}
                          placeholder="en_US"
                          onChange={(e) => handleSnapchatPatch(ch.channelId, { locale: e.target.value })}
                          style={{ fontSize: 'var(--text-sm)', maxWidth: '160px' }}
                        />
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', marginTop: '4px' }}>
                          The caption becomes the Spotlight description (max 160 chars, #hashtags are clickable). Spotlight needs a vertical video, 6–60 seconds.
                        </div>
                      </div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-sm)', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={sc.saveToProfile !== false}
                          onChange={(e) => handleSnapchatPatch(ch.channelId, { saveToProfile: e.target.checked })}
                        />
                        Also save to profile
                      </label>
                    </>
                  )}
                  {snapType !== 'saved_story' && snapType !== 'spotlight' && (
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>
                      Stories post one image or video (5–60s) as a snap on your public story for 24 hours. The caption is not sent to Snapchat.
                    </div>
                  )}
                </div>
              );
            });
          })()}
        </div>
      )}

      {hasTumblr && (
        <div style={sectionStyle}>
          <div style={sectionHeadingStyle}>
            <img src="/assets/platforms/tumblr.svg" alt="" width={20} height={20} />
            Tumblr
          </div>
          {tumblrChannels.map((ch) => {
            const t = platformSpecific.tumblr?.[ch.channelId] ?? {};
            return (
              <div key={ch.channelId} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div>
                  <FieldLabel>Blog</FieldLabel>
                  <TumblrBlogSelector
                    channelId={ch.channelId}
                    selectedBlog={t.blogName ?? ''}
                    onSelect={(blogName) => handleTumblrPatch(ch.channelId, { blogName })}
                  />
                </div>
                <div>
                  <FieldLabel>Title</FieldLabel>
                  <input
                    className="input"
                    type="text"
                    value={t.title ?? ''}
                    placeholder="Optional heading above the post"
                    onChange={(e) => handleTumblrPatch(ch.channelId, { title: e.target.value })}
                    style={{ fontSize: 'var(--text-sm)' }}
                  />
                </div>
                <div>
                  <FieldLabel>Tags</FieldLabel>
                  <input
                    className="input"
                    type="text"
                    value={(t.tags ?? []).join(',')}
                    placeholder="art, design, photography"
                    onChange={(e) =>
                      handleTumblrPatch(ch.channelId, {
                        // Preserve the raw segments while this controlled input is
                        // being edited. Trimming/filtering here removes a trailing
                        // comma or space on the rerender, making it impossible to
                        // type the next tag or a multi-word tag. The Tumblr handler
                        // normalizes these segments immediately before publishing.
                        tags: e.target.value.split(','),
                      })
                    }
                    style={{ fontSize: 'var(--text-sm)' }}
                  />
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', marginTop: '4px' }}>
                    Comma-separated. Tumblr tags drive discovery, so they matter more here than elsewhere.
                  </div>
                </div>
                <div>
                  <FieldLabel>Link</FieldLabel>
                  <input
                    className="input"
                    type="text"
                    value={t.link ?? ''}
                    placeholder="https://example.com"
                    onChange={(e) => handleTumblrPatch(ch.channelId, { link: e.target.value })}
                    style={{ fontSize: 'var(--text-sm)' }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* X options */}
      {hasX && (
        <div style={sectionStyle}>
          <div style={sectionHeadingStyle}>
            <img src="/assets/platforms/x.svg" alt="" width={20} height={20} />
            X
          </div>
          <div>
            <FieldLabel>Who can reply</FieldLabel>
            <div style={{ position: 'relative' }}>
              <select
                className="input"
                value={xData.replySettings}
                onChange={(e) => handleXChange('replySettings', e.target.value)}
                style={{ appearance: 'none', paddingRight: '36px', cursor: 'pointer', fontSize: 'var(--text-sm)' }}
              >
                {X_REPLY_SETTINGS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--stone-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}><polyline points="4 6 8 10 12 6" /></svg>
            </div>
          </div>
        </div>
      )}

      {/* Pinterest options */}
      {hasPinterest && (
        <div style={sectionStyle}>
          <div style={sectionHeadingStyle}>
            <img src="/assets/platforms/pinterest.svg" alt="" width={20} height={20} />
            Pinterest
          </div>
          {/* Link */}
          <div>
            <FieldLabel>Destination URL</FieldLabel>
            <input
              className="input"
              type="url"
              placeholder="https://example.com"
              value={platformSpecific.pinterest?.link ?? ''}
              onChange={(e) => handlePinterestField('link', e.target.value)}
              style={{ fontSize: 'var(--text-sm)' }}
            />
          </div>

          {/* Board selector */}
          <div>
            <FieldLabel>Board</FieldLabel>
            {pinterestChannels.map((ch) => {
              const boardId = platformSpecific.pinterest?.[ch.channelId]?.boardId ?? '';
              return (
                <div key={ch.channelId}>
                  <PinterestBoardSelector
                    channelId={ch.channelId}
                    selectedBoardId={boardId}
                    onSelect={(id) => handleBoardSelect(ch.channelId, id)}
                  />
                </div>
              );
            })}
          </div>

          {/* Cover image (video pins) */}
          <div>
            <FieldLabel>Cover image</FieldLabel>
            <CoverImagePicker
              value={(platformSpecific.pinterest as any)?.coverImageUrl ?? ''}
              onChange={(url) => handlePinterestField('coverImageUrl', url)}
            />
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>
              Video pins only. Leave blank to use a frame from your video.
            </span>
          </div>

          {/* Dominant color */}
          <div>
            <FieldLabel>Dominant color</FieldLabel>
            <input
              className="input"
              type="text"
              placeholder="#FF5733"
              value={(platformSpecific.pinterest as any)?.dominantColor ?? ''}
              onChange={(e) => handlePinterestField('dominantColor', e.target.value)}
              style={{ fontSize: 'var(--text-sm)' }}
            />
          </div>
        </div>
      )}

      {/* GMB options */}
      {hasGmb && (
        <div style={sectionStyle}>
          <div style={sectionHeadingStyle}>
            <img src="/assets/platforms/gmb.svg" alt="" width={20} height={20} />
            Google Business
          </div>
          {/* CTA Type */}
          <div>
            <FieldLabel>CTA Type</FieldLabel>
            <div style={{ position: 'relative' }}>
              <select
                className="input"
                value={gmbData.ctaType}
                onChange={(e) => handleGmbCtaType(e.target.value)}
                style={{
                  appearance: 'none',
                  paddingRight: '36px',
                  cursor: 'pointer',
                  fontSize: 'var(--text-sm)',
                }}
              >
                <option value="">None</option>
                {GMB_CTA_TYPES.map((ct) => (
                  <option key={ct.value} value={ct.value}>
                    {ct.label}
                  </option>
                ))}
              </select>
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="var(--stone-400)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{
                  position: 'absolute',
                  right: '12px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  pointerEvents: 'none',
                }}
              >
                <polyline points="4 6 8 10 12 6" />
              </svg>
            </div>
          </div>

          {/* CTA URL — not needed for CALL (uses listing phone number) */}
          {gmbData.ctaType && gmbData.ctaType !== 'CALL' && (
            <div>
              <FieldLabel required>CTA URL</FieldLabel>
              <input
                className="input"
                type="url"
                placeholder="https://example.com"
                value={gmbData.ctaUrl}
                onChange={(e) => handleGmbCtaUrl(e.target.value)}
                style={{ fontSize: 'var(--text-sm)' }}
              />
            </div>
          )}
          {gmbData.ctaType === 'CALL' && (
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', margin: 0 }}>
              Uses the phone number from your Google Business listing.
            </p>
          )}

          {/* Event / Offer fields */}
          {(gmbPostType === 'event' || gmbPostType === 'offer') && (<>
          {/* Event / Offer Title */}
          <div>
            <FieldLabel required>{gmbPostType === 'event' ? 'Event' : 'Offer'} Title</FieldLabel>
            <input
              className="input"
              type="text"
              placeholder={gmbPostType === 'event' ? 'Summer Music Festival' : '20% Off Everything'}
              value={gmbData.eventTitle}
              onChange={(e) => handleGmbField('eventTitle', e.target.value)}
              style={{ fontSize: 'var(--text-sm)' }}
            />
          </div>

          {/* Start Date / Time */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <div style={{ flex: 1 }}>
              <FieldLabel required>Start Date</FieldLabel>
              <input
                className="input"
                type="date"
                value={gmbData.startDate}
                onChange={(e) => handleGmbField('startDate', e.target.value)}
                style={{ fontSize: 'var(--text-sm)' }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <FieldLabel>Start Time</FieldLabel>
              <input
                className="input"
                type="time"
                value={gmbData.startTime}
                onChange={(e) => handleGmbField('startTime', e.target.value)}
                style={{ fontSize: 'var(--text-sm)' }}
              />
            </div>
          </div>

          {/* End Date / Time */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <div style={{ flex: 1 }}>
              <FieldLabel required>End Date</FieldLabel>
              <input
                className="input"
                type="date"
                value={gmbData.endDate}
                onChange={(e) => handleGmbField('endDate', e.target.value)}
                style={{ fontSize: 'var(--text-sm)' }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <FieldLabel>End Time</FieldLabel>
              <input
                className="input"
                type="time"
                value={gmbData.endTime}
                onChange={(e) => handleGmbField('endTime', e.target.value)}
                style={{ fontSize: 'var(--text-sm)' }}
              />
            </div>
          </div>

          {/* Offer-only fields */}
          {gmbPostType === 'offer' && (
            <>
              <div>
                <FieldLabel>Coupon Code</FieldLabel>
                <input
                  className="input"
                  type="text"
                  placeholder="SAVE20"
                  value={gmbData.couponCode}
                  onChange={(e) => handleGmbField('couponCode', e.target.value)}
                  style={{ fontSize: 'var(--text-sm)' }}
                />
              </div>
              <div>
                <FieldLabel>Redeem Online URL</FieldLabel>
                <input
                  className="input"
                  type="url"
                  placeholder="https://example.com/redeem"
                  value={gmbData.redeemOnlineUrl}
                  onChange={(e) => handleGmbField('redeemOnlineUrl', e.target.value)}
                  style={{ fontSize: 'var(--text-sm)' }}
                />
              </div>
              <div>
                <FieldLabel>Terms & Conditions</FieldLabel>
                <textarea
                  className="input"
                  placeholder="Valid for in-store purchases only..."
                  value={gmbData.termsConditions}
                  onChange={(e) => handleGmbField('termsConditions', e.target.value)}
                  rows={2}
                  style={{ fontSize: 'var(--text-sm)', resize: 'vertical' }}
                />
              </div>
            </>
          )}
          </>)}
        </div>
      )}

      {/* TikTok options */}
      {hasTikTok && (
        <TikTokSection
          channelId={tiktokChannels[0].channelId}
          ttData={ttData}
          onField={handleTtChange}
          mediaWarning={mediaWarning}
          isPhotoPost={postTypes?.tiktok === 'photo_slideshow'}
        />
      )}

      {/* YouTube options */}
      {hasYouTube && (
        <div style={sectionStyle}>
          <div style={sectionHeadingStyle}>
            <img src="/assets/platforms/youtube.svg" alt="" width={20} height={20} />
            YouTube
          </div>
          {mediaWarning && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 14px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-warning-bg)',
              fontSize: 'var(--text-xs)',
              color: '#92400E',
            }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="7" cy="7" r="6" />
                <line x1="7" y1="4.5" x2="7" y2="7.5" />
                <circle cx="7" cy="10" r="0.5" fill="currentColor" />
              </svg>
              {mediaWarning}
            </div>
          )}
          {/* Made for kids */}
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={ytData.madeForKids}
              onChange={(e) => handleYtChange('madeForKids', e.target.checked)}
              style={{ accentColor: 'var(--color-primary)' }}
            />
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-700)' }}>
              Made for kids
            </span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>
              (required by YouTube)
            </span>
          </label>

          {/* Visibility + Category row */}
          <div style={{ display: 'flex', gap: '12px' }}>
            <div style={{ flex: 1 }}>
              <FieldLabel required>Visibility</FieldLabel>
              <div style={{ position: 'relative' }}>
                <select
                  className="input"
                  value={ytData.privacyStatus}
                  onChange={(e) => handleYtChange('privacyStatus', e.target.value)}
                  style={{ appearance: 'none', paddingRight: '36px', cursor: 'pointer', fontSize: 'var(--text-sm)' }}
                >
                  {YOUTUBE_PRIVACY.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--stone-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}><polyline points="4 6 8 10 12 6" /></svg>
              </div>
            </div>

            <div style={{ flex: 1 }}>
              <FieldLabel required>Category</FieldLabel>
              <div style={{ position: 'relative' }}>
                <select
                  className="input"
                  value={ytData.categoryId}
                  onChange={(e) => handleYtChange('categoryId', e.target.value)}
                  style={{ appearance: 'none', paddingRight: '36px', cursor: 'pointer', fontSize: 'var(--text-sm)' }}
                >
                  {YOUTUBE_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--stone-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}><polyline points="4 6 8 10 12 6" /></svg>
              </div>
            </div>
          </div>

          {/* Playlist */}
          <div>
            <FieldLabel>Playlist</FieldLabel>
            {youtubeChannels.map((ch) => (
              <YouTubePlaylistSelector
                key={ch.channelId}
                channelId={ch.channelId}
                selectedPlaylistId={ytData.playlistId || ''}
                onSelect={(id) => handleYtChange('playlistId', id)}
              />
            ))}
          </div>

          {/* Thumbnail */}
          <div>
            <FieldLabel>Thumbnail</FieldLabel>
            <CoverImagePicker
              value={ytData.thumbnailUrl || ''}
              onChange={(url) => handleYtChange('thumbnailUrl', url)}
              placeholder="https://example.com/thumbnail.jpg"
            />
          </div>
        </div>
      )}
    </div>
  );
}
