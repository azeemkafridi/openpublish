import type { APIRoute } from 'astro';
import '@/lib/platforms/init';
import { getPlatformHandler } from '@/lib/platforms/registry';
import { LinkedInHandler } from '@/lib/platforms/linkedin';
import { TelegramHandler } from '@/lib/platforms/telegram';
import { getPlatformAvailability, getPlatformAvailabilityFor, resolveAvailabilityForRole } from '@/lib/platforms/availability';
import { generateOAuthState } from '@/lib/oauth/state';
import { platformDisplayName, type PlatformName } from '@/lib/platforms/types';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { eq, and, or, lt } from 'drizzle-orm';
import { encrypt } from '@/lib/auth/crypto';
import { logActivity } from '@/lib/activity/log';
import { createLogger } from '@/lib/logger';
import { checkChannelQuota, checkPlatformAllowed, getOrgPlan } from '@/lib/quotas/check';
import { PLAN_DISPLAY_NAMES } from '@/lib/quotas/plans';
import { quotaExceededResponse } from '@/lib/quotas/errors';
import type { PlanTier } from '@/lib/quotas/plans';
import { validateHostname, ssrfSafeFetch } from '@/lib/security/url-guard';

const logger = createLogger('channel-connect');

const API_VERSION = 'v24.0';
const FB_BASE = `https://graph.facebook.com/${API_VERSION}`;

const VALID_PLATFORMS = new Set<string>([
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

export const GET: APIRoute = async ({ locals, params, url }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const platform = params.platform;
  if (!platform || !VALID_PLATFORMS.has(platform)) {
    return json(
      {
        error: 'Invalid platform',
        validPlatforms: Array.from(VALID_PLATFORMS),
      },
      400,
    );
  }

  const platformName = platform as PlatformName;

  // Platform availability gate (`PLATFORM_<NAME>` + app-credential presence).
  // Blocks NEW connections when the platform is `off` or `connect_off` — the
  // latter still lets already-connected channels publish. Returns the reason so
  // the UI can say "paused" vs "unavailable" instead of a generic 404, and so we
  // never 500 out of a handler's missing-credential throw.
  // Role-aware: `admin_only` platforms connect normally for site admins.
  const availability = resolveAvailabilityForRole(getPlatformAvailability(platform), user.role);
  if (!availability.canConnect) {
    return json(
      {
        error: {
          message: availability.message,
          code: 'PLATFORM_DISABLED',
          platform,
          state: availability.state,
          reason: availability.reason,
        },
      },
      403,
    );
  }

  // Check if platform is allowed on org's plan
  const platformCheck = await checkPlatformAllowed(locals.auth.organizationId, platformName);
  if (!platformCheck.allowed) {
    const plan = await getOrgPlan(locals.auth.organizationId);
    const nextPlan = plan === 'free' ? 'Pro' : plan === 'pro' ? 'Business' : null;
    const platformLabel = platformName === 'x' ? 'X (Twitter)' : platformName.charAt(0).toUpperCase() + platformName.slice(1);
    return json({
      error: {
        message: `${platformLabel} is not available on the ${PLAN_DISPLAY_NAMES[plan]} plan.`,
        hint: nextPlan ? `Upgrade to ${nextPlan} to connect ${platformLabel}.` : 'This platform is not available on your current plan.',
        code: 'FEATURE_DISABLED',
        upgrade: !!nextPlan,
      },
    }, 403);
  }

  // Channel-limit wall, enforced BEFORE the OAuth round-trip so the user sees
  // the structured error (slot CTA + upgrade link) instead of completing a
  // platform login that the callback then rejects with a plain string.
  // Reconnects must still pass at the limit: an ACTIVE channel on this platform
  // that lost its token (needs_reconnect, or an expired token) can be
  // re-authorized without adding a channel, so the pre-check is skipped when
  // one exists — the callback still enforces quota if the user picks a
  // different (new) account mid-flow, and still counts revived soft-deleted
  // channels, which DO add to the quota.
  {
    const reconnectable = await db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.organizationId, locals.auth.organizationId),
          eq(channels.platform, platformName),
          eq(channels.isActive, true),
          or(eq(channels.needsReconnect, true), lt(channels.tokenExpiresAt, new Date())),
        ),
      )
      .limit(1);
    if (reconnectable.length === 0) {
      const quota = await checkChannelQuota(locals.auth.organizationId, platformName);
      if (!quota.allowed) {
        const plan = await getOrgPlan(locals.auth.organizationId) as PlanTier;
        return quotaExceededResponse(quota, plan);
      }
    }
  }

  try {
    const handler = getPlatformHandler(platformName);

    // Bluesky uses credentials-based auth, not OAuth
    if (handler.config.authType === 'credentials') {
      return json({ authType: 'credentials' });
    }

    // Mastodon uses per-instance OAuth — needs instance URL first
    if (platformName === 'mastodon') {
      return json({ authType: 'mastodon' });
    }

    // Facebook uses client-side JS SDK login (Facebook Login for Business)
    if (platformName === 'facebook') {
      const appId = process.env.FACEBOOK_APP_ID;
      if (!appId) return json({ error: 'FACEBOOK_APP_ID not configured' }, 500);
      const configId = process.env.FACEBOOK_CONFIG_ID || '';
      return json({ authType: 'facebook_sdk', appId, configId });
    }

    const baseUrl = process.env.BASE_URL || 'http://localhost:4321';
    const redirect = url.searchParams.get('redirect') === 'true';
    // Mobile app connects flag the OAuth state so the callback page redirects
    // into the app (openpublish://) instead of /channels.
    const fromMobile = url.searchParams.get('source') === 'mobile';

    // LinkedIn company pages use a separate OAuth round-trip against the Community
    // Management app (App B) with organization scopes and its own callback path.
    if (platformName === 'linkedin' && url.searchParams.get('mode') === 'page') {
      // Company pages are gated on their own (`PLATFORM_LINKEDIN_PAGES`) because
      // the Community Management API is a separate LinkedIn app with a separate
      // review — personal profiles can be fully live while this is pending.
      const pageAvailability = getPlatformAvailabilityFor('linkedin', 'organization');
      if (!pageAvailability.canConnect) {
        return json(
          {
            error: {
              message: pageAvailability.message,
              code: 'PLATFORM_DISABLED',
              platform,
              accountType: 'organization',
              state: pageAvailability.state,
              reason: pageAvailability.reason,
            },
          },
          403,
        );
      }

      const pageState = generateOAuthState(user.id, 'linkedin', locals.auth.organizationId, {
        mode: 'page',
        ...(fromMobile ? { source: 'mobile' } : {}),
      });
      const pageRedirectUri = `${baseUrl}/auth/callback/linkedin-page`;
      const pageUrl = await new LinkedInHandler().getPageOAuthUrl(pageRedirectUri, pageState);
      if (redirect) {
        return new Response(null, { status: 302, headers: { Location: pageUrl } });
      }
      return json({ url: pageUrl });
    }

    const state = generateOAuthState(
      user.id,
      platformName,
      locals.auth.organizationId,
      fromMobile ? { source: 'mobile' } : undefined,
    );
    const redirectUri = `${baseUrl}/auth/callback/${platformName}`;
    const oauthUrl = await handler.getOAuthUrl(redirectUri, state);

    if (redirect) {
      return new Response(null, {
        status: 302,
        headers: { Location: oauthUrl },
      });
    }

    return json({ url: oauthUrl });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to generate OAuth URL';
    logger.error({ error: message, platform, stack: error instanceof Error ? error.stack : undefined }, 'Failed to get OAuth URL');
    return json({ error: 'Failed to initiate connection' }, 500);
  }
};

