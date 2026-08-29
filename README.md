# openPublish

Open-source social media publishing and scheduling. Compose once, publish to
16 platforms, schedule with a calendar and queue, and track basic analytics —
on your own server.

- **Platforms**: X, Bluesky, Mastodon, LinkedIn (profiles + company pages),
  Facebook, Instagram, Threads, TikTok, YouTube, Pinterest, Google Business,
  Reddit, Discord, Telegram, Tumblr, Snapchat
- **Composer** with per-platform overrides, threads, media, post types
- **Scheduling**: calendar, queue slots, repeat posts, RSS autopost, CSV bulk import
- **Analytics**: post + account metrics synced from each platform
- **Media library**: local-disk storage by default, any S3-compatible store optionally
- **REST API** with API-key auth for scripts and agents
- **No quotas, no plans, no telemetry** — it's your server

## Quick start (Docker)

```bash
git clone <this repo> && cd openpublish
cp .env.example .env
# set BETTER_AUTH_SECRET and ENCRYPTION_KEY (openssl rand -hex 32 each)
docker compose up -d
```

Open http://localhost:4321, register the first account, and connect channels.
Each platform you want in **self-host mode** needs its own developer app —
uncomment its block in `.env` and fill in the credentials. Platforms without
credentials are hidden from the Connect page automatically. Bluesky, Mastodon
and Telegram need no app registration at all — good first channels to try.

### Cloud mode

Don't want to register 14 developer apps and sit through platform audits
(TikTok, YouTube and Meta review self-hosted apps individually)? Set:

```
ENGINE=cloud
BULKPUBLISH_API_KEY=bp_...
```

and openPublish delegates channel connections and publishing to the
[BulkPublish](https://www.bulkpublish.com) cloud API — same UI, no platform
app setup. Self-host and cloud modes can be switched at any time.

## Development

```bash
npm install --legacy-peer-deps
cp .env.example .env   # fill in CORE section
docker compose up -d postgres redis
npm run dev:local      # web on :4321 (runs migrations first)
npm run worker:local   # background workers, second terminal
```

- `npm test` — unit tests (Vitest)
- `npm run db:generate` — regenerate Drizzle migrations after editing
  `src/lib/db/schema.ts` (commit the migration with the schema change)

## Architecture

Astro 5 SSR + React islands, PostgreSQL via Drizzle ORM, BullMQ on Redis for
the publish/metrics/token-refresh workers, better-auth for sessions. One
Docker image runs as `APP_MODE=web`, `worker`, or `all`.

## License

AGPL-3.0 — see [LICENSE](LICENSE).
