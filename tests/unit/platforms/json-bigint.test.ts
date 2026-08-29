import { describe, it, expect } from 'vitest';
import {
  parseJsonPreservingBigInts,
  quoteUnsafeIntegers,
  idToString,
} from '@lib/platforms/json-bigint';

export {};

// The exact id from the report: https://www.tiktok.com/@surah.pk/video/7667872114598333716
const REAL_ID = '7667872114598333716';
const ROUNDED_ID = '7667872114598333000';

describe('parseJsonPreservingBigInts', () => {
  it('demonstrates the bug it exists to fix', () => {
    // Guard: if JSON.parse ever stopped rounding, this module is unnecessary.
    const broken = JSON.parse(`{"id":${REAL_ID}}`);
    expect(String(broken.id)).toBe(ROUNDED_ID);
  });

  it('preserves the exact digits of an out-of-range integer', () => {
    const parsed = parseJsonPreservingBigInts(`{"id":${REAL_ID}}`) as { id: string };
    expect(parsed.id).toBe(REAL_ID);
    expect(typeof parsed.id).toBe('string');
  });

  it('preserves ids inside arrays — TikTok returns publicaly_available_post_id as one', () => {
    const parsed = parseJsonPreservingBigInts(
      `{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[${REAL_ID}]}}`,
    ) as { data: { publicaly_available_post_id: string[] } };
    expect(parsed.data.publicaly_available_post_id[0]).toBe(REAL_ID);
  });

  it('leaves safe integers as numbers so count arithmetic is unchanged', () => {
    const parsed = parseJsonPreservingBigInts(
      '{"like_count":42,"view_count":9007199254740991,"zero":0,"neg":-17}',
    ) as Record<string, unknown>;
    expect(parsed.like_count).toBe(42);
    expect(typeof parsed.like_count).toBe('number');
    // Exactly MAX_SAFE_INTEGER is still safe.
    expect(parsed.view_count).toBe(9007199254740991);
    expect(typeof parsed.view_count).toBe('number');
    expect(parsed.zero).toBe(0);
    expect(parsed.neg).toBe(-17);
  });

  it('quotes an unsafe negative integer without losing the sign', () => {
    const parsed = parseJsonPreservingBigInts('{"n":-9007199254740993}') as { n: string };
    expect(parsed.n).toBe('-9007199254740993');
  });

  it('does not touch long digit runs inside strings', () => {
    const caption = 'call 12345678901234567890 now';
    const parsed = parseJsonPreservingBigInts(
      JSON.stringify({ caption, id: 1 }),
    ) as { caption: string; id: number };
    expect(parsed.caption).toBe(caption);
    expect(parsed.id).toBe(1);
  });

  it('does not mistake an escaped quote for the end of a string', () => {
    const parsed = parseJsonPreservingBigInts(
      '{"a":"he said \\"7667872114598333716\\"","b":' + REAL_ID + '}',
    ) as { a: string; b: string };
    expect(parsed.a).toBe('he said "7667872114598333716"');
    expect(parsed.b).toBe(REAL_ID);
  });

  it('leaves floats and exponents alone', () => {
    const parsed = parseJsonPreservingBigInts(
      '{"f":7667872114598333.716,"e":7.667872114598333e18}',
    ) as { f: number; e: number };
    expect(typeof parsed.f).toBe('number');
    expect(typeof parsed.e).toBe('number');
    expect(parsed.e).toBe(7.667872114598333e18);
  });

  it('round-trips ordinary payloads identically to JSON.parse', () => {
    const payloads = [
      '{"data":{"videos":[{"id":1,"like_count":0}]}}',
      '[]',
      '{"nested":{"a":[1,2,3],"b":null,"c":true,"d":"x"}}',
      'null',
      '"just a string"',
      '123',
    ];
    for (const p of payloads) {
      expect(parseJsonPreservingBigInts(p)).toEqual(JSON.parse(p));
    }
  });

  it('throws on malformed JSON, like JSON.parse', () => {
    expect(() => parseJsonPreservingBigInts('{oops')).toThrow();
  });

  it('handles a 16-digit safe integer at the length prefilter boundary', () => {
    // 16 digits but still safe — must stay a number.
    const safe16 = '1234567890123456';
    expect(Number.isSafeInteger(Number(safe16))).toBe(true);
    const parsed = parseJsonPreservingBigInts(`{"n":${safe16}}`) as { n: number };
    expect(parsed.n).toBe(1234567890123456);
    expect(typeof parsed.n).toBe('number');
  });
});

describe('quoteUnsafeIntegers', () => {
  it('is a no-op when every number is safe', () => {
    const src = '{"a":1,"b":[2,3],"c":"4"}';
    expect(quoteUnsafeIntegers(src)).toBe(src);
  });
});

describe('idToString', () => {
  it('passes strings through unchanged', () => {
    expect(idToString(REAL_ID)).toBe(REAL_ID);
  });

  it('stringifies numbers', () => {
    expect(idToString(123)).toBe('123');
  });

  it('returns undefined for absent or non-id values', () => {
    expect(idToString(undefined)).toBeUndefined();
    expect(idToString(null)).toBeUndefined();
    expect(idToString({})).toBeUndefined();
    expect(idToString(NaN)).toBeUndefined();
  });
});
