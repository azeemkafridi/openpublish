CREATE TABLE "polar_processed_orders" (
	"order_id" varchar(255) PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"product_id" varchar(255) NOT NULL,
	"net_amount_cents" integer DEFAULT 0 NOT NULL,
	"refunded_amount_cents" integer DEFAULT 0 NOT NULL,
	"paid_at" timestamp with time zone DEFAULT now(),
	"last_refunded_at" timestamp with time zone,
	"event_kind" varchar(50) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "polar_processed_orders" ADD CONSTRAINT "polar_processed_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "polar_processed_orders_org_idx" ON "polar_processed_orders" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "polar_processed_orders_product_idx" ON "polar_processed_orders" USING btree ("product_id");