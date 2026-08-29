-- Daily digest email feature removed. Drop the opt-in preference column.
-- (The 'daily_digest' value stays in the notification_type enum — Postgres
-- cannot drop enum values without recreating the type.)
ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "email_daily_digest";
