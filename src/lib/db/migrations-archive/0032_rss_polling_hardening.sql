ALTER TABLE "rss_feeds" ADD COLUMN "last_success_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rss_feeds" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rss_feeds" ADD COLUMN "next_poll_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rss_feeds" ADD COLUMN "etag" text;--> statement-breakpoint
ALTER TABLE "rss_feeds" ADD COLUMN "last_modified" text;--> statement-breakpoint
-- Existing feeds were already baselined under the old lastCheckedAt sentinel;
-- carry that over so they don't re-baseline (and silently swallow) a cycle.
UPDATE "rss_feeds" SET "last_success_at" = "last_checked_at" WHERE "last_checked_at" IS NOT NULL;
