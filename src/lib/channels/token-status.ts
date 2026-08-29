/**
 * Shared token-status computation for channel API responses.
 *
 * The stored tokenExpiresAt is the ACCESS token expiry, which for many platforms
 * is minutes-to-hours (Google: 1h) even though the connection itself never expires —
 * the refresh token (or long-lived-token self-refresh) renews it indefinitely via the
 * 40-minute token-refresh sweep. Counting down that timestamp in the UI made every
 * healthy YouTube/GMB/LinkedIn/TikTok channel read "expiring soon" forever.
 *
 * Rule: a channel that holds a refresh credential auto-renews and is 'valid' no matter
 * how close the access-token expiry is. It only reads 'expired' when renewal is proven
 * broken — needsReconnect was flagged, or the access token has been dead for over a day
 * (the sweep runs every 40 minutes, so >24h stale means refreshes are failing).
 * Countdown semantics apply only to channels with a real hard expiry and no way to
 * renew (e.g. LinkedIn before refresh-token approval).
 */

export type TokenStatus = 'valid' | 'expiring_soon' | 'expired';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface TokenStatusInput {
  needsReconnect?: boolean | null;
  refreshToken?: string | null;
  tokenExpiresAt?: Date | string | null;
}

export function computeTokenStatus(ch: TokenStatusInput): {
  tokenStatus: TokenStatus;
  autoRenews: boolean;
} {
  const autoRenews = !!ch.refreshToken;

  // A platform-side revocation (set by a publish failure, a failed refresh, or the
  // token-validation sweep) trumps everything — long-lived tokens (e.g. Facebook page
  // tokens with tokenExpiresAt null) can be dead while "unexpired".
  if (ch.needsReconnect) return { tokenStatus: 'expired', autoRenews };

  const expiresAtMs = ch.tokenExpiresAt ? new Date(ch.tokenExpiresAt).getTime() : null;

  if (autoRenews) {
    return {
      tokenStatus:
        expiresAtMs !== null && expiresAtMs < Date.now() - ONE_DAY_MS ? 'expired' : 'valid',
      autoRenews,
    };
  }

  if (expiresAtMs !== null) {
    if (expiresAtMs <= Date.now()) return { tokenStatus: 'expired', autoRenews };
    if (expiresAtMs - Date.now() < 7 * ONE_DAY_MS) {
      return { tokenStatus: 'expiring_soon', autoRenews };
    }
  }

  return { tokenStatus: 'valid', autoRenews };
}
