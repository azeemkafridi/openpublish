CREATE TYPE "public"."post_approval_status" AS ENUM('none', 'pending', 'approved', 'rejected');--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "approval_status" "post_approval_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
CREATE INDEX "posts_org_approval_idx" ON "posts" USING btree ("organization_id","approval_status");