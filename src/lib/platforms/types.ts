export type PlatformName =
  | 'facebook'
  | 'instagram'
  | 'x'
  | 'tiktok'
  | 'youtube'
  | 'threads'
  | 'bluesky'
  | 'pinterest'
  | 'gmb'
  | 'linkedin'
  | 'mastodon'
  | 'reddit'
  | 'discord'
  | 'telegram'
  | 'tumblr'
  | 'snapchat';

/**
 * Every platform the app knows about, in connect-grid display order.
 *
 * Lives here — in the dependency-free types module — so browser code can import
 * it without dragging in the env-reading availability module. `PlatformName[]`
 * plus the exhaustiveness check below means a new platform in the union that is
 * missing from this list fails to compile.
 */
export const ALL_PLATFORMS: PlatformName[] = [
  'facebook',
  'instagram',
  'x',
  'tiktok',
  'youtube',
  'threads',
  'bluesky',
  'pinterest',
  'gmb',
  'linkedin',
  'mastodon',
  'reddit',
  'discord',
  'telegram',
  'tumblr',
  'snapchat',
];

export const PLATFORM_DISPLAY_NAMES: Record<PlatformName, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  x: 'X',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  threads: 'Threads',
  bluesky: 'Bluesky',
  pinterest: 'Pinterest',
  gmb: 'Google Business',
  linkedin: 'LinkedIn',
  mastodon: 'Mastodon',
  reddit: 'Reddit',
  discord: 'Discord',
  telegram: 'Telegram',
  tumblr: 'Tumblr',
  snapchat: 'Snapchat',
};

/**
 * Brand accent per platform — the solid logo colour, used for icons, dots and
 * progress fills, and served to the marketing site through /api/platforms.
 *
 * Canonical because it had two disagreeing copies: the registry served Instagram
 * as #E1306C while every UI surface (and the marketing site's own fallback and
 * inline SVG) used #E4405F, so the public homepage rendered a different pink
 * than the app. #E4405F wins on weight of use.
 *
 * These are brand assets, not theme tokens, so they stay literal hex rather than
 * CSS variables — a platform's logo colour must not shift with our palette.
 */
export const PLATFORM_BRAND_COLORS: Record<PlatformName, string> = {
  facebook: '#1877F2',
  instagram: '#E4405F',
  x: '#000000',
  tiktok: '#000000',
  youtube: '#FF0000',
  threads: '#000000',
  bluesky: '#0085FF',
  pinterest: '#E60023',
  gmb: '#4285F4',
  linkedin: '#0A66C2',
  mastodon: '#6364FF',
  reddit: '#FF4500',
  discord: '#5865F2',
  telegram: '#26A5E4',
  tumblr: '#001935',
  snapchat: '#FFFC00',
};

export function platformDisplayName(platform: string): string {
  return PLATFORM_DISPLAY_NAMES[platform as PlatformName] || platform;
}

export interface TokenData {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  openId?: string;
  userId?: string;
}

export interface AccountInfo {
  id: string;
  name: string;
  profileImage?: string;
  accountType?: string;
}

export interface PublishResult {
  success: boolean;
  postId?: string;
  url?: string;
  error?: string;
  processing?: boolean;
  processingId?: string;
  /**
   * The failure was caused by an invalid/revoked access token that re-auth
   * won't fix on its own — the user must reconnect the account. The publish
   * worker uses this to flag the channel as needing reconnection. Set it for
   * definitive auth errors (e.g. Facebook error 190/200), not transient ones.
   */
  authExpired?: boolean;
}

export interface StatusResult {
  status: 'published' | 'processing' | 'failed';
  postId?: string;
  url?: string;
  message?: string;
  /**
   * The platform failed for a reason that is worth publishing again from
   * scratch (its own transient server/ingest error — not our media, not the
   * user's content). Polling the same id again is pointless once a platform
   * reports a terminal failure, so the status-check worker re-runs the whole
   * publish instead. Only set this where the platform documents the failure as
   * retryable; a content/format rejection would just fail identically.
   */
  retryable?: boolean;
}

export interface PostData {
  content: string;
  mediaUrls: string[];
  mediaFiles: MediaFileData[];
  postType?: string;
  platformSpecific?: Record<string, unknown>;
  linkPreview?: { title: string; description: string; image: string; url: string } | null;
}

export interface MediaFileData {
  url: string;
  localPath: string;
  mimeType: string;
  width?: number;
  height?: number;
  duration?: number;
  sizeBytes: number;
  altText?: string;
  /**
   * Public URL of the auto-generated poster frame (videos only, when the
   * derivative exists). Used as a still-image fallback where a platform
   * demands one — e.g. Pinterest video-pin cover images.
   *
   * Already converted to a format the target platform accepts: our stored
   * derivatives are WebP, which Pinterest and Reddit both reject. The publish
   * worker swaps in a converted copy per platform before handlers see this.
   */
  posterUrl?: string;
  /**
   * Storage key of the poster derivative behind `posterUrl`. Internal to the
   * publish worker, which needs the key (not the URL) to run the poster
   * through the same format conversion as attached images.
   */
  posterPath?: string;
}

