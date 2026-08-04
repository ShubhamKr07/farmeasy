ALTER TABLE "inventory_items" ADD COLUMN "item_code" text;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_items_facility_id_item_code_uniq" ON "inventory_items" USING btree ("facility_id","item_code");
