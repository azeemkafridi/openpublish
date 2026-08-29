CREATE TABLE "rss_feed_items" (
	"feed_id" integer NOT NULL,
	"guid" varchar(500) NOT NULL,
	"post_id" integer,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "rss_feed_items_feed_id_guid_pk" PRIMARY KEY("feed_id","guid")
);
--> statement-breakpoint
CREATE TABLE "rss_feeds" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"feed_url" text NOT NULL,
	"channel_ids" jsonb NOT NULL,
	"mode" varchar(10) DEFAULT 'draft' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "rss_feed_items" ADD CONSTRAINT "rss_feed_items_feed_id_rss_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."rss_feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rss_feed_items" ADD CONSTRAINT "rss_feed_items_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rss_feeds" ADD CONSTRAINT "rss_feeds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rss_feed_items_feed_idx" ON "rss_feed_items" USING btree ("feed_id");--> statement-breakpoint
CREATE INDEX "rss_feeds_org_idx" ON "rss_feeds" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "rss_feeds_enabled_idx" ON "rss_feeds" USING btree ("enabled");