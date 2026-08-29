import { describe, it, expect } from 'vitest';
import { emptyContentLabel } from '@/lib/posts/contentLabel';

export {};

function daysAgoIso(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe('emptyContentLabel', () => {
  it('does NOT claim removal for a recently published title-only post', () => {
    // The bug: a multi-channel post where only a Title was set (empty body) was
    // labelled "Content removed after 3 months" the moment it published.
    expect(emptyContentLabel('published', daysAgoIso(1))).toBe('(No text content)');
    expect(emptyContentLabel('partial', daysAgoIso(10))).toBe('(No text content)');
  });

  it('labels removal only once a published post is older than the 3-month window', () => {
    expect(emptyContentLabel('published', daysAgoIso(120))).toBe('(Content removed after 3 months)');
  });

  it('never claims removal for non-published posts regardless of age', () => {
    expect(emptyContentLabel('draft', daysAgoIso(200))).toBe('(No text content)');
    expect(emptyContentLabel('scheduled', daysAgoIso(200))).toBe('(No text content)');
  });

  it('is safe when createdAt is missing', () => {
    expect(emptyContentLabel('published', null)).toBe('(No text content)');
    expect(emptyContentLabel('published', undefined)).toBe('(No text content)');
  });
});
