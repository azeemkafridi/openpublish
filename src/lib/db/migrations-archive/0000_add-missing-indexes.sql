CREATE TYPE "public"."notification_type" AS ENUM('post_published', 'post_failed', 'post_scheduled_reminder', 'token_expiring', 'token_expired', 'daily_digest', 'system');--> statement-breakpoint
CREATE TYPE "public"."platform_name" AS ENUM('facebook', 'instagram', 'x', 'tiktok', 'youtube', 'threads', 'bluesky', 'pinterest', 'gmb');--> statement-breakpoint
CREATE TYPE "public"."platform_status" AS ENUM('pending', 'publishing', 'published', 'failed', 'processing');--> statement-breakpoint
CREATE TYPE "public"."post_status" AS ENUM('draft', 'scheduled', 'publishing', 'published', 'partial', 'failed', 'processing');--> statement-breakpoint
CREATE TYPE "public"."recurring_frequency" AS ENUM('daily', 'weekly', 'biweekly', 'monthly');--> statement-breakpoint
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
CREATE TABLE "activity_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text,
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
CREATE TABLE "channels" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"platform" "platform_name" NOT NULL,
	"account_name" varchar(255) NOT NULL,
	"account_id" varchar(255) NOT NULL,
	"account_type" varchar(50) DEFAULT 'unknown',
	"access_token" text,
	"refresh_token" text,
	"token_expires_at" timestamp with time zone,
	"profile_image" text,
	"is_active" boolean DEFAULT true,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" varchar(100) NOT NULL,
	"color" varchar(7) DEFAULT '#6366f1',
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "media_files" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"original_path" varchar(500) NOT NULL,
	"thumbnail_path" varchar(500),
	"file_name" varchar(255) NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"size_bytes" integer NOT NULL,
	"width" integer,
	"height" integer,
	"duration" integer,
	"is_original_deleted" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"email_on_failure" boolean DEFAULT true,
	"email_daily_digest" boolean DEFAULT false,
	"email_on_token_expiry" boolean DEFAULT true,
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
	"type" "notification_type" NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"is_read" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "post_labels" (
	"post_id" integer NOT NULL,
	"label_id" integer NOT NULL,
	CONSTRAINT "post_labels_post_id_label_id_pk" PRIMARY KEY("post_id","label_id")
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
	"content" text DEFAULT '',
	"media_files" jsonb DEFAULT '[]'::jsonb,
	"status" "post_status" DEFAULT 'draft',
	"scheduled_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"timezone" varchar(100) DEFAULT 'UTC',
	"post_type_overrides" jsonb DEFAULT '{}'::jsonb,
	"platform_specific" jsonb DEFAULT '{}'::jsonb,
	"recurring_schedule_id" integer,
	"delete_media_after_publish" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "recurring_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"frequency" "recurring_frequency" NOT NULL,
	"day_of_week" integer,
	"day_of_month" integer,
	"time_of_day" varchar(5) NOT NULL,
	"timezone" varchar(100) DEFAULT 'UTC',
	"channel_ids" jsonb DEFAULT '[]'::jsonb,
	"media_file_ids" jsonb DEFAULT '[]'::jsonb,
	"content_template" text DEFAULT '',
	"post_type_overrides" jsonb DEFAULT '{}'::jsonb,
	"platform_specific" jsonb DEFAULT '{}'::jsonb,
	"is_active" boolean DEFAULT true,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
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
CREATE TABLE "webhooks" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"url" varchar(500) NOT NULL,
	"secret" varchar(255) NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb,
	"is_active" boolean DEFAULT true,
	"last_triggered_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "activity_user_idx" ON "activity_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "activity_action_idx" ON "activity_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "activity_created_idx" ON "activity_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "api_keys_user_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "channels_user_idx" ON "channels" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "channels_platform_idx" ON "channels" USING btree ("platform");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_unique_account" ON "channels" USING btree ("user_id","platform","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "labels_unique" ON "labels" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "labels_user_idx" ON "labels" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "media_user_idx" ON "media_files" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_user_read_idx" ON "notifications" USING btree ("user_id","is_read");--> statement-breakpoint
CREATE INDEX "post_labels_label_idx" ON "post_labels" USING btree ("label_id");--> statement-breakpoint
CREATE INDEX "post_labels_post_idx" ON "post_labels" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "post_platforms_post_idx" ON "post_platforms" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "post_platforms_channel_idx" ON "post_platforms" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "post_platforms_status_idx" ON "post_platforms" USING btree ("status");--> statement-breakpoint
CREATE INDEX "posts_user_idx" ON "posts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "posts_status_idx" ON "posts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "posts_scheduled_idx" ON "posts" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "recurring_schedules_user_idx" ON "recurring_schedules" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recurring_schedules_active_next_idx" ON "recurring_schedules" USING btree ("is_active","next_run_at");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "webhooks_user_idx" ON "webhooks" USING btree ("user_id");