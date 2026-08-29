import { promises as dns, lookup as dnsLookupCb } from 'node:dns';
import { Agent } from 'undici';

/**
 * SSRF guards for server-side fetches of user-supplied URLs (link previews, remote
 * media import, Mastodon instance connect, webhooks). Two layers:
 *
 *  1. Pre-fetch validation (validateHostname): resolve the hostname and reject
 *     private/internal/reserved addresses BEFORE fetching, re-validating on every
 *     redirect hop. Hardened against IPv4-mapped-IPv6 and multi-record
 *     (one-public/one-private) bypasses.
 *  2. Connect-time IP pinning (ssrfSafeDispatcher): an undici Agent whose DNS
 *     lookup re-validates every resolved address at the moment the socket
 *     connects — closing the DNS-rebinding TOCTOU where a low-TTL attacker
 *     swaps the record to a private IP between validation and fetch.
 *
 * Use BOTH: validate first (cheap, friendly error), then fetch through the
 * pinned dispatcher.
 */

/** True if the IP is in a private, loopback, link-local, CGNAT or reserved range. */
export function isPrivateIP(ip: string): boolean {
  let addr = ip.trim().toLowerCase();

  // Normalize IPv4-mapped / IPv4-compatible IPv6 (::ffff:1.2.3.4, ::1.2.3.4) → dotted IPv4.
  const mapped = addr.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) addr = mapped[1];

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(addr)) {
    const o = addr.split('.').map(Number);
    if (o.some((n) => Number.isNaN(n) || n > 255)) return true; // malformed → treat as unsafe
    const [a, b, c] = o;
    if (a === 0 || a === 127) return true;             // "this network" / loopback
    if (a === 10) return true;                         // private
    if (a === 172 && b >= 16 && b <= 31) return true;  // private
    if (a === 192 && b === 168) return true;           // private
    if (a === 169 && b === 254) return true;           // link-local (cloud metadata)
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a === 192 && b === 0 && c === 0) return true;  // 192.0.0.0/24 (protocol assignments)
    if (a >= 224) return true;                         // multicast / reserved (224.0.0.0+)
    return false;
  }

  // IPv6
  if (addr === '::' || addr === '::1') return true; // unspecified / loopback
  if (/^fe[89ab]/.test(addr)) return true;          // link-local fe80::/10
  if (/^f[cd]/.test(addr)) return true;             // unique-local fc00::/7
  return false;
}

/** Resolve a hostname and confirm NONE of its addresses are private/internal. */
export async function validateHostname(hostname: string): Promise<boolean> {
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    if (addresses.length === 0) return false;
    return addresses.every((a) => !isPrivateIP(a.address));
  } catch {
    return false;
  }
}

/**
 * DNS lookup used by the pinned dispatcher: resolves ALL records and fails the
 * connection if ANY is private/internal. Because this runs inside the socket
 * connect, the address that passed the check here is the address the socket
 * actually dials — a rebinding attacker has no window to swap it.
 */
export function guardedLookup(
  hostname: string,
  options: Parameters<typeof dnsLookupCb>[1],
  callback: (err: NodeJS.ErrnoException | null, address?: any, family?: number) => void,
): void {
  dnsLookupCb(hostname, { ...(options as object), all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = addresses as Array<{ address: string; family: number }>;
    if (list.length === 0 || list.some((a) => isPrivateIP(a.address))) {
      const blocked: NodeJS.ErrnoException = new Error(
        `Blocked by SSRF guard: ${hostname} resolves to a private or reserved address`,
      );
      blocked.code = 'ERR_SSRF_BLOCKED';
      return callback(blocked);
    }
    if ((options as { all?: boolean } | undefined)?.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

/** Shared undici Agent that pins DNS validation to socket connect time. */
export const ssrfSafeDispatcher = new Agent({ connect: { lookup: guardedLookup as any } });

/**
 * fetch() for user-supplied URLs, routed through the IP-pinned dispatcher.
 * Callers should still run their protocol/hostname pre-checks for friendly
 * errors; this is the enforcement layer underneath.
 */
export function ssrfSafeFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, dispatcher: ssrfSafeDispatcher } as RequestInit);
}
