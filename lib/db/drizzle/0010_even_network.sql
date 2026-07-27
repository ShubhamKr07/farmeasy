CREATE TYPE "public"."user_role" AS ENUM('technician', 'lead', 'supervisor');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"role" "user_role" DEFAULT 'technician' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
