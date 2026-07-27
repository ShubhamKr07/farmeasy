ALTER TABLE "accounting_connections" RENAME COLUMN "clerk_user_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "bad_tray_entries" RENAME COLUMN "created_by" TO "user_id";--> statement-breakpoint
ALTER TABLE "cycles" RENAME COLUMN "created_by" TO "user_id";--> statement-breakpoint
ALTER TABLE "facility_logs" RENAME COLUMN "clerk_user_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "manual_checks" RENAME COLUMN "created_by" TO "user_id";--> statement-breakpoint
ALTER TABLE "recommender_queries" RENAME COLUMN "clerk_user_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "stock_movements" RENAME COLUMN "created_by" TO "user_id";--> statement-breakpoint
ALTER TABLE "tasks" RENAME COLUMN "created_by" TO "user_id";--> statement-breakpoint
ALTER TABLE "user_settings" RENAME COLUMN "clerk_user_id" TO "user_id";--> statement-breakpoint
DROP INDEX "accounting_connections_user_provider_uniq";--> statement-breakpoint
DROP INDEX "recommender_queries_user_idx";--> statement-breakpoint
DROP INDEX "user_settings_user_key_uniq";--> statement-breakpoint
-- The five created_by-derived columns are nullable and empty of any
-- meaningful pre-existing values in production (verified: cycles has 14
-- rows, all NULL; the other four have 0 rows) — safe to cast straight to
-- uuid and add their FK constraint here. The four clerk_user_id-derived
-- columns (accounting_connections, facility_logs, recommender_queries,
-- user_settings) hold real Clerk ID strings and stay `text` until Task 3's
-- backfill script maps them to real user UUIDs — their type cast and FK
-- constraint are added in Task 4, not here.
ALTER TABLE "bad_tray_entries" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;--> statement-breakpoint
ALTER TABLE "cycles" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;--> statement-breakpoint
ALTER TABLE "manual_checks" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;--> statement-breakpoint
ALTER TABLE "stock_movements" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;--> statement-breakpoint
ALTER TABLE "bad_tray_entries" ADD CONSTRAINT "bad_tray_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_checks" ADD CONSTRAINT "manual_checks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_connections_user_provider_uniq" ON "accounting_connections" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "recommender_queries_user_idx" ON "recommender_queries" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_settings_user_key_uniq" ON "user_settings" USING btree ("user_id","key");
