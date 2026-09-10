/**
 * Shared pre-publish validation for all platforms.
 *
 * Validates content length, media constraints, and required fields
 * BEFORE calling platform APIs — avoids wasted API calls and gives
 * users clear error messages.
 */

import type { PlatformName, PostData } from './types';
import { platformLength } from '../url';

// ---------------------------------------------------------------------------
// Character limits per platform
// ---------------------------------------------------------------------------

export const PLATFORM_CHAR_LIMITS: Record<PlatformName, number> = {
  x: 280,
  threads: 500,
  bluesky: 300,
  mastodon: 500,
  pinterest: 500,
  linkedin: 3000,
  instagram: 2200,
  tiktok: 2200,
  youtube: 5000,
  facebook: 63206,
  gmb: 1500,
  reddit: 40000,
  discord: 2000,
  telegram: 4096,
  // NPF caps a single text block at 4096 chars; the handler splits longer
  // content across blocks, so the practical post ceiling is far higher.
  tumblr: 32768,
  // Spotlight descriptions cap at 160 chars; stories and saved stories take
  // no caption at all, so the caption is only ever used for Spotlight.
  snapchat: 160,
};

// ---------------------------------------------------------------------------
// Media constraints per platform + post type
// ---------------------------------------------------------------------------

interface MediaConstraint {
  maxImages: number;
  maxVideos: number;
  allowMixed: boolean;
  /**
   * The post type cannot be published without media (≥1 file). Set on every
   * post type a platform offers that demands media — e.g. a YouTube video, an
   * Instagram feed photo, a TikTok video. This is the check that catches the
   * "No video file provided for YouTube upload" class of failure BEFORE the
   * job reaches the platform handler.
   */
  required?: boolean;
  minMedia?: number;
  maxMedia?: number;
  /**
   * Minimum pixel dimensions for attached IMAGES. Only enforced when the
   * file's width/height are known (they are for our own uploads and rehosted
   * URLs); unknown dimensions pass, keeping the check advisory rather than a
   * false blocker. Videos are never measured against these.
   */
  minImageWidth?: number;
  minImageHeight?: number;
}

const DEFAULT_CONSTRAINT: MediaConstraint = {
  maxImages: 10,
  maxVideos: 1,
  allowMixed: false,
};

/**
 * The post type to validate against when none is supplied (or an unknown one
 * is). This MUST match how each platform handler behaves when `post.postType`
 * is undefined — e.g. the YouTube handler treats a typeless post as a `video`,
 * so a typeless YouTube post must be validated as a `video` (media required),
 * not fall through to a permissive default. Drift here is exactly what let
 * post #149 (a text-only YouTube post) slip past validation.
 */
const PLATFORM_DEFAULT_TYPE: Record<PlatformName, string> = {
  x: 'tweet',
  instagram: 'feed_photo',
  facebook: 'post',
  tiktok: 'video',
  youtube: 'video',
  threads: 'text',
  bluesky: 'post',
  pinterest: 'pin',
  gmb: 'standard',
  linkedin: 'post',
  mastodon: 'post',
  reddit: 'post',
  discord: 'post',
  telegram: 'post',
  tumblr: 'post',
  snapchat: 'story',
};

