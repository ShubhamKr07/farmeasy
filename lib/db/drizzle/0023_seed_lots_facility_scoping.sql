ALTER TABLE "seed_lots" DROP CONSTRAINT "seed_lots_qr_code_unique";--> statement-breakpoint
ALTER TABLE "seed_lots" ADD COLUMN "facility_id" integer;--> statement-breakpoint
ALTER TABLE "seed_lots" ADD CONSTRAINT "seed_lots_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "seed_lots_facility_id_qr_code_uniq" ON "seed_lots" USING btree ("facility_id","qr_code");--> statement-breakpoint
CREATE INDEX "seed_lots_facility_id_idx" ON "seed_lots" USING btree ("facility_id");