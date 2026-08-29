import { describe, it, expect } from 'vitest';
import { parseMediaIds } from '@/lib/media/refs';

describe('parseMediaIds', () => {
  it('extracts a plain number[] (current format)', () => {
    expect(parseMediaIds([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('extracts ids from {id, url}[] (legacy object format)', () => {
    expect(parseMediaIds([{ id: 5, url: 'a' }, { id: 6, url: 'b' }])).toEqual([5, 6]);
  });

  it('handles a mix and drops malformed entries', () => {
    expect(parseMediaIds([1, { id: 2 }, null, { url: 'x' }, '7', undefined])).toEqual([1, 2]);
  });

  it('returns [] for non-array / nullish input', () => {
    expect(parseMediaIds(null)).toEqual([]);
    expect(parseMediaIds(undefined)).toEqual([]);
    expect(parseMediaIds({} as unknown)).toEqual([]);
  });
});