const MEDIA_CONSTRAINTS: Partial<Record<PlatformName, Record<string, MediaConstraint>>> = {
  x: {
    tweet: { maxImages: 4, maxVideos: 1, allowMixed: false },
    video: { maxImages: 0, maxVideos: 1, allowMixed: false, required: true },
    thread: { maxImages: 4, maxVideos: 1, allowMixed: false },
  },
  instagram: {
    // Every Instagram post type requires media — IG cannot publish text-only.
    feed_photo: { maxImages: 1, maxVideos: 0, allowMixed: false, required: true },
    feed_video: { maxImages: 0, maxVideos: 1, allowMixed: false, required: true },
    reel: { maxImages: 0, maxVideos: 1, allowMixed: false, required: true },
    story: { maxImages: 1, maxVideos: 1, allowMixed: false, required: true },
    carousel: { maxImages: 10, maxVideos: 10, allowMixed: true, required: true, minMedia: 2, maxMedia: 10 },
  },
  facebook: {
    // A plain page post is text-optional and accepts images OR a single video
    // (the handler branches on mime type, not post type).
    post: { maxImages: 10, maxVideos: 1, allowMixed: false },
    video: { maxImages: 0, maxVideos: 1, allowMixed: false, required: true },
    reel: { maxImages: 0, maxVideos: 1, allowMixed: false, required: true },
    story: { maxImages: 1, maxVideos: 1, allowMixed: false, required: true },
    carousel: { maxImages: 10, maxVideos: 0, allowMixed: false, required: true, minMedia: 2 },
  },
  threads: {
    text: { maxImages: 0, maxVideos: 0, allowMixed: false },
    image: { maxImages: 1, maxVideos: 0, allowMixed: false, required: true },
    video: { maxImages: 0, maxVideos: 1, allowMixed: false, required: true },
    carousel: { maxImages: 20, maxVideos: 20, allowMixed: true, required: true, minMedia: 2, maxMedia: 20 },
  },
  bluesky: {
    // Bluesky posts accept images OR a single video (handler branches on mime).
    post: { maxImages: 4, maxVideos: 1, allowMixed: false },
    video: { maxImages: 0, maxVideos: 1, allowMixed: false, required: true },
  },
  tiktok: {
    // TikTok cannot publish without media — both post types require it.
    video: { maxImages: 0, maxVideos: 1, allowMixed: false, required: true },
    photo_slideshow: { maxImages: 35, maxVideos: 0, allowMixed: false, required: true, minMedia: 1 },
  },
  youtube: {
    // YouTube is video-only — a title/description without a video cannot post.
    video: { maxImages: 0, maxVideos: 1, allowMixed: false, required: true, minMedia: 1 },
    short: { maxImages: 0, maxVideos: 1, allowMixed: false, required: true, minMedia: 1 },
  },
  linkedin: {
    // A standard post is text-optional and accepts a single image OR video.
    post: { maxImages: 1, maxVideos: 1, allowMixed: false },
    multi_image: { maxImages: 20, maxVideos: 0, allowMixed: false, required: true, minMedia: 2 },
    pdf_carousel: { maxImages: 20, maxVideos: 0, allowMixed: false, required: true, minMedia: 2 },
    article: { maxImages: 1, maxVideos: 0, allowMixed: false },
  },
  pinterest: {
    // Every pin type requires media — a pin is fundamentally an image/video.
    pin: { maxImages: 1, maxVideos: 0, allowMixed: false, required: true, minMedia: 1 },
    video_pin: { maxImages: 0, maxVideos: 1, allowMixed: false, required: true, minMedia: 1 },
    carousel: { maxImages: 5, maxVideos: 0, allowMixed: false, required: true, minMedia: 2, maxMedia: 5 },
  },
  mastodon: {
    post: { maxImages: 4, maxVideos: 1, allowMixed: false },
  },
  gmb: {
    // Google Business posts are text-first; a single image is optional.
    // Google requires post photos to be at least 250×250 px, but the v4
    // localPosts API reports an undersized image as a bare "500 Internal
    // error encountered" — retried forever as transient (post #1352, a
    // 1075×210 banner). Enforcing the documented minimum here fails fast
    // with a real message instead.
    standard: { maxImages: 1, maxVideos: 0, allowMixed: false, minImageWidth: 250, minImageHeight: 250 },
    post: { maxImages: 1, maxVideos: 0, allowMixed: false, minImageWidth: 250, minImageHeight: 250 },
    event: { maxImages: 1, maxVideos: 0, allowMixed: false, minImageWidth: 250, minImageHeight: 250 },
    offer: { maxImages: 1, maxVideos: 0, allowMixed: false, minImageWidth: 250, minImageHeight: 250 },
  },
  reddit: {
    // A Reddit submission is text-optional and accepts a single image OR a single
    // video (the handler derives the post kind from the attached media / link).
    post: { maxImages: 1, maxVideos: 1, allowMixed: false },
  },
  discord: {
    // A Discord message is text-optional and accepts up to 10 mixed attachments.
    post: { maxImages: 10, maxVideos: 10, allowMixed: true, maxMedia: 10 },
  },
  telegram: {
    // A Telegram post is text-optional; a media group accepts up to 10 mixed items.
    post: { maxImages: 10, maxVideos: 10, allowMixed: true, maxMedia: 10 },
  },
  tumblr: {
    // A Tumblr post is text-optional. NPF allows up to 30 images, but only ONE
    // uploaded video and never a video mixed with images in the same post.
    post: { maxImages: 30, maxVideos: 1, allowMixed: false, maxMedia: 30 },
  },
  snapchat: {
    // Every Snapchat post is exactly one media file. Spotlight is video-only.
    story: { maxImages: 1, maxVideos: 1, allowMixed: false, required: true, maxMedia: 1 },
    saved_story: { maxImages: 1, maxVideos: 1, allowMixed: false, required: true, maxMedia: 1 },
    spotlight: { maxImages: 0, maxVideos: 1, allowMixed: false, required: true, maxMedia: 1 },
  },
};

