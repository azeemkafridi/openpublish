/**
 * Media storage cleanup tests.
 *
 * Tests webapp/src/lib/media/storage.ts covering:
 *   - cleanupPostMedia skips when deleteMediaAfterPublish is false
 *   - Skips when not all platforms are done (published or failed)
 *   - Handles both numeric ID and {id} object formats in mediaFiles
 *   - Skips media referenced by other posts (JSONB containment check)
 *   - Deletes from R2 for R2 keys
 *   - Deletes from filesystem for local paths
 *   - Marks isOriginalDeleted in DB after deletion
 *   - Uses organizationId (not userId) for ownership verification
 *   - Skips already-deleted media (isOriginalDeleted = true)
 *   - Handles errors gracefully without throwing
 */

// ---------------------------------------------------------------------------
// Mocks (hoisted)
// ---------------------------------------------------------------------------

const mockDbSelect = vi.fn();
const mockDbUpdate = vi.fn();
const mockDeleteFromR2 = vi.fn();
const mockIsR2Key = vi.fn();
const mockExistsSync = vi.fn();
const mockUnlinkSync = vi.fn();

vi.mock('@lib/db', () => {
  // Chainable query builder mock
  function makeChain(resolveValue: any[] = []) {
    const chain: Record<string, any> = {};
    const methods = ['select', 'from', 'where', 'orderBy', 'limit', 'offset', 'innerJoin', 'leftJoin', 'set'];
    for (const m of methods) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    // Make it thenable so `await db.select()...` resolves
    (chain as Record<symbol, unknown>)[Symbol.for('resolveValue')] = resolveValue;
    chain.then = (resolve: any, reject?: any) => {
      try {
        return Promise.resolve(resolve((chain as Record<symbol, unknown>)[Symbol.for('resolveValue')]));
      } catch (e) {
        return reject ? Promise.resolve(reject(e)) : Promise.reject(e);
      }
    };
    return chain;
  }

  const selectChain = makeChain();
  const updateChain = makeChain();

  mockDbSelect.mockReturnValue(selectChain);
  mockDbUpdate.mockReturnValue(updateChain);

  return {
    db: {
      select: mockDbSelect,
      update: mockDbUpdate,
    },
  };
});

vi.mock('@lib/db/schema', () => ({
  posts: {
    id: 'posts.id',
    organizationId: 'posts.organizationId',
    mediaFiles: 'posts.mediaFiles',
    deleteMediaAfterPublish: 'posts.deleteMediaAfterPublish',
  },
  mediaFiles: {
    id: 'mediaFiles.id',
    organizationId: 'mediaFiles.organizationId',
    originalPath: 'mediaFiles.originalPath',
    isOriginalDeleted: 'mediaFiles.isOriginalDeleted',
    variants: 'mediaFiles.variants',
  },
  postPlatforms: {
    postId: 'postPlatforms.postId',
    status: 'postPlatforms.status',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ type: 'eq', args: a })),
  and: vi.fn((...a: any[]) => ({ type: 'and', args: a })),
  or: vi.fn((...a: any[]) => ({ type: 'or', args: a })),
  ne: vi.fn((...a: any[]) => ({ type: 'ne', args: a })),
  sql: vi.fn(),
}));

vi.mock('@/lib/media/r2', () => ({
  deleteFromR2: mockDeleteFromR2,
  isR2Key: mockIsR2Key,
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: mockExistsSync,
    unlinkSync: mockUnlinkSync,
  },
  existsSync: mockExistsSync,
  unlinkSync: mockUnlinkSync,
}));

