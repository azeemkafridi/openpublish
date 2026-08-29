/**
 * Unit tests for the SSRF IP guard. Locks in the hardening from the security audit:
 * IPv4-mapped IPv6 forms, CGNAT, reserved ranges, and malformed octets must all be
 * treated as private/unsafe, while genuine public addresses pass.
 */
import { describe, it, expect, vi } from 'vitest';

const mockLookup = vi.fn();
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  const mocked = { ...actual, lookup: (...args: any[]) => mockLookup(...args) };
  return { ...mocked, default: mocked };
});

import { isPrivateIP, guardedLookup, ssrfSafeFetch, ssrfSafeDispatcher } from '@lib/security/url-guard';

describe('isPrivateIP', () => {
  it('blocks IPv4 private / loopback / link-local / CGNAT / reserved ranges', () => {
    for (const ip of [
      '127.0.0.1', '10.0.0.1', '172.16.5.5', '172.31.255.255', '192.168.1.1',
      '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0',
      '192.0.0.1', '224.0.0.1', '255.255.255.255',
    ]) {
      expect(isPrivateIP(ip), ip).toBe(true);
    }
  });

  it('blocks IPv4-mapped IPv6 forms of private/metadata addresses (audit bypass)', () => {
    for (const ip of ['::ffff:169.254.169.254', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::127.0.0.1']) {
      expect(isPrivateIP(ip), ip).toBe(true);
    }
  });

  it('blocks IPv6 loopback / unspecified / unique-local / link-local', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'feba::1']) {
      expect(isPrivateIP(ip), ip).toBe(true);
    }
  });

  it('treats malformed IPv4 octets as unsafe', () => {
    expect(isPrivateIP('999.1.1.1')).toBe(true);
  });

  it('allows genuine public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '140.82.112.3', '93.184.216.34', '2606:4700:4700::1111']) {
      expect(isPrivateIP(ip), ip).toBe(false);
    }
  });
});

// The connect-time lookup used by the IP-pinned dispatcher: validating at socket
// connect closes the DNS-rebinding TOCTOU that pre-fetch validation alone leaves open.
describe('guardedLookup', () => {
  const runLookup = (records: Array<{ address: string; family: number }>) => {
    mockLookup.mockImplementation((_host: string, _opts: unknown, cb: any) => cb(null, records));
    return new Promise<{ err: any; address?: any; family?: number }>((resolve) => {
      guardedLookup('example.com', {} as any, (err, address, family) => resolve({ err, address, family }));
    });
  };

  it('passes a public address through', async () => {
    const { err, address, family } = await runLookup([{ address: '93.184.216.34', family: 4 }]);
    expect(err).toBeNull();
    expect(address).toBe('93.184.216.34');
    expect(family).toBe(4);
  });

  it('blocks a private address at connect time', async () => {
    const { err } = await runLookup([{ address: '169.254.169.254', family: 4 }]);
    expect(err?.code).toBe('ERR_SSRF_BLOCKED');
  });

  it('blocks when ANY record is private (multi-record bypass)', async () => {
    const { err } = await runLookup([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    expect(err?.code).toBe('ERR_SSRF_BLOCKED');
  });

  it('blocks an empty resolution', async () => {
    const { err } = await runLookup([]);
    expect(err?.code).toBe('ERR_SSRF_BLOCKED');
  });

  it('propagates DNS errors', async () => {
    mockLookup.mockImplementation((_h: string, _o: unknown, cb: any) => cb(new Error('ENOTFOUND')));
    const { err } = await new Promise<{ err: any }>((resolve) => {
      guardedLookup('nope.invalid', {} as any, (err) => resolve({ err }));
    });
    expect(err?.message).toBe('ENOTFOUND');
  });
});

describe('ssrfSafeFetch', () => {
  it('routes through the pinned dispatcher', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);
    try {
      await ssrfSafeFetch('https://example.com/x', { method: 'POST' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/x',
        expect.objectContaining({ method: 'POST', dispatcher: ssrfSafeDispatcher }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

export {};