export interface ChannelData {
  id: number;
  platform: PlatformName;
  accountId: string;
  accountName: string;
  accountType?: string;
  accessToken: string;
  refreshToken?: string;
  metadata?: Record<string, unknown>;
  // Optional — only populated for platforms that need it for cost tracking / quota enforcement (currently X).
  // Other handlers ignore it.
  organizationId?: number;
}

export interface PostTypeOption {
  value: string;
  label: string;
  description?: string;
  mediaRequired?: boolean;
  maxMedia?: number;
  minMedia?: number;
  allowedMediaTypes?: ('image' | 'video')[];
}

export interface PlatformMediaRules {
  maxSizeMB?: number;
  formats?: string[];
  maxCount?: number;
  maxDurationSec?: number;
  minDurationSec?: number;
  aspectRatios?: string[];
  orientation?: 'vertical' | 'horizontal' | 'any';
  maxChars?: number;
  maxDimension?: number; // max pixels on either side
}

export interface ThreadPublishResult {
  success: boolean;
  posts?: Array<{
    sequence: number;
    postId: string;
    url: string;
    parentId?: string;
  }>;
  error?: string;
  /**
   * Same contract as {@link PublishResult.authExpired}: the failure was a dead
   * token, not a transient error, so the worker must not defer for retry and
   * should flag the channel for reconnect. The worker already reads this on the
   * thread path — declaring it lets a handler actually set it.
   */
  authExpired?: boolean;
}

export interface MetricsData {
  impressions?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  clicks?: number;
  videoViews?: number;
  extra?: Record<string, number>;
}

/**
 * A user/page on a social platform who interacted with a post — author of a
 * comment or a reaction. Fields beyond id+name are best-effort: not every
 * platform exposes a headline or vanity handle.
 */
export interface EngagementActor {
  id: string;
  name: string;
  handle?: string;
  headline?: string;
  profileImage?: string;
  profileUrl?: string;
}

export interface EngagementComment {
  id: string;
  text: string;
  createdAt?: string;
  likeCount?: number;
  actor: EngagementActor;
  /** Set when this comment is a reply — the id of the comment it replies to. */
  parentId?: string;
}

export interface EngagementReaction {
  id: string;
  type?: string;
  createdAt?: string;
  actor: EngagementActor;
}

export interface PostMetricsOptions {
  /**
   * platformPostId → stored permalink, for handlers whose read path needs more
   * than the post id. Discord is the consumer: a message is addressed as
   * /channels/{channelId}/messages/{id}, and the channel a given post went to
   * is recorded only in the permalink (one Discord server has many channels).
   * Every other handler ignores it.
   */
  urlsById?: Record<string, string | null | undefined>;
}

export interface EngagementOptions {
  commentsLimit?: number;
  reactionsLimit?: number;
  /**
   * The stored permalink for this post. Discord needs it: a message id alone is
   * not addressable — the API path is /channels/{channelId}/messages/{id}, and
   * the channel a given post went to is recorded in the URL, not on the channel
   * row (one Discord server has many channels). Optional, and every other
   * handler ignores it.
   */
  platformUrl?: string | null;
}

export interface EngagementData {
  comments: EngagementComment[];
  reactions: EngagementReaction[];
  hasMoreComments?: boolean;
  hasMoreReactions?: boolean;
  /** Set when the platform does not expose this data at all (e.g. TikTok). */
  unsupported?: boolean;
  /**
   * Set when the platform exposes commenters but never individual likers
   * (Threads, Instagram, YouTube). The UI hides the Reactors tab entirely
   * rather than showing a permanently-empty "Reactors (0)".
   */
  reactionsUnsupported?: boolean;
  /** Set when the call ran but a specific scope/permission is missing. */
  notice?: string;
  /**
   * The subset of `notice` that explains the COMMENT list specifically — set
   * whenever the comment read did not succeed (no token, a gate declined, the
   * API errored, the platform has no thread for this post).
   *
   * `notice` mixes comment- and reaction-scoped messages, and several handlers
   * concatenate both. A surface that renders only comments (the inline thread
   * in the analytics mockup) cannot tell them apart, so it used to fall back to
   * "No comments yet." — asserting a measured zero for a read that never came
   * back. Absent means the comment read succeeded and an empty list really is
   * an empty list.
   */
  commentsNotice?: string;
}

export interface PlatformConfig {
  name: PlatformName;
  displayName: string;
  icon: string;
  color: string;
  authType: 'oauth' | 'credentials' | 'sdk';
  postTypes: PostTypeOption[];
  mediaRules: Record<string, PlatformMediaRules>;
}
