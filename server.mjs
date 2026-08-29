// Production HTTP entry point. The Astro Node adapter is configured in
// `mode: 'middleware'` so it exports a Node-style request handler instead of
// running its own server — that lets us put `compression` in front of every
// response (SSR pages, /_app JS bundles, /api JSON), which the standalone
// adapter cannot do.
import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handler as ssrHandler } from './dist/server/entry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(__dirname, 'dist', 'client');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true);

// Compress everything by default. The middleware checks Accept-Encoding and
// skips already-compressed payloads (images, video, fonts).
app.use(compression());

// Hashed Astro assets get a one-year immutable cache. Anything else served
// from the static dir falls back to the default short cache.
//
// `_app`, not Astro's default `_astro` — see `build.assets` in
// astro.config.mjs. The two must match or the app serves 404s for its own
// chunks. (express.static(clientDir) below would still find them, but without
// the immutable cache headers, so a mismatch degrades silently rather than
// failing loudly.)
app.use(
  '/_app',
  express.static(path.join(clientDir, '_app'), {
    immutable: true,
    maxAge: '1y',
  }),
);
app.use(express.static(clientDir));

// Astro's SSR middleware handles everything else (pages + /api/*).
app.use(ssrHandler);

const port = Number(process.env.PORT || 4321);
const host = process.env.HOST || '0.0.0.0';
app.listen(port, host, () => {
  console.log(`[server] listening on ${host}:${port}`);
});
