import { JSDOM } from 'jsdom';

/**
 * Minimal RSS 2.0 / Atom feed parser on top of jsdom's XML mode (already a
 * dependency via collect). Extracts a stable per-item guid plus every field the
 * autopost field mapping can reference: title, link, description/summary, full
 * content (content:encoded / Atom content), author, categories, published
 * date, and the item's image/video enclosure if any.
 */

export interface FeedItemMedia {
  url: string;
  /** 'image' | 'video' derived from the enclosure MIME type or URL extension. */
  kind: 'image' | 'video';
  mimeType: string | null;
}

export interface FeedItem {
  guid: string;
  title: string;
  link: string;
  publishedAt: Date | null;
  /** Short summary (RSS <description> / Atom <summary>). May contain HTML. */
  description: string;
  /** Full body (content:encoded / Atom <content>). May contain HTML. */
  content: string;
  author: string;
  categories: string[];
  image: FeedItemMedia | null;
  video: FeedItemMedia | null;
  /**
   * The item's own extra leaf fields (namespaced or not) that aren't one of the
   * typed standard fields above — e.g. a feed's custom <source>, <dc:publisher>,
   * <price>. Keyed by lowercased localName so they become insertable {token}s.
   */
  fields: Record<string, string>;
}

export interface ParsedFeed {
  title: string;
  items: FeedItem[];
}

export class FeedParseError extends Error {}

const text = (el: Element | null | undefined): string => el?.textContent?.trim() ?? '';

