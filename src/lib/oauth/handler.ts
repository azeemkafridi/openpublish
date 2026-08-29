import { db } from '../db';
import { channels } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { encrypt } from '../auth/crypto';
import '../platforms/init';
import { getPlatformHandler } from '../platforms/registry';
import { LinkedInHandler } from '../platforms/linkedin';
import { validateOAuthState, type OAuthStateData } from './state';
import { storeLinkedInPageSession } from './linkedin-page-session';
import { createLogger } from '../logger';
import type { PlatformName, TokenData, AccountInfo } from '../platforms/types';
import { platformDisplayName } from '../platforms/types';
import { logActivity } from '../activity/log';
import { checkChannelQuota, checkPlatformAllowed, getOrgPlan } from '../quotas/check';
import { PLAN_DISPLAY_NAMES } from '../quotas/plans';
import { validateHostname, ssrfSafeFetch } from '../security/url-guard';

const logger = createLogger('oauth');

export interface OAuthCallbackResult {
  success: boolean;
  channelId?: number;
  accountName?: string;
  platform?: string;
  error?: string;
  /** Where the connect was initiated ('mobile' = bounce back into the app). */
  source?: string;
}

export async function handleOAuthCallback(
  platform: PlatformName,
  code: string,
  state: string,
  redirectUri: string,
): Promise<OAuthCallbackResult> {
  // Validate state
  const stateData = await validateOAuthState(state);
  if (!stateData) {
    logger.warn({ platform, state }, 'Invalid or expired OAuth state');
    return { success: false, error: 'Invalid or expired authorization. Please try again.' };
  }

  if (stateData.platform !== platform) {
    logger.warn({ expected: stateData.platform, got: platform }, 'Platform mismatch');
    return { success: false, error: 'Platform mismatch in OAuth callback.' };
  }

  // Mobile-initiated connects carry source:'mobile' in the state so the
  // callback page can bounce back into the app instead of /channels.
  const result = await completeOAuthCallback(platform, stateData, code, state, redirectUri);
  const source = stateData.metadata?.source;
  return source ? { ...result, source } : result;
}

