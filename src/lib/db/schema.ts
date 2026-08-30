import {
  pgTable,
  text,
  integer,
  bigint,
  serial,
  bigserial,
  boolean,
  timestamp,
  varchar,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
  primaryKey,
  date,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// ============== ENUMS ==============

export const postStatusEnum = pgEnum('post_status', [
  'draft',
  'scheduled',
  'publishing',
  'published',
  'partial',
  'failed',
  'processing',
]);

// Approval is ORTHOGONAL to the publish lifecycle (Postiz's approvedSubmitForOrder
// pattern): a post can be `scheduled` yet held from the reconciler while approval
// is `pending`/`rejected`. Keeping this out of post_status avoids touching every
// status switch across the app + SDKs.
export const postApprovalStatusEnum = pgEnum('post_approval_status', [
  'none', // no approval requested/required — publishes normally
  'pending', // awaiting an approver; the scheduler will NOT pick it up
  'approved', // approved — publishes normally
  'rejected', // sent back to the author; will not publish until resubmitted
]);

export const platformStatusEnum = pgEnum('platform_status', [
  'pending',
  'publishing',
  'published',
  'failed',
  'processing',
  // Terminal "we can't prove it": the publish request may have reached the
  // platform but the response was lost (timeout/reset/crash). Never auto-
  // retried and excluded from every re-drive sweep — republishing could
  // duplicate the post. The user is told to check the account first.
  'unconfirmed',
]);

export const platformEnum = pgEnum('platform_name', [
  'facebook',
  'instagram',
  'x',
  'tiktok',
  'youtube',
  'threads',
  'bluesky',
  'pinterest',
  'gmb',
  'linkedin',
  'mastodon',
  'reddit',
  'discord',
  'telegram',
  'tumblr',
  'snapchat',
]);

export const notificationTypeEnum = pgEnum('notification_type', [
  'post_published',
  'post_failed',
  'post_scheduled_reminder',
  'token_expiring',
  'token_expired',
  // 'daily_digest' feature was removed; the enum value is retained because
  // Postgres cannot drop enum values without recreating the type.
  'daily_digest',
  'system',
]);

export const userPlanEnum = pgEnum('user_plan', ['free', 'pro', 'business']);

export const orgMemberRoleEnum = pgEnum('org_member_role', [
  'owner',
  'admin',
  // 'member' is the legacy role. Postgres can't drop an enum value, so it stays
  // here for back-compat; the migration remaps existing 'member' rows to 'admin'
  // and no new code assigns it. New values are appended so the migration is a
  // clean set of ALTER TYPE ... ADD VALUE statements.
  'member',
  'approver',
  'contributor',
  'viewer',
]);

// ============== BETTER AUTH TABLES ==============

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  // VESTIGIAL — do not read for entitlements. The authoritative plan lives on
  // organizations.plan (quota checks go through getOrgPlan); this column is
  // never updated by the Polar webhook and stays 'free' for paying customers.
  // Kept only because better-auth's user shape references it. See the Postiz
  // upstream audit (2026-08-15) for the drift risk that motivated this note.
  plan: userPlanEnum('plan').notNull().default('free'),
  role: text('role').notNull().default('user'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_user_idx').on(table.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('account_user_idx').on(table.userId)],
);

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
});

// ============== ORGANIZATIONS ==============

