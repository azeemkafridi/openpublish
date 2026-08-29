/**
 * Tests for the RSS field mapping: normalization, HTML stripping, template
 * rendering with fallbacks, truncation, media selection, and per-channel
 * rendering (overrides, char limits, media-required skips).
 */

import {
  normalizeFieldMapping,
  stripHtmlToText,
  renderTemplate,
  truncateForLimit,
  truncateForPlatform,
  selectItemMedia,
  renderForChannel,
  renderItemForChannels,
  availableTokens,
  DEFAULT_FIELD_MAPPING,
  type RssFieldMapping,
} from '@/lib/rss/mapping';
import type { FeedItem } from '@/lib/rss/parse';
import { platformLength } from '@/lib/url';

const ITEM: FeedItem = {
  guid: 'g1',
  title: 'Hello World',
  link: 'https://ex.com/hello',
  publishedAt: new Date('2026-07-01T10:00:00Z'),
  description: '<p>A &amp; B summary</p>',
  content: '<h1>Big</h1><p>First para.</p><p>Second para.</p>',
  author: 'Jo',
  categories: ['news', 'tech'],
  image: { url: 'https://ex.com/a.jpg', kind: 'image', mimeType: 'image/jpeg' },
  video: null,
  fields: {},
};

const CTX = { item: ITEM, feedName: 'Blog' };

describe('normalizeFieldMapping', () => {
  it('passes undefined/null through', () => {
    expect(normalizeFieldMapping(undefined)).toBeUndefined();
    expect(normalizeFieldMapping(null)).toBeNull();
  });

  it('fills defaults and drops empty overrides', () => {
    const m = normalizeFieldMapping({ template: '{title}', channelOverrides: { '5': {} } });
    expect(m).toEqual({ template: '{title}', mediaField: 'none', stripHtml: true, truncate: 'smart', hashtags: '' });
  });

  it('rejects invalid shapes', () => {
    expect(normalizeFieldMapping([])).toBeNull();
    expect(normalizeFieldMapping({ template: '' })).toBeNull();
    expect(normalizeFieldMapping({ template: '{title}', channelOverrides: { abc: {} } })).toBeNull();
    expect(normalizeFieldMapping({ template: '{title}', channelOverrides: { '5': { truncate: 'nope' } } })).toBeNull();
  });

  it('keeps valid overrides keyed by channel id', () => {
    const m = normalizeFieldMapping({
      template: '{title}\n\n{link}',
      mediaField: 'auto',
      truncate: 'skip',
      hashtags: ' #a ',
      channelOverrides: { '10': { template: '{title} {link}', stripHtml: false } },
    });
    expect(m).toMatchObject({
      mediaField: 'auto',
      truncate: 'skip',
      hashtags: '#a',
      channelOverrides: { '10': { template: '{title} {link}', stripHtml: false } },
    });
  });
});

describe('stripHtmlToText', () => {
  it('strips tags, decodes entities, keeps paragraph breaks', () => {
    expect(stripHtmlToText('<p>A &amp; B</p><p>C&#33;</p>')).toBe('A & B\nC!');
  });
  it('drops script/style content', () => {
    expect(stripHtmlToText('<script>x()</script>Hi<style>a{}</style>')).toBe('Hi');
  });
});

describe('renderTemplate', () => {
  it('substitutes tokens', () => {
    expect(renderTemplate('{title}\n\n{link}', CTX, true)).toBe('Hello World\n\nhttps://ex.com/hello');
  });

  it('drops lines whose tokens are all empty (fallback)', () => {
    const item = { ...ITEM, author: '' };
    expect(renderTemplate('{title}\nBy {author}\n{link}', { ...CTX, item }, true)).toBe(
      'Hello World\nBy\nhttps://ex.com/hello',
    );
    // A line that is ONLY an empty token disappears entirely.
    expect(renderTemplate('{title}\n{author}\n{link}', { ...CTX, item }, true)).toBe(
      'Hello World\nhttps://ex.com/hello',
    );
  });

  it('strips HTML from description/content when enabled and keeps it otherwise', () => {
    expect(renderTemplate('{description}', CTX, true)).toBe('A & B summary');
    expect(renderTemplate('{description}', CTX, false)).toBe('<p>A &amp; B summary</p>');
  });

  it('renders categories and feedName, leaves unknown tokens as-is', () => {
    expect(renderTemplate('{feedName}: {categories} {nope}', CTX, true)).toBe('Blog: news, tech {nope}');
  });
});

