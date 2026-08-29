import { describe, it, expect } from 'vitest';
import { computeTokenStatus } from '@/lib/channels/token-status';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('computeTokenStatus', () => {
  it('needsReconnect always reports expired, even with a refresh token', () => {
    const r = computeTokenStatus({
      needsReconnect: true,
      refreshToken: 'enc',
      tokenExpiresAt: new Date(Date.now() + 30 * DAY),
    });
    expect(r.tokenStatus).toBe('expired');
    expect(r.autoRenews).toBe(true);
  });

  it('auto-renewing channel with access token expiring in 1 hour is valid (the YouTube case)', () => {
    const r = computeTokenStatus({
      refreshToken: 'enc',
      tokenExpiresAt: new Date(Date.now() + HOUR),
    });
    expect(r).toEqual({ tokenStatus: 'valid', autoRenews: true });
  });

  it('auto-renewing channel with a recently lapsed access token is still valid (sweep will renew)', () => {
    const r = computeTokenStatus({
      refreshToken: 'enc',
      tokenExpiresAt: new Date(Date.now() - 2 * HOUR),
    });
    expect(r.tokenStatus).toBe('valid');
  });

  it('auto-renewing channel whose token has been dead >24h reports expired (refreshes are failing)', () => {
    const r = computeTokenStatus({
      refreshToken: 'enc',
      tokenExpiresAt: new Date(Date.now() - 2 * DAY),
    });
    expect(r.tokenStatus).toBe('expired');
  });

  it('non-renewing channel counts down: expiring_soon under 7 days', () => {
    const r = computeTokenStatus({
      refreshToken: null,
      tokenExpiresAt: new Date(Date.now() + 3 * DAY),
    });
    expect(r).toEqual({ tokenStatus: 'expiring_soon', autoRenews: false });
  });

  it('non-renewing channel past expiry is expired', () => {
    const r = computeTokenStatus({
      refreshToken: null,
      tokenExpiresAt: new Date(Date.now() - HOUR),
    });
    expect(r.tokenStatus).toBe('expired');
  });

  it('non-renewing channel with a far expiry is valid', () => {
    const r = computeTokenStatus({
      refreshToken: null,
      tokenExpiresAt: new Date(Date.now() + 60 * DAY),
    });
    expect(r.tokenStatus).toBe('valid');
  });

  it('no expiry and no refresh token (static tokens, e.g. Facebook page/Telegram bot) is valid', () => {
    const r = computeTokenStatus({ refreshToken: null, tokenExpiresAt: null });
    expect(r).toEqual({ tokenStatus: 'valid', autoRenews: false });
  });

  it('accepts ISO-string expiry dates', () => {
    const r = computeTokenStatus({
      refreshToken: null,
      tokenExpiresAt: new Date(Date.now() + DAY).toISOString(),
    });
    expect(r.tokenStatus).toBe('expiring_soon');
  });
});

export {};
