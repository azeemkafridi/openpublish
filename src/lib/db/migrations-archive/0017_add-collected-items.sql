CREATE TABLE "collected_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" integer NOT NULL,
	"url" varchar(2048) NOT NULL,
	"domain" varchar(255),
	"site_name" varchar(255),
	"title" varchar(500),
	"author" varchar(255),
	"excerpt" text,
	"cover_image" varchar(2048),
	"content" text,
	"content_text" text,
	"word_count" integer,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"notes" text,
	"status" varchar(20) DEFAULT 'inbox' NOT NULL,
	"fetch_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"fetch_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collected_items" ADD CONSTRAINT "collected_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collected_items_org_idx" ON "collected_items" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "collected_items_user_idx" ON "collected_items" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "collected_items_created_idx" ON "collected_items" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "collected_items_status_idx" ON "collected_items" USING btree ("status");