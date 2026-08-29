/**
 * The client-IP derivation behind Traefik.
 *
 * Regression target: every IP-keyed limiter (auth, oauth token/revoke/authorize)
 * used to read the LEFTMOST `X-Forwarded-For` entry. Traefik APPENDS the real
 * peer address to whatever the caller sent, so the leftmost value is caller-
 * controlled — the limiters were bypassable by varying one header, with no proxy
 * and no new address. These tests pin the rightmost-entry behaviour.
 */
import { describe, it, expect } from 'vitest';
import { getClientIp, UNKNOWN_IP } from '@lib/http/client-ip';

const h = (forwarded?: string) =>
  new Headers(forwarded === undefined ? {} : { 'x-forwarded-for': forwarded });

describe('getClientIp', () => {
  describe('spoofing', () => {
    it('ignores a caller-supplied entry to the left of Traefik’s', () => {
      // What an attacker sends:      X-Forwarded-For: 1.2.3.4
      // What Traefik forwards on:    X-Forwarded-For: 1.2.3.4, 203.0.113.7
      expect(getClientIp(h('1.2.3.4, 203.0.113.7'))).toBe('203.0.113.7');
    });

    it('ignores an entire forged chain', () => {
      expect(getClientIp(h('9.9.9.9, 8.8.8.8, 7.7.7.7, 203.0.113.7'))).toBe('203.0.113.7');
    });

    it('does not let prose in the header become the rate-limit key', () => {
      expect(getClientIp(h('not-an-ip'), '198.51.100.2')).toBe('198.51.100.2');
    });

    it('varying the spoofed prefix does not vary the key', () => {
      const a = getClientIp(h('10.0.0.1, 203.0.113.7'));
      const b = getClientIp(h('10.0.0.2, 203.0.113.7'));
      expect(a).toBe(b);
    });
  });

  describe('normal traffic', () => {
    it('uses the only entry when the caller sent no header of its own', () => {
      expect(getClientIp(h('203.0.113.7'))).toBe('203.0.113.7');
    });

    it('tolerates the spacing variations proxies emit', () => {
      expect(getClientIp(h('  1.2.3.4 ,   203.0.113.7  '))).toBe('203.0.113.7');
    });

    it('keeps IPv6 addresses intact', () => {
      expect(getClientIp(h('2001:db8::1, 2001:db8::dead:beef'))).toBe('2001:db8::dead:beef');
    });

    it('unwraps a bracketed IPv6 address with a port', () => {
      expect(getClientIp(h('[2001:db8::1]:443'))).toBe('2001:db8::1');
    });

    it('strips an IPv4 port without eating the address', () => {
      expect(getClientIp(h('203.0.113.7:51234'))).toBe('203.0.113.7');
    });

    it('unwraps the ::ffff: form Node reports on a dual-stack socket', () => {
      expect(getClientIp(h(), '::ffff:203.0.113.7')).toBe('203.0.113.7');
    });
  });

  describe('fallbacks', () => {
    it('falls back to the socket peer when the header is absent', () => {
      expect(getClientIp(h(), '198.51.100.2')).toBe('198.51.100.2');
    });

    it('returns the placeholder when nothing usable is available', () => {
      expect(getClientIp(h())).toBe(UNKNOWN_IP);
      expect(getClientIp(h(''), null)).toBe(UNKNOWN_IP);
      expect(getClientIp(h(', ,'), undefined)).toBe(UNKNOWN_IP);
    });

    it('rejects an out-of-range IPv4 octet rather than keying on it', () => {
      expect(getClientIp(h('999.1.1.1'))).toBe(UNKNOWN_IP);
    });

    it('rejects a zero-padded octet (ambiguous, and never emitted by Traefik)', () => {
      expect(getClientIp(h('010.1.1.1'))).toBe(UNKNOWN_IP);
    });

    it('rejects an over-long value outright', () => {
      expect(getClientIp(h('1'.repeat(200)))).toBe(UNKNOWN_IP);
    });
  });
});
