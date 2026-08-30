import '@lib/env';
import { defineMiddleware } from 'astro:middleware';
import { getAuthContext, getCachedSession, clearCachedSession } from '@lib/auth/middleware';
import { auth } from '@lib/auth/index';
import { db } from '@lib/db';
import { user as userTable, organizations, organizationMembers } from '@lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { checkRateLimit, rateLimitResponse } from '@lib/rate-limit';
import { checkDailyApiQuota } from '@lib/rate-limit';
import { getClientIp } from '@lib/http/client-ip';
import { createLogger } from '@lib/logger';
import { normalizeRole } from '@lib/team/permissions';
import { isCloudProxiedPath, proxyToCloud, cloudApiUrl } from '@lib/engine';

const requestLogger = createLogger('request');

// Paths to exclude from logging entirely
const LOG_SKIP_PATHS = ['/favicon.svg', '/robots.txt'];

/**
 * Log a request. Level is determined by status code:
 *  - 500+ → error
 *  - 400+ → warn
 *  - else  → info
 */
function logRequest(
  shouldLog: boolean,
  data: {
    method: string;
    path: string;
    status: number;
    duration: number;
    ip: string;
    type: string;
    userId?: string;
    authAction?: string;
    error?: string;
  },
) {
  if (!shouldLog) return;
  const { status } = data;
  if (status >= 500) {
    requestLogger.error(data, data.type);
  } else if (status >= 400) {
    requestLogger.warn(data, data.type);
  } else {
    requestLogger.info(data, data.type);
  }
}

/**
 * The host the visitor actually asked for.
 *
 * NOT `context.url.host`. The Node adapter runs in middleware mode behind
 * express (server.mjs) and builds the request URL against a fixed `localhost`
 * origin — verified against a production build, where a request carrying
 * `Host: openpublish.example` still arrives with `context.url.href` of
 * `http://localhost/tools/…`. Anything comparing hosts via `context.url` is
 * therefore always true, which for the /tools canonical redirect below would
 * mean an infinite redirect on the very host we made canonical.
 *
 * Traefik forwards with `passHostHeader: true` and also sets
 * `X-Forwarded-Host`; the forwarded header wins when present, and only its
 * first entry is trusted (it is a comma-separated list when proxies chain).
 */
function incomingHost(headers: Headers): string {
  const raw = headers.get('x-forwarded-host') ?? headers.get('host') ?? '';
  return raw.split(',')[0].trim().toLowerCase();
}

const IS_HTTPS = (process.env.BASE_URL || '').startsWith('https://');