/**
 * Resolve the constraint for a (platform, postType) pair. When `postType` is
 * missing or not a type the platform actually offers, fall back to the
 * platform's DEFAULT type (NOT a permissive generic default), mirroring how the
 * handlers behave for a typeless post. This is the fix for the typeless-post
 * gap that produced the YouTube failure.
 */
function resolveConstraint(platform: PlatformName, postType?: string): MediaConstraint {
  const map = MEDIA_CONSTRAINTS[platform];
  if (!map) return DEFAULT_CONSTRAINT;
  if (postType && map[postType]) return map[postType];
  const def = PLATFORM_DEFAULT_TYPE[platform];
  return (def ? map[def] : undefined) ?? map[Object.keys(map)[0]] ?? DEFAULT_CONSTRAINT;
}

/** Human-friendly description of the media a required post type expects. */
function requiredMediaNoun(c: MediaConstraint): string {
  if (c.maxVideos > 0 && c.maxImages === 0) return 'a video';
  if (c.maxImages > 0 && c.maxVideos === 0) return 'an image';
  return 'media';
}

/**
 * What a platform's DEFAULT post type needs media-wise. Used by RSS autopost
 * (and its preview) to decide whether a feed item can publish to a channel at
 * all — e.g. YouTube requires a video, Instagram requires media, X does not.
 */
