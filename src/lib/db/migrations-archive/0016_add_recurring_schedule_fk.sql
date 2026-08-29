-- Clear any orphaned references first so ADD CONSTRAINT doesn't fail on existing rows that
-- point at a recurring_schedule that was already deleted (the bug this FK guards against).
UPDATE "posts" SET "recurring_schedule_id" = NULL WHERE "recurring_schedule_id" IS NOT NULL AND "recurring_schedule_id" NOT IN (SELECT "id" FROM "recurring_schedules");--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_recurring_schedule_id_recurring_schedules_id_fk" FOREIGN KEY ("recurring_schedule_id") REFERENCES "public"."recurring_schedules"("id") ON DELETE set null ON UPDATE no action;
