ALTER TABLE "posts" ADD COLUMN "auto_plug_enabled" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "auto_plug_text" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "auto_plug_threshold" integer DEFAULT 50;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "auto_plug_fired" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "auto_repost_enabled" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "auto_repost_threshold" integer DEFAULT 100;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "auto_repost_fired" boolean DEFAULT false;