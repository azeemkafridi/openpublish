ALTER TYPE "public"."platform_name" ADD VALUE IF NOT EXISTS 'mastodon';--> statement-breakpoint
CREATE TABLE "account_metrics" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"platform" varchar(32) NOT NULL,
	"date" date NOT NULL,
	"followers" integer DEFAULT 0,
	"following" integer DEFAULT 0,
	"impressions" integer DEFAULT 0,
	"reach" integer DEFAULT 0,
	"profile_views" integer DEFAULT 0,
	"website_clicks" integer DEFAULT 0,
	"engagement_rate" integer DEFAULT 0,
	"platform_specific" jsonb DEFAULT '{}'::jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_labels" (
	"media_file_id" integer NOT NULL,
	"label_id" integer NOT NULL,
	CONSTRAINT "media_labels_media_file_id_label_id_pk" PRIMARY KEY("media_file_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "post_metrics" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"post_platform_id" integer NOT NULL,
	"post_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"platform" "platform_name" NOT NULL,
	"impressions" integer DEFAULT 0,
	"reach" integer DEFAULT 0,
	"likes" integer DEFAULT 0,
	"comments" integer DEFAULT 0,
	"shares" integer DEFAULT 0,
	"saves" integer DEFAULT 0,
	"clicks" integer DEFAULT 0,
	"video_views" integer DEFAULT 0,
	"engagement_rate" integer DEFAULT 0,
	"platform_specific_metrics" jsonb DEFAULT '{}'::jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "labels_unique";--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "type" varchar(10) DEFAULT 'post' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "subscription_status" varchar(20);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "subscription_current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "subscription_cancel_at_period_end" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "post_platforms" ADD COLUMN "thread_post_ids" jsonb DEFAULT 'null'::jsonb;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "platform_content" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "thread_parts" jsonb DEFAULT 'null'::jsonb;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "platform_thread_parts" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "recurring_schedules" ADD COLUMN "post_format" varchar(50) DEFAULT 'post';--> statement-breakpoint
ALTER TABLE "recurring_schedules" ADD COLUMN "thread_parts" jsonb DEFAULT 'null'::jsonb;--> statement-breakpoint
ALTER TABLE "account_metrics" ADD CONSTRAINT "account_metrics_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_metrics" ADD CONSTRAINT "account_metrics_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_labels" ADD CONSTRAINT "media_labels_media_file_id_media_files_id_fk" FOREIGN KEY ("media_file_id") REFERENCES "public"."media_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_labels" ADD CONSTRAINT "media_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_post_platform_id_post_platforms_id_fk" FOREIGN KEY ("post_platform_id") REFERENCES "public"."post_platforms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_metrics_channel_idx" ON "account_metrics" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "account_metrics_org_idx" ON "account_metrics" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "account_metrics_date_idx" ON "account_metrics" USING btree ("date");--> statement-breakpoint
CREATE INDEX "account_metrics_platform_idx" ON "account_metrics" USING btree ("platform");--> statement-breakpoint
CREATE UNIQUE INDEX "account_metrics_channel_date_uniq" ON "account_metrics" USING btree ("channel_id","date");--> statement-breakpoint
CREATE INDEX "media_labels_label_idx" ON "media_labels" USING btree ("label_id");--> statement-breakpoint
CREATE INDEX "media_labels_media_idx" ON "media_labels" USING btree ("media_file_id");--> statement-breakpoint
CREATE INDEX "post_metrics_post_platform_idx" ON "post_metrics" USING btree ("post_platform_id");--> statement-breakpoint
CREATE INDEX "post_metrics_post_idx" ON "post_metrics" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "post_metrics_org_idx" ON "post_metrics" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "post_metrics_fetched_idx" ON "post_metrics" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "post_metrics_platform_idx" ON "post_metrics" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "labels_type_idx" ON "labels" USING btree ("type");--> statement-breakpoint
CREATE INDEX "media_created_idx" ON "media_files" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "posts_created_idx" ON "posts" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "labels_unique" ON "labels" USING btree ("organization_id","name","type");