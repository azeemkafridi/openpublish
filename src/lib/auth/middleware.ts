import { auth } from './index';
import { db } from '../db';
import { apiKeys, user as userTable, organizationMembers, organizations } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { createHash } from 'crypto';
import { normalizeRole, type OrgRole } from '../team/permissions';

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  /** Global site role from user.role ('user' | 'admin') — gates /admin only. */
  role: string;
  authType: 'session' | 'api_key' | 'oauth';
  organizationId: number;
  organizationName: string;
  organizationPlan: 'free' | 'pro' | 'business';
  /** The caller's membership role in the active organization (team permissions). */
  organizationRole: OrgRole;
  /**
   * OAuth grants only. Sessions and API keys have full account access and carry
   * no scopes; the middleware enforces these for authType 'oauth'.
   */
  scopes?: string[];
}

// In-memory session cache: sha256(session cookie) -> result of getSession.
// Every API request (and mobile fans out several per screen) paid a DB session
// lookup; 30s of reuse cuts that to one per session per window. Only positive
// results are cached, so a sign-in is never delayed — the cost is that a
// revoked/signed-out session can linger for up to 30s on already-open clients.
type CachedSession = { user: { id: string; email: string; name: string } };
const sessionCache = new Map<string, { session: CachedSession; expiresAt: number }>();
const SESSION_CACHE_TTL = 30 * 1000;
const SESSION_CACHE_MAX = 10_000;

function sessionCookieKey(request: Request): string | null {
  const cookies = request.headers.get('cookie') || '';
  // Match the better-auth session cookie in both plain and __Secure- forms.
  const match = cookies.match(/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]+)/);
  if (!match) return null;
  return createHash('sha256').update(match[1]).digest('hex');
}

/** Drop the cached session for this request's cookie (call on sign-out). */
export function clearCachedSession(request: Request): void {
  const key = sessionCookieKey(request);
  if (key) sessionCache.delete(key);
}

/** getSession with a short-lived positive cache. Shared by API and page auth. */
export async function getCachedSession(request: Request): Promise<CachedSession | null> {
  const key = sessionCookieKey(request);
  if (key) {
    const hit = sessionCache.get(key);
    if (hit && Date.now() < hit.expiresAt) return hit.session;
    if (hit) sessionCache.delete(key);
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return null;
  const value: CachedSession = {
    user: { id: session.user.id, email: session.user.email, name: session.user.name },
  };
  if (key) {
    if (sessionCache.size >= SESSION_CACHE_MAX) sessionCache.clear();
    sessionCache.set(key, { session: value, expiresAt: Date.now() + SESSION_CACHE_TTL });
  }
  return value;
}

export async function getAuthContext(
  request: Request,
): Promise<AuthContext | null> {
  // Check for API key auth first
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer bp_')) {
    const key = authHeader.slice(7);
    return validateApiKey(key);
  }

  // Fall back to session auth (short-lived cached lookup)
  const session = await getCachedSession(request);
  if (!session?.user) return null;

  // Fetch role from DB
  const [dbUser] = await db
    .select({ role: userTable.role })
    .from(userTable)
    .where(eq(userTable.id, session.user.id))
    .limit(1);

  // Resolve active organization from cookie or default
  let org: { id: number; name: string; plan: string; role: string } | null = null;
  try {
    org = await resolveOrganization(session.user.id, request);
  } catch (err) {
    // Log but don't silently swallow real errors
    console.error('[auth] Failed to resolve organization:', err);
  }

  if (!org) return null; // No org = cannot proceed (will 401)

  return {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: dbUser?.role ?? 'user',
    authType: 'session',
    organizationId: org.id,
    organizationName: org.name,
    organizationPlan: org.plan as 'free' | 'pro' | 'business',
    organizationRole: normalizeRole(org.role),
  };
}

