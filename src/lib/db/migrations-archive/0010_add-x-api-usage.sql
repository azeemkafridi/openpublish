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
ALTER TABLE "x_api_usage_daily" ADD CONSTRAINT "x_api_usage_daily_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "x_api_usage_daily_unique" ON "x_api_usage_daily" USING btree ("organization_id","date","action_type");--> statement-breakpoint
CREATE INDEX "x_api_usage_daily_org_idx" ON "x_api_usage_daily" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "x_api_usage_daily_date_idx" ON "x_api_usage_daily" USING btree ("date");
