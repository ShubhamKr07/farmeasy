-- MT-M2 batch 3: crops org-scoped hybrid catalog. organization_id NULL =
-- shared system crop (readable by every tenant); a set organization_id =
-- tenant-private crop. Existing ~5 rows stay NULL (system crops) -- no
-- backfill/seeding needed, no data loss. Drops the table-wide unique(name)
-- and replaces it with (organization_id, name) [per-org uniqueness] +
-- a partial unique(name) where organization_id is null [system names stay
-- globally unique].
-- Rollback:
--   DROP INDEX "crops_system_name_uniq";
--   DROP INDEX "crops_org_id_name_uniq";
--   ALTER TABLE "crops" DROP CONSTRAINT "crops_organization_id_organizations_id_fk";
--   ALTER TABLE "crops" DROP COLUMN "organization_id";
--   ALTER TABLE "crops" ADD CONSTRAINT "crops_name_unique" UNIQUE ("name");
ALTER TABLE "crops" DROP CONSTRAINT "crops_name_unique";--> statement-breakpoint
ALTER TABLE "crops" ADD COLUMN "organization_id" integer;--> statement-breakpoint
ALTER TABLE "crops" ADD CONSTRAINT "crops_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crops_org_id_name_uniq" ON "crops" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "crops_system_name_uniq" ON "crops" USING btree ("name") WHERE "crops"."organization_id" is null;