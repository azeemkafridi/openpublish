import { eq, sql } from 'drizzle-orm';
import { getRedisConnection } from '../jobs/queue';
import { PLAN_LIMITS, type PlanTier } from '../quotas/plans';
import { db } from '../db';
import { organizations } from '../db/schema';
import { createLogger } from '../logger';

const logger = createLogger('platform:x-usage');

/**
 * X (Twitter) API costs are billed per request (writes) or per resource returned (reads).
 * Source: https://developer.x.com/en/docs/x-api/getting-started/about-x-api
 *
 * Stored in integer tenths-of-cents (`dcents`) — $0.005 = 5 dcents, $0.015 = 15 dcents.
 * Display by dividing by 1000.
 */
export type XApiAction =
  | 'tweet_create'              // POST /tweets — $0.015 = 15 dcents (no URL)
  | 'tweet_create_with_url'     // POST /tweets — $0.200 = 200 dcents (URL in content)
  | 'thread_segment_create'     // POST /tweets within publishThread (text only) — 15 dcents
  | 'thread_segment_with_url'   // thread segment containing URL — 200 dcents
  | 'media_simple_upload'       // POST upload.json — 5 dcents (per request, Media Metadata)
  | 'media_chunked_init'        // POST upload.json INIT — 5 dcents
  | 'comment_create'            // reply tweet (text only) — 15 dcents
  | 'comment_create_with_url'   // reply tweet containing URL — 200 dcents (Content: Create with URL)
  | 'repost'                    // POST /users/:id/retweets — 15 dcents (User Interaction)
  | 'post_read'                 // GET /tweets per resource returned — 5 dcents per tweet
  | 'user_read'                 // GET /users per resource returned — 10 dcents per user
  | 'user_search';              // GET /users/search per resource returned — 10 dcents per user

export const X_API_COSTS_DCENTS: Record<XApiAction, number> = {
  tweet_create: 15,
  tweet_create_with_url: 200,
  thread_segment_create: 15,
  thread_segment_with_url: 200,
  media_simple_upload: 5,
  media_chunked_init: 5,
  comment_create: 15,
  comment_create_with_url: 200,
  repost: 15,
  post_read: 5,
  user_read: 10,
  user_search: 10,
};

/**
 * Actions that count against the user's monthly budget. Originally writes only;
 * reads joined on 2026-08-19 so metered reads (metrics sync, engagement, user
 * search, health checks) consume the org's own X quota instead of silently
 * draining the shared Pay-per-use account. One budget covers both — there is
 * no separate read quota. The worst a runaway read loop can burn is the
 * remaining monthly budget plus credits, which the org itself is paying for.
 */
const BILLED_ACTIONS: ReadonlySet<XApiAction> = new Set([
  'tweet_create',
  'tweet_create_with_url',
  'thread_segment_create',
  'thread_segment_with_url',
  'media_simple_upload',
  'media_chunked_init',
  'comment_create',
  'comment_create_with_url',
  'repost',
  'post_read',
  'user_read',
  'user_search',
]);

export function isBilledAction(action: XApiAction): boolean {
  return BILLED_ACTIONS.has(action);
}

/** User-facing message when the global X kill switch is engaged. */
export const X_DISABLED_MESSAGE =
  'X publishing is temporarily disabled. Please try again shortly.';

/**
 * Global emergency brake. When `X_DISABLE_LIVE_API` is truthy, all billed X API calls (writes,
 * media uploads, and metered reads) are short-circuited — an instant, deploy-free way to stop X
 * spend if X changes pricing or a billing bug surfaces. OAuth connect is intentionally exempt so
 * accounts can still be (re)connected while live traffic is paused.
 */
export function isXLiveApiDisabled(): boolean {
  const v = process.env.X_DISABLE_LIVE_API;
  return v === '1' || v === 'true';
}

