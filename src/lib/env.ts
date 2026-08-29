export const required = [
  'DATABASE_URL',
  'REDIS_URL',
  'ENCRYPTION_KEY',
  'BETTER_AUTH_SECRET',
  'BASE_URL',
] as const;

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

if (
  process.env.NODE_ENV === 'production' &&
  process.env.BASE_URL?.startsWith('http://')
) {
  console.warn(
    '[env] WARNING: BASE_URL uses HTTP in production. HTTPS is strongly recommended.',
  );
}