describe('truncateForLimit', () => {
  it('returns short text unchanged', () => {
    expect(truncateForLimit('short', 280, 'smart')).toBe('short');
  });

  it('hard cut ends with an ellipsis at the limit', () => {
    const out = truncateForLimit('a'.repeat(300), 280, 'hard');
    expect(out.length).toBeLessThanOrEqual(280);
    expect(out.endsWith('…')).toBe(true);
  });

  it('smart mode preserves a trailing link line', () => {
    const link = 'https://ex.com/hello';
    const body = `${'word '.repeat(80).trim()}\n\n${link}`;
    const out = truncateForLimit(body, 280, 'smart');
    expect(out.length).toBeLessThanOrEqual(280);
    expect(out.endsWith(link)).toBe(true);
    expect(out).toContain('…');
  });
});

describe('selectItemMedia', () => {
  it('honors mediaField', () => {
    const m = (mediaField: RssFieldMapping['mediaField']): RssFieldMapping => ({ ...DEFAULT_FIELD_MAPPING, mediaField });
    expect(selectItemMedia(m('none'), ITEM)).toBeNull();
    expect(selectItemMedia(m('image'), ITEM)?.url).toBe('https://ex.com/a.jpg');
    expect(selectItemMedia(m('video'), ITEM)).toBeNull();
    expect(selectItemMedia(m('auto'), ITEM)?.kind).toBe('image');
    const withVideo = { ...ITEM, video: { url: 'https://ex.com/v.mp4', kind: 'video' as const, mimeType: 'video/mp4' } };
    expect(selectItemMedia(m('auto'), withVideo)?.kind).toBe('video');
  });
});

describe('renderForChannel', () => {
  const X = { id: 10, platform: 'x' };

  it('renders the default mapping within limits', () => {
    const r = renderForChannel(DEFAULT_FIELD_MAPPING, CTX, X, null);
    expect(r.skipped).toBe(false);
    expect(r.text).toBe('Hello World\n\nhttps://ex.com/hello');
    expect(r.charLimit).toBe(280);
  });

  it('appends hashtags', () => {
    const r = renderForChannel({ ...DEFAULT_FIELD_MAPPING, hashtags: '#a #b' }, CTX, X, null);
    expect(r.text.endsWith('\n\n#a #b')).toBe(true);
  });

  it('applies a per-channel override and flags it', () => {
    const mapping: RssFieldMapping = {
      ...DEFAULT_FIELD_MAPPING,
      channelOverrides: { '10': { template: 'X: {title}', hashtags: '#x' } },
    };
    const r = renderForChannel(mapping, CTX, X, null);
    expect(r.overridden).toBe(true);
    expect(r.text).toBe('X: Hello World\n\n#x');
  });

  it('truncates over-limit text (smart keeps the link)', () => {
    const item = { ...ITEM, title: 'T '.repeat(200).trim() };
    const r = renderForChannel(DEFAULT_FIELD_MAPPING, { ...CTX, item }, X, null);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(280);
    expect(r.text.endsWith(ITEM.link)).toBe(true);
  });

  it('skips the channel when truncate=skip and text is over the limit', () => {
    const item = { ...ITEM, title: 'T'.repeat(400) };
    const r = renderForChannel({ ...DEFAULT_FIELD_MAPPING, truncate: 'skip' }, { ...CTX, item }, X, null);
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toMatch(/over the x limit/);
  });

  it('skips media-required platforms when the item has no usable media', () => {
    const ig = renderForChannel(DEFAULT_FIELD_MAPPING, CTX, { id: 11, platform: 'instagram' }, null);
    expect(ig.skipped).toBe(true);
    expect(ig.skipReason).toMatch(/attaches no media/);

    // YouTube needs a video; an image doesn't satisfy it.
    const yt = renderForChannel(
      { ...DEFAULT_FIELD_MAPPING, mediaField: 'image' },
      CTX,
      { id: 12, platform: 'youtube' },
      ITEM.image,
    );
    expect(yt.skipped).toBe(true);
    expect(yt.skipReason).toMatch(/needs a video/);
  });

  it('publishes to a media-required platform when media matches', () => {
    const r = renderForChannel(
      { ...DEFAULT_FIELD_MAPPING, mediaField: 'image' },
      CTX,
      { id: 11, platform: 'instagram' },
      ITEM.image,
    );
    expect(r.skipped).toBe(false);
  });

  it('skips when the template renders empty for this item', () => {
    const item = { ...ITEM, author: '' };
    const r = renderForChannel({ ...DEFAULT_FIELD_MAPPING, template: '{author}' }, { ...CTX, item }, X, null);
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toMatch(/empty/);
  });
});

describe('renderItemForChannels', () => {
  it('renders every channel with the shared item media', () => {
    const mapping: RssFieldMapping = { ...DEFAULT_FIELD_MAPPING, mediaField: 'auto' };
    const { media, renders } = renderItemForChannels(mapping, CTX, [
      { id: 10, platform: 'x' },
      { id: 11, platform: 'instagram' },
      { id: 12, platform: 'youtube' },
    ]);
    expect(media?.kind).toBe('image');
    expect(renders.find((r) => r.channelId === 10)?.skipped).toBe(false);
    expect(renders.find((r) => r.channelId === 11)?.skipped).toBe(false);
    expect(renders.find((r) => r.channelId === 12)?.skipped).toBe(true); // no video
  });
});