/**
 * Common TLDs that X auto-links when written as a *bare* domain (no scheme, no `www.`).
 *
 * This is a deliberate inclusion-list, NOT every valid TLD. It's tuned to catch the domains
 * that actually appear in posts (`acme.com`, `foo.io`, `bit.ly/x`) while NOT misfiring on dev
 * jargon and filenames — `node.js`, `main.py`, `build.sh`, `index.html`, `data.json` all end in
 * extensions deliberately kept OUT of this list. Missing a rare-TLD bare domain only slightly
 * under-bills; over-billing a code token at the 13× with-URL rate would be worse UX, so when in
 * doubt we leave a TLD out. Full-scheme (`https://…`) and `www.` URLs are matched separately and
 * are not constrained by this list.
 */
const BARE_DOMAIN_TLDS = [
  'com', 'net', 'org', 'io', 'co', 'ai', 'app', 'dev', 'xyz', 'me', 'info', 'biz', 'tv', 'gg',
  'to', 'ly', 'link', 'site', 'online', 'store', 'shop', 'blog', 'page', 'tech', 'news', 'live',
  'fm', 'design', 'uk', 'ca', 'au', 'de', 'fr', 'es', 'it', 'nl', 'in', 'us', 'eu',
];

/** Bare domain on a common TLD, e.g. `acme.com`, `foo.io/path`. Case-insensitive. */
const BARE_DOMAIN_RE = new RegExp(`\\b[a-z0-9][a-z0-9-]*\\.(?:${BARE_DOMAIN_TLDS.join('|')})\\b`, 'i');

/** Strip `local@domain.tld` so an email's domain doesn't trip the bare-domain check below. */
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+/gi;

/**
 * Detect whether tweet content contains a URL — X charges ~13× more for "Content: Create
 * with URL" ($0.200 vs $0.015). We mirror what X actually auto-links so the charge matches
 * what X bills us; false positives merely over-charge on the higher (correct-when-linked) rate.
 *
 * Three cases are covered:
 *   1. Explicit scheme — `https://…` / `http://…`. Catches t.co links, shortened URLs, and
 *      markdown link targets (`[text](https://…)`), which X always linkifies.
 *   2. Scheme-less `www.` URLs (`www.example.com/path`) — X still auto-links these. A second
 *      dot + 2+ letter TLD is required so a bare word ("www") or "www.hello" doesn't trip it.
 *   3. Bare domains with no scheme and no `www.` (`see acme.com`) — X linkifies these too, and
 *      they're billed at the with-URL rate. We match them against BARE_DOMAIN_TLDS (common TLDs
 *      only) to avoid over-charging filenames/jargon like `node.js` or `main.py`.
 *
 * Emails are stripped first because X does NOT linkify the domain inside an email address — so
 * `you@acme.com` must bill at the no-URL rate, not get caught by case 3.
 */
export function detectUrlInContent(content: string): boolean {
  if (/https?:\/\/\S+/i.test(content)) return true;
  if (/\bwww\.\S+\.[a-z]{2,}/i.test(content)) return true;
  if (BARE_DOMAIN_RE.test(content.replace(EMAIL_RE, ' '))) return true;
  return false;
}

/** Compute Redis key for daily per-action cost — TTL 48h, used for snapshots and per-day display. */
function dayKey(orgId: number, date: string, action: XApiAction): string {
  return `x:api:cost:${orgId}:${date}:${action}`;
}

