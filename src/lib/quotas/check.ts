// openPublish is self-hosted and unmetered: every quota check passes.
// The exported signatures mirror the original module so call sites in the
// publish path (publish.worker, api/posts, oauth/handler, queue/scheduler,
// media routes) work unchanged.
import { db } from '../db';
import { organizations } from '../db/schema';
import { eq } from 'drizzle-orm';
import { PLAN_LIMITS, type PlanTier, type PlanLimits } from './plans';

export interface QuotaCheckResult {
  allowed: boolean;
  current: number;
  limit: number;
  resource: string;
  baseLimit?: number;
  activeSlots?: number;
}

const ALLOW = (resource: string): QuotaCheckResult => ({
  allowed: true,
  current: 0,
  limit: -1,
  resource,
});

export async function getOrgPlan(organizationId: number): Promise<PlanTier> {
  const [row] = await db
    .select({ plan: organizations.plan })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row?.plan ?? 'free';
}

export async function getOrgSubscriptionInfo(_organizationId: number) {
  return { subscriptionStatus: null, subscriptionCurrentPeriodEnd: null, subscriptionCancelAtPeriodEnd: false };
}

/** @deprecated Use getOrgPlan instead */
export async function getUserPlan(_userId: string): Promise<PlanTier> {
  return 'free';
}

export function getUserLimits(plan: PlanTier): PlanLimits {
  return PLAN_LIMITS[plan];
}

export const ORG_LIMITS: Record<PlanTier, number> = { free: -1, pro: -1, business: -1 };

export async function checkOrgCountQuota(_userId: string): Promise<QuotaCheckResult> {
  return ALLOW('organizations');
}

export async function checkPlatformAllowed(_organizationId: number, platform: string): Promise<QuotaCheckResult> {
  return ALLOW(`platform_${platform}`);
}

export async function checkChannelQuota(_organizationId: number, _platform?: string): Promise<QuotaCheckResult> {
  return ALLOW('channels');
}

export async function checkDailyPostQuota(_organizationId: number): Promise<QuotaCheckResult> {
  return ALLOW('posts_per_day');
}

export async function checkPostsPerMonthQuota(_organizationId: number): Promise<QuotaCheckResult> {
  return ALLOW('posts_per_month');
}

export async function checkPendingScheduledQuota(_organizationId: number): Promise<QuotaCheckResult> {
  return ALLOW('pending_scheduled');
}

/** [start, end) UTC instants of the calendar day containing `date` in IANA timezone `tz`. */
export function dayRangeInTz(date: Date, tz: string): { start: Date; end: Date } {
  const dayStr = date.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
  const nextDayStr = new Date(new Date(`${dayStr}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  return { start: zonedMidnightUtc(dayStr, tz), end: zonedMidnightUtc(nextDayStr, tz) };
}

function zonedMidnightUtc(dayStr: string, tz: string): Date {
  const refUtc = new Date(`${dayStr}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    // hourCycle only — adding hour12: false overrides it and can resolve to h24.
    hourCycle: 'h23',
  }).formatToParts(refUtc);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const actualInTz = new Date(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:00Z`);
  const tzOffset = actualInTz.getTime() - refUtc.getTime();
  return new Date(refUtc.getTime() - tzOffset);
}

export async function checkScheduledPerDayQuota(_organizationId: number, _forDate?: Date, _timezone = 'UTC'): Promise<QuotaCheckResult> {
  return ALLOW('scheduled_per_day');
}

export async function getScheduledPerDayLimit(_organizationId: number): Promise<number> {
  return 999;
}

export async function checkApiKeyQuota(_organizationId: number): Promise<QuotaCheckResult> {
  return ALLOW('api_keys');
}

export async function checkWebhookQuota(_organizationId: number): Promise<QuotaCheckResult> {
  return ALLOW('webhooks');
}

export async function checkRecurringScheduleQuota(_organizationId: number): Promise<QuotaCheckResult> {
  return ALLOW('recurring_schedules');
}

export async function checkMediaStorageQuota(_organizationId: number): Promise<QuotaCheckResult> {
  return ALLOW('media_storage');
}

export async function checkRssFeedQuota(_organizationId: number): Promise<QuotaCheckResult> {
  return ALLOW('rss_feeds');
}

export async function checkLabelQuota(_organizationId: number): Promise<QuotaCheckResult> {
  return ALLOW('labels');
}

export async function checkOrgMemberQuota(_organizationId: number): Promise<QuotaCheckResult> {
  return ALLOW('org_members');
}

export async function checkPostQuotasBatch(_organizationId: number): Promise<{
  plan: PlanTier;
  daily: QuotaCheckResult;
  monthly: QuotaCheckResult;
  scheduled: QuotaCheckResult;
}> {
  return {
    plan: 'free',
    daily: ALLOW('posts_per_day'),
    monthly: ALLOW('posts_per_month'),
    scheduled: ALLOW('pending_scheduled'),
  };
}
