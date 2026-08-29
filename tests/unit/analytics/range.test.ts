import { describe, it, expect } from 'vitest';
import { clampFrom, earliestAllowedFrom, MAX_STATS_WINDOW_DAYS } from '@/lib/analytics/range';

export {};

/**
 * The 30-day window cap enforces YouTube API Services Developer Policy III.E.4 (and the
 * equivalent Meta/X/TikTok/LinkedIn/Pinterest retention limits): no statistics may be
 * displayed or returned for a window older than 30 days. Use a fixed noon-UTC `now` so the
 * computed floor is stable across the timezones CI and local dev run in.
 */
describe('analytics range clamp (30-day statistics cap)', () => {
  const now = new Date('2026-06-19T12:00:00Z');
  const floor = '2026-05-20'; // 2026-06-19 minus 30 days

  it('caps the window at 30 days', () => {
    expect(MAX_STATS_WINDOW_DAYS).toBe(30);
  });

  it('earliestAllowedFrom is today minus 30 days', () => {
    expect(earliestAllowedFrom(now)).toBe(floor);
  });

  it('clamps a from older than 30 days up to the floor', () => {
    expect(clampFrom('2020-01-01', now)).toBe(floor);
    expect(clampFrom('2026-01-01', now)).toBe(floor);
    expect(clampFrom('2026-05-19', now)).toBe(floor); // one day past the limit
  });

  it('leaves a from within 30 days untouched', () => {
    expect(clampFrom('2026-05-20', now)).toBe('2026-05-20'); // exactly the limit
    expect(clampFrom('2026-06-10', now)).toBe('2026-06-10');
    expect(clampFrom('2026-06-19', now)).toBe('2026-06-19');
  });

  it('normalizes an ISO datetime to its date before clamping', () => {
    expect(clampFrom('2026-06-15T08:30:00Z', now)).toBe('2026-06-15');
    expect(clampFrom('2020-06-15T08:30:00Z', now)).toBe(floor);
  });

  it('falls back to the floor for blank or missing input', () => {
    expect(clampFrom('', now)).toBe(floor);
    expect(clampFrom(null, now)).toBe(floor);
    expect(clampFrom(undefined, now)).toBe(floor);
  });
});
