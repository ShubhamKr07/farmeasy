CREATE TYPE "public"."readiness_event_key" AS ENUM('labels_downloaded', 'labels_scanned', 'grow_profile_created', 'seeds_added', 'first_cycle_seeded', 'sensors_skipped', 'quickbooks_skipped', 'team_invited');--> statement-breakpoint
CREATE TYPE "public"."sensor_account_status" AS ENUM('connected', 'failed', 'pending_integration');--> statement-breakpoint
CREATE TYPE "public"."sensor_auth_method" AS ENUM('api_key', 'oauth', 'username_password');--> statement-breakpoint
CREATE TYPE "public"."wizard_event_type" AS ENUM('view', 'save', 'abandon', 'skip');--> statement-breakpoint
CREATE TYPE "public"."wizard_step" AS ENUM('farm_basics', 'layout', 'sensors_accounts', 'sensors_devices', 'sensors_review', 'done');--> statement-breakpoint
CREATE TABLE "facility_readiness_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"facility_id" integer NOT NULL,
	"event_key" "readiness_event_key" NOT NULL,
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	"undone_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sensor_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"vendor" text NOT NULL,
	"auth_method" "sensor_auth_method" NOT NULL,
	"status" "sensor_account_status" DEFAULT 'pending_integration' NOT NULL,
	"masked_fingerprint" text,
	"credential_ciphertext" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wizard_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"step" "wizard_step" NOT NULL,
	"event_type" "wizard_event_type" NOT NULL,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wizard_progress" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" integer,
	"current_step" "wizard_step" DEFAULT 'farm_basics' NOT NULL,
	"step_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rooms" DROP CONSTRAINT "rooms_name_unique";--> statement-breakpoint
ALTER TABLE "sensors" DROP CONSTRAINT "sensors_placement";--> statement-breakpoint
ALTER TABLE "rooms" DROP CONSTRAINT "rooms_facility_id_facilities_id_fk";
--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN "organization_id" integer;--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN "facility_name" text;--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN "units" text DEFAULT 'metric' NOT NULL;--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "sensors" ADD COLUMN "room_id" integer;--> statement-breakpoint
ALTER TABLE "sensors" ADD COLUMN "facility_wide" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sensors" ADD COLUMN "sensor_account_id" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "organization_id" integer;--> statement-breakpoint
ALTER TABLE "facility_readiness_events" ADD CONSTRAINT "facility_readiness_events_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensor_accounts" ADD CONSTRAINT "sensor_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wizard_events" ADD CONSTRAINT "wizard_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wizard_progress" ADD CONSTRAINT "wizard_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wizard_progress" ADD CONSTRAINT "wizard_progress_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "facility_readiness_events_facility_id_idx" ON "facility_readiness_events" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "facility_readiness_events_facility_key_uniq" ON "facility_readiness_events" USING btree ("facility_id","event_key");--> statement-breakpoint
CREATE UNIQUE INDEX "sensor_accounts_org_vendor_uniq" ON "sensor_accounts" USING btree ("organization_id","vendor");--> statement-breakpoint
CREATE UNIQUE INDEX "wizard_progress_user_id_uniq" ON "wizard_progress" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensors" ADD CONSTRAINT "sensors_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensors" ADD CONSTRAINT "sensors_sensor_account_id_sensor_accounts_id_fk" FOREIGN KEY ("sensor_account_id") REFERENCES "public"."sensor_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sensors_room_id_idx" ON "sensors" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "sensors_sensor_account_id_idx" ON "sensors" USING btree ("sensor_account_id");--> statement-breakpoint
ALTER TABLE "sensors" ADD CONSTRAINT "sensors_placement" CHECK ("sensors"."channel_id" IS NOT NULL OR "sensors"."rack_id" IS NOT NULL OR "sensors"."room_id" IS NOT NULL OR "sensors"."facility_wide" = true);