export const POST: APIRoute = async ({ locals, params, request }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const platform = params.platform;

  // The credential/SDK platforms connect via POST, which used to bypass the
  // availability and plan gates the OAuth GET path enforces.
  if (platform && VALID_PLATFORMS.has(platform)) {
    const availability = resolveAvailabilityForRole(getPlatformAvailability(platform), user.role);
    if (!availability.canConnect) {
      return json(
        {
          error: {
            message: availability.message,
            code: 'PLATFORM_DISABLED',
            platform,
            state: availability.state,
            reason: availability.reason,
          },
        },
        403,
      );
    }
    const platformCheck = await checkPlatformAllowed(locals.auth.organizationId, platform as PlatformName);
    if (!platformCheck.allowed) {
      const plan = await getOrgPlan(locals.auth.organizationId);
      return json({
        error: {
          message: `${platformDisplayName(platform as PlatformName)} is not available on the ${PLAN_DISPLAY_NAMES[plan]} plan.`,
          code: 'FEATURE_DISABLED',
        },
      }, 403);
    }
  }

  if (platform === 'facebook') {
    const body = await request.json();
    return handleFacebookPageSave(user.id, locals.auth.organizationId, body);
  }

  if (platform === 'bluesky') {
    return handleBlueskyConnect(user.id, locals.auth.organizationId, request);
  }

  if (platform === 'mastodon') {
    return handleMastodonConnect(user.id, locals.auth.organizationId, request);
  }

  if (platform === 'telegram') {
    return handleTelegramConnect(user.id, locals.auth.organizationId, request);
  }

  return json({ error: 'POST not supported for this platform' }, 400);
};

