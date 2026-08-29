import type { FeedItem, FeedItemMedia } from './parse';
import {
  PLATFORM_CHAR_LIMITS,
  defaultMediaRequirement,
} from '../platforms/validation';
import type { PlatformName } from '../platforms/types';
import { platformLength } from '../url';

/**
 * Per-feed field mapping: how an RSS/Atom item becomes post content on each
 * channel. Stored in rss_feeds.field_mapping (JSONB, nullable — null means the
 * built-in default below, which matches the pre-mapping behavior).
 *
 * Media selection is post-level (media files attach to the post, not to a
 * single channel), so `mediaField` has no per-channel override. Per-channel
 * overrides cover the text side and are written into
 * posts.platform_content[platform] — the same mechanism the Composer uses —
 * so two channels on the SAME platform share one rendered text.
 */

export const MAPPING_TOKENS = [
  'title',
  'link',
  'description',
  'content',
  'author',
  'categories',
  'feedName',
] as const;
export type MappingToken = (typeof MAPPING_TOKENS)[number];

export type MediaField = 'none' | 'image' | 'video' | 'auto';
export type TruncateMode = 'smart' | 'hard' | 'skip';

export interface RssMappingOverride {
  template?: string;
  hashtags?: string;
  stripHtml?: boolean;
  truncate?: TruncateMode;
}

export interface RssFieldMapping {
  /** Caption template built from {token}s, e.g. "{title}\n\n{link}". */
  template: string;
  /** Which item enclosure to attach: none, image, video, or auto (video, else image). */
  mediaField: MediaField;
  /** Strip HTML tags/entities from description/content tokens. */
  stripHtml: boolean;
  /** Over the platform char limit: smart trim (keep trailing link), hard cut, or skip the channel. */
  truncate: TruncateMode;
  /** Appended after the rendered template, e.g. "#news #blog". */
  hashtags: string;
  /** Per-channel overrides keyed by channel id (as a string — JSON keys). */
  channelOverrides?: Record<string, RssMappingOverride>;
}

export const DEFAULT_FIELD_MAPPING: RssFieldMapping = {
  template: '{title}\n\n{link}',
  mediaField: 'none',
  stripHtml: true,
  truncate: 'smart',
  hashtags: '',
};

const MAX_TEMPLATE_LEN = 2000;
const MAX_HASHTAGS_LEN = 500;
const MAX_OVERRIDES = 50;

/**
 * Validate + normalize a client-supplied fieldMapping. Returns the normalized
 * mapping, or null when the payload is not a valid mapping. `undefined` and
 * `null` inputs return undefined/null respectively (meaning "use default" /
 * "clear").
 */
export function normalizeFieldMapping(raw: unknown): RssFieldMapping | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;

  const template = typeof m.template === 'string' ? m.template : DEFAULT_FIELD_MAPPING.template;
  if (!template.trim() || template.length > MAX_TEMPLATE_LEN) return null;

  const mediaField: MediaField = ['none', 'image', 'video', 'auto'].includes(m.mediaField as string)
    ? (m.mediaField as MediaField)
    : 'none';
  const truncate: TruncateMode = ['smart', 'hard', 'skip'].includes(m.truncate as string)
    ? (m.truncate as TruncateMode)
    : 'smart';
  const stripHtml = m.stripHtml === undefined ? true : Boolean(m.stripHtml);
  const hashtags = typeof m.hashtags === 'string' ? m.hashtags.trim().slice(0, MAX_HASHTAGS_LEN) : '';

  let channelOverrides: Record<string, RssMappingOverride> | undefined;
  if (m.channelOverrides !== undefined) {
    if (typeof m.channelOverrides !== 'object' || m.channelOverrides === null || Array.isArray(m.channelOverrides)) {
      return null;
    }
    const entries = Object.entries(m.channelOverrides as Record<string, unknown>);
    if (entries.length > MAX_OVERRIDES) return null;
    channelOverrides = {};
    for (const [key, val] of entries) {
      if (!/^\d+$/.test(key)) return null;
      if (typeof val !== 'object' || val === null || Array.isArray(val)) return null;
      const o = val as Record<string, unknown>;
      const out: RssMappingOverride = {};
      if (o.template !== undefined) {
        if (typeof o.template !== 'string' || o.template.length > MAX_TEMPLATE_LEN) return null;
        if (o.template.trim()) out.template = o.template;
      }
      if (o.hashtags !== undefined) {
        if (typeof o.hashtags !== 'string') return null;
        out.hashtags = o.hashtags.trim().slice(0, MAX_HASHTAGS_LEN);
      }
      if (o.stripHtml !== undefined) out.stripHtml = Boolean(o.stripHtml);
      if (o.truncate !== undefined) {
        if (!['smart', 'hard', 'skip'].includes(o.truncate as string)) return null;
        out.truncate = o.truncate as TruncateMode;
      }
      if (Object.keys(out).length > 0) channelOverrides[key] = out;
    }
    if (Object.keys(channelOverrides).length === 0) channelOverrides = undefined;
  }

  return { template, mediaField, stripHtml, truncate, hashtags, ...(channelOverrides ? { channelOverrides } : {}) };
}