export const organizations = pgTable(
  'organizations',
  {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    slug: varchar('slug', { length: 100 }).notNull().unique(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // Kept for call-site compatibility; every tier resolves to unlimited limits
    // on self-host (see lib/quotas/plans.ts).
    plan: userPlanEnum('plan').notNull().default('free'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('organizations_owner_idx').on(table.ownerId),
  ],
);

export const organizationMembers = pgTable(
  'organization_members',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // Default kept as legacy 'member' (a pre-existing, committed enum value): using
    // a newly-ADD VALUE'd value as a column default fails inside the same transaction
    // that added it, and migrations now run as ONE transaction — so this constraint is
    // real, not historical. The default is never exercised in practice (every insert
    // specifies a role), and the permission layer treats 'member' as an 'admin' alias.
    role: orgMemberRoleEnum('role').notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('org_members_unique').on(table.organizationId, table.userId),
    index('org_members_user_idx').on(table.userId),
  ],
);

// Pending/processed invitations to join an organization. The seat quota counts
// active members + pending (non-expired) invites; revoke/expiry frees the seat.
// ============== CHANNELS ==============

export const channels = pgTable(
  'channels',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: text('user_id').notNull(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    platform: platformEnum('platform').notNull(),
    accountName: varchar('account_name', { length: 255 }).notNull(),
    accountId: varchar('account_id', { length: 255 }).notNull(),
    accountType: varchar('account_type', { length: 50 }).default('unknown'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    profileImage: text('profile_image'),
    isActive: boolean('is_active').default(true),
    // The platform reported the token as invalid/revoked (e.g. Facebook error
    // 190) and it can't be auto-refreshed — the user must reconnect. Kept
    // separate from isActive (which means "user disabled") and from
    // tokenExpiresAt (a time-based estimate platforms like Facebook never set),
    // so the UI can reflect a dead token even when the expiry clock says fine.
    needsReconnect: boolean('needs_reconnect').default(false),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('channels_user_idx').on(table.userId),
    index('channels_org_idx').on(table.organizationId),
    index('channels_platform_idx').on(table.platform),
    uniqueIndex('channels_unique_account').on(
      table.organizationId,
      table.platform,
      table.accountId,
    ),
  ],
);

// ============== THREAD TYPES ==============

export interface ThreadPart {
  content: string;
  mediaFileIds: number[];
}

export interface ThreadPostRecord {
  sequence: number;
  postId: string;
  url: string;
  parentId?: string;
}

// ============== POSTS ==============

export interface MediaFileRef {
  id: number;
  originalUrl: string;
  thumbnailUrl: string;   // 160x160 square crop for cards/lists
  previewUrl?: string;    // 400px wide for grids/uploaders
  mimeType: string;
  width?: number;
  height?: number;
  duration?: number;
  sizeBytes: number;
}

export const posts = pgTable(
  'posts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: text('user_id').notNull(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    content: text('content').default(''),
    platformContent: jsonb('platform_content').$type<Record<string, string>>().default({}),
    mediaFiles: jsonb('media_files').$type<MediaFileRef[]>().default([]),
    status: postStatusEnum('status').default('draft'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    timezone: varchar('timezone', { length: 100 }).default('UTC'),
    postFormat: varchar('post_format', { length: 50 }).default('post'),
    postTypeOverrides: jsonb('post_type_overrides')
      .$type<Record<string, string>>()
      .default({}),
    platformSpecific: jsonb('platform_specific')
      .$type<Record<string, Record<string, unknown>>>()
      .default({}),
    threadParts: jsonb('thread_parts').$type<ThreadPart[] | null>().default(null),
    platformThreadParts: jsonb('platform_thread_parts').$type<Record<string, ThreadPart[]>>().default({}),
    // Default: KEEP media — it's reclaimed by the 3-month retention sweep, not deleted
    // right after publishing. Opt-in true (per post) for users who want to free storage sooner.
    deleteMediaAfterPublish: boolean('delete_media_after_publish').default(false),
    autoPlugEnabled: boolean('auto_plug_enabled').default(false),
    autoPlugText: text('auto_plug_text'),
    autoPlugThreshold: integer('auto_plug_threshold').default(50),
    autoPlugFired: boolean('auto_plug_fired').default(false),
    // Per-post override for link tracking. NULL = inherit the org setting;
    // true/false force it for this post regardless of the org default.
    linkTrackingOverride: boolean('link_tracking_override'),
    autoRepostEnabled: boolean('auto_repost_enabled').default(false),
    autoRepostThreshold: integer('auto_repost_threshold').default(100),
    autoRepostFired: boolean('auto_repost_fired').default(false),
    // Approval flow (team roles Phase 2). 'pending'/'rejected' block the scheduler
    // pickup; approve/reject happen via POST /api/posts/[id]/approve|reject.
    approvalStatus: postApprovalStatusEnum('approval_status').notNull().default('none'),
    approvedBy: text('approved_by'), // user id of the approver
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    // Serves the "Pending approval" list/badge count per org.
    index('posts_org_approval_idx').on(table.organizationId, table.approvalStatus),
    index('posts_user_idx').on(table.userId),
    index('posts_org_idx').on(table.organizationId),
    index('posts_status_idx').on(table.status),
    index('posts_scheduled_idx').on(table.scheduledAt),
    index('posts_created_idx').on(table.createdAt),
    // Serves the metrics 30-day scan and the calendar publishedAt OR-arm.
    index('posts_org_published_idx').on(table.organizationId, table.publishedAt),
    // Serves the hot list path: GET /api/posts filters by organizationId and sorts
    // by createdAt DESC (feed, calendar list/month, all polled). Without this the
    // single-column org/createdAt indexes force an index-then-sort; this composite
    // lets Postgres satisfy WHERE org ORDER BY createdAt DESC from one index.
    index('posts_org_created_idx').on(table.organizationId, table.createdAt.desc()),
    // Serves the hottest filtered list: GET /api/posts?status=… (mobile Home
    // polls scheduled+failed) and the publish worker's due-post scan. The
    // single-column org/status indexes forced a filter over one of them.
    index('posts_org_status_sched_idx').on(table.organizationId, table.status, table.scheduledAt),
    // Trigram index for the posts search box (`ilike '%term%'` — a leading
    // wildcard no btree can serve). Requires pg_trgm; the migration creates
    // the extension first.
    index('posts_content_trgm_idx').using('gin', table.content.op('gin_trgm_ops')),
  ],
);

// ============== POST PLATFORMS ==============

export const postPlatforms = pgTable(
  'post_platforms',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    postId: integer('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
    channelId: integer('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
    platform: platformEnum('platform').notNull(),
    status: platformStatusEnum('status').default('pending'),
    platformPostId: varchar('platform_post_id', { length: 500 }),
    platformUrl: varchar('platform_url', { length: 500 }),
    threadPostIds: jsonb('thread_post_ids').$type<ThreadPostRecord[] | null>().default(null),
    errorMessage: text('error_message'),
    retryCount: integer('retry_count').default(0),
    maxRetries: integer('max_retries').default(3),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('post_platforms_post_idx').on(table.postId),
    index('post_platforms_channel_idx').on(table.channelId),
    index('post_platforms_status_idx').on(table.status),
  ],
);

// ============== LABELS ==============

export const labels = pgTable(
  'labels',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id').notNull(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    color: varchar('color', { length: 7 }).default('#6366f1'),
    type: varchar('type', { length: 10 }).notNull().default('post'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex('labels_unique').on(table.organizationId, table.name, table.type),
    index('labels_user_idx').on(table.userId),
    index('labels_org_idx').on(table.organizationId),
    index('labels_type_idx').on(table.type),
  ],
);

// Saved channel groupings ("Sets") for one-click multi-channel targeting in the
// composer. channelIds is a JSONB array of channels.id values; deleted channels
// are filtered out at read time rather than cascaded.
export const channelSets = pgTable(
  'channel_sets',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id').notNull(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    channelIds: jsonb('channel_ids').notNull().$type<number[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex('channel_sets_unique').on(table.organizationId, table.name),
    index('channel_sets_org_idx').on(table.organizationId),
  ],
);

export const postLabels = pgTable(
  'post_labels',
  {
    postId: integer('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
    labelId: integer('label_id').notNull().references(() => labels.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.labelId] }),
    index('post_labels_label_idx').on(table.labelId),
    index('post_labels_post_idx').on(table.postId),
  ],
);

// ============== MEDIA FILES ==============

export const mediaFiles = pgTable(
  'media_files',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: text('user_id').notNull(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    originalPath: varchar('original_path', { length: 500 }).notNull(),
    thumbnailPath: varchar('thumbnail_path', { length: 500 }),  // Small square crop (160x160) for cards/lists
    previewPath: varchar('preview_path', { length: 500 }),  // Medium preview (400px wide) for grids
    // Large derivative (1200px wide webp) for lightboxes and preview panes —
    // the 400px preview is visibly soft at those sizes, and the original is
    // too heavy to decode (a 4000px photo is ~48MB of bitmap in the browser).
    // For videos this is generated from the extracted poster frame.
    largePath: varchar('large_path', { length: 500 }),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    width: integer('width'),
    height: integer('height'),
    duration: integer('duration'),
    isOriginalDeleted: boolean('is_original_deleted').default(false),
    variants: jsonb('variants').$type<Record<string, { path: string; mimeType: string }>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('media_user_idx').on(table.userId),
    index('media_org_idx').on(table.organizationId),
    index('media_created_idx').on(table.createdAt),
  ],
);

// ============== MEDIA LABELS ==============

export const mediaLabels = pgTable(
  'media_labels',
  {
    mediaFileId: integer('media_file_id').notNull().references(() => mediaFiles.id, { onDelete: 'cascade' }),
    labelId: integer('label_id').notNull().references(() => labels.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.mediaFileId, table.labelId] }),
    index('media_labels_label_idx').on(table.labelId),
    index('media_labels_media_idx').on(table.mediaFileId),
  ],
);

