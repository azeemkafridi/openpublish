CREATE INDEX "activity_org_created_idx" ON "activity_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "organizations_polar_customer_idx" ON "organizations" USING btree ("polar_customer_id");--> statement-breakpoint
CREATE INDEX "posts_org_published_idx" ON "posts" USING btree ("organization_id","published_at");