/** Compute Redis key for live monthly billed spend — TTL 35d, used for budget enforcement. */
function monthKey(orgId: number, yearMonth: string): string {
  return `x:api:writecost:${orgId}:${yearMonth}`;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthUtc(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Track a single X API call. Fire-and-forget; never throws.
 * Increments per-day per-action counter and (if billed) the live monthly budget counter,
 * then settles any plan-overage against the org's credit balance.
 */
export function trackXApiCall(
  orgId: number,
  action: XApiAction,
  costDcents: number,
  callCount = 1,
): void {
  if (!orgId || costDcents <= 0) return;

  try {
    const redis = getRedisConnection();
    const date = todayUtc();
    const month = monthUtc();
    const dKey = dayKey(orgId, date, action);
    const cKey = `${dKey}:count`;

    redis.incrby(dKey, costDcents).catch(() => {});
    redis.incrby(cKey, callCount).catch(() => {});
    redis.expire(dKey, 172800).catch(() => {});
    redis.expire(cKey, 172800).catch(() => {});

    if (isBilledAction(action)) {
      const mKey = monthKey(orgId, month);
      // Use the awaited incrby result to settle overage against credits
      redis
        .incrby(mKey, costDcents)
        .then(async (monthlyUsedAfter) => {
          await redis.expire(mKey, 35 * 86400).catch(() => {});
          // Look up the org's plan to know where the budget cap is
          const plan = await getOrgPlanCached(orgId);
          await settleCreditOverage(orgId, plan, costDcents, monthlyUsedAfter);
        })
        .catch((err) => {
          logger.warn({ err, orgId, action }, 'X cost billing settlement failed');
        });
    }
  } catch (err) {
    logger.warn({ err, orgId, action }, 'trackXApiCall failed');
  }
}

// Lightweight 60s in-memory cache of org → plan to avoid hammering DB on every API call.
const planCache = new Map<number, { plan: PlanTier; expiresAt: number }>();

async function getOrgPlanCached(orgId: number): Promise<PlanTier> {
  const cached = planCache.get(orgId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.plan;

  try {
    const [row] = await db
      .select({ plan: organizations.plan })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    const plan = (row?.plan ?? 'free') as PlanTier;
    planCache.set(orgId, { plan, expiresAt: now + 60_000 });
    return plan;
  } catch {
    return 'free';
  }
}

export interface XBudgetStatus {
  allowed: boolean;
  /** Plan-budget cents already consumed this month (Redis live counter). */
  usedDcents: number;
  /** Plan-budget cents per month (0 if X is disabled on this plan). */
  limitDcents: number;
  /** Plan budget remaining (clamped >= 0). */
  remainingDcents: number;
  /** Credit balance in dcents (DB column on organizations). */
  creditDcents: number;
  /** Total available = plan remaining + credits. */
  totalAvailableDcents: number;
  resetsAt: string;
}

/**
 * Check whether the org has remaining X budget for a write of the given cost.
 *
 * Allowed if `(plan_limit - monthly_used) + credit_balance >= cost`.
 * Plan budget is consumed first, credits are overage. Free plan has limit=0
 * but can still publish if credits cover the cost.
 */
export async function checkXBudget(
  orgId: number,
  _plan: PlanTier,
  _estimatedCostDcents = 0,
): Promise<XBudgetStatus> {
  // Self-hosted: the operator's own X app is billed by X directly, so there is
  // no budget to enforce. Spend is still tracked (Redis + xApiUsageDaily) for
  // cost visibility.
  const used = await getMonthlyWriteSpendDcents(orgId);
  return {
    allowed: true,
    usedDcents: used,
    limitDcents: -1,
    remainingDcents: Number.MAX_SAFE_INTEGER,
    creditDcents: 0,
    totalAvailableDcents: Number.MAX_SAFE_INTEGER,
    resetsAt: nextMonthResetIso(),
  };
}

/** Self-hosted: there is no purchased-credit system; the balance is always 0. */
export async function getCreditBalanceDcents(_orgId: number): Promise<number> {
  return 0;
}

/** Self-hosted: no credit system — a no-op that reports a zero balance. */
export async function adjustCreditBalanceDcents(
  _orgId: number,
  _deltaDcents: number,
): Promise<number> {
  return 0;
}

/**
 * After a successful billed call has been recorded against the monthly counter,
 * settle any overage by deducting from credits.
 *
 * `costDcents` = the cost of the call we just made.
 * `monthlyUsedAfter` = monthly counter value AFTER the increment (returned by INCRBY).
 *
 * Returns the dcents drawn from credits (0 if entirely covered by plan budget).
 */
export async function settleCreditOverage(
  orgId: number,
  plan: PlanTier,
  costDcents: number,
  monthlyUsedAfter: number,
): Promise<number> {
  // Self-hosted: no credit system, nothing to settle.
  void orgId; void plan; void costDcents; void monthlyUsedAfter;
  return 0;
}

/** Read the live monthly billed spend in dcents from Redis. Returns 0 if missing or Redis unavailable. */
export async function getMonthlyWriteSpendDcents(orgId: number): Promise<number> {
  try {
    const redis = getRedisConnection();
    const value = await redis.get(monthKey(orgId, monthUtc()));
    return value ? parseInt(value, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

/**
 * Gate for X *read* spend. Reads draw from the same monthly X budget as
 * writes — plan allowance first, purchased credits as overage — with one
 * plan rule on top: the free plan gets no metered reads at all, even with a
 * credit balance (credits unlock free-plan *publishing*; analytics reads are
 * a paid-plan feature).
 *
 * `estimatedCostDcents` is the cost of the read about to be made (callers
 * pass the action's unit cost; per-resource reads are estimates the same way
 * write gating estimates before the response is known).
 */
export async function checkXReadBudget(
  orgId: number,
  plan: PlanTier,
  estimatedCostDcents = 0,
): Promise<boolean> {
  // Self-hosted: reads are never gated.
  void orgId; void plan; void estimatedCostDcents;
  return true;
}

export interface XUsageBreakdown {
  byAction: Record<string, { costDcents: number; callCount: number }>;
  totalDcents: number;
  billedDcents: number;
  absorbedDcents: number;
}

/** Read today's per-action usage from Redis. Returns zeros if Redis unavailable. */
export async function getXUsageToday(orgId: number): Promise<XUsageBreakdown> {
  return getXUsageForDate(orgId, todayUtc());
}

export async function getXUsageForDate(orgId: number, date: string): Promise<XUsageBreakdown> {
  const empty: XUsageBreakdown = { byAction: {}, totalDcents: 0, billedDcents: 0, absorbedDcents: 0 };
  try {
    const redis = getRedisConnection();
    const actions = Object.keys(X_API_COSTS_DCENTS) as XApiAction[];

    const pipeline = redis.pipeline();
    for (const action of actions) {
      pipeline.get(dayKey(orgId, date, action));
      pipeline.get(`${dayKey(orgId, date, action)}:count`);
    }
    const results = await pipeline.exec();
    if (!results) return empty;

    const breakdown: XUsageBreakdown = { byAction: {}, totalDcents: 0, billedDcents: 0, absorbedDcents: 0 };

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const costRaw = results[i * 2]?.[1] as string | null;
      const countRaw = results[i * 2 + 1]?.[1] as string | null;
      const cost = costRaw ? parseInt(costRaw, 10) || 0 : 0;
      const count = countRaw ? parseInt(countRaw, 10) || 0 : 0;
      if (cost === 0 && count === 0) continue;

      breakdown.byAction[action] = { costDcents: cost, callCount: count };
      breakdown.totalDcents += cost;
      if (isBilledAction(action)) breakdown.billedDcents += cost;
      else breakdown.absorbedDcents += cost;
    }

    return breakdown;
  } catch (err) {
    logger.warn({ err, orgId, date }, 'getXUsageForDate failed');
    return empty;
  }
}

/** ISO timestamp for the first millisecond of next UTC month — when budget resets. */
export function nextMonthResetIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/** Format dcents as "$X.XXX" for UI display. 1500 dcents = "$1.500" → trim to "$1.50" for whole-cent values. */
export function formatDcentsAsDollars(dcents: number): string {
  const dollars = dcents / 1000;
  return dollars >= 10 ? `$${dollars.toFixed(2)}` : `$${dollars.toFixed(3)}`;
}