// ============== RECURRING SCHEDULES ==============

// ============== NOTIFICATIONS ==============

export const notifications = pgTable(
  'notifications',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    organizationId: integer('organization_id').references(() => organizations.id, { onDelete: 'set null' }),
    type: notificationTypeEnum('type').notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    message: text('message').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>(),
    isRead: boolean('is_read').default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('notifications_user_idx').on(table.userId),
    index('notifications_user_read_idx').on(table.userId, table.isRead),
    // Serves the per-user list (WHERE user_id ORDER BY created_at DESC).
    index('notifications_user_created_idx').on(table.userId, table.createdAt),
    // Partial index for the unread-badge count: WHERE user_id AND NOT is_read
    // AND type <> 'post_published' — the two count(*) queries on the bell
    // otherwise heap-filter the type predicate over all of a user's rows.
    index('notifications_unread_badge_idx')
      .on(table.userId)
      .where(sql`${table.isRead} = false AND ${table.type} <> 'post_published'`),
  ],
);

export const notificationPreferences = pgTable('notification_preferences', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull().unique().references(() => user.id, { onDelete: 'cascade' }),
  // Email categories are OPT-IN (default false) — a user must explicitly enable
  // them so we never send (and bill) email a user didn't ask for. In-app
  // notifications cost nothing and stay on by default.
  emailOnFailure: boolean('email_on_failure').default(false),
  emailOnTokenExpiry: boolean('email_on_token_expiry').default(false),
  inAppPublished: boolean('in_app_published').default(true),
  inAppFailed: boolean('in_app_failed').default(true),
  inAppScheduleReminder: boolean('in_app_schedule_reminder').default(true),
  inAppTokenExpiry: boolean('in_app_token_expiry').default(true),
});