// ---------------------------------------------------------------------------
// HTML → text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

/** Lightweight HTML → plain text: block tags become newlines, entities decoded. */
export function stripHtmlToText(html: string): string {
  if (!html) return '';
  let s = html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|h[1-6]|li|blockquote|tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  s = s.replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
  // Collapse runs of blank lines and trailing spaces.
  return s
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderContext {
  item: FeedItem;
  feedName: string;
}

function tokenValue(token: string, ctx: RenderContext, stripHtml: boolean): string | null {
  const { item } = ctx;
  switch (token) {
    case 'title':
      return stripHtml ? stripHtmlToText(item.title) : item.title;
    case 'link':
      return item.link;
    case 'description':
      return stripHtml ? stripHtmlToText(item.description) : item.description;
    case 'content':
      return stripHtml ? stripHtmlToText(item.content) : item.content;
    case 'author':
      return item.author;
    case 'categories':
      return item.categories.join(', ');
    case 'feedName':
      return ctx.feedName;
    default: {
      // Not a standard token — resolve it from the item's own custom leaf
      // fields (namespaced or otherwise). Unknown to both → left as-is.
      const custom = item.fields?.[token.toLowerCase()];
      if (custom == null) return null;
      return stripHtml ? stripHtmlToText(custom) : custom;
    }
  }
}

const STANDARD_TOKEN_LABELS: Record<MappingToken, string> = {
  title: 'Title',
  link: 'Link',
  description: 'Summary',
  content: 'Full text',
  author: 'Author',
  categories: 'Categories',
  feedName: 'Feed name',
};

export interface AvailableToken {
  /** Insertable token including braces, e.g. "{title}". */
  token: string;
  /** Human label for the pill. */
  label: string;
}

/** Title-case a custom field's localName for its pill label. */
function humanizeToken(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * The tokens actually offered by a specific feed item: standard tokens that are
 * populated (link + feedName are always available), followed by the item's own
 * custom leaf fields. Drives the editor's pills so they mirror the real feed.
 */
export function availableTokens(item: FeedItem, feedName: string): AvailableToken[] {
  const present: Record<MappingToken, boolean> = {
    title: Boolean(item.title),
    link: Boolean(item.link),
    description: Boolean(item.description),
    content: Boolean(item.content),
    author: Boolean(item.author),
    categories: item.categories.length > 0,
    feedName: Boolean(feedName),
  };
  const out: AvailableToken[] = [];
  for (const t of MAPPING_TOKENS) {
    if (present[t]) out.push({ token: `{${t}}`, label: STANDARD_TOKEN_LABELS[t] });
  }
  for (const [name, value] of Object.entries(item.fields ?? {})) {
    if (value) out.push({ token: `{${name}}`, label: humanizeToken(name) });
  }
  return out;
}

/**
 * Substitute {token}s. Missing/empty fields render as '' and any line that
 * becomes empty because ALL its tokens were empty is dropped (fallback
 * behavior for items without a description, author, etc.).
 */
export function renderTemplate(template: string, ctx: RenderContext, stripHtml: boolean): string {
  const lines = template.split('\n').map((line) => {
    let hadToken = false;
    let allEmpty = true;
    const rendered = line.replace(/\{([a-zA-Z]+)\}/g, (match, name) => {
      const val = tokenValue(name, ctx, stripHtml);
      if (val === null) return match;
      hadToken = true;
      if (val.trim()) allEmpty = false;
      return val;
    });
    if (hadToken && allEmpty && !rendered.trim()) return null;
    return rendered.replace(/[ \t]+$/g, '');
  });
  return lines
    .filter((l): l is string => l !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Truncate `body` to `limit` chars. Smart mode keeps a trailing link line
 * intact (the most common template shape "text…\n\nhttps://…") and trims the
 * text ahead of it at a word boundary with an ellipsis.
 */
export function truncateForLimit(body: string, limit: number, mode: 'smart' | 'hard'): string {
  if (body.length <= limit) return body;
  if (mode === 'hard') return body.slice(0, limit - 1).trimEnd() + '…';

  const lines = body.split('\n');
  const last = lines[lines.length - 1]?.trim() ?? '';
  const lastIsUrl = /^https?:\/\/\S+$/.test(last);
  if (lastIsUrl && last.length + 4 < limit) {
    const head = lines.slice(0, -1).join('\n').trimEnd();
    const room = limit - last.length - 3; // '…' + '\n\n'
    let cut = head.slice(0, room);
    const lastSpace = cut.search(/\s\S*$/);
    if (lastSpace > room * 0.5) cut = cut.slice(0, lastSpace);
    return cut.trimEnd() + '…\n\n' + last;
  }
  let cut = body.slice(0, limit - 1);
  const lastSpace = cut.search(/\s\S*$/);
  if (lastSpace > (limit - 1) * 0.5) cut = cut.slice(0, lastSpace);
  return cut.trimEnd() + '…';
}

/**
 * Platform-aware truncation: on url-weighted platforms (x/mastodon, where every
 * URL counts as 23 chars) the plain-length budget is `limit` plus the URLs'
 * surplus, so a long trailing link keeps its full text. Since cutting can drop
 * or split a URL and shift the weighted count, re-check and shrink until the
 * result actually fits as the platform measures it.
 */
export function truncateForPlatform(
  body: string,
  limit: number,
  mode: 'smart' | 'hard',
  platform: PlatformName,
): string {
  // effLimit is a PLAIN-length budget approximating the weighted limit. It can
  // start below `limit` (many sub-23-char URLs make weighted > plain), so it
  // must be clamped — a negative slice budget would return most of the body.
  let effLimit = Math.max(1, limit + (body.length - platformLength(body, platform)));
  let out = truncateForLimit(body, effLimit, mode);
  // Cutting can drop/split URLs and shift the weighted count, so re-check and
  // shrink until the result fits as the platform measures it. effLimit strictly
  // decreases by the current excess each pass, so this terminates; the
  // iteration cap is a pure safety net.
  for (let i = 0; i < 50 && platformLength(out, platform) > limit && effLimit > 1; i++) {
    effLimit = Math.max(1, effLimit - (platformLength(out, platform) - limit));
    out = truncateForLimit(body, effLimit, mode);
  }
  if (platformLength(out, platform) > limit) {
    // Pathological fallback (URL-dense body): the shortest string our regex
    // counts as a 23-char URL is 8 chars ('http://x'), so a plain budget of
    // limit*8/23 can never exceed the weighted limit.
    out = truncateForLimit(body, Math.max(2, Math.floor((limit * 8) / 23)), 'hard');
  }
  return out;
}

export interface ChannelRender {
  channelId: number;
  platform: PlatformName;
  /** Final text for this channel (empty when skipped). */
  text: string;
  charLimit: number;
  truncated: boolean;
  /** True when this channel used a per-channel override. */
  overridden: boolean;
  skipped: boolean;
  skipReason: string | null;
  /** The media that would attach to the post, if any (item-level). */
  media: FeedItemMedia | null;
}

/** Resolve which item media the mapping selects (post-level decision). */
export function selectItemMedia(mapping: RssFieldMapping, item: FeedItem): FeedItemMedia | null {
  switch (mapping.mediaField) {
    case 'image':
      return item.image;
    case 'video':
      return item.video;
    case 'auto':
      return item.video ?? item.image;
    default:
      return null;
  }
}

/**
 * Render one feed item for one channel, applying the channel's override on
 * top of the global mapping, hashtags, char limits, truncation policy, and
 * the platform's media requirement.
 */
export function renderForChannel(
  mapping: RssFieldMapping,
  ctx: RenderContext,
  channel: { id: number; platform: string },
  media: FeedItemMedia | null,
): ChannelRender {
  const platform = channel.platform as PlatformName;
  const override = mapping.channelOverrides?.[String(channel.id)] ?? {};
  const template = override.template ?? mapping.template;
  const stripHtml = override.stripHtml ?? mapping.stripHtml;
  const truncate = override.truncate ?? mapping.truncate;
  const hashtags = (override.hashtags ?? mapping.hashtags).trim();
  const overridden = Object.keys(override).length > 0;

  const base: Omit<ChannelRender, 'text' | 'truncated' | 'skipped' | 'skipReason'> = {
    channelId: channel.id,
    platform,
    charLimit: PLATFORM_CHAR_LIMITS[platform] ?? 5000,
    overridden,
    media,
  };

  // Media requirement: a platform whose default post type demands media can't
  // publish an item that has none (or the wrong kind).
  const req = defaultMediaRequirement(platform);
  if (req.required) {
    const ok =
      media && ((media.kind === 'image' && req.acceptsImage) || (media.kind === 'video' && req.acceptsVideo));
    if (!ok) {
      const why = media
        ? `${platform} needs ${req.noun}, but the selected item media is ${media.kind === 'image' ? 'an image' : 'a video'}`
        : mapping.mediaField === 'none'
          ? `${platform} needs ${req.noun}, but this feed's mapping attaches no media`
          : `${platform} needs ${req.noun}, but this item has none`;
      return { ...base, text: '', truncated: false, skipped: true, skipReason: why };
    }
  }

  let text = renderTemplate(template, ctx, stripHtml);
  if (hashtags) text = text ? `${text}\n\n${hashtags}` : hashtags;
  if (!text.trim()) {
    return {
      ...base,
      text: '',
      truncated: false,
      skipped: true,
      skipReason: 'The template rendered to empty text for this item',
    };
  }

  const limit = base.charLimit;
  const textLength = platformLength(text, platform);
  if (textLength > limit) {
    if (truncate === 'skip') {
      return {
        ...base,
        text: '',
        truncated: false,
        skipped: true,
        skipReason: `Rendered text is ${textLength} characters — over the ${platform} limit of ${limit} (truncation is set to skip)`,
      };
    }
    return { ...base, text: truncateForPlatform(text, limit, truncate, platform), truncated: true, skipped: false, skipReason: null };
  }

  return { ...base, text, truncated: false, skipped: false, skipReason: null };
}

/** Render an item for every channel of a feed. */
export function renderItemForChannels(
  mapping: RssFieldMapping,
  ctx: RenderContext,
  channels: Array<{ id: number; platform: string }>,
): { media: FeedItemMedia | null; renders: ChannelRender[] } {
  const media = selectItemMedia(mapping, ctx.item);
  return { media, renders: channels.map((ch) => renderForChannel(mapping, ctx, ch, media)) };
}
