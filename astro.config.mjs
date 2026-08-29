// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import react from '@astrojs/react';

export default defineConfig({
  site: process.env.BASE_URL || 'http://localhost:4321',
  output: 'server',
  // Middleware mode lets us wrap Astro's request handler in an Express server
  // (see webapp/server.mjs) that adds gzip/brotli compression. Astro's
  // standalone Node server doesn't compress responses, which made every JS
  // chunk and JSON response ship at full size.
  adapter: node({ mode: 'middleware' }),
  build: {
    // Astro's default is `_astro`, and the marketing site — a separate Astro
    // app — emits its own `/_astro/*` chunks. That is fine while the two live
    // on different hosts, but www.bulkpublish.com/tools is served by proxying
    // this app in behind the marketing host: the HTML comes from here while
    // every root-relative subresource is resolved against marketing's nginx,
    // which answers `try_files ... =404`. Identical directory names meant the
    // tool pages would load with no CSS and no hydrated React at all.
    //
    // Renaming this app's asset directory makes the two sets addressable
    // apart, so Traefik can route `/_app` here and leave `/_astro` with
    // marketing. Keep in sync with the express.static mount in server.mjs.
    assets: '_app',
  },
  integrations: [react()],
  server: { port: 4321, host: true },
  security: {
    checkOrigin: false, // Disabled — our middleware handles auth on every route. checkOrigin was blocking multipart file uploads (CSRF treated FormData as form submission).
  },
  vite: {
    optimizeDeps: {
      exclude: ['react/jsx-dev-runtime', 'react/jsx-runtime'],
    },
    server: {
      allowedHosts: ['.ngrok-free.dev'],
    },
    ssr: {
      // Keep better-auth (and its plugins/SDK) OUT of the SSR bundle. When Vite
      // minifies better-auth into dist/server, its internal router stops matching
      // any route and every /api/auth/* request 404s — silently breaking all
      // login/session endpoints. Loaded from node_modules at runtime it works
      // correctly, so force it external. Do not remove without verifying
      // /api/auth/ok returns 200 in the built image.
      external: ['better-auth'],
    },
  },
});