// Expo push tokens for the mobile app. One row per device; the token string is
// globally unique (re-registering a token moves it to the current user, e.g.
// after logging into another account on the same device). Push delivery is
// user-scoped like notifications; organizationId mirrors notifications' 'set
// null' scoping for context only.
export const pushTokens = pgTable(
  'push_tokens',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    organizationId: integer('organization_id').references(() => organizations.id, { onDelete: 'set null' }),
    token: varchar('token', { length: 255 }).notNull().unique(),
    platform: varchar('platform', { length: 10 }).notNull(), // 'ios' | 'android'
    deviceName: varchar('device_name', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('push_tokens_user_idx').on(table.userId),
  ],
);

// ============== API KEYS ==============

export const apiKeys = pgTable(
  'api_keys',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id').notNull(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    keyHash: varchar('key_hash', { length: 255 }).notNull().unique(),
    keyPrefix: varchar('key_prefix', { length: 10 }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    isActive: boolean('is_active').default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('api_keys_user_idx').on(table.userId),
    index('api_keys_org_idx').on(table.organizationId),
  ],
);

// ============== OAUTH (first-party authorization server) ==============
//
// An alternative to api_keys for third-party apps embedding openPublish: the
// end user approves the app instead of pasting a key. Tokens resolve to the
// same AuthContext and inherit the approving org's plan and quotas, so nothing
// about api_keys changes.

// ============== WEBHOOKS ==============

// ============== POST METRICS ==============

export const postMetrics = pgTable(
  'post_metrics',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    postPlatformId: integer('post_platform_id')
      .notNull()
      .references(() => postPlatforms.id, { onDelete: 'cascade' }),
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    platform: platformEnum('platform').notNull(),
    impressions: integer('impressions').default(0),
    reach: integer('reach').default(0),
    likes: integer('likes').default(0),
    comments: integer('comments').default(0),
    shares: integer('shares').default(0),
    saves: integer('saves').default(0),
    clicks: integer('clicks').default(0),
    videoViews: integer('video_views').default(0),
    engagementRate: integer('engagement_rate').default(0), // basis points: 325 = 3.25%
    platformSpecificMetrics: jsonb('platform_specific_metrics')
      .$type<Record<string, number>>()
      .default({}),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('post_metrics_post_platform_idx').on(table.postPlatformId),
    index('post_metrics_post_idx').on(table.postId),
    index('post_metrics_org_idx').on(table.organizationId),
    index('post_metrics_fetched_idx').on(table.fetchedAt),
    index('post_metrics_platform_idx').on(table.platform),
    // Powers DISTINCT ON (post_platform_id) ORDER BY post_platform_id, fetched_at DESC
    // used by GET /api/posts when aggregating the latest snapshot per post_platform.
    index('post_metrics_pp_fetched_idx').on(table.postPlatformId, table.fetchedAt.desc()),
  ],
);

// ============== ACCOUNT METRICS ==============

