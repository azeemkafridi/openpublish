/** Shared test data constants */

export const ORG_A = { id: 1, name: 'Org Alpha', slug: 'org-alpha', plan: 'pro' as const, ownerId: 'user-a' };
export const ORG_B = { id: 2, name: 'Org Beta', slug: 'org-beta', plan: 'free' as const, ownerId: 'user-b' };

export const USER_A = { id: 'user-a', name: 'Alice', email: 'alice@test.com', role: 'user' };
export const USER_B = { id: 'user-b', name: 'Bob', email: 'bob@test.com', role: 'user' };
export const USER_ADMIN = { id: 'user-admin', name: 'Admin', email: 'admin@test.com', role: 'admin' };

export const SAMPLE_LABEL = {
  id: 1, name: 'Marketing', color: '#3B82F6',
  userId: 'user-a', organizationId: 1, type: 'post',
  createdAt: new Date('2026-01-15'),
};

export const SAMPLE_LABEL_2 = {
  id: 2, name: 'Product', color: '#10B981',
  userId: 'user-a', organizationId: 1, type: 'post',
  createdAt: new Date('2026-01-16'),
};

export const SAMPLE_API_KEY = {
  id: 1, name: 'Test Key', keyHash: 'abc123def456', keyPrefix: 'bp_1234',
  userId: 'user-a', organizationId: 1,
  isActive: true, expiresAt: null, lastUsedAt: null,
  createdAt: new Date('2026-01-10'),
};

export const SAMPLE_WEBHOOK = {
  id: 1, url: 'https://example.com/hook', name: 'Test Hook',
  events: ['post.published'], secret: 'whsec_test123',
  userId: 'user-a', organizationId: 1,
  isActive: true, failureCount: 0, lastTriggeredAt: null,
  createdAt: new Date('2026-01-12'),
};

export const SAMPLE_POST = {
  id: 1, content: 'Test post content', status: 'draft' as const,
  organizationId: 1, userId: 'user-a',
  scheduledAt: null, publishedAt: null, timezone: 'UTC',
  mediaFiles: [], postFormat: 'post', postTypeOverrides: null,
  platformSpecific: null, recurringScheduleId: null,
  deleteMediaAfterPublish: false,
  createdAt: new Date('2026-01-20'), updatedAt: new Date('2026-01-20'),
};

export const SAMPLE_CHANNEL = {
  id: 1, organizationId: 1, userId: 'user-a',
  platform: 'facebook' as const, accountName: 'Test Page',
  accountId: 'fb-123', accountType: 'page',
  accessToken: 'token', refreshToken: null, tokenExpiresAt: null,
  profileImage: null, isActive: true, metadata: null,
  createdAt: new Date('2026-01-05'), updatedAt: new Date('2026-01-05'),
};

export const SAMPLE_ORG_MEMBER = {
  id: 1, organizationId: 1, userId: 'user-a', role: 'owner' as const,
  joinedAt: new Date('2026-01-01'),
};
