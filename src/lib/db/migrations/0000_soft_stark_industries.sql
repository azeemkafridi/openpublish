CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('post_published', 'post_failed', 'post_scheduled_reminder', 'token_expiring', 'token_expired', 'daily_digest', 'system');--> statement-breakpoint
CREATE TYPE "public"."org_member_role" AS ENUM('owner', 'admin', 'member', 'approver', 'contributor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."platform_name" AS ENUM('facebook', 'instagram', 'x', 'tiktok', 'youtube', 'threads', 'bluesky', 'pinterest', 'gmb', 'linkedin', 'mastodon', 'reddit', 'discord', 'telegram', 'tumblr', 'snapchat');--> statement-breakpoint
CREATE TYPE "public"."platform_status" AS ENUM('pending', 'publishing', 'published', 'failed', 'processing', 'unconfirmed');--> statement-breakpoint
CREATE TYPE "public"."post_approval_status" AS ENUM('none', 'pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."post_status" AS ENUM('draft', 'scheduled', 'publishing', 'published', 'partial', 'failed', 'processing');--> statement-breakpoint
CREATE TYPE "public"."user_plan" AS ENUM('free', 'pro', 'business');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "activity_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text,
	"organization_id" integer,
	"action" varchar(100) NOT NULL,
	"resource" varchar(100),
	"resource_id" varchar(255),
	"details" jsonb,
	"level" varchar(20) DEFAULT 'info',
	"ip_address" varchar(45),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"key_hash" varchar(255) NOT NULL,
	"key_prefix" varchar(10) NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "api_usage_daily" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"date" varchar(10) NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "channel_sets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"channel_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" integer NOT NULL,
	"platform" "platform_name" NOT NULL,
	"account_name" varchar(255) NOT NULL,
	"account_id" varchar(255) NOT NULL,
	"account_type" varchar(50) DEFAULT 'unknown',
	"access_token" text,
	"refresh_token" text,
	"token_expires_at" timestamp with time zone,
	"profile_image" text,
	"is_active" boolean DEFAULT true,
	"needs_reconnect" boolean DEFAULT false,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"color" varchar(7) DEFAULT '#6366f1',
	"type" varchar(10) DEFAULT 'post' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "media_files" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" integer NOT NULL,
	"original_path" varchar(500) NOT NULL,
	"thumbnail_path" varchar(500),
	"preview_path" varchar(500),
	"large_path" varchar(500),
	"file_name" varchar(255) NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"size_bytes" integer NOT NULL,
	"width" integer,
	"height" integer,
	"duration" integer,
	"is_original_deleted" boolean DEFAULT false,
	"variants" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "media_labels" (
	"media_file_id" integer NOT NULL,
	"label_id" integer NOT NULL,
	CONSTRAINT "media_labels_media_file_id_label_id_pk" PRIMARY KEY("media_file_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"email_on_failure" boolean DEFAULT false,
	"email_on_token_expiry" boolean DEFAULT false,
	"in_app_published" boolean DEFAULT true,
	"in_app_failed" boolean DEFAULT true,
	"in_app_schedule_reminder" boolean DEFAULT true,
	"in_app_token_expiry" boolean DEFAULT true,
	CONSTRAINT "notification_preferences_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" integer,
	"type" "notification_type" NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"is_read" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"role" "org_member_role" DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"owner_id" text NOT NULL,
	"plan" "user_plan" DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "post_labels" (
	"post_id" integer NOT NULL,
	"label_id" integer NOT NULL,
	CONSTRAINT "post_labels_post_id_label_id_pk" PRIMARY KEY("post_id","label_id")
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
CREATE TABLE "post_platforms" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"post_id" integer NOT NULL,
	"channel_id" integer NOT NULL,
	"platform" "platform_name" NOT NULL,
	"status" "platform_status" DEFAULT 'pending',
	"platform_post_id" varchar(500),
	"platform_url" varchar(500),
	"thread_post_ids" jsonb DEFAULT 'null'::jsonb,
	"error_message" text,
	"retry_count" integer DEFAULT 0,
	"max_retries" integer DEFAULT 3,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" integer NOT NULL,
	"content" text DEFAULT '',
	"platform_content" jsonb DEFAULT '{}'::jsonb,
	"media_files" jsonb DEFAULT '[]'::jsonb,
	"status" "post_status" DEFAULT 'draft',
	"scheduled_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"timezone" varchar(100) DEFAULT 'UTC',
	"post_format" varchar(50) DEFAULT 'post',
	"post_type_overrides" jsonb DEFAULT '{}'::jsonb,
	"platform_specific" jsonb DEFAULT '{}'::jsonb,
	"thread_parts" jsonb DEFAULT 'null'::jsonb,
	"platform_thread_parts" jsonb DEFAULT '{}'::jsonb,
	"delete_media_after_publish" boolean DEFAULT false,
	"auto_plug_enabled" boolean DEFAULT false,
	"auto_plug_text" text,
	"auto_plug_threshold" integer DEFAULT 50,
	"auto_plug_fired" boolean DEFAULT false,
	"link_tracking_override" boolean,
	"auto_repost_enabled" boolean DEFAULT false,
	"auto_repost_threshold" integer DEFAULT 100,
	"auto_repost_fired" boolean DEFAULT false,
	"approval_status" "post_approval_status" DEFAULT 'none' NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" integer,
	"token" varchar(255) NOT NULL,
	"platform" varchar(10) NOT NULL,
	"device_name" varchar(255),
	"created_at" timestamp with time zone DEFAULT now(),
	"last_seen_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "push_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"plan" "user_plan" DEFAULT 'free' NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "x_api_usage_daily" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"date" varchar(10) NOT NULL,
	"action_type" varchar(50) NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL,
	"cost_dcents" integer DEFAULT 0 NOT NULL,
	"billed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_metrics" ADD CONSTRAINT "account_metrics_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_metrics" ADD CONSTRAINT "account_metrics_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_usage_daily" ADD CONSTRAINT "api_usage_daily_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_sets" ADD CONSTRAINT "channel_sets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_labels" ADD CONSTRAINT "media_labels_media_file_id_media_files_id_fk" FOREIGN KEY ("media_file_id") REFERENCES "public"."media_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_labels" ADD CONSTRAINT "media_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_labels" ADD CONSTRAINT "post_labels_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_labels" ADD CONSTRAINT "post_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_post_platform_id_post_platforms_id_fk" FOREIGN KEY ("post_platform_id") REFERENCES "public"."post_platforms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_platforms" ADD CONSTRAINT "post_platforms_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_platforms" ADD CONSTRAINT "post_platforms_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_api_usage_daily" ADD CONSTRAINT "x_api_usage_daily_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "account_metrics_channel_idx" ON "account_metrics" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "account_metrics_org_idx" ON "account_metrics" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "account_metrics_date_idx" ON "account_metrics" USING btree ("date");--> statement-breakpoint
CREATE INDEX "account_metrics_platform_idx" ON "account_metrics" USING btree ("platform");--> statement-breakpoint
CREATE UNIQUE INDEX "account_metrics_channel_date_uniq" ON "account_metrics" USING btree ("channel_id","date");--> statement-breakpoint
CREATE INDEX "activity_user_idx" ON "activity_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "activity_org_idx" ON "activity_logs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "activity_action_idx" ON "activity_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "activity_created_idx" ON "activity_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "activity_org_created_idx" ON "activity_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "api_keys_user_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_usage_daily_org_date" ON "api_usage_daily" USING btree ("organization_id","date");--> statement-breakpoint
CREATE INDEX "api_usage_daily_org_idx" ON "api_usage_daily" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_sets_unique" ON "channel_sets" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "channel_sets_org_idx" ON "channel_sets" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "channels_user_idx" ON "channels" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "channels_org_idx" ON "channels" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "channels_platform_idx" ON "channels" USING btree ("platform");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_unique_account" ON "channels" USING btree ("organization_id","platform","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "labels_unique" ON "labels" USING btree ("organization_id","name","type");--> statement-breakpoint
CREATE INDEX "labels_user_idx" ON "labels" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "labels_org_idx" ON "labels" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "labels_type_idx" ON "labels" USING btree ("type");--> statement-breakpoint
CREATE INDEX "media_user_idx" ON "media_files" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "media_org_idx" ON "media_files" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "media_created_idx" ON "media_files" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "media_labels_label_idx" ON "media_labels" USING btree ("label_id");--> statement-breakpoint
CREATE INDEX "media_labels_media_idx" ON "media_labels" USING btree ("media_file_id");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_user_read_idx" ON "notifications" USING btree ("user_id","is_read");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_unread_badge_idx" ON "notifications" USING btree ("user_id") WHERE "notifications"."is_read" = false AND "notifications"."type" <> 'post_published';--> statement-breakpoint
CREATE UNIQUE INDEX "org_members_unique" ON "organization_members" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "org_members_user_idx" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "organizations_owner_idx" ON "organizations" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "post_labels_label_idx" ON "post_labels" USING btree ("label_id");--> statement-breakpoint
CREATE INDEX "post_labels_post_idx" ON "post_labels" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "post_metrics_post_platform_idx" ON "post_metrics" USING btree ("post_platform_id");--> statement-breakpoint
CREATE INDEX "post_metrics_post_idx" ON "post_metrics" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "post_metrics_org_idx" ON "post_metrics" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "post_metrics_fetched_idx" ON "post_metrics" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "post_metrics_platform_idx" ON "post_metrics" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "post_metrics_pp_fetched_idx" ON "post_metrics" USING btree ("post_platform_id","fetched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "post_platforms_post_idx" ON "post_platforms" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "post_platforms_channel_idx" ON "post_platforms" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "post_platforms_status_idx" ON "post_platforms" USING btree ("status");--> statement-breakpoint
CREATE INDEX "posts_org_approval_idx" ON "posts" USING btree ("organization_id","approval_status");--> statement-breakpoint
CREATE INDEX "posts_user_idx" ON "posts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "posts_org_idx" ON "posts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "posts_status_idx" ON "posts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "posts_scheduled_idx" ON "posts" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "posts_created_idx" ON "posts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "posts_org_published_idx" ON "posts" USING btree ("organization_id","published_at");--> statement-breakpoint
CREATE INDEX "posts_org_created_idx" ON "posts" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_org_status_sched_idx" ON "posts" USING btree ("organization_id","status","scheduled_at");--> statement-breakpoint
CREATE INDEX "posts_content_trgm_idx" ON "posts" USING gin ("content" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "push_tokens_user_idx" ON "push_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "x_api_usage_daily_unique" ON "x_api_usage_daily" USING btree ("organization_id","date","action_type");--> statement-breakpoint
CREATE INDEX "x_api_usage_daily_org_idx" ON "x_api_usage_daily" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "x_api_usage_daily_date_idx" ON "x_api_usage_daily" USING btree ("date");