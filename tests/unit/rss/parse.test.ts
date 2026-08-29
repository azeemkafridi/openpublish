/**
 * Tests for the RSS 2.0 / Atom feed parser used by autopost.
 */
import { parseFeed, FeedParseError } from '@/lib/rss/parse';

const RSS = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>My Blog</title>
    <item>
      <title>First post</title>
      <link>https://example.com/first</link>
      <guid>https://example.com/first</guid>
      <pubDate>Wed, 15 Jul 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>No guid — falls back to link</title>
      <link>https://example.com/second</link>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Blog</title>
  <entry>
    <id>tag:example.com,2026:entry-1</id>
    <title>Atom entry</title>
    <link rel="alternate" href="https://example.com/atom-1"/>
    <published>2026-07-15T10:00:00Z</published>
  </entry>
</feed>`;

describe('parseFeed', () => {
  it('parses RSS 2.0', () => {
    const feed = parseFeed(RSS);
    expect(feed.title).toBe('My Blog');
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0]).toMatchObject({
      guid: 'https://example.com/first',
      title: 'First post',
      link: 'https://example.com/first',
    });
    expect(feed.items[0].publishedAt).toBeInstanceOf(Date);
    // guid falls back to link
    expect(feed.items[1].guid).toBe('https://example.com/second');
    expect(feed.items[1].publishedAt).toBeNull();
  });

  it('parses Atom', () => {
    const feed = parseFeed(ATOM);
    expect(feed.title).toBe('Atom Blog');
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      guid: 'tag:example.com,2026:entry-1',
      title: 'Atom entry',
      link: 'https://example.com/atom-1',
    });
  });

  it('rejects HTML / non-feed XML', () => {
    expect(() => parseFeed('<html><body>nope</body></html>')).toThrow(FeedParseError);
  });

  it('skips items with no guid and no link', () => {
    const feed = parseFeed(`<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
      <item><title>orphan</title></item></channel></rss>`);
    expect(feed.items).toHaveLength(0);
  });

  it('truncates very long guids to 500 chars', () => {
    const longLink = 'https://example.com/' + 'a'.repeat(600);
    const feed = parseFeed(`<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
      <item><link>${longLink}</link></item></channel></rss>`);
    expect(feed.items[0].guid.length).toBe(500);
  });

  it('extracts description, content:encoded, author, and categories (RSS)', () => {
    const feed = parseFeed(`<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>t</title>
      <item>
        <title>Post</title><link>https://ex.com/p</link>
        <description>&lt;p&gt;Sum&lt;/p&gt;</description>
        <content:encoded>&lt;p&gt;Full body&lt;/p&gt;</content:encoded>
        <dc:creator>Jo</dc:creator>
        <category>news</category><category>tech</category>
      </item></channel></rss>`);
    const item = feed.items[0];
    expect(item.description).toBe('<p>Sum</p>');
    expect(item.content).toBe('<p>Full body</p>');
    expect(item.author).toBe('Jo');
    expect(item.categories).toEqual(['news', 'tech']);
  });

  it('extracts image and video enclosures (RSS)', () => {
    const feed = parseFeed(`<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>t</title>
      <item><link>https://ex.com/a</link>
        <enclosure url="https://ex.com/v.mp4" type="video/mp4" />
        <media:content url="https://ex.com/i.jpg" type="image/jpeg" />
      </item>
      <item><link>https://ex.com/b</link>
        <media:thumbnail url="https://ex.com/t.png" />
      </item></channel></rss>`);
    expect(feed.items[0].video?.url).toBe('https://ex.com/v.mp4');
    expect(feed.items[0].image?.url).toBe('https://ex.com/i.jpg');
    expect(feed.items[1].image?.url).toBe('https://ex.com/t.png');
    expect(feed.items[1].video).toBeNull();
  });

  it('extracts summary, content, author, categories, and enclosure links (Atom)', () => {
    const feed = parseFeed(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>
      <entry>
        <id>a1</id><title>E</title>
        <link rel="alternate" href="https://ex.com/e" />
        <link rel="enclosure" href="https://ex.com/pic.png" type="image/png" />
        <summary>Sum</summary><content>Body</content>
        <author><name>An</name></author>
        <category term="dev" />
      </entry></feed>`);
    const item = feed.items[0];
    expect(item.description).toBe('Sum');
    expect(item.content).toBe('Body');
    expect(item.author).toBe('An');
    expect(item.categories).toEqual(['dev']);
    expect(item.image?.url).toBe('https://ex.com/pic.png');
  });

  it('collects custom leaf fields but not standard/structural tags (RSS)', () => {
    const feed = parseFeed(`<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>t</title>
      <item>
        <title>Post</title><link>https://ex.com/p</link>
        <guid>https://ex.com/p</guid><pubDate>Wed, 15 Jul 2026 10:00:00 GMT</pubDate>
        <dc:publisher>Acme Press</dc:publisher>
        <price>$9.99</price>
        <hyphen-name>ignored</hyphen-name>
        <enclosure url="https://ex.com/i.jpg" type="image/jpeg" />
      </item></channel></rss>`);
    const item = feed.items[0];
    // Custom namespaced + plain leaf fields surface under lowercased localName.
    expect(item.fields.publisher).toBe('Acme Press');
    expect(item.fields.price).toBe('$9.99');
    // Standard/structural tags are NOT duplicated as custom fields.
    expect(item.fields.title).toBeUndefined();
    expect(item.fields.link).toBeUndefined();
    expect(item.fields.guid).toBeUndefined();
    expect(item.fields.pubdate).toBeUndefined();
    expect(item.fields.enclosure).toBeUndefined();
    // Non-alphabetic localNames can't be template tokens, so they're dropped.
    expect(Object.keys(item.fields)).not.toContain('hyphen-name');
  });
});

