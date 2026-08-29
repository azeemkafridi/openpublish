ALTER TABLE "notification_preferences" ALTER COLUMN "email_on_failure" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "notification_preferences" ALTER COLUMN "email_on_token_expiry" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "needs_reconnect" boolean DEFAULT false;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "post_metrics_pp_fetched_idx" ON "post_metrics" USING btree ("post_platform_id","fetched_at" DESC NULLS LAST);