async function completeOAuthCallback(
  platform: PlatformName,
  stateData: OAuthStateData,
  code: string,
  state: string,
  redirectUri: string,
): Promise<OAuthCallbackResult> {
  const handler = getPlatformHandler(platform);
  const { userId, organizationId } = stateData;

  // Mastodon uses per-instance OAuth with credentials stored in state metadata
  if (platform === 'mastodon') {
    return handleMastodonOAuth(stateData, code, redirectUri);
  }

  try {
    // Check if platform is allowed on org's plan
    const platformCheck = await checkPlatformAllowed(organizationId, platform);
    if (!platformCheck.allowed) {
      const plan = await getOrgPlan(organizationId);
      logger.info({ platform, organizationId, plan }, 'OAuth callback rejected: platform not on plan');
      return {
        success: false,
        error: `${platformDisplayName(platform)} is not available on the ${PLAN_DISPLAY_NAMES[plan]} plan. Upgrade to Pro or Business to connect it.`,
      };
    }

    // Exchange code for token
    logger.info({ platform, userId, organizationId }, 'Exchanging OAuth code for token');
    const tokenData: TokenData = await handler.exchangeCodeForToken(code, redirectUri, state);

    // Get account info
    logger.info({ platform }, 'Fetching account info');
    const accountInfo: AccountInfo = await handler.getAccountInfo(tokenData.accessToken);

    // Discord's connected account is a GUILD (server), but getAccountInfo can only
    // see the bot/app identity — the guild id arrives via TokenData.userId from the
    // token exchange. Use it as the channel's accountId so publish URLs and the
    // channel picker (listGuildChannels) key off the guild.
    const accountId =
      platform === 'discord' && tokenData.userId ? tokenData.userId : accountInfo.id;

    // Calculate token expiration
    const tokenExpiresAt = tokenData.expiresIn
      ? new Date(Date.now() + tokenData.expiresIn * 1000)
      : null;

    // Check if this account already exists (reconnection vs new channel)
    const existing = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.organizationId, organizationId),
          eq(channels.platform, platform),
          eq(channels.accountId, accountId),
        ),
      )
      .limit(1);

    // Enforce quota for new channels and for reviving a disconnected (soft-deleted)
    // one — an inactive row doesn't count against the quota, so re-activating adds one.
    if (existing.length === 0 || !existing[0].isActive) {
      const quota = await checkChannelQuota(organizationId, platform);
      if (!quota.allowed) {
        const plan = await getOrgPlan(organizationId);
        logger.info(
          { platform, organizationId, plan, current: quota.current, limit: quota.limit, resource: quota.resource },
          'OAuth callback rejected: channel quota reached',
        );
        return {
          success: false,
          error: `You've reached the channel limit on the ${PLAN_DISPLAY_NAMES[plan]} plan (${quota.current}/${quota.limit}). Add an extra channel slot for $2.99/month from Settings, or upgrade for more channels.`,
        };
      }
    }

    let channelId: number;

    if (existing.length > 0) {
      // Update existing channel
      await db
        .update(channels)
        .set({
          accountName: accountInfo.name,
          accessToken: encrypt(tokenData.accessToken),
          refreshToken: tokenData.refreshToken
            ? encrypt(tokenData.refreshToken)
            : existing[0].refreshToken,
          tokenExpiresAt,
          profileImage: accountInfo.profileImage || existing[0].profileImage,
          isActive: true,
          needsReconnect: false,
          updatedAt: new Date(),
        })
        .where(eq(channels.id, existing[0].id));
      channelId = existing[0].id;
      logActivity({
        userId,
        organizationId,
        action: 'channel.reconnected',
        resource: 'channel',
        resourceId: channelId,
        details: { platform, accountName: accountInfo.name },
      });
      logger.info({ platform, channelId, accountName: accountInfo.name }, 'Updated existing channel');
    } else {
      // Create new channel
      const [inserted] = await db
        .insert(channels)
        .values({
          userId,
          organizationId,
          platform,
          accountName: accountInfo.name,
          accountId,
          accountType: accountInfo.accountType || 'unknown',
          accessToken: encrypt(tokenData.accessToken),
          refreshToken: tokenData.refreshToken
            ? encrypt(tokenData.refreshToken)
            : null,
          tokenExpiresAt,
          profileImage: accountInfo.profileImage,
          isActive: true,
        })
        .returning({ id: channels.id });
      channelId = inserted.id;
      logActivity({
        userId,
        organizationId,
        action: 'channel.connected',
        resource: 'channel',
        resourceId: channelId,
        details: { platform, accountName: accountInfo.name },
      });
      logger.info({ platform, channelId, accountName: accountInfo.name }, 'Created new channel');
    }

    // For Instagram: fetch the linked Facebook Page token for comment support
    if (platform === 'instagram') {
      try {
        // Get the user's Facebook Pages to find the one linked to this Instagram account
        const pagesRes = await fetch(
          `https://graph.facebook.com/v21.0/me/accounts?fields=id,access_token,instagram_business_account&access_token=${tokenData.accessToken}`,
        );
        const pagesData = (await pagesRes.json()) as { data?: Array<{ id: string; access_token: string; instagram_business_account?: { id: string } }> };

        if (pagesData.data) {
          // Find the page linked to this Instagram account
          const linkedPage = pagesData.data.find(
            (p) => p.instagram_business_account?.id === accountInfo.id,
          );
          if (linkedPage) {
            await db
              .update(channels)
              .set({ metadata: { pageAccessToken: encrypt(linkedPage.access_token), pageId: linkedPage.id } })
              .where(eq(channels.id, channelId));
            logger.info({ channelId, pageId: linkedPage.id }, 'Stored Facebook Page token for Instagram comments');
          }
        }
      } catch (err) {
        logger.warn({ channelId, error: err }, 'Could not fetch Facebook Page token for Instagram (comments may not work)');
      }
    }

    return {
      success: true,
      channelId,
      accountName: accountInfo.name,
      platform,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ platform, error: message }, 'OAuth callback failed');
    return { success: false, error: message };
  }
}

/**
 * Handle the company-page OAuth callback (Community Management app / App B).
 *
 * Unlike the personal flow this does NOT create a channel directly: the org-scoped token
 * can administer several pages, so we stash it in a short-lived session and hand control
 * back to the UI to let the user pick which page to connect. Finalization happens in
 * /api/channels/connect-linkedin-page.
 */
export async function handleLinkedInPageCallback(
  code: string,
  state: string,
  redirectUri: string,
): Promise<{ success: boolean; sessionKey?: string; error?: string }> {
  const stateData = await validateOAuthState(state);
  if (!stateData || stateData.platform !== 'linkedin' || stateData.metadata?.mode !== 'page') {
    logger.warn({ state }, 'Invalid or expired LinkedIn page OAuth state');
    return { success: false, error: 'Invalid or expired authorization. Please try again.' };
  }

  const { userId, organizationId } = stateData;

  try {
    const platformCheck = await checkPlatformAllowed(organizationId, 'linkedin');
    if (!platformCheck.allowed) {
      const plan = await getOrgPlan(organizationId);
      return { success: false, error: `LinkedIn is not available on the ${PLAN_DISPLAY_NAMES[plan]} plan.` };
    }

    const handler = getPlatformHandler('linkedin') as LinkedInHandler;
    logger.info({ userId, organizationId }, 'Exchanging LinkedIn page OAuth code for token');
    const tokenData = await handler.exchangePageCodeForToken(code, redirectUri);

    const sessionKey = await storeLinkedInPageSession({
      userId,
      organizationId,
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      expiresIn: tokenData.expiresIn,
    });

    return { success: true, sessionKey };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, 'LinkedIn page OAuth callback failed');
    return { success: false, error: message };
  }
}