export {};

describe('parseFeed — namespace and relative-URL handling', () => {
  it('parses Atom with a prefixed namespace', () => {
    const xml = `<?xml version="1.0"?>
<a:feed xmlns:a="http://www.w3.org/2005/Atom">
  <a:title>Prefixed Atom</a:title>
  <a:entry>
    <a:id>tag:example.com,2026:p1</a:id>
    <a:title>Prefixed entry</a:title>
    <a:link rel="alternate" href="https://example.com/p1"/>
  </a:entry>
</a:feed>`;
    const feed = parseFeed(xml);
    expect(feed.title).toBe('Prefixed Atom');
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].link).toBe('https://example.com/p1');
  });

  it('parses Atom missing the default xmlns', () => {
    const xml = `<?xml version="1.0"?>
<feed>
  <title>No-ns Atom</title>
  <entry>
    <id>e1</id>
    <title>Entry</title>
    <link rel="alternate" href="https://example.com/e1"/>
  </entry>
</feed>`;
    const feed = parseFeed(xml);
    expect(feed.items).toHaveLength(1);
  });

  it('resolves relative item links and media against the feed URL', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Rel Blog</title>
    <item>
      <title>Rel post</title>
      <link>/posts/rel-1</link>
      <enclosure url="/img/pic.jpg" type="image/jpeg"/>
    </item>
  </channel>
</rss>`;
    const feed = parseFeed(xml, 'https://blog.example.com/feed.xml');
    expect(feed.items[0].link).toBe('https://blog.example.com/posts/rel-1');
    expect(feed.items[0].image?.url).toBe('https://blog.example.com/img/pic.jpg');
  });

  it('resolves relative Atom links and enclosures', () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Rel Atom</title>
  <entry>
    <id>tag:e,2026:1</id>
    <title>E</title>
    <link rel="alternate" href="../a/1"/>
    <link rel="enclosure" href="vid.mp4" type="video/mp4"/>
  </entry>
</feed>`;
    const feed = parseFeed(xml, 'https://site.example.com/feeds/atom.xml');
    expect(feed.items[0].link).toBe('https://site.example.com/a/1');
    expect(feed.items[0].video?.url).toBe('https://site.example.com/feeds/vid.mp4');
  });

  it('leaves absolute URLs untouched (guid stability)', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Abs</title>
    <item>
      <title>Abs post</title>
      <link>HTTPS://Example.com/Posts/1?a=b#frag</link>
    </item>
  </channel>
</rss>`;
    const feed = parseFeed(xml, 'https://other.example.com/feed');
    expect(feed.items[0].link).toBe('HTTPS://Example.com/Posts/1?a=b#frag');
  });

  it('parses without a feedUrl argument (backwards compatible)', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>T</title><item><title>P</title><link>/rel</link></item></channel></rss>`;
    const feed = parseFeed(xml);
    expect(feed.items[0].link).toBe('/rel');
  });
});
