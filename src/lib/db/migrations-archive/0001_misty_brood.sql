-- Step 1: Create enum and new tables
CREATE TYPE "public"."org_member_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"owner_id" text NOT NULL,
	"plan" "user_plan" DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);--> statement-breakpoint
CREATE TABLE "organization_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"role" "org_member_role" DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_members_unique" ON "organization_members" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "org_members_user_idx" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "organizations_owner_idx" ON "organizations" USING btree ("owner_id");--> statement-breakpoint

-- Step 2: Add organization_id columns as NULLABLE first (for backfill)
ALTER TABLE "channels" ADD COLUMN "organization_id" integer;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "organization_id" integer;--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "organization_id" integer;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "organization_id" integer;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "preview_path" varchar(500);--> statement-breakpoint
ALTER TABLE "recurring_schedules" ADD COLUMN "organization_id" integer;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "organization_id" integer;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "organization_id" integer;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "organization_id" integer;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN "organization_id" integer;--> statement-breakpoint

-- Step 3: Backfill - create default org per user and assign all data
-- Create a default organization for each existing user
INSERT INTO "organizations" ("name", "slug", "owner_id", "plan")
SELECT
  COALESCE("name", 'My') || '''s Workspace',
  LOWER(REGEXP_REPLACE(COALESCE("name", 'workspace'), '[^a-zA-Z0-9]+', '-', 'g')) || '-' || EXTRACT(EPOCH FROM NOW())::bigint || '-' || SUBSTRING("id" FROM 1 FOR 8),
  "id",
  COALESCE("plan", 'free')
FROM "user";--> statement-breakpoint

-- Create owner membership for each user
INSERT INTO "organization_members" ("organization_id", "user_id", "role")
SELECT o."id", o."owner_id", 'owner'
FROM "organizations" o;--> statement-breakpoint

-- Backfill organization_id on all resource tables
UPDATE "channels" c SET "organization_id" = o."id" FROM "organizations" o WHERE o."owner_id" = c."user_id";--> statement-breakpoint
UPDATE "posts" p SET "organization_id" = o."id" FROM "organizations" o WHERE o."owner_id" = p."user_id";--> statement-breakpoint
UPDATE "labels" l SET "organization_id" = o."id" FROM "organizations" o WHERE o."owner_id" = l."user_id";--> statement-breakpoint
UPDATE "media_files" m SET "organization_id" = o."id" FROM "organizations" o WHERE o."owner_id" = m."user_id";--> statement-breakpoint
UPDATE "recurring_schedules" r SET "organization_id" = o."id" FROM "organizations" o WHERE o."owner_id" = r."user_id";--> statement-breakpoint
UPDATE "notifications" n SET "organization_id" = o."id" FROM "organizations" o WHERE o."owner_id" = n."user_id";--> statement-breakpoint
UPDATE "api_keys" a SET "organization_id" = o."id" FROM "organizations" o WHERE o."owner_id" = a."user_id";--> statement-breakpoint
UPDATE "webhooks" w SET "organization_id" = o."id" FROM "organizations" o WHERE o."owner_id" = w."user_id";--> statement-breakpoint
UPDATE "activity_logs" al SET "organization_id" = o."id" FROM "organizations" o WHERE o."owner_id" = al."user_id";--> statement-breakpoint

-- Step 4: Set NOT NULL on required columns (notifications and activity_logs stay nullable)
ALTER TABLE "channels" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "labels" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "media_files" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_schedules" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhooks" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint

-- Step 5: Add foreign keys
ALTER TABLE "channels" ADD CONSTRAINT "channels_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_schedules" ADD CONSTRAINT "recurring_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Step 6: Update indexes
DROP INDEX IF EXISTS "channels_unique_account";--> statement-breakpoint
DROP INDEX IF EXISTS "labels_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "channels_unique_account" ON "channels" USING btree ("organization_id","platform","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "labels_unique" ON "labels" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "channels_org_idx" ON "channels" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "posts_org_idx" ON "posts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "labels_org_idx" ON "labels" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "media_org_idx" ON "media_files" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "recurring_schedules_org_idx" ON "recurring_schedules" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "webhooks_org_idx" ON "webhooks" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "activity_org_idx" ON "activity_logs" USING btree ("organization_id");