function addSecurityHeaders(response: Response): void {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (IS_HTTPS) {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // TODO: Add enforcing CSP once the full allowlist is mapped (fonts, CDN scripts, Facebook SDK, Sentry, etc.)
  // X-Frame-Options: DENY above handles clickjacking protection in the meantime.
}

/** Finalize a response: add security headers (compression handled by Traefik/reverse proxy) */
function finalizeResponse(response: Response): Response {
  addSecurityHeaders(response);
  return response;
}

const PUBLIC_PATHS = [
  '/login', '/register', '/forgot-password', '/reset-password', '/verify-email', '/api/auth/',
  // Genuinely public: the enabled-platform list (no auth, no ops detail).
  // Listed as an exact path so the authenticated '/api/platforms' can't
  // inherit it.
  '/api/platforms/public',
  // Product-event beacon (src/lib/track.ts). Must accept pre-auth traffic —
  // login/register page views and signup outcomes are the point — so it skips
  // the session check here and attributes the event itself when a session
  // cookie is present. Rate-limited per IP and strictly validated in-route.
  '/api/events',
  // API reference — public like the spec it renders (/openapi.json is a
  // static file and bypasses the middleware anyway).
  '/docs',
  // Local-storage media (STORAGE=local). Platforms fetch post media from these
  // URLs at publish time, so they must be reachable without a session — keys
  // are unguessable server-generated names, mirroring a public bucket URL.
  '/uploads/',
];
const STATIC_EXTENSIONS = [
  '.css',
  '.js',
  '.png',
  '.jpg',
  '.jpeg',
  '.svg',
  '.ico',
  '.woff',
  '.woff2',
];

// In-memory role cache: userId -> { role, expiresAt }
const roleCache = new Map<string, { role: string; expiresAt: number }>();
const ROLE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedRole(userId: string): string | null {
  const entry = roleCache.get(userId);
  if (!entry || Date.now() > entry.expiresAt) {
    roleCache.delete(userId);
    return null;
  }
  return entry.role;
}

function setCachedRole(userId: string, role: string): void {
  roleCache.set(userId, { role, expiresAt: Date.now() + ROLE_CACHE_TTL });
}

/** Drop a user's cached role so an admin ban/unban takes effect immediately. */
export function clearRoleCache(userId: string): void {
  roleCache.delete(userId);
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;
  const start = Date.now();
  const method = context.request.method;
  // `clientAddress` throws when the request is being prerendered rather than
  // served. Nothing prerenders today, but middleware runs for every page and a
  // throw here is a build failure, not a bad log line — so it stays guarded.
  let peerAddress: string | null = null;
  try {
    peerAddress = context.clientAddress;
  } catch {
    /* not available outside a real request */
  }
  const ip = getClientIp(context.request.headers, peerAddress);

  // Determine if this request should be logged
  const shouldLog =
    !STATIC_EXTENSIONS.some((ext) => pathname.endsWith(ext)) &&
    !LOG_SKIP_PATHS.includes(pathname) &&
    !pathname.startsWith('/assets/');

  try {
    // Skip auth for static assets
    if (STATIC_EXTENSIONS.some((ext) => pathname.endsWith(ext))) {
      return next();
    }

    // Let Better Auth handle its own routes
    if (pathname.startsWith('/api/auth/')) {
      // Skip rate limiting for webhooks (Polar sends bursts)
      const isWebhook = pathname.includes('/webhooks');
      // Rate limit auth endpoints by IP (10 req/min) — except webhooks
      const rl = isWebhook ? { allowed: true, remaining: 0, retryAfter: 0 } : await checkRateLimit(`rl:auth:${ip}`, 10, 60);
      if (!rl.allowed) {
        const rlResponse = rateLimitResponse(rl.retryAfter ?? 60);
        logRequest(shouldLog, { method, path: pathname, status: 429, duration: Date.now() - start, ip, type: 'auth' });
        return rlResponse;
      }
      const authAction = pathname.replace('/api/auth/', '').split('/')[0];
      // Sign-out revokes the session server-side — drop the 30s cached copy
      // too so already-open clients lose access immediately.
      if (authAction === 'sign-out') clearCachedSession(context.request);
      const response = await auth.handler(context.request);
      logRequest(shouldLog, { method, path: pathname, status: response.status, duration: Date.now() - start, ip, type: 'auth', authAction });
      return response;
    }

    // Skip auth for public paths
    if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p.endsWith('/') ? p : p + '/'))) {
      const response = await next();
      const finalResponse = await finalizeResponse(response);
      logRequest(shouldLog, { method, path: pathname, status: response.status, duration: Date.now() - start, ip, type: 'public' });
      return finalResponse;
    }

    // Authenticate API routes
    if (pathname.startsWith('/api/')) {
      const authContext = await getAuthContext(context.request);
      if (!authContext) {
        const response = new Response(
          JSON.stringify({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        );
        logRequest(shouldLog, { method, path: pathname, status: 401, duration: Date.now() - start, ip, type: 'api' });
        return response;
      }

      // Banned users lose all API access (sessions are also revoked on ban;
      // this covers sessions issued before the ban and the role-cache window)
      if (authContext.role === 'banned') {
        const response = new Response(
          JSON.stringify({ error: { message: 'Account disabled', code: 'ACCOUNT_DISABLED' } }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        );
        logRequest(shouldLog, { method, path: pathname, status: 403, duration: Date.now() - start, ip, type: 'api', userId: authContext.userId });
        return response;
      }


      // Rate limit API routes by user (per-minute burst limit)
      const isWrite = method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
      const rlKey = `rl:api:${authContext.userId}:${isWrite ? 'w' : 'r'}`;
      const rlLimit = isWrite ? 60 : 300; // 60 writes/min, 300 reads/min
      const rl = await checkRateLimit(rlKey, rlLimit, 60);
      if (!rl.allowed) {
        const rlResponse = rateLimitResponse(rl.retryAfter!);
        logRequest(shouldLog, { method, path: pathname, status: 429, duration: Date.now() - start, ip, type: 'api', userId: authContext.userId });
        return rlResponse;
      }

      // Daily API quota check (unlimited on self-host; kept for structure).
      if (authContext.authType === 'api_key') {
        const dailyCheck = await checkDailyApiQuota(
          authContext.organizationId,
          authContext.organizationPlan as 'free' | 'pro' | 'business',
        );
        if (!dailyCheck.allowed) {
          const res = new Response(
            JSON.stringify({
              error: {
                message: `Daily API quota exceeded (${dailyCheck.current}/${dailyCheck.limit}). Resets at midnight UTC.`,
                code: 'DAILY_QUOTA_EXCEEDED',
                current: dailyCheck.current,
                limit: dailyCheck.limit,
                upgrade: dailyCheck.limit < 50000,
              },
            }),
            { status: 429, headers: { 'Content-Type': 'application/json' } },
          );
          logRequest(shouldLog, { method, path: pathname, status: 429, duration: Date.now() - start, ip, type: 'api', userId: authContext.userId });
          return res;
        }
      }

      context.locals.auth = {
        user: {
          id: authContext.userId,
          email: authContext.email,
          name: authContext.name,
          role: authContext.role,
        },
        authType: authContext.authType,
        organizationId: authContext.organizationId,
        organizationName: authContext.organizationName,
        organizationPlan: authContext.organizationPlan,
        organizationRole: authContext.organizationRole,
        scopes: authContext.scopes,
      };

      // ENGINE=cloud: the publishing API surface is served by the BulkPublish
      // cloud with the operator's API key. Runs AFTER local auth, so only
      // authenticated members of this instance ever reach the proxy. Channel
      // connect is the exception — OAuth must run on the cloud origin.
      if (isCloudProxiedPath(pathname)) {
        if (pathname.startsWith('/api/channels/connect')) {
          const response = new Response(
            JSON.stringify({
              error: {
                message: `In cloud mode, connect channels at ${cloudApiUrl()}/channels — they appear here automatically.`,
                code: 'CLOUD_CONNECT_EXTERNAL',
              },
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
          logRequest(shouldLog, { method, path: pathname, status: 400, duration: Date.now() - start, ip, type: 'cloud-proxy', userId: authContext.userId });
          return response;
        }
        const response = await proxyToCloud(context.request, pathname, context.url.search);
        logRequest(shouldLog, { method, path: pathname, status: response.status, duration: Date.now() - start, ip, type: 'cloud-proxy', userId: authContext.userId });
        return finalizeResponse(response);
      }

      const response = await next();
      const finalResponse = await finalizeResponse(response);
      logRequest(shouldLog, { method, path: pathname, status: response.status, duration: Date.now() - start, ip, type: 'api', userId: authContext.userId });
      return finalResponse;
    }

    // Authenticate page routes via session (short-lived cached lookup)
    const session = await getCachedSession(context.request);
    if (!session?.user) {
      logRequest(shouldLog, { method, path: pathname, status: 302, duration: Date.now() - start, ip, type: 'page' });
      return context.redirect('/login');
    }

    // Use cached role instead of DB query on every page view
    let role = getCachedRole(session.user.id);
    if (!role) {
      const [dbUser] = await db
        .select({ role: userTable.role })
        .from(userTable)
        .where(eq(userTable.id, session.user.id))
        .limit(1);
      role = dbUser?.role ?? 'user';
      setCachedRole(session.user.id, role);
    }

    // Banned users are signed out of all pages
    if (role === 'banned') {
      logRequest(shouldLog, { method, path: pathname, status: 302, duration: Date.now() - start, ip, type: 'page', userId: session.user.id });
      return context.redirect('/login?error=account_disabled');
    }

    // Resolve active organization for page routes
    let org: { id: number; name: string; plan: string; role: string } | null = null;
    try {
      org = await resolvePageOrg(session.user.id, context.request);
    } catch (err) {
      requestLogger.error({ method, path: pathname, ip, userId: session.user.id, error: err instanceof Error ? err.message : String(err) }, 'org-resolve-error');
    }

    if (!org) {
      // User has no organization — redirect to a setup page or show error
      // This can happen if org creation hook failed during signup
      logRequest(shouldLog, { method, path: pathname, status: 302, duration: Date.now() - start, ip, type: 'page', userId: session.user.id });
      return context.redirect('/login?error=no_organization');
    }

    context.locals.auth = {
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        role,
      },
      authType: 'session' as const,
      organizationId: org.id,
      organizationName: org.name,
      organizationPlan: org.plan as 'free' | 'pro' | 'business',
      organizationRole: normalizeRole(org.role),
    };

    const response = await next();
    const finalResponse = await finalizeResponse(response);
    logRequest(shouldLog, { method, path: pathname, status: response.status, duration: Date.now() - start, ip, type: 'page', userId: session.user.id });
    return finalResponse;
  } catch (error) {
    const duration = Date.now() - start;
    logRequest(shouldLog, {
      method,
      path: pathname,
      status: 500,
      duration,
      ip,
      type: 'error',
      error: error instanceof Error ? error.stack || error.message : String(error),
    });
    throw error;
  }
});

// In-memory org cache for page routes
export const pageOrgCache = new Map<string, { org: { id: number; name: string; plan: string; role: string }; expiresAt: number }>();

/** Clear the page org cache for a user (call after org switch) */
export function clearPageOrgCache(userId: string): void {
  for (const key of pageOrgCache.keys()) {
    if (key.startsWith(`${userId}:`)) pageOrgCache.delete(key);
  }
}
const PAGE_ORG_CACHE_TTL = 5 * 60 * 1000;

async function resolvePageOrg(
  userId: string,
  request: Request,
): Promise<{ id: number; name: string; plan: string; role: string } | null> {
  const cookies = request.headers.get('cookie') || '';
  const match = cookies.match(/bp_active_org=(\d+)/);
  const cookieOrgId = match ? Number(match[1]) : null;

  if (cookieOrgId) {
    const cacheKey = `${userId}:${cookieOrgId}`;
    const cached = pageOrgCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.org;

    const [membership] = await db
      .select({ orgId: organizations.id, orgName: organizations.name, orgPlan: organizations.plan, role: organizationMembers.role })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.organizationId, cookieOrgId)))
      .limit(1);

    if (membership) {
      const org = { id: membership.orgId, name: membership.orgName, plan: membership.orgPlan, role: membership.role };
      pageOrgCache.set(cacheKey, { org, expiresAt: Date.now() + PAGE_ORG_CACHE_TTL });
      return org;
    }
  }

  // Fall back to user's first org
  const [defaultOrg] = await db
    .select({ orgId: organizations.id, orgName: organizations.name, orgPlan: organizations.plan, role: organizationMembers.role })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(eq(organizationMembers.userId, userId))
    .limit(1);

  if (!defaultOrg) return null;

  const org = { id: defaultOrg.orgId, name: defaultOrg.orgName, plan: defaultOrg.orgPlan, role: defaultOrg.role };
  pageOrgCache.set(`${userId}:${org.id}`, { org, expiresAt: Date.now() + PAGE_ORG_CACHE_TTL });
  return org;
}