export function defaultMediaRequirement(platform: PlatformName): {
  required: boolean;
  acceptsImage: boolean;
  acceptsVideo: boolean;
  noun: string;
} {
  const c = resolveConstraint(platform);
  return {
    required: Boolean(c.required),
    acceptsImage: c.maxImages > 0,
    acceptsVideo: c.maxVideos > 0,
    noun: requiredMediaNoun(c),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationError {
  platform: PlatformName;
  field: string;
  message: string;
}

/**
 * Validate a post for a specific platform before publishing.
 * Returns an array of validation errors (empty = valid).
 */
export function validateForPlatform(
  post: PostData,
  platform: PlatformName,
  postType?: string,
): ValidationError[] {
  const errors: ValidationError[] = [];

  // 1. Content length — measured as the platform measures it (x/mastodon
  // count every URL as 23 chars; see platformLength).
  const limit = PLATFORM_CHAR_LIMITS[platform];
  const contentLength = post.content ? platformLength(post.content, platform) : 0;
  if (post.content && contentLength > limit) {
    errors.push({
      platform,
      field: 'content',
      message: `Content exceeds ${platform} limit of ${limit} characters (current: ${contentLength})`,
    });
  }

  // 2. Media constraints — resolve against the platform's effective post type.
  const pt = postType && MEDIA_CONSTRAINTS[platform]?.[postType] ? postType : PLATFORM_DEFAULT_TYPE[platform];
  const constraints = resolveConstraint(platform, postType);
  const images = post.mediaFiles.filter((f) => f.mimeType.startsWith('image/'));
  const videos = post.mediaFiles.filter((f) => f.mimeType.startsWith('video/'));
  const totalMedia = post.mediaFiles.length;

  // 2a. Required media — the post type cannot publish without media. This is
  // the gap that let text-only YouTube/TikTok/Instagram/Pinterest posts fail
  // deep in the handler with a cryptic "No video file provided" instead of a
  // clear, up-front error. Reported first; the count checks below are moot.
  if (constraints.required && totalMedia === 0) {
    errors.push({
      platform,
      field: 'media',
      message: `${platform} ${pt} requires ${requiredMediaNoun(constraints)} (no media attached)`,
    });
  }

  if (!constraints.allowMixed && images.length > 0 && videos.length > 0) {
    errors.push({
      platform,
      field: 'media',
      message: `${platform} does not support mixing images and videos in a single post`,
    });
  }

  if (images.length > constraints.maxImages) {
    errors.push({
      platform,
      field: 'media',
      message: `${platform} allows max ${constraints.maxImages} images for ${pt} (got ${images.length})`,
    });
  }

  if (videos.length > constraints.maxVideos) {
    errors.push({
      platform,
      field: 'media',
      message: `${platform} allows max ${constraints.maxVideos} videos for ${pt} (got ${videos.length})`,
    });
  }

  if (constraints.minMedia && totalMedia > 0 && totalMedia < constraints.minMedia) {
    errors.push({
      platform,
      field: 'media',
      message: `${platform} ${pt} requires at least ${constraints.minMedia} media files (got ${totalMedia})`,
    });
  }

  // 2b. Minimum image dimensions — only where the platform documents one and
  // the file's dimensions are known. Skipping unknown dimensions is deliberate:
  // this gate must never block media we simply haven't measured.
  if (constraints.minImageWidth || constraints.minImageHeight) {
    for (const img of images) {
      if (typeof img.width !== 'number' || typeof img.height !== 'number') continue;
      if (
        (constraints.minImageWidth && img.width < constraints.minImageWidth) ||
        (constraints.minImageHeight && img.height < constraints.minImageHeight)
      ) {
        errors.push({
          platform,
          field: 'media',
          message: `${platform} requires images of at least ${constraints.minImageWidth}x${constraints.minImageHeight} pixels (got ${img.width}x${img.height})`,
        });
      }
    }
  }

  if (constraints.maxMedia && totalMedia > constraints.maxMedia) {
    errors.push({
      platform,
      field: 'media',
      message: `${platform} ${pt} supports max ${constraints.maxMedia} media files (got ${totalMedia})`,
    });
  }

  // 3. Required content check (some post types need text)
  if (!post.content && !post.mediaFiles.length && platform !== 'gmb') {
    errors.push({
      platform,
      field: 'content',
      message: `Post must have content or media for ${platform}`,
    });
  }

  return errors;
}

/**
 * platform_content must be a flat map of platform → string. It is stored as
 * jsonb, so without this gate any JSON shape survives to the publish worker,
 * where a non-string override crashes handlers that call String methods on it
 * (seen in prod: {"youtube": {"content": "..."}} → "content.split is not a
 * function"). Returns an error message, or null when the shape is valid.
 */
export function validatePlatformContentShape(
  platformContent: unknown,
): string | null {
  if (platformContent === undefined || platformContent === null) return null;
  if (typeof platformContent !== 'object' || Array.isArray(platformContent)) {
    return 'platformContent must be an object mapping platform names to strings';
  }
  for (const [platform, value] of Object.entries(platformContent)) {
    if (typeof value !== 'string') {
      return `platformContent.${platform} must be a string, got ${Array.isArray(value) ? 'array' : typeof value}. Send the caption text directly, e.g. {"${platform}": "your caption"}`;
    }
  }
  return null;
}

/**
 * The privacy levels TikTok's Content Posting API accepts, as documented in
 * the openapi spec. SEND_TO_USER_INBOX is the unaudited-app draft-upload
 * stopgap. The composer UI only offers what creator_info returns for the
 * account, but API clients bypass the UI — an unknown value (seen in prod:
 * "PUBLIC") reaches TikTok verbatim and fails the whole post at publish time
 * with "The request post info is empty or incorrect".
 */
const TIKTOK_PRIVACY_LEVELS = new Set([
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
]);

/**
 * Every closed-enum field inside platformSpecific, checked at create/update so
 * an off-spec value fails fast with a 400 instead of at publish time.
 * `hints` maps obvious shorthands to the value the sender meant (matched
 * case-insensitively) — surfaced as "did you mean …?", never applied silently.
 *
 * The publish-time behavior each entry prevents:
 *  - tiktok.privacyLevel   → TikTok 400 "The request post info is empty or incorrect"
 *  - youtube.privacyStatus → YouTube 400 invalid privacy status
 *  - x.replySettings       → X 400 invalid reply_settings
 *  - gmb.ctaType           → silently dropped by the handler (the CTA vanishes)
 *  - instagram.graduationStrategy → anything ≠ 'auto' silently treated as manual
 */
const PLATFORM_SPECIFIC_ENUMS: Array<{
  platform: string;
  field: string;
  values: Set<string>;
  hints?: Record<string, string>;
}> = [
  {
    platform: 'tiktok',
    field: 'privacyLevel',
    values: TIKTOK_PRIVACY_LEVELS,
    hints: {
      PUBLIC: 'PUBLIC_TO_EVERYONE',
      EVERYONE: 'PUBLIC_TO_EVERYONE',
      FRIENDS: 'MUTUAL_FOLLOW_FRIENDS',
      FOLLOWERS: 'FOLLOWER_OF_CREATOR',
      PRIVATE: 'SELF_ONLY',
      ONLY_ME: 'SELF_ONLY',
    },
  },
  {
    platform: 'youtube',
    field: 'privacyStatus',
    values: new Set(['public', 'unlisted', 'private']),
    // The enum is lowercase; any casing of a valid word maps to itself.
    hints: { PUBLIC: 'public', UNLISTED: 'unlisted', PRIVATE: 'private' },
  },
  {
    platform: 'x',
    // The exact enum X accepts for reply_settings on POST /2/tweets
    // ('everyone' means the field is omitted).
    field: 'replySettings',
    values: new Set(['everyone', 'following', 'verified', 'subscribers', 'mentionedUsers']),
    hints: { MENTIONED_USERS: 'mentionedUsers', MENTIONEDUSERS: 'mentionedUsers' },
  },
  {
    platform: 'gmb',
    field: 'ctaType',
    values: new Set(['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL']),
    hints: { LEARNMORE: 'LEARN_MORE', SIGNUP: 'SIGN_UP' },
  },
  {
    platform: 'instagram',
    field: 'graduationStrategy',
    values: new Set(['manual', 'auto']),
    hints: { MANUAL: 'manual', AUTO: 'auto' },
  },
];

/**
 * platformSpecific fields whose value is a URL our worker (or the platform)
 * will fetch at publish time. Checked at create/update so a junk or internal
 * URL 400s immediately instead of failing (or probing our network) days later
 * inside the publish worker. The publish-time SSRF guard (fetchRemoteMedia /
 * ssrfSafeFetch, with connect-time DNS pinning) remains the enforcement layer;
 * this is the friendly, synchronous front door.
 */
const PLATFORM_SPECIFIC_URL_FIELDS: Array<{ platform: string; field: string }> = [
  { platform: 'youtube', field: 'thumbnailUrl' },   // fetched by our worker
  { platform: 'reddit', field: 'thumbnailUrl' },    // fetched by our worker
  { platform: 'facebook', field: 'thumbnailUrl' },  // fetched by our worker, POSTed to the video's thumbnails edge
  { platform: 'pinterest', field: 'coverImageUrl' }, // handed to Pinterest's API
  { platform: 'instagram', field: 'coverUrl' },      // handed to Instagram's API as cover_url
  { platform: 'gmb', field: 'ctaUrl' },              // handed to Google's API
  { platform: 'gmb', field: 'redeemOnlineUrl' },     // handed to Google's API
];

/** Literal private/loopback hosts we can reject without a DNS lookup. */
function isObviouslyInternalHost(hostname: string): boolean {
  // URL.hostname keeps the brackets on IPv6 literals ("[::1]") — strip them.
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    return true;
  }
  // Literal IPv4 in a private/reserved range
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) {
    const [a, b, c] = h.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0 && c === 0) return true;
  }
  // Literal IPv6 loopback/link-local/unique-local (URL hostnames keep brackets off)
  if (h === '::1' || h === '::' || /^fe[89ab]/.test(h) || /^f[cd]/.test(h)) return true;
  return false;
}

