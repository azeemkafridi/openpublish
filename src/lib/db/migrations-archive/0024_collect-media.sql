ALTER TABLE "collected_items" ADD COLUMN "media_id" bigint;--> statement-breakpoint
ALTER TABLE "collected_items" ADD COLUMN "mime_type" varchar(100);--> statement-breakpoint
ALTER TABLE "collected_items" ADD CONSTRAINT "collected_items_media_id_media_files_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_files"("id") ON DELETE set null ON UPDATE no action;