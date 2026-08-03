-- Runs after 0019's backfill populates every row. Asserting NOT NULL before
-- backfill would fail against existing data — same ordering hazard the
-- rooms.facility_id split (0014/0015/0016) exists to avoid.
ALTER TABLE "cycles" ALTER COLUMN "facility_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ALTER COLUMN "facility_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ALTER COLUMN "facility_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "facility_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ALTER COLUMN "facility_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "facility_logs" ALTER COLUMN "facility_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sensors" ALTER COLUMN "facility_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "growth_profiles" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "accounting_connections" ALTER COLUMN "organization_id" SET NOT NULL;