function validateUrlField(platform: string, field: string, value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `platformSpecific.${platform}.${field} is not a valid URL`;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return `platformSpecific.${platform}.${field} must be an http(s) URL`;
  }
  if (isObviouslyInternalHost(parsed.hostname)) {
    return `platformSpecific.${platform}.${field} must point to a publicly reachable host`;
  }
  return null;
}

/**
 * Validate the platformSpecific options a request carries, catching values
 * the target platform would reject (or silently ignore) at publish time.
 * Deliberately narrow: only fields with a closed, documented enum — plus
 * URL-typed fields our worker fetches — are checked, so unknown/extra keys
 * still pass through untouched. Returns an error message or null.
 */
export function validatePlatformSpecificShape(platformSpecific: unknown): string | null {
  if (platformSpecific === undefined || platformSpecific === null) return null;
  if (typeof platformSpecific !== 'object' || Array.isArray(platformSpecific)) {
    return 'platformSpecific must be an object keyed by platform name';
  }

  for (const { platform, field, values, hints } of PLATFORM_SPECIFIC_ENUMS) {
    const opts = (platformSpecific as Record<string, unknown>)[platform];
    if (!opts || typeof opts !== 'object' || Array.isArray(opts)) continue;
    const value = (opts as Record<string, unknown>)[field];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && values.has(value)) continue;
    const hint = typeof value === 'string' ? hints?.[value.toUpperCase()] : undefined;
    return (
      `platformSpecific.${platform}.${field} must be one of: ${[...values].join(', ')}` +
      (hint ? `. Did you mean "${hint}"?` : '')
    );
  }

  for (const { platform, field } of PLATFORM_SPECIFIC_URL_FIELDS) {
    const opts = (platformSpecific as Record<string, unknown>)[platform];
    if (!opts || typeof opts !== 'object' || Array.isArray(opts)) continue;
    const value = (opts as Record<string, unknown>)[field];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string') {
      return `platformSpecific.${platform}.${field} must be a URL string`;
    }
    const err = validateUrlField(platform, field, value);
    if (err) return err;
  }
  return null;
}

