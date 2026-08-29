# ── Stage 1: Install ALL dependencies (for build) ────────────
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --legacy-peer-deps && npm rebuild sharp esbuild

# ── Stage 2: Build Astro SSR bundle ──────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

# ── Stage 3: Production dependencies only ────────────────────
FROM node:22-alpine AS prod-deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --legacy-peer-deps
RUN npm rebuild sharp

# ── Stage 4: Production image ────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

# ffmpeg/ffprobe power video poster extraction + metadata probing in the media
# worker (lib/media/ffmpeg.ts). Installed via apk rather than an npm wrapper
# because `npm ci --ignore-scripts` above would skip a postinstall download.
RUN apk add --no-cache tini ffmpeg

# Non-root user
RUN addgroup -S app && adduser -S app -G app

# Copy production deps only
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/server.mjs ./server.mjs

# Copy worker source (tsx runs these at runtime)
COPY --from=builder /app/workers ./workers
COPY --from=builder /app/src ./src

# Copy migration files, drizzle config, and tsconfig (needed by tsx for path aliases).
# The migration .sql files and meta/_journal.json live under src/lib/db/migrations,
# already copied with ./src above.
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# The entrypoint runs scripts/db-migrate.mjs before starting web or worker.
COPY --from=builder /app/scripts ./scripts

# Copy entrypoint
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Create dirs and set ownership (uploads holds local-disk media storage)
RUN mkdir -p /app/uploads && chown -R app:app /app

USER app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321

EXPOSE 4321

ENTRYPOINT ["tini", "--"]
CMD ["/docker-entrypoint.sh"]