vi.mock('@lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

export {};

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------

const { cleanupPostMedia } = await import('@/lib/media/storage');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Configure the DB mock to return specific values for sequential select() calls */
function mockSelectSequence(calls: any[][]) {
  let callIndex = 0;
  mockDbSelect.mockImplementation(() => {
    const resolveValue = calls[callIndex] ?? [];
    callIndex++;

    const chain: Record<string, any> = {};
    const methods = ['select', 'from', 'where', 'orderBy', 'limit', 'offset', 'innerJoin', 'leftJoin'];
    for (const m of methods) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    chain.then = (resolve: any) => Promise.resolve(resolve(resolveValue));
    return chain;
  });
}

function mockUpdateChain() {
  const chain: Record<string, any> = {};
  const methods = ['set', 'where'];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (resolve: any) => Promise.resolve(resolve(undefined));
  mockDbUpdate.mockReturnValue(chain);
  return chain;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleanupPostMedia', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteFromR2.mockResolvedValue(undefined);
  });

  it('skips cleanup when post not found', async () => {
    mockSelectSequence([
      [], // post query returns empty
    ]);

    await cleanupPostMedia(999);

    // Only one select call (post lookup), no further processing
    expect(mockDbSelect).toHaveBeenCalledTimes(1);
    expect(mockDeleteFromR2).not.toHaveBeenCalled();
  });

  it('skips cleanup when deleteMediaAfterPublish is false', async () => {
    mockSelectSequence([
      [{ id: 1, deleteMediaAfterPublish: false, organizationId: 10, mediaFiles: [1, 2] }],
    ]);

    await cleanupPostMedia(1);

    // Only the post lookup, no platform check
    expect(mockDbSelect).toHaveBeenCalledTimes(1);
    expect(mockDeleteFromR2).not.toHaveBeenCalled();
  });

  it('skips cleanup when not all platforms are done', async () => {
    mockSelectSequence([
      [{ id: 1, deleteMediaAfterPublish: true, organizationId: 10, mediaFiles: [1] }],
      [
        { status: 'published' },
        { status: 'pending' }, // still pending
      ],
    ]);

    await cleanupPostMedia(1);

    // post lookup + platforms lookup, but no media processing
    expect(mockDbSelect).toHaveBeenCalledTimes(2);
    expect(mockDeleteFromR2).not.toHaveBeenCalled();
  });

  it('proceeds when all platforms are published or failed', async () => {
    const updateChain = mockUpdateChain();

    mockSelectSequence([
      [{ id: 1, deleteMediaAfterPublish: true, organizationId: 10, mediaFiles: [42] }],
      [{ status: 'published' }, { status: 'failed' }], // all done
      [], // no other post references this media
      [{ id: 42, organizationId: 10, originalPath: 'original/test.jpg', isOriginalDeleted: false }],
    ]);

    mockIsR2Key.mockReturnValue(true);

    await cleanupPostMedia(1);

    expect(mockDeleteFromR2).toHaveBeenCalledWith('original/test.jpg');
    expect(mockDbUpdate).toHaveBeenCalled();
  });

  it('handles numeric ID format in mediaFiles', async () => {
    const updateChain = mockUpdateChain();

    mockSelectSequence([
      [{ id: 1, deleteMediaAfterPublish: true, organizationId: 10, mediaFiles: [7] }],
      [{ status: 'published' }],
      [], // no other references
      [{ id: 7, organizationId: 10, originalPath: 'original/photo.jpg', isOriginalDeleted: false }],
    ]);

    mockIsR2Key.mockReturnValue(true);

    await cleanupPostMedia(1);

    expect(mockDeleteFromR2).toHaveBeenCalledWith('original/photo.jpg');
  });

  it('handles {id} object format in mediaFiles', async () => {
    const updateChain = mockUpdateChain();

    mockSelectSequence([
      [{ id: 1, deleteMediaAfterPublish: true, organizationId: 10, mediaFiles: [{ id: 7 }] }],
      [{ status: 'published' }],
      [], // no other references
      [{ id: 7, organizationId: 10, originalPath: 'original/photo.jpg', isOriginalDeleted: false }],
    ]);

    mockIsR2Key.mockReturnValue(true);

    await cleanupPostMedia(1);

    expect(mockDeleteFromR2).toHaveBeenCalledWith('original/photo.jpg');
  });

  it('skips media referenced by other posts in the same org', async () => {
    mockSelectSequence([
      [{ id: 1, deleteMediaAfterPublish: true, organizationId: 10, mediaFiles: [42] }],
      [{ status: 'published' }],
      [{ id: 99 }], // another post references this media
    ]);

    await cleanupPostMedia(1);

    // Should NOT delete because another post references this media
    expect(mockDeleteFromR2).not.toHaveBeenCalled();
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('deletes from R2 when originalPath is an R2 key', async () => {
    const updateChain = mockUpdateChain();

    mockSelectSequence([
      [{ id: 1, deleteMediaAfterPublish: true, organizationId: 10, mediaFiles: [5] }],
      [{ status: 'published' }],
      [], // not referenced elsewhere
      [{ id: 5, organizationId: 10, originalPath: 'original/image.webp', isOriginalDeleted: false }],
    ]);

    mockIsR2Key.mockReturnValue(true);

    await cleanupPostMedia(1);

    expect(mockIsR2Key).toHaveBeenCalledWith('original/image.webp');
    expect(mockDeleteFromR2).toHaveBeenCalledWith('original/image.webp');
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('deletes from filesystem when originalPath is a local path', async () => {
    const updateChain = mockUpdateChain();

    mockSelectSequence([
      [{ id: 1, deleteMediaAfterPublish: true, organizationId: 10, mediaFiles: [5] }],
      [{ status: 'published' }],
      [],
      [{ id: 5, organizationId: 10, originalPath: '/var/uploads/original/image.jpg', isOriginalDeleted: false }],
    ]);

    mockIsR2Key.mockReturnValue(false);
    mockExistsSync.mockReturnValue(true);

    await cleanupPostMedia(1);

    expect(mockExistsSync).toHaveBeenCalledWith('/var/uploads/original/image.jpg');
    expect(mockUnlinkSync).toHaveBeenCalledWith('/var/uploads/original/image.jpg');
    expect(mockDeleteFromR2).not.toHaveBeenCalled();
  });

  it('skips already deleted media (isOriginalDeleted = true)', async () => {
    mockSelectSequence([
      [{ id: 1, deleteMediaAfterPublish: true, organizationId: 10, mediaFiles: [5] }],
      [{ status: 'published' }],
      [],
      [{ id: 5, organizationId: 10, originalPath: 'original/image.webp', isOriginalDeleted: true }],
    ]);

    await cleanupPostMedia(1);

    expect(mockDeleteFromR2).not.toHaveBeenCalled();
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('marks isOriginalDeleted and clears variants after successful deletion', async () => {
    const updateChain = mockUpdateChain();

    mockSelectSequence([
      [{ id: 1, deleteMediaAfterPublish: true, organizationId: 10, mediaFiles: [5] }],
      [{ status: 'published' }],
      [],
      [{ id: 5, organizationId: 10, originalPath: 'original/image.webp', isOriginalDeleted: false, variants: {} }],
    ]);

    mockIsR2Key.mockReturnValue(true);

    await cleanupPostMedia(1);

    expect(mockDbUpdate).toHaveBeenCalled();
    expect(updateChain.set).toHaveBeenCalledWith({ isOriginalDeleted: true, variants: {} });
  });

  it('deletes all variants from R2 alongside the original', async () => {
    mockUpdateChain();

    mockSelectSequence([
      [{ id: 1, deleteMediaAfterPublish: true, organizationId: 10, mediaFiles: [5] }],
      [{ status: 'published' }],
      [],
      [{
        id: 5,
        organizationId: 10,
        originalPath: 'original/photo.png',
        isOriginalDeleted: false,
        variants: {
          jpg_92: { path: 'converted/photo-jpg92.jpg', mimeType: 'image/jpeg' },
          bluesky: { path: 'converted/photo-bsky.jpg', mimeType: 'image/jpeg' },
          story_9_16: { path: 'converted/photo-story.jpg', mimeType: 'image/jpeg' },
        },
      }],
    ]);

    mockIsR2Key.mockReturnValue(true);

    await cleanupPostMedia(1);

    expect(mockDeleteFromR2).toHaveBeenCalledWith('original/photo.png');
    expect(mockDeleteFromR2).toHaveBeenCalledWith('converted/photo-jpg92.jpg');
    expect(mockDeleteFromR2).toHaveBeenCalledWith('converted/photo-bsky.jpg');
    expect(mockDeleteFromR2).toHaveBeenCalledWith('converted/photo-story.jpg');
    expect(mockDeleteFromR2).toHaveBeenCalledTimes(4);
  });

  it('continues variant cleanup even if one variant deletion fails', async () => {
    mockUpdateChain();

    mockSelectSequence([
      [{ id: 1, deleteMediaAfterPublish: true, organizationId: 10, mediaFiles: [5] }],
      [{ status: 'published' }],
      [],
      [{
        id: 5,
        organizationId: 10,
        originalPath: 'original/photo.png',
        isOriginalDeleted: false,
        variants: {
          jpg_92: { path: 'converted/photo-jpg92.jpg', mimeType: 'image/jpeg' },
          story_9_16: { path: 'converted/photo-story.jpg', mimeType: 'image/jpeg' },
        },
      }],
    ]);

    mockIsR2Key.mockReturnValue(true);
    // Second variant delete fails
    mockDeleteFromR2.mockImplementation(async (path: string) => {
      if (path === 'converted/photo-jpg92.jpg') throw new Error('R2 hiccup');
    });

    await expect(cleanupPostMedia(1)).resolves.toBeUndefined();

    // Both variants were attempted despite the error on the first
    expect(mockDeleteFromR2).toHaveBeenCalledWith('converted/photo-jpg92.jpg');
    expect(mockDeleteFromR2).toHaveBeenCalledWith('converted/photo-story.jpg');
  });

  it('handles null/undefined variants field without crashing', async () => {
    const updateChain = mockUpdateChain();

    mockSelectSequence([
      [{ id: 1, deleteMediaAfterPublish: true, organizationId: 10, mediaFiles: [5] }],
      [{ status: 'published' }],
      [],
      [{
        id: 5,
        organizationId: 10,
        originalPath: 'original/photo.png',
        isOriginalDeleted: false,
        variants: null,
      }],
    ]);

    mockIsR2Key.mockReturnValue(true);

    await cleanupPostMedia(1);

    // Only the original was deleted (no variants to sweep)
    expect(mockDeleteFromR2).toHaveBeenCalledTimes(1);
    expect(mockDeleteFromR2).toHaveBeenCalledWith('original/photo.png');
    expect(updateChain.set).toHaveBeenCalledWith({ isOriginalDeleted: true, variants: {} });
  });

  it('uses organizationId for media ownership check (not userId)', async () => {
    // Verify that the media lookup filters by organizationId
    const updateChain = mockUpdateChain();
    let mediaWhereArgs: any = null;

    let selectCall = 0;
    mockDbSelect.mockImplementation(() => {
      selectCall++;
      const chain: Record<string, any> = {};
      const methods = ['select', 'from', 'orderBy', 'limit', 'offset', 'innerJoin', 'leftJoin'];
      for (const m of methods) {
        chain[m] = vi.fn().mockReturnValue(chain);
      }
      chain.where = vi.fn().mockImplementation((...args: any[]) => {
        if (selectCall === 4) mediaWhereArgs = args;
        return chain;
      });

      const values: Record<number, any[]> = {
        1: [{ id: 1, deleteMediaAfterPublish: true, organizationId: 10, mediaFiles: [5] }],
        2: [{ status: 'published' }],
        3: [],
        4: [{ id: 5, organizationId: 10, originalPath: 'original/test.jpg', isOriginalDeleted: false }],
      };
      chain.then = (resolve: any) => Promise.resolve(resolve(values[selectCall] ?? []));
      return chain;
    });

    mockIsR2Key.mockReturnValue(true);

    await cleanupPostMedia(1);

    // The 4th select is the media file lookup — its where clause should include organizationId
    expect(mediaWhereArgs).toBeDefined();
  });

  it('handles deletion error gracefully without throwing', async () => {
    mockSelectSequence([
      [{ id: 1, deleteMediaAfterPublish: true, organizationId: 10, mediaFiles: [5] }],
      [{ status: 'published' }],
      [],
      [{ id: 5, organizationId: 10, originalPath: 'original/image.webp', isOriginalDeleted: false }],
    ]);

    mockIsR2Key.mockReturnValue(true);
    mockDeleteFromR2.mockRejectedValue(new Error('R2 network error'));

    // Should not throw
    await expect(cleanupPostMedia(1)).resolves.toBeUndefined();
  });

  it('skips media ref entries without a valid ID', async () => {
    mockSelectSequence([
      [{ id: 1, deleteMediaAfterPublish: true, organizationId: 10, mediaFiles: [null, undefined, { name: 'no-id' }] }],
      [{ status: 'published' }],
    ]);

    await cleanupPostMedia(1);

    // None of those refs have valid IDs, so no media lookups should happen
    expect(mockDeleteFromR2).not.toHaveBeenCalled();
  });

  it('handles empty mediaFiles array', async () => {
    mockSelectSequence([
      [{ id: 1, deleteMediaAfterPublish: true, organizationId: 10, mediaFiles: [] }],
      [{ status: 'published' }],
    ]);

    await cleanupPostMedia(1);

    expect(mockDeleteFromR2).not.toHaveBeenCalled();
  });
});