/**
 * Validate postTypeOverrides against the post types each platform actually
 * offers (the MEDIA_CONSTRAINTS keys — the same source validateForPlatform
 * resolves against). Without this, an unknown type silently falls back to the
 * platform default: {"instagram": "Story"} posted to the feed instead of as a
 * story, with no error anywhere. Unknown platform keys pass through untouched.
 */
export function validatePostTypeOverridesShape(postTypeOverrides: unknown): string | null {
  if (postTypeOverrides === undefined || postTypeOverrides === null) return null;
  if (typeof postTypeOverrides !== 'object' || Array.isArray(postTypeOverrides)) {
    return 'postTypeOverrides must be an object mapping platform names to post types';
  }
  for (const [platform, type] of Object.entries(postTypeOverrides)) {
    if (type === undefined || type === null || type === '') continue;
    // 'thread' is the cross-platform pseudo-type the composer's Thread format
    // sends for every threading platform (threads/bluesky/mastodon have no
    // MEDIA_CONSTRAINTS entry for it — thread media lives per-part and is
    // validated there). 'default' is the composer's explicit
    // use-the-platform-default sentinel.
    if (type === 'thread' || type === 'default') continue;
    const known = MEDIA_CONSTRAINTS[platform as PlatformName];
    if (!known) continue;
    if (typeof type !== 'string' || !known[type]) {
      const valid = Object.keys(known).join(', ');
      const hint = typeof type === 'string' && known[type.toLowerCase()] ? `. Did you mean "${type.toLowerCase()}"?` : '';
      return `postTypeOverrides.${platform} must be one of: ${valid}${hint}`;
    }
  }
  return null;
}

