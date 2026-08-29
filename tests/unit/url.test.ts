/**
 * URL extraction utility tests.
 *
 * Tests webapp/src/lib/url.ts covering:
 *   - extractFirstUrl: finds HTTP/HTTPS URLs in text
 *   - extractFirstUrl: returns null when no URL present
 *   - extractFirstUrl: returns first URL when multiple exist
 *   - extractFirstUrl: strips trailing punctuation
 *   - extractFirstUrl: handles empty/null-ish input
 *   - extractAllUrls: returns all URLs found
 *   - extractAllUrls: returns empty array when no URLs
 */

import { extractFirstUrl, extractAllUrls, platformLength, countsUrlsAsFixedLength, URL_CHAR_WEIGHT } from '@/lib/url';

describe('extractFirstUrl', () => {
  it('finds an HTTPS URL in text', () => {
    const text = 'Check out https://example.com for more info';
    expect(extractFirstUrl(text)).toBe('https://example.com');
  });

  it('finds an HTTP URL in text', () => {
    const text = 'Visit http://example.com today';
    expect(extractFirstUrl(text)).toBe('http://example.com');
  });

  it('finds a URL with path and query params', () => {
    const text = 'See https://example.com/path/to/page?foo=bar&baz=1';
    expect(extractFirstUrl(text)).toBe('https://example.com/path/to/page?foo=bar&baz=1');
  });

  it('finds a URL with fragment', () => {
    const text = 'Link: https://example.com/page#section-2';
    expect(extractFirstUrl(text)).toBe('https://example.com/page#section-2');
  });

  it('returns null when no URL is present', () => {
    expect(extractFirstUrl('No links here, just text')).toBeNull();
    expect(extractFirstUrl('email: user@example.com is not a URL')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractFirstUrl('')).toBeNull();
  });

  it('returns null for falsy input', () => {
    expect(extractFirstUrl(null as any)).toBeNull();
    expect(extractFirstUrl(undefined as any)).toBeNull();
  });

  it('returns the first URL when multiple exist', () => {
    const text = 'First: https://first.com and second: https://second.com';
    expect(extractFirstUrl(text)).toBe('https://first.com');
  });

  it('strips trailing period', () => {
    const text = 'Visit https://example.com.';
    expect(extractFirstUrl(text)).toBe('https://example.com');
  });

  it('strips trailing comma', () => {
    const text = 'Link: https://example.com, more text';
    expect(extractFirstUrl(text)).toBe('https://example.com');
  });

  it('strips trailing semicolon', () => {
    const text = 'URL: https://example.com; next sentence';
    expect(extractFirstUrl(text)).toBe('https://example.com');
  });

  it('strips trailing exclamation mark', () => {
    const text = 'Check this out https://example.com!';
    expect(extractFirstUrl(text)).toBe('https://example.com');
  });

  it('strips trailing closing parenthesis', () => {
    const text = '(see https://example.com)';
    expect(extractFirstUrl(text)).toBe('https://example.com');
  });

  it('strips trailing colon', () => {
    const text = 'URL: https://example.com:';
    expect(extractFirstUrl(text)).toBe('https://example.com');
  });

  it('preserves port numbers in URLs', () => {
    const text = 'Running at https://localhost:3000/dashboard';
    expect(extractFirstUrl(text)).toBe('https://localhost:3000/dashboard');
  });

  it('handles URL at start of text', () => {
    const text = 'https://example.com is a great site';
    expect(extractFirstUrl(text)).toBe('https://example.com');
  });

  it('handles URL at end of text', () => {
    const text = 'Great site: https://example.com';
    expect(extractFirstUrl(text)).toBe('https://example.com');
  });

  it('handles URL that is the entire text', () => {
    const text = 'https://example.com/page';
    expect(extractFirstUrl(text)).toBe('https://example.com/page');
  });

  it('handles URLs with encoded characters', () => {
    const text = 'Link: https://example.com/path%20with%20spaces';
    expect(extractFirstUrl(text)).toBe('https://example.com/path%20with%20spaces');
  });
});

describe('extractAllUrls', () => {
  it('returns all URLs found in text', () => {
    const text = 'First: https://first.com and second: https://second.com and third: http://third.org/page';
    const urls = extractAllUrls(text);
    expect(urls).toEqual([
      'https://first.com',
      'https://second.com',
      'http://third.org/page',
    ]);
  });

  it('returns empty array when no URLs found', () => {
    expect(extractAllUrls('No links here')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(extractAllUrls('')).toEqual([]);
  });

  it('returns empty array for falsy input', () => {
    expect(extractAllUrls(null as any)).toEqual([]);
    expect(extractAllUrls(undefined as any)).toEqual([]);
  });

  it('strips trailing punctuation from each URL', () => {
    const text = 'Link1: https://a.com, Link2: https://b.com.';
    const urls = extractAllUrls(text);
    expect(urls).toEqual(['https://a.com', 'https://b.com']);
  });

  it('handles single URL', () => {
    const text = 'Only one: https://example.com';
    expect(extractAllUrls(text)).toEqual(['https://example.com']);
  });
});

describe('platformLength', () => {
  const longUrl = 'https://example.com/very/long/path/that/goes/on/and/on/forever?with=query&and=more'; // 83 chars

  it('counts URLs as 23 chars on x', () => {
    const text = `Read this: ${longUrl}`;
    expect(platformLength(text, 'x')).toBe('Read this: '.length + URL_CHAR_WEIGHT);
  });

  it('counts URLs as 23 chars on mastodon', () => {
    expect(platformLength(longUrl, 'mastodon')).toBe(URL_CHAR_WEIGHT);
  });

  it('counts short URLs as 23 chars too', () => {
    expect(platformLength('https://a.co', 'x')).toBe(URL_CHAR_WEIGHT);
  });

  it('weights every URL in the text', () => {
    const text = `${longUrl} and ${longUrl}`;
    expect(platformLength(text, 'x')).toBe(URL_CHAR_WEIGHT + ' and '.length + URL_CHAR_WEIGHT);
  });

  it('does not count trailing punctuation as part of the URL', () => {
    const text = `See ${longUrl}.`;
    expect(platformLength(text, 'x')).toBe('See '.length + URL_CHAR_WEIGHT + 1);
  });

  it('uses plain length on non-weighted platforms', () => {
    const text = `Read this: ${longUrl}`;
    expect(platformLength(text, 'linkedin')).toBe(text.length);
    expect(platformLength(text, 'bluesky')).toBe(text.length);
  });

  it('handles empty/no-URL text', () => {
    expect(platformLength('', 'x')).toBe(0);
    expect(platformLength('no links', 'x')).toBe(8);
  });

  it('countsUrlsAsFixedLength flags only x and mastodon', () => {
    expect(countsUrlsAsFixedLength('x')).toBe(true);
    expect(countsUrlsAsFixedLength('mastodon')).toBe(true);
    expect(countsUrlsAsFixedLength('facebook')).toBe(false);
  });
});