async function handleTelegramConnect(userId: string, organizationId: number, request: Request) {
  try {
    const body = await request.json();
    const botToken = (body.botToken || '').trim();
    const chatId = (body.chatId || '').trim();
    if (!botToken || !chatId) {
      return json({ error: 'Both a bot token and a chat id/username are required.' }, 400);
    }

    // getAccountInfo only sees the bot — resolve the destination chat for display.
    // getChatInfo also validates the bot token + that the bot can reach the chat.
    const handler = getPlatformHandler('telegram') as TelegramHandler;
    const chat = await handler.getChatInfo(botToken, chatId);
    const accountId = chat.id;
    const accountName = chat.title;

    // Check if this chat already exists (reconnection vs new channel)
    const existing = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.organizationId, organizationId),
          eq(channels.platform, 'telegram'),
          eq(channels.accountId, accountId),
        ),
      )
      .limit(1);

    // Enforce quota for new channels and revived (soft-deleted) ones
    if (existing.length === 0 || !existing[0].isActive) {
      const quota = await checkChannelQuota(organizationId, 'telegram');
      if (!quota.allowed) {
        const plan = await getOrgPlan(organizationId) as PlanTier;
        return quotaExceededResponse(quota, plan);
      }
    }

    // metadata.chatId is what the handler reads at publish time. Store the
    // NORMALIZED reference (chat.chatId) — a public @username (with the "@"
    // added if the user omitted it) or a numeric chat id — so sends succeed.
    const metadata: Record<string, unknown> = { chatId: chat.chatId };

    let channelId: number;

    if (existing.length > 0) {
      const mergedMetadata = { ...(existing[0].metadata as Record<string, unknown> || {}), ...metadata };
      await db
        .update(channels)
        .set({
          accountName,
          accessToken: encrypt(botToken),
          metadata: mergedMetadata,
          isActive: true,
          needsReconnect: false,
          updatedAt: new Date(),
        })
        .where(eq(channels.id, existing[0].id));
      channelId = existing[0].id;
    } else {
      const [inserted] = await db
        .insert(channels)
        .values({
          userId,
          organizationId,
          platform: 'telegram',
          accountName,
          accountId,
          accountType: chat.type || 'channel',
          accessToken: encrypt(botToken),
          refreshToken: null,
          tokenExpiresAt: null,
          metadata,
          isActive: true,
          needsReconnect: false,
        })
        .returning({ id: channels.id });
      channelId = inserted.id;
    }

    logActivity({
      userId,
      organizationId,
      action: existing.length > 0 ? 'channel.reconnected' : 'channel.connected',
      resource: 'channel',
      resourceId: channelId,
      details: { platform: 'telegram', accountName },
    });

    return json({ success: true, channelId, accountName });
  } catch (error) {
    // getChatInfo throws user-facing messages ("Invalid bot token." / "Could not
    // find that chat...") — surface them so the connect dialog is actionable.
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, 'Telegram connect failed');
    return json({ error: message || 'Failed to connect Telegram account' }, 400);
  }
}

