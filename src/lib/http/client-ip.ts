/**
 * Client IP derivation for rate-limit keying and request logs.
 *
 * The deployment is client -> Traefik -> Express/Astro: exactly one trusted hop.
 * (your instance is DNS-only on Cloudflare, not proxied — responses carry
 * no `cf-ray` — so there is no CDN in front of Traefik.)
 *
 * Traefik APPENDS the TCP peer address to whatever `X-Forwarded-For` the client
 * sent, so the header arrives as:
 *
 *     X-Forwarded-For: <whatever the caller wrote>, <real client IP>
 *
 * Every call site here used to read `split(',')[0]` — the LEFTMOST entry — which
 * is precisely the part the caller controls. Any limiter keyed on it was
 * bypassable by varying one request header: no proxy, no VPN, no new IP. The
 * RIGHTMOST entry is the one Traefik itself wrote, and is the only value in this
 * header we have any reason to trust.
 *
 * If a proxy is ever added IN FRONT of Traefik (e.g. turning on Cloudflare's
 * orange cloud), each extra hop appends one more entry and the trustworthy value
 * moves one position left — set `TRUSTED_PROXY_HOPS` to the number of proxies we
 * control. Getting this wrong is a real outage shape: too high and callers can
 * spoof again, too low and every user collapses into one bucket keyed on the
 * proxy's own address.
 */

/** Number of proxies we control between the public internet and this process. */
const TRUSTED_PROXY_HOPS = Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS || '1') || 1);

/** Value used when no usable address can be derived (also the log placeholder). */
export const UNKNOWN_IP = '-';

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Deliberately a shape check, not a parser. The value only ever becomes a Redis
 * key suffix and a log field, so the job is to reject attacker prose, not to
 * validate every RFC 4291 form.
 */
function isIpish(value: string): boolean {
  if (!value || value.length > 45) return false;
  const v4 = IPV4_RE.exec(value);
  if (v4) return v4.slice(1).every((o) => Number(o) <= 255 && String(Number(o)) === o);
  return value.includes(':') && /^[0-9a-f:.]+$/i.test(value);
}

/**
 * Strip the decorations an address can pick up in transit: a `[::1]:443` style
 * bracketed port, an IPv4 `1.2.3.4:5678` port, and the `::ffff:` prefix Node
 * puts on IPv4 connections to a dual-stack socket.
 */
function normalize(raw: string): string {
  let value = raw.trim();
  if (!value) return '';

  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) value = bracketed[1];
  // Only strip a trailing :port for IPv4 — in IPv6 the colons are the address.
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(value)) value = value.split(':')[0];

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) value = mapped[1];

  return value;
}

/**
 * The address of the caller, as best we can establish it.
 *
 * @param headers  Request headers (needs `x-forwarded-for`).
 * @param fallback Astro's `clientAddress` — the socket peer, so behind Traefik
 *                 it is Traefik's own container address. Not useful for keying,
 *                 but it is never attacker-controlled, which is why it is the
 *                 fallback rather than the leftmost header entry.
 */
export function getClientIp(headers: Headers, fallback?: string | null): string {
  const forwarded = headers.get('x-forwarded-for');

  if (forwarded) {
    const entries = forwarded
      .split(',')
      .map(normalize)
      .filter(Boolean);
    // Count in from the right: the last entry is this process's peer (Traefik),
    // and each additional trusted hop shifts the real client one place left.
    const candidate = entries[entries.length - TRUSTED_PROXY_HOPS];
    if (candidate && isIpish(candidate)) return candidate;
  }

  const direct = normalize(fallback || '');
  return direct && isIpish(direct) ? direct : UNKNOWN_IP;
}