export const accountMetrics = pgTable(
  'account_metrics',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    channelId: integer('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    platform: varchar('platform', { length: 32 }).notNull(),
    date: date('date').notNull(),
    followers: integer('followers').default(0),
    following: integer('following').default(0),
    impressions: integer('impressions').default(0),
    reach: integer('reach').default(0),
    profileViews: integer('profile_views').default(0),
    websiteClicks: integer('website_clicks').default(0),
    engagementRate: integer('engagement_rate').default(0), // basis points: 325 = 3.25%
    platformSpecific: jsonb('platform_specific')
      .$type<Record<string, number>>()
      .default({}),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('account_metrics_channel_idx').on(table.channelId),
    index('account_metrics_org_idx').on(table.organizationId),
    index('account_metrics_date_idx').on(table.date),
    index('account_metrics_platform_idx').on(table.platform),
    uniqueIndex('account_metrics_channel_date_uniq').on(table.channelId, table.date),
  ],
);

// ============== ACTIVITY LOGS ==============

export const activityLogs = pgTable(
  'activity_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: text('user_id'),
    organizationId: integer('organization_id').references(() => organizations.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 100 }).notNull(),
    resource: varchar('resource', { length: 100 }),
    resourceId: varchar('resource_id', { length: 255 }),
    details: jsonb('details').$type<Record<string, unknown>>(),
    level: varchar('level', { length: 20 }).default('info'),
    ipAddress: varchar('ip_address', { length: 45 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('activity_user_idx').on(table.userId),
    index('activity_org_idx').on(table.organizationId),
    index('activity_action_idx').on(table.action),
    index('activity_created_idx').on(table.createdAt),
    // Serves the org-scoped activity list (WHERE organization_id ORDER BY created_at DESC).
    index('activity_org_created_idx').on(table.organizationId, table.createdAt),
  ],
);

// ============== API USAGE ==============

export const apiUsageDaily = pgTable(
  'api_usage_daily',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    date: varchar('date', { length: 10 }).notNull(), // YYYY-MM-DD
    count: integer('count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex('api_usage_daily_org_date').on(table.organizationId, table.date),
    index('api_usage_daily_org_idx').on(table.organizationId),
  ],
);

// X (Twitter) API external cost tracking — see lib/platforms/x-usage.ts
// `costDcents` = tenths of a cent (5 = $0.005). `billed` = counts against user budget (writes only).
export const xApiUsageDaily = pgTable(
  'x_api_usage_daily',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    date: varchar('date', { length: 10 }).notNull(), // YYYY-MM-DD
    actionType: varchar('action_type', { length: 50 }).notNull(),
    callCount: integer('call_count').notNull().default(0),
    costDcents: integer('cost_dcents').notNull().default(0),
    billed: boolean('billed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex('x_api_usage_daily_unique').on(table.organizationId, table.date, table.actionType),
    index('x_api_usage_daily_org_idx').on(table.organizationId),
    index('x_api_usage_daily_date_idx').on(table.date),
  ],
);

// ============== RELATIONS ==============

export const organizationsRelations = relations(organizations, ({ many, one }) => ({
  owner: one(user, { fields: [organizations.ownerId], references: [user.id] }),
  members: many(organizationMembers),
}));

export const organizationMembersRelations = relations(organizationMembers, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationMembers.organizationId],
    references: [organizations.id],
  }),
  user: one(user, { fields: [organizationMembers.userId], references: [user.id] }),
}));

export const postsRelations = relations(posts, ({ many }) => ({
  postPlatforms: many(postPlatforms),
  postLabels: many(postLabels),
  metrics: many(postMetrics),
}));

export const postPlatformsRelations = relations(postPlatforms, ({ one, many }) => ({
  post: one(posts, { fields: [postPlatforms.postId], references: [posts.id] }),
  channel: one(channels, {
    fields: [postPlatforms.channelId],
    references: [channels.id],
  }),
  metrics: many(postMetrics),
}));

export const postMetricsRelations = relations(postMetrics, ({ one }) => ({
  postPlatform: one(postPlatforms, {
    fields: [postMetrics.postPlatformId],
    references: [postPlatforms.id],
  }),
  post: one(posts, {
    fields: [postMetrics.postId],
    references: [posts.id],
  }),
}));

export const postLabelsRelations = relations(postLabels, ({ one }) => ({
  post: one(posts, { fields: [postLabels.postId], references: [posts.id] }),
  label: one(labels, { fields: [postLabels.labelId], references: [labels.id] }),
}));

export const mediaLabelsRelations = relations(mediaLabels, ({ one }) => ({
  mediaFile: one(mediaFiles, { fields: [mediaLabels.mediaFileId], references: [mediaFiles.id] }),
  label: one(labels, { fields: [mediaLabels.labelId], references: [labels.id] }),
}));
