import type { APIRoute } from 'astro';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const GET: APIRoute = async ({ locals }) => {
  const { user } = locals.auth;

  if (!user) {
    return json({ authenticated: false, user: null });
  }

  return json({
    authenticated: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
    },
  });
};