async function handleMastodonOAuth(
  stateData: import('./state').OAuthStateData,
  code: string,
  redirectUri: string,
): Promise<OAuthCallbackResult> {
  const { userId, organizationId, metadata } = stateData;
  const instanceUrl = metadata?.instanceUrl;
  const clientId = metadata?.clientId;
  const clientSecret = metadata?.clientSecret;

  if (!instanceUrl || !clientId || !clientSecret) {
    logger.error({ metadata }, 'Mastodon callback missing instance credentials in state');
    return { success: false, error: 'Missing Mastodon instance credentials. Please try connecting again.' };
  }

  try {
    // Check if platform is allowed
    const platformCheck = await checkPlatformAllowed(organizationId, 'mastodon');
    if (!platformCheck.allowed) {
      const plan = await getOrgPlan(organizationId);
      return {
        success: false,
        error: `Mastodon is not available on the ${PLAN_DISPLAY_NAMES[plan]} plan.`,
      };
    }

    // SSRF guard (defense-in-depth): re-validate the instance host before any fetch.
    if (!(await validateHostname(instanceUrl))) {
      logger.error({ instanceUrl }, 'Mastodon instance failed SSRF validation');
      return { success: false, error: 'That Mastodon instance is not allowed.' };
    }

    // Exchange code for token
    logger.info({ instanceUrl }, 'Exchanging Mastodon OAuth code for token');
    const tokenRes = await ssrfSafeFetch(`https://${instanceUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code,
        scope: 'read write:statuses write:media',
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      logger.error({ instanceUrl, status: tokenRes.status, error: errText }, 'Mastodon token exchange failed');
      return { success: false, error: 'Failed to exchange authorization code. Please try again.' };
    }

    const tokenData = (await tokenRes.json()) as { access_token: string; token_type: string; scope: string };

    // Get account info
    logger.info({ instanceUrl }, 'Fetching Mastodon account info');
    const accountRes = await ssrfSafeFetch(`https://${instanceUrl}/api/v1/accounts/verify_credentials`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!accountRes.ok) {
      const errText = await accountRes.text();
      logger.error({ instanceUrl, status: accountRes.status, error: errText }, 'Mastodon account info failed');
      return { success: false, error: 'Failed to fetch account info from your Mastodon instance.' };
    }

    const accountInfo = (await accountRes.json()) as {
      id: string;
      username: string;
      display_name: string;
      avatar: string;
      url: string;
    };

    const accountName = accountInfo.display_name || accountInfo.username;
    const accountId = `${accountInfo.id}@${instanceUrl}`;

    // Check if this account already exists (reconnection vs new channel)
    const existing = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.organizationId, organizationId),
          eq(channels.platform, 'mastodon'),
          eq(channels.accountId, accountId),
        ),
      )
      .limit(1);

    // Enforce quota for new channels and for reviving a disconnected (soft-deleted)
    // one — an inactive row doesn't count against the quota, so re-activating adds one.
    if (existing.length === 0 || !existing[0].isActive) {
      const quota = await checkChannelQuota(organizationId, 'mastodon');
      if (!quota.allowed) {
        const plan = await getOrgPlan(organizationId);
        return {
          success: false,
          error: `You've reached the channel limit on the ${PLAN_DISPLAY_NAMES[plan]} plan (${quota.current}/${quota.limit}). Add an extra channel slot for $2.99/month from Settings, or upgrade for more channels.`,
        };
      }
    }

    let channelId: number;

    if (existing.length > 0) {
      await db
        .update(channels)
        .set({
          accountName,
          accessToken: encrypt(tokenData.access_token),
          profileImage: accountInfo.avatar || existing[0].profileImage,
          metadata: { instanceUrl },
          isActive: true,
          needsReconnect: false,
          updatedAt: new Date(),
        })
        .where(eq(channels.id, existing[0].id));
      channelId = existing[0].id;
      logActivity({
        userId,
        organizationId,
        action: 'channel.reconnected',
        resource: 'channel',
        resourceId: channelId,
        details: { platform: 'mastodon', accountName },
      });
      logger.info({ channelId, accountName, instanceUrl }, 'Updated existing Mastodon channel');
    } else {
      const [inserted] = await db
        .insert(channels)
        .values({
          userId,
          organizationId,
          platform: 'mastodon',
          accountName,
          accountId,
          accountType: 'user',
          accessToken: encrypt(tokenData.access_token),
          refreshToken: null,
          tokenExpiresAt: null,
          profileImage: accountInfo.avatar,
          metadata: { instanceUrl },
          isActive: true,
        })
        .returning({ id: channels.id });
      channelId = inserted.id;
      logActivity({
        userId,
        organizationId,
        action: 'channel.connected',
        resource: 'channel',
        resourceId: channelId,
        details: { platform: 'mastodon', accountName },
      });
      logger.info({ channelId, accountName, instanceUrl }, 'Created new Mastodon channel');
    }

    return {
      success: true,
      channelId,
      accountName,
      platform: 'mastodon',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ instanceUrl, error: message }, 'Mastodon OAuth callback failed');
    return { success: false, error: message };
  }
}
