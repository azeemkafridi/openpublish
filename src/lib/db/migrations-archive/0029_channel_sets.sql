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
ALTER TABLE "channel_sets" ADD CONSTRAINT "channel_sets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_sets_unique" ON "channel_sets" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "channel_sets_org_idx" ON "channel_sets" USING btree ("organization_id");--> statement-breakpoint
-- Re-emitted by drizzle-kit because hand-written 0028 wasn't in the snapshot;
-- IF EXISTS makes it a no-op on databases that already ran 0028.
ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "email_daily_digest";