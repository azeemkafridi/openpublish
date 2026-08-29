/**
 * Engine selection.
 *
 *   ENGINE=selfhost (default) — channels, publishing, media and analytics run
 *   locally against the operator's own platform apps and workers.
 *
 *   ENGINE=cloud — the same UI drives the BulkPublish cloud API instead: the
 *   middleware transparently proxies the publishing API surface (posts,
 *   channels, media, schedules, labels, analytics, …) to BULKPUBLISH_API_URL,
 *   authenticated with the operator's BULKPUBLISH_API_KEY. No platform app
 *   registration or local workers needed. Channel connections are made in the
 *   cloud dashboard (OAuth must run on the cloud origin).
 *
 * Auth, users and the local workspace always stay local.
 */

export type EngineMode = 'selfhost' | 'cloud';

export function engineMode(): EngineMode {
  return process.env.ENGINE === 'cloud' ? 'cloud' : 'selfhost';
}

export function cloudApiUrl(): string {
  return (process.env.BULKPUBLISH_API_URL || 'https://app.bulkpublish.com').replace(/\/$/, '');
}

export function cloudApiKey(): string | undefined {
  return process.env.BULKPUBLISH_API_KEY;
}

/**
 * The API prefixes served by the cloud in cloud mode. Everything else —
 * auth, api-keys (local instance keys), push tokens, events — stays local.
 */
const CLOUD_PROXY_PREFIXES = [
  '/api/posts',
  '/api/channels',
  '/api/channel-sets',
  '/api/media',
  '/api/schedules',
  '/api/labels',
  '/api/rss-feeds',
  '/api/analytics',
  '/api/platforms',
  '/api/activity',
];

// Never proxied even in cloud mode: local-storage upload target.
const CLOUD_PROXY_EXCLUDES = ['/api/media/local-put'];

export function isCloudProxiedPath(pathname: string): boolean {
  if (engineMode() !== 'cloud') return false;
  if (CLOUD_PROXY_EXCLUDES.some((p) => pathname === p)) return false;
  return CLOUD_PROXY_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

/**
 * Forward one request to the cloud API with the operator's key. Bodies stream
 * through untouched; hop-by-hop and cookie headers are dropped.
 */
export async function proxyToCloud(request: Request, pathname: string, search: string): Promise<Response> {
  const key = cloudApiKey();
  if (!key) {
    return new Response(
      JSON.stringify({
        error: {
          message: 'ENGINE=cloud requires BULKPUBLISH_API_KEY. Create one at ' + cloudApiUrl() + '/developer.',
          code: 'CLOUD_NOT_CONFIGURED',
        },
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const target = `${cloudApiUrl()}${pathname}${search}`;
  const headers = new Headers();
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('Content-Type', contentType);
  headers.set('Authorization', `Bearer ${key}`);
  headers.set('User-Agent', 'openPublish-cloud-engine/0.1');

  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    init.duplex = 'half';
  }

  const upstream = await fetch(target, init);

  const outHeaders = new Headers();
  const upstreamType = upstream.headers.get('content-type');
  if (upstreamType) outHeaders.set('Content-Type', upstreamType);
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}
