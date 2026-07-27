-- The user_role enum was defined with the wrong values (technician, lead,
-- supervisor) -- a guess made while writing the Auth migration plan without
-- checking the app's real role taxonomy, which is actually defined in
-- lib/api-zod/src/roles.ts: technician, supervisor, quality_lead,
-- facility_lead. Caught live during Task 3's first real export run when a
-- user with Clerk publicMetadata.role = "facility_lead" failed to insert
-- (invalid enum value), and the export script's insert error was silently
-- swallowed.
--
-- Postgres can't drop enum values in place, so recreate the type: the one
-- existing row ('technician') is valid in both the old and new value sets,
-- so this is a safe rename+swap with no data loss.
CREATE TYPE "public"."user_role_new" AS ENUM('technician', 'supervisor', 'quality_lead', 'facility_lead');--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" TYPE "public"."user_role_new" USING "role"::text::"public"."user_role_new";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'technician';--> statement-breakpoint
DROP TYPE "public"."user_role";--> statement-breakpoint
ALTER TYPE "public"."user_role_new" RENAME TO "user_role";