async function handleFacebookPageSave(userId: string, organizationId: number, body: Record<string, any>) {
  const { userAccessToken, pageId, pageName, pageAccessToken } = body;

  if (!userAccessToken || !pageId || !pageName) {
    return json({ error: 'Missing required fields (userAccessToken, pageId, pageName)' }, 400);
  }

  // Check if this page already exists (reconnection vs new channel)
  const existingFb = await db
    .select({ id: channels.id, isActive: channels.isActive })
    .from(channels)
    .where(
      and(
        eq(channels.organizationId, organizationId),
        eq(channels.platform, 'facebook'),
        eq(channels.accountId, pageId),
      ),
    )
    .limit(1);

  // Enforce quota for new channels and revived (soft-deleted) ones
  if (existingFb.length === 0 || !existingFb[0].isActive) {
    const quota = await checkChannelQuota(organizationId, 'facebook');
    if (!quota.allowed) {
      const plan = await getOrgPlan(organizationId) as PlanTier;
      return quotaExceededResponse(quota, plan);
    }
  }

  const appId = process.env.FACEBOOK_APP_ID!;
  const appSecret = process.env.FACEBOOK_APP_SECRET!;

  try {
    // Exchange short-lived user token for long-lived user token
    const longLivedRes = await fetch(
      `${FB_BASE}/oauth/access_token?` +
      `grant_type=fb_exchange_token` +
      `&client_id=${appId}` +
      `&client_secret=${appSecret}` +
      `&fb_exchange_token=${userAccessToken}`,
    );
    const longLived = (await longLivedRes.json()) as {
      access_token?: string;
      error?: { message: string };
    };

    // Start with client-provided page token (from /me/accounts or business endpoint)
    let finalPageToken = pageAccessToken || '';

    // Try to get a long-lived page token via the long-lived user token
    // This produces a non-expiring page token when the user has direct page access
    const tokenSource = longLived.access_token || userAccessToken;
    if (!finalPageToken || longLived.access_token) {
      const pageTokenRes = await fetch(
        `${FB_BASE}/${pageId}?fields=access_token&access_token=${tokenSource}`,
      );
      const pageTokenData = (await pageTokenRes.json()) as {
        access_token?: string;
        error?: { message: string };
      };

      if (pageTokenData.access_token) {
        finalPageToken = pageTokenData.access_token;
        logger.info({ pageId }, 'Obtained long-lived page token');
      } else if (!finalPageToken) {
        logger.warn({ pageId, error: pageTokenData.error }, 'Could not get page token');
      }
    }

    if (!finalPageToken) {
      return json({
        error: 'Could not obtain a page access token. You need direct admin access to the page. ' +
               'Go to business.facebook.com → Settings → People → your name → Assets → Pages → add the page with Full Control.',
      }, 400);
    }

    // Get page profile picture. Best-effort: this is cosmetic (avatar only),
    // and a Graph error page or non-JSON body here must not fail the connect.
    let pageInfo: { picture?: { data?: { url?: string } } } = {};
    try {
      const infoRes = await fetch(
        `${FB_BASE}/${pageId}?fields=id,name,picture&access_token=${finalPageToken}`,
      );
      if (infoRes.ok) {
        pageInfo = (await infoRes.json()) as typeof pageInfo;
      }
    } catch (error) {
      logger.warn({ pageId, error }, 'Facebook page picture fetch failed; connecting without avatar');
    }

    // Upsert channel
    const existing = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.organizationId, organizationId),
          eq(channels.platform, 'facebook'),
          eq(channels.accountId, pageId),
        ),
      )
      .limit(1);

    let channelId: number;

    if (existing.length > 0) {
      await db
        .update(channels)
        .set({
          accountName: pageName,
          accessToken: encrypt(finalPageToken),
          tokenExpiresAt: null,
          profileImage: pageInfo.picture?.data?.url || existing[0].profileImage,
          isActive: true,
          needsReconnect: false,
          updatedAt: new Date(),
        })
        .where(eq(channels.id, existing[0].id));
      channelId = existing[0].id;
    } else {
      const [inserted] = await db
        .insert(channels)
        .values({
          userId,
          organizationId,
          platform: 'facebook',
          accountName: pageName,
          accountId: pageId,
          accountType: 'page',
          accessToken: encrypt(finalPageToken),
          refreshToken: null,
          tokenExpiresAt: null,
          profileImage: pageInfo.picture?.data?.url,
          isActive: true,
          needsReconnect: false,
        })
        .returning({ id: channels.id });
      channelId = inserted.id;
    }

    logActivity({
      userId,
      organizationId,
      action: existing.length > 0 ? 'channel.reconnected' : 'channel.connected',
      resource: 'channel',
      resourceId: channelId,
      details: { platform: 'facebook', accountName: pageName },
    });

    logger.info({ channelId, pageName, pageId }, 'Facebook page connected');
    return json({ success: true, channelId, accountName: pageName });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, 'Facebook page save failed');
    return json({ error: 'Failed to save Facebook page connection' }, 500);
  }
}