/**
 * Thread parts (global and per-platform) carry the same jsonb risk as
 * platform_content: the worker reads `part.content || ''`, so a truthy
 * non-string content survives to the platform handlers and crashes string
 * handling there. Validates `threadParts` (an array of parts) and
 * `platformThreadParts` (platform → array of parts). Returns an error
 * message, or null when the shapes are valid.
 */
export function validateThreadPartsShape(
  threadParts: unknown,
  platformThreadParts: unknown,
): string | null {
  const checkParts = (parts: unknown, label: string): string | null => {
    if (parts === undefined || parts === null) return null;
    if (!Array.isArray(parts)) return `${label} must be an array of thread parts`;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (typeof p !== 'object' || p === null || Array.isArray(p)) {
        return `${label}[${i}] must be an object with a string content`;
      }
      const c = (p as { content?: unknown }).content;
      if (c !== undefined && c !== null && typeof c !== 'string') {
        return `${label}[${i}].content must be a string, got ${Array.isArray(c) ? 'array' : typeof c}`;
      }
    }
    return null;
  };

  const globalErr = checkParts(threadParts, 'threadParts');
  if (globalErr) return globalErr;

  if (platformThreadParts === undefined || platformThreadParts === null) return null;
  if (typeof platformThreadParts !== 'object' || Array.isArray(platformThreadParts)) {
    return 'platformThreadParts must be an object mapping platform names to arrays of thread parts';
  }
  for (const [platform, parts] of Object.entries(platformThreadParts)) {
    const err = checkParts(parts, `platformThreadParts.${platform}`);
    if (err) return err;
  }
  return null;
}

/**
 * Validate the LENGTH of every thread part, per platform.
 *
 * The per-platform content check next to this one only ever saw `content` and
 * `platformContent`. A thread's `content` is its head part, so parts 2..n went
 * to the platforms unchecked, and a per-platform override in
 * `platformThreadParts` was never measured at all — an over-long part was
 * accepted here and then rejected by the platform mid-thread, which leaves the
 * post `partial` with the first segments already public and no way to fix them.
 *
 * Which parts a platform actually publishes is decided in exactly one place at
 * publish time (`publishSingleThreadPlatform`): its own override when that
 * override has entries, otherwise the global list. This mirrors that rule
 * rather than restating it, because validating a different set than the one
 * that publishes is worse than not validating at all.
 *
 * Returns one message per over-long part. An empty array means every part
 * fits everywhere it is going.
 */
