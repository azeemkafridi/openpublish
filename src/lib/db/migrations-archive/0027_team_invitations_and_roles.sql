CREATE TYPE "public"."org_invitation_status" AS ENUM('pending', 'accepted', 'revoked', 'expired');--> statement-breakpoint
ALTER TYPE "public"."org_member_role" ADD VALUE 'approver';--> statement-breakpoint
ALTER TYPE "public"."org_member_role" ADD VALUE 'contributor';--> statement-breakpoint
ALTER TYPE "public"."org_member_role" ADD VALUE 'viewer';--> statement-breakpoint
CREATE TABLE "organization_invitations" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"email" varchar(255) NOT NULL,
	"role" "org_member_role" NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"status" "org_invitation_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" text,
	CONSTRAINT "organization_invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_invitations_org_idx" ON "organization_invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_invitations_unique_pending" ON "organization_invitations" USING btree ("organization_id",lower("email")) WHERE "organization_invitations"."status" = 'pending';--> statement-breakpoint
-- Backfill: remap the legacy 'member' role to 'admin' so existing multi-user orgs keep
-- full power under the new role model. Uses only pre-existing enum values, so it is safe
-- in the same migration as the ADD VALUE statements above. NOTE: this data statement only
-- runs via local `drizzle-kit migrate`; prod uses `drizzle-kit push` (DDL diff only), so the
-- permission layer also treats 'member' as an 'admin' alias for prod correctness.
UPDATE "organization_members" SET "role" = 'admin' WHERE "role" = 'member';