CREATE TABLE "access_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"farm_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"notified_at" timestamp,
	CONSTRAINT "access_requests_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "account_purge_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"action" text NOT NULL,
	"at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signup_allowlist" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "signup_allowlist_email_unique" UNIQUE("email")
);