async function validateApiKey(key: string): Promise<AuthContext | null> {
  const keyHash = createHash('sha256').update(key).digest('hex');

  const [found] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
    .limit(1);

  if (!found) return null;

  // Check expiration
  if (found.expiresAt && found.expiresAt < new Date()) return null;

  // Update last used timestamp (fire and forget)
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, found.id))
    .then(() => {});

  // Track per-key daily usage (fire and forget)
  import('../rate-limit').then(({ trackApiKeyUsage }) => trackApiKeyUsage(found.id)).catch(() => {});

  // API key is tied to a specific org — validate user is still a member and
  // carry their membership role so API/MCP-created posts respect it (e.g. a
  // contributor-level key still needs approval).
  const [membership] = await db
    .select({
      orgId: organizations.id,
      orgName: organizations.name,
      orgPlan: organizations.plan,
      role: organizationMembers.role,
      siteRole: userTable.role,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .innerJoin(userTable, eq(userTable.id, organizationMembers.userId))
    .where(and(
      eq(organizationMembers.userId, found.userId),
      eq(organizationMembers.organizationId, found.organizationId),
    ))
    .limit(1);

  if (!membership) return null; // User no longer a member of this org

  return {
    userId: found.userId,
    email: '',
    name: '',
    // 'banned' passes through so the middleware ban check kills the key too;
    // anything else stays 'user' — the API surface never uses site admin.
    role: membership.siteRole === 'banned' ? 'banned' : 'user',
    authType: 'api_key',
    organizationId: membership.orgId,
    organizationName: membership.orgName,
    organizationPlan: membership.orgPlan as 'free' | 'pro' | 'business',
    organizationRole: normalizeRole(membership.role),
  };
}

// In-memory org cache: "userId:orgId" -> { org, expiresAt }
const orgCache = new Map<string, { org: { id: number; name: string; plan: string; role: string }; expiresAt: number }>();
const ORG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function resolveOrganization(
  userId: string,
  request: Request,
): Promise<{ id: number; name: string; plan: string; role: string } | null> {
  // Try to get active org from cookie
  const cookies = request.headers.get('cookie') || '';
  const match = cookies.match(/bp_active_org=(\d+)/);
  const cookieOrgId = match ? Number(match[1]) : null;

  if (cookieOrgId) {
    const cacheKey = `${userId}:${cookieOrgId}`;
    const cached = orgCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.org;

    // Validate membership
    const [membership] = await db
      .select({ orgId: organizations.id, orgName: organizations.name, orgPlan: organizations.plan, role: organizationMembers.role })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.organizationId, cookieOrgId)))
      .limit(1);

    if (membership) {
      const org = { id: membership.orgId, name: membership.orgName, plan: membership.orgPlan, role: membership.role };
      orgCache.set(cacheKey, { org, expiresAt: Date.now() + ORG_CACHE_TTL });
      return org;
    }
  }

  // Fall back to user's first org (default)
  const [defaultOrg] = await db
    .select({ orgId: organizations.id, orgName: organizations.name, orgPlan: organizations.plan, role: organizationMembers.role })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(eq(organizationMembers.userId, userId))
    .limit(1);

  if (!defaultOrg) return null;

  const org = { id: defaultOrg.orgId, name: defaultOrg.orgName, plan: defaultOrg.orgPlan, role: defaultOrg.role };
  const cacheKey = `${userId}:${org.id}`;
  orgCache.set(cacheKey, { org, expiresAt: Date.now() + ORG_CACHE_TTL });
  return org;
}

/** Clear the org cache for a user (call after org switch, plan change, etc.) */
export function clearOrgCache(userId: string): void {
  for (const key of orgCache.keys()) {
    if (key.startsWith(`${userId}:`)) orgCache.delete(key);
  }
}

/** Clear the org cache for an organization (call after plan change via webhook, etc.) */
export function clearOrgCacheByOrgId(orgId: number): void {
  const suffix = `:${orgId}`;
  for (const key of orgCache.keys()) {
    if (key.endsWith(suffix)) orgCache.delete(key);
  }
}
