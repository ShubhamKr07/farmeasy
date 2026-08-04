ALTER TABLE "accounting_connections" ADD COLUMN "organization_id" integer;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "facility_id" integer;--> statement-breakpoint
ALTER TABLE "cycles" ADD COLUMN "facility_id" integer;--> statement-breakpoint
ALTER TABLE "facility_logs" ADD COLUMN "facility_id" integer;--> statement-breakpoint
ALTER TABLE "growth_profiles" ADD COLUMN "organization_id" integer;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "facility_id" integer;--> statement-breakpoint
ALTER TABLE "sensors" ADD COLUMN "facility_id" integer;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "facility_id" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "facility_id" integer;--> statement-breakpoint
ALTER TABLE "accounting_connections" ADD CONSTRAINT "accounting_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_logs" ADD CONSTRAINT "facility_logs_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_profiles" ADD CONSTRAINT "growth_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensors" ADD CONSTRAINT "sensors_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounting_connections_organization_id_idx" ON "accounting_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "alerts_facility_id_idx" ON "alerts" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "cycles_facility_id_idx" ON "cycles" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "facility_logs_facility_id_idx" ON "facility_logs" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "growth_profiles_organization_id_idx" ON "growth_profiles" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "inventory_items_facility_id_idx" ON "inventory_items" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "sensors_facility_id_idx" ON "sensors" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "shipments_facility_id_idx" ON "shipments" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "tasks_facility_id_idx" ON "tasks" USING btree ("facility_id");