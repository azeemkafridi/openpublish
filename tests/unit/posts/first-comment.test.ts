/**
 * Tests for recordFirstCommentResult — persists the outcome of the app-authored
 * "First Comment" reply into posts.platform_specific._firstCommentResults.
 *
 * The write must be a jsonb_set merge (not a read-modify-write) so two
 * platforms finishing concurrently can't clobber each other's result.
 */
const { captured } = vi.hoisted(() => {
  const captured = { set: null as any, whereCalled: false };
  return { captured };
});

vi.mock('@lib/db', () => ({
  db: {
    update: () => ({
      set: (payload: any) => {
        captured.set = payload;
        return {
          where: () => {
            captured.whereCalled = true;
            return Promise.resolve(undefined);
          },
        };
      },
    }),
  },
}));

vi.mock('@lib/db/schema', () => ({
  posts: { id: 'posts.id', platformSpecific: 'posts.platform_specific' },
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  captured.set = null;
  captured.whereCalled = false;
});

describe('recordFirstCommentResult', () => {
  it('writes a posted result scoped to the platform', async () => {
    const { recordFirstCommentResult } = await import('@lib/posts/first-comment');

    await recordFirstCommentResult(42, 'facebook', {
      status: 'posted',
      at: '2026-07-27T10:00:00.000Z',
    });

    expect(captured.whereCalled).toBe(true);
    const sqlText = JSON.stringify(captured.set.platformSpecific);
    // Merges rather than replaces, and targets the platform's own key.
    expect(sqlText).toContain('jsonb_set');
    expect(sqlText).toContain('_firstCommentResults');
    expect(sqlText).toContain('facebook');
    expect(sqlText).toContain('posted');
  });

  it('records the error text on a failed attempt', async () => {
    const { recordFirstCommentResult } = await import('@lib/posts/first-comment');

    await recordFirstCommentResult(42, 'instagram', {
      status: 'failed',
      error: 'Permission denied',
      at: '2026-07-27T10:00:00.000Z',
    });

    const sqlText = JSON.stringify(captured.set.platformSpecific);
    expect(sqlText).toContain('instagram');
    expect(sqlText).toContain('failed');
    expect(sqlText).toContain('Permission denied');
  });

  it('omits the error field when the comment succeeded', async () => {
    const { recordFirstCommentResult } = await import('@lib/posts/first-comment');

    await recordFirstCommentResult(7, 'threads', {
      status: 'posted',
      at: '2026-07-27T10:00:00.000Z',
    });

    const sqlText = JSON.stringify(captured.set.platformSpecific);
    expect(sqlText).not.toContain('"error"');
  });
});

export {};
