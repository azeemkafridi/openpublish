/**
 * threadComments() — orders comments so replies sit under the comment they
 * answer. The list count shown above it comes from the raw array, so this MUST
 * return every comment: anything it silently drops makes the header disagree
 * with the list.
 */
import { describe, it, expect } from 'vitest';
import { threadComments, type Comment } from '@/components/analytics/engagement-shared';

const c = (id: string, parentId?: string): Comment => ({
  id,
  text: id,
  parentId,
  actor: { id: `a-${id}`, name: id },
});

describe('threadComments', () => {
  it('nests a reply under its parent', () => {
    const out = threadComments([c('1'), c('2', '1')]);
    expect(out.map((o) => [o.comment.id, o.depth])).toEqual([['1', 0], ['2', 1]]);
  });

  it('keeps a reply whose parent is outside the page at top level', () => {
    const out = threadComments([c('2', 'missing')]);
    expect(out).toEqual([{ comment: expect.objectContaining({ id: '2' }), depth: 0 }]);
  });

  it('clamps depth so deep chains stay at one indent', () => {
    const out = threadComments([c('1'), c('2', '1'), c('3', '2'), c('4', '3')]);
    expect(out.map((o) => o.depth)).toEqual([0, 1, 1, 1]);
  });

  it('renders every comment even when parents form a cycle', () => {
    // Facebook has been seen to return parent.id equal to the comment's own id.
    const out = threadComments([c('1', '2'), c('2', '1'), c('3', '3')]);
    expect(out).toHaveLength(3);
    expect(out.map((o) => o.comment.id).sort()).toEqual(['1', '2', '3']);
  });

  it('preserves input order among siblings', () => {
    const out = threadComments([c('a'), c('b'), c('c')]);
    expect(out.map((o) => o.comment.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty list unchanged', () => {
    expect(threadComments([])).toEqual([]);
  });
});

export {};