function parseDate(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve a possibly-relative URL against the feed's own URL. Absolute URLs
 * pass through UNTOUCHED (no normalization) — item links double as dedup guids,
 * so rewriting an absolute URL would re-baseline existing feeds.
 */
function resolveUrl(href: string, base?: string): string {
  if (!href || !base) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif)(\?|#|$)/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm)(\?|#|$)/i;

function mediaKind(url: string, mimeType: string | null): 'image' | 'video' | null {
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType?.startsWith('video/')) return 'video';
  if (IMAGE_EXT.test(url)) return 'image';
  if (VIDEO_EXT.test(url)) return 'video';
  return null;
}

/**
 * Collect the item's first image and first video from <enclosure>,
 * <media:content>, and <media:thumbnail> (thumbnail only as an image
 * fallback), in that priority order.
 */
function extractMedia(item: Element, baseUrl?: string): { image: FeedItemMedia | null; video: FeedItemMedia | null } {
  let image: FeedItemMedia | null = null;
  let video: FeedItemMedia | null = null;

  const consider = (rawUrl: string | null, type: string | null) => {
    if (!rawUrl) return;
    const url = resolveUrl(rawUrl, baseUrl);
    const kind = mediaKind(url, type);
    if (kind === 'image' && !image) image = { url, kind, mimeType: type || null };
    if (kind === 'video' && !video) video = { url, kind, mimeType: type || null };
  };

  for (const el of item.querySelectorAll('enclosure')) {
    consider(el.getAttribute('url'), el.getAttribute('type'));
  }
  // Namespaced elements: jsdom XML mode exposes them via getElementsByTagName
  // with the prefixed name.
  for (const el of Array.from(item.getElementsByTagName('media:content'))) {
    consider(el.getAttribute('url'), el.getAttribute('type') || el.getAttribute('medium'));
  }
  if (!image) {
    const thumb = item.getElementsByTagName('media:thumbnail')[0];
    if (thumb) consider(thumb.getAttribute('url'), 'image/*');
  }
  return { image, video };
}

function nsText(item: Element, name: string): string {
  const el = item.getElementsByTagName(name)[0];
  return el?.textContent?.trim() ?? '';
}

/**
 * Tags that map to a typed FeedItem field (or are structural) and so must NOT
 * be surfaced again as generic custom fields. Compared against lowercased
 * localNames, so both `content:encoded` and `dc:creator` are covered.
 */
const STANDARD_FIELD_TAGS = new Set([
  'title', 'link', 'description', 'summary', 'content', 'encoded',
  'author', 'creator', 'category', 'categories', 'guid', 'id',
  'pubdate', 'published', 'updated', 'date', 'enclosure', 'thumbnail',
  'group', 'comments', 'source', 'image',
]);

const MAX_CUSTOM_FIELDS = 20;
const MAX_CUSTOM_VALUE_LEN = 2000;

/**
 * Collect an item's extra simple leaf fields as `{ token: text }`. Only
 * alphabetic localNames survive (the template token regex is `[a-zA-Z]+`), leaf
 * (no child elements) text nodes are taken, and the standard/structural tags
 * above are skipped so the pills show a feed's OWN custom fields, not repeats.
 */
function collectCustomFields(item: Element): Record<string, string> {
  const out: Record<string, string> = {};
  let count = 0;
  for (const el of Array.from(item.children)) {
    if (count >= MAX_CUSTOM_FIELDS) break;
    if (el.children.length > 0) continue; // leaf only — skip containers
    const name = el.localName?.toLowerCase();
    if (!name || !/^[a-z]+$/.test(name)) continue;
    if (STANDARD_FIELD_TAGS.has(name) || name in out) continue;
    const value = el.textContent?.trim();
    if (!value) continue;
    out[name] = value.slice(0, MAX_CUSTOM_VALUE_LEN);
    count++;
  }
  return out;
}

export function parseFeed(xml: string, feedUrl?: string): ParsedFeed {
  let doc: Document;
  try {
    doc = new JSDOM(xml, { contentType: 'text/xml' }).window.document;
  } catch {
    throw new FeedParseError('Not a valid XML feed');
  }

  // RSS 2.0: <rss><channel><item>…
  const channel = doc.querySelector('rss > channel');
  if (channel) {
    const items: FeedItem[] = [];
    for (const item of channel.querySelectorAll('item')) {
      const link = resolveUrl(text(item.querySelector('link')), feedUrl);
      const guid = text(item.querySelector('guid')) || link;
      if (!guid) continue;
      items.push({
        guid: guid.slice(0, 500),
        title: text(item.querySelector('title')),
        link,
        publishedAt: parseDate(text(item.querySelector('pubDate'))),
        description: text(item.querySelector(':scope > description')),
        content: nsText(item, 'content:encoded'),
        author: text(item.querySelector(':scope > author')) || nsText(item, 'dc:creator'),
        categories: Array.from(item.querySelectorAll(':scope > category')).map((c) => text(c)).filter(Boolean),
        ...extractMedia(item, feedUrl),
        fields: collectCustomFields(item),
      });
    }
    return { title: text(channel.querySelector(':scope > title')), items };
  }

  // Atom: <feed><entry>… — matched by local name so prefixed namespaces
  // (<a:feed xmlns:a="…">) and feeds missing the default xmlns still parse.
  // (querySelector type selectors match by local name in XML documents,
  // so the entry/link/... queries below work for prefixed feeds too.)
  const root = doc.documentElement;
  const feed = root && root.localName === 'feed' ? root : null;
  if (feed) {
    const items: FeedItem[] = [];
    for (const entry of feed.querySelectorAll('entry')) {
      // Prefer the alternate link; fall back to the first link href.
      const linkEl =
        entry.querySelector('link[rel="alternate"]') ?? entry.querySelector('link');
      const link = resolveUrl(linkEl?.getAttribute('href') ?? '', feedUrl);
      const guid = text(entry.querySelector('id')) || link;
      if (!guid) continue;
      // Atom media: <link rel="enclosure" href type> plus media:* extensions.
      const { image, video } = extractMedia(entry, feedUrl);
      let img = image;
      let vid = video;
      for (const encl of entry.querySelectorAll('link[rel="enclosure"]')) {
        const href = resolveUrl(encl.getAttribute('href') ?? '', feedUrl);
        if (!href) continue;
        const kind = mediaKind(href, encl.getAttribute('type'));
        if (kind === 'image' && !img) img = { url: href, kind, mimeType: encl.getAttribute('type') };
        if (kind === 'video' && !vid) vid = { url: href, kind, mimeType: encl.getAttribute('type') };
      }
      items.push({
        guid: guid.slice(0, 500),
        title: text(entry.querySelector('title')),
        link,
        publishedAt: parseDate(
          text(entry.querySelector('published')) || text(entry.querySelector('updated')),
        ),
        description: text(entry.querySelector(':scope > summary')),
        content: text(entry.querySelector(':scope > content')),
        author: text(entry.querySelector(':scope > author > name')),
        categories: Array.from(entry.querySelectorAll(':scope > category'))
          .map((c) => c.getAttribute('term') || text(c))
          .filter(Boolean) as string[],
        image: img,
        video: vid,
        fields: collectCustomFields(entry),
      });
    }
    return { title: text(feed.querySelector(':scope > title')), items };
  }

  throw new FeedParseError('Unsupported feed format (expected RSS 2.0 or Atom)');
}