async function handleBlueskyConnect(userId: string, organizationId: number, request: Request) {
  try {
    const body = await request.json();
    const pdsUrl = (body.pdsUrl || '').trim() || null; // optional custom PDS URL
    const handler = getPlatformHandler('bluesky');
    const tokenData = await handler.exchangeCodeForToken(
      JSON.stringify(body),
      '',
    );
    const accountInfo = await handler.getAccountInfo(tokenData.accessToken);

    // Check if this account already exists (reconnection vs new channel)
    const existing = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.organizationId, organizationId),
          eq(channels.platform, 'bluesky'),
          eq(channels.accountId, accountInfo.id),
        ),
      )
      .limit(1);

    // Enforce quota for new channels and revived (soft-deleted) ones
    if (existing.length === 0 || !existing[0].isActive) {
      const quota = await checkChannelQuota(organizationId, 'bluesky');
      if (!quota.allowed) {
        const plan = await getOrgPlan(organizationId) as PlanTier;
        return quotaExceededResponse(quota, plan);
      }
    }

    // Build metadata with DID and optional custom PDS URL
    const metadata: Record<string, unknown> = { did: accountInfo.id };
    if (pdsUrl) metadata.pdsUrl = pdsUrl;

    let channelId: number;

    if (existing.length > 0) {
      // Merge new metadata with any existing metadata
      const mergedMetadata = { ...(existing[0].metadata as Record<string, unknown> || {}), ...metadata };
      await db
        .update(channels)
        .set({
          accountName: accountInfo.name,
          accessToken: encrypt(tokenData.accessToken),
          refreshToken: tokenData.refreshToken ? encrypt(tokenData.refreshToken) : existing[0].refreshToken,
          metadata: mergedMetadata,
          isActive: true,
          needsReconnect: false,
          updatedAt: new Date(),
        })
        .where(eq(channels.id, existing[0].id));
      channelId = existing[0].id;
    } else {
      const [inserted] = await db
        .insert(channels)
        .values({
          userId,
          organizationId,
          platform: 'bluesky',
          accountName: accountInfo.name,
          accountId: accountInfo.id,
          accountType: accountInfo.accountType || 'personal',
          accessToken: encrypt(tokenData.accessToken),
          refreshToken: tokenData.refreshToken ? encrypt(tokenData.refreshToken) : null,
          tokenExpiresAt: null,
          profileImage: accountInfo.profileImage,
          metadata,
          isActive: true,
          needsReconnect: false,
        })
        .returning({ id: channels.id });
      channelId = inserted.id;
    }

    logActivity({
      userId,
      organizationId,
      action: existing.length > 0 ? 'channel.reconnected' : 'channel.connected',
      resource: 'channel',
      resourceId: channelId,
      details: { platform: 'bluesky', accountName: accountInfo.name },
    });

    return json({ success: true, channelId, accountName: accountInfo.name });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, 'Bluesky connect failed');
    return json({ error: 'Failed to connect Bluesky account' }, 500);
  }
}

async function handleMastodonConnect(userId: string, organizationId: number, request: Request) {
  try {
    const body = await request.json();
    let instanceUrl = (body.instanceUrl || '').trim().toLowerCase();

    if (!instanceUrl) {
      return json({ error: 'Instance URL is required (e.g., mastodon.social)' }, 400);
    }

    // Normalize: strip protocol and trailing slash
    instanceUrl = instanceUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');

    // Basic validation
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(instanceUrl)) {
      return json({ error: 'Invalid instance URL. Enter a domain like mastodon.social' }, 400);
    }

    // SSRF guard: the instance host must resolve to a public address (not internal/metadata).
    if (!(await validateHostname(instanceUrl))) {
      return json({ error: `Could not connect to ${instanceUrl}. Make sure it's a valid, publicly reachable Mastodon instance.` }, 400);
    }

    const baseUrl = process.env.BASE_URL || 'http://localhost:4321';
    const redirectUri = `${baseUrl}/auth/callback/mastodon`;

    // Register app on the instance
    logger.info({ instanceUrl }, 'Registering Mastodon app on instance');
    const appRes = await ssrfSafeFetch(`https://${instanceUrl}/api/v1/apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'openPublish',
        redirect_uris: redirectUri,
        scopes: 'read write:statuses write:media',
        website: 'https://github.com/openpublish',
      }),
    });

    if (!appRes.ok) {
      const errText = await appRes.text();
      logger.error({ instanceUrl, status: appRes.status, error: errText }, 'Failed to register app on instance');
      return json({ error: `Could not connect to ${instanceUrl}. Make sure it's a valid Mastodon instance.` }, 400);
    }

    const appData = (await appRes.json()) as {
      client_id: string;
      client_secret: string;
    };

    // Generate OAuth state with instance metadata
    const state = generateOAuthState(userId, 'mastodon', organizationId, {
      instanceUrl,
      clientId: appData.client_id,
      clientSecret: appData.client_secret,
      // Mobile-initiated connects bounce back into the app from the callback.
      ...(body.source === 'mobile' ? { source: 'mobile' } : {}),
    });

    // Build authorize URL
    const authorizeUrl =
      `https://${instanceUrl}/oauth/authorize?` +
      `client_id=${encodeURIComponent(appData.client_id)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent('read write:statuses write:media')}` +
      `&state=${encodeURIComponent(state)}`;

    logger.info({ instanceUrl }, 'Mastodon OAuth URL generated');
    return json({ url: authorizeUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, 'Mastodon connect failed');
    return json({ error: 'Failed to connect Mastodon account' }, 500);
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