export function validateThreadPartLengths(args: {
  postFormat?: string | null;
  threadParts?: Array<{ content?: string | null }> | null;
  platformThreadParts?: Record<string, Array<{ content?: string | null }>> | null;
  platforms: string[];
  postTypeOverrides?: Record<string, string> | null;
}): string[] {
  if (args.postFormat !== 'thread') return [];

  const global = args.threadParts ?? [];
  const perPlatform = args.platformThreadParts ?? {};
  const errors: string[] = [];

  for (const platform of new Set(args.platforms)) {
    // A repost carries no text of its own, so it has no length to check.
    if (args.postTypeOverrides?.[platform] === 'repost') continue;
    const limit = PLATFORM_CHAR_LIMITS[platform as PlatformName];
    if (typeof limit !== 'number') continue;

    // Same resolution as publish time: an override wins only when it has parts.
    // Array.isArray, not a truthiness check: the shape validators that run
    // ahead of this in the routes would already have rejected a non-array
    // override, but this function's whole job is turning bad input into a 400
    // and a TypeError here would be a 500 instead.
    const override = perPlatform[platform];
    const parts = Array.isArray(override) && override.length ? override : (Array.isArray(global) ? global : []);

    parts.forEach((part, index) => {
      const text = typeof part?.content === 'string' ? part.content : '';
      if (!text) return;
      const length = platformLength(text, platform);
      if (length > limit) {
        errors.push(
          `${platform}: thread part ${index + 1} exceeds ${limit} character limit (${length})`,
        );
      }
    });
  }

  /*
   * Cap what we say. Nothing limits how many parts a thread may have, so a
   * client sending hundreds of over-long parts across four platforms would get
   * a four-figure list of messages concatenated into one error string. The
   * first few tell the caller everything they need; the count tells them the
   * scale.
   */
  const MAX_REPORTED = 10;
  if (errors.length > MAX_REPORTED) {
    const hidden = errors.length - MAX_REPORTED;
    return [...errors.slice(0, MAX_REPORTED), `and ${hidden} more thread part${hidden === 1 ? '' : 's'} over the limit`];
  }
  return errors;
}

/**
 * Validate a post's media against EVERY platform it targets, in one call.
 *
 * This is the server-side gate for the create/publish API routes (and the
 * agentic API): it builds a lightweight PostData per platform and runs the
 * same `validateForPlatform` the worker uses, so an invalid combination
 * (e.g. a text-only post sent to YouTube) is rejected synchronously with a
 * clear message instead of being accepted and failing later in a job.
 *
 * Per-platform post type is taken from `postTypeOverrides[platform]`; when
 * absent, `validateForPlatform` falls back to the platform's default type.
 * Thread-format posts are skipped here — their media lives per-part and the
 * media-required platforms don't support threads anyway.
 */
export function validatePostMediaForPlatforms(args: {
  content?: string | null;
  platformContent?: Record<string, string> | null;
  media: Array<{ mimeType: string; width?: number | null; height?: number | null }>;
  postFormat?: string | null;
  postTypeOverrides?: Record<string, string> | null;
  platforms: PlatformName[];
}): ValidationError[] {
  if (args.postFormat === 'thread') return [];

  const mediaFiles = args.media.map((m) => ({
    url: '',
    localPath: '',
    mimeType: m.mimeType,
    width: m.width ?? undefined,
    height: m.height ?? undefined,
    sizeBytes: 0,
  }));

  const errors: ValidationError[] = [];
  const seen = new Set<PlatformName>();
  for (const platform of args.platforms) {
    if (seen.has(platform)) continue;
    seen.add(platform);

    const postType = args.postTypeOverrides?.[platform];
    const content = args.platformContent?.[platform] || args.content || '';
    const post: PostData = { content, mediaUrls: [], mediaFiles };
    errors.push(...validateForPlatform(post, platform, postType));
  }
  return errors;
}
