-- MT-M2 batch 4: sensor_status becomes per-facility (was a single global
-- row upserted by cycles.ts with no tenant scoping -- see the design spec's
-- Batch 4 and 00024_sensor_status_rls.sql for the RLS side of this fix).
--
-- The existing global row is a regenerated aggregate snapshot (manually
-- entered per-cycle sensor readings), not source-of-truth data, so it is
-- safe to delete outright rather than backfill -- it re-creates itself
-- per-facility on the next cycle write (see cycles.ts's rescoped upsert).
-- Deleting it first is what makes the NOT NULL facility_id add below safe
-- (no existing rows to violate the constraint).
DELETE FROM public.sensor_status;--> statement-breakpoint
ALTER TABLE "sensor_status" ADD COLUMN "facility_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "sensor_status" ADD CONSTRAINT "sensor_status_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sensor_status_facility_id_uniq" ON "sensor_status" USING btree ("facility_id");

-- Rollback:
--   drop index if exists "sensor_status_facility_id_uniq";
--   alter table public.sensor_status drop constraint if exists "sensor_status_facility_id_facilities_id_fk";
--   alter table public.sensor_status drop column if exists "facility_id";
--   (the deleted global row is not restored -- it regenerates on the next cycle write)