describe('url-weighted char counting (x/mastodon)', () => {
  const LONG_LINK = 'https://ex.com/' + 'p'.repeat(260); // 275 chars, counts as 23 on x

  it('does not truncate when a long URL keeps the weighted count under the limit', () => {
    // title(11) + \n\n(2) + 23 = 36 weighted — plain length would be 288 (> 280)
    const item = { ...ITEM, link: LONG_LINK };
    const r = renderForChannel(DEFAULT_FIELD_MAPPING, { ...CTX, item }, { id: 10, platform: 'x' }, null);
    expect(r.truncated).toBe(false);
    expect(r.skipped).toBe(false);
    expect(r.text.endsWith(LONG_LINK)).toBe(true);
  });

  it('reports weighted char count in the skip reason', () => {
    const item = { ...ITEM, title: 'T'.repeat(400), link: LONG_LINK };
    const r = renderForChannel(
      { ...DEFAULT_FIELD_MAPPING, truncate: 'skip' },
      { ...CTX, item },
      { id: 10, platform: 'x' },
      null,
    );
    expect(r.skipped).toBe(true);
    // weighted: 400 + 2 + 23 = 425, not the plain 677
    expect(r.skipReason).toContain('425 characters');
  });

  it('truncateForPlatform keeps a long trailing link and fits the weighted limit', () => {
    const body = 'w '.repeat(300).trim() + '\n\n' + LONG_LINK;
    const out = truncateForPlatform(body, 280, 'smart', 'x');
    expect(out.endsWith(LONG_LINK)).toBe(true);
    // weighted length must fit
    const weighted = out.length - LONG_LINK.length + 23;
    expect(weighted).toBeLessThanOrEqual(280);
    // and it should use MORE plain budget than an unweighted truncation would
    expect(out.length).toBeGreaterThan(280);
  });

  it('truncateForPlatform fits URL-dense bodies where weighted length far exceeds plain length', () => {
    // 60 short links: plain 959 chars, weighted 1439 — the naive effLimit
    // (limit - surplus) would go negative and return most of the body.
    const body = Array.from({ length: 60 }, () => 'https://a.co/NN').join(' ');
    for (const mode of ['smart', 'hard'] as const) {
      const out = truncateForPlatform(body, 280, mode, 'x');
      expect(platformLength(out, 'x')).toBeLessThanOrEqual(280);
      expect(out.length).toBeGreaterThan(0);
    }
  });

  it('truncateForPlatform behaves like truncateForLimit on non-weighted platforms', () => {
    const body = 'x'.repeat(600);
    expect(truncateForPlatform(body, 500, 'hard', 'linkedin')).toBe(truncateForLimit(body, 500, 'hard'));
  });
});

describe('custom feed field tokens', () => {
  it('resolves an unknown token from item.fields (with HTML stripped)', () => {
    const ctx = { item: { ...ITEM, fields: { publisher: '<b>Acme</b> Press' } }, feedName: 'Blog' };
    expect(renderTemplate('{title}\n{publisher}', ctx, true)).toBe('Hello World\nAcme Press');
  });

  it('is case-insensitive on the custom token name', () => {
    const ctx = { item: { ...ITEM, fields: { price: '$9.99' } }, feedName: 'Blog' };
    expect(renderTemplate('{Price}', ctx, true)).toBe('$9.99');
  });

  it('leaves a token that matches neither a standard field nor a custom field as-is', () => {
    const ctx = { item: { ...ITEM, fields: {} }, feedName: 'Blog' };
    expect(renderTemplate('{nope}', ctx, true)).toBe('{nope}');
  });
});

describe('availableTokens', () => {
  it('lists populated standard tokens then custom fields', () => {
    const item = { ...ITEM, author: '', categories: [], fields: { publisher: 'Acme' } };
    const tokens = availableTokens(item, 'Blog');
    const map = Object.fromEntries(tokens.map((t) => [t.token, t.label]));
    // title/link/description/content present; author/categories omitted (empty).
    expect(map['{title}']).toBe('Title');
    expect(map['{feedName}']).toBe('Feed name');
    expect(map['{author}']).toBeUndefined();
    expect(map['{categories}']).toBeUndefined();
    // Custom field appears with a humanized label.
    expect(map['{publisher}']).toBe('Publisher');
  });

  it('always offers link and feedName even when other fields are empty', () => {
    const item = { ...ITEM, title: '', description: '', content: '', author: '', categories: [], fields: {} };
    const tokens = availableTokens(item, 'Blog').map((t) => t.token);
    expect(tokens).toContain('{link}');
    expect(tokens).toContain('{feedName}');
    expect(tokens).not.toContain('{title}');
  });
});

export {};
