import type { APIRoute } from 'astro';
import { fetchLinkPreview, LinkPreviewError } from '@lib/link-preview';

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export const GET: APIRoute = async ({ locals, url }) => {
  const { user } = locals.auth;
  if (!user) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return json({ error: 'Missing url parameter' }, 400);
  }

  try {
    const preview = await fetchLinkPreview(targetUrl);
    return json(preview, 200, { 'Cache-Control': 'private, max-age=3600' });
  } catch (err) {
    if (err instanceof LinkPreviewError) return json({ error: err.message }, err.status);
    return json({ error: 'Failed to fetch URL' }, 502);
  }
};
