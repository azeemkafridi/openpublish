ALTER TABLE "collected_items" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "collected_items" ADD COLUMN "favicon" varchar(2048);--> statement-breakpoint
ALTER TABLE "collected_items" ADD COLUMN "content_markdown" text;