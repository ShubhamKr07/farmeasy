CREATE TABLE "signup_config" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"mode" text DEFAULT 'off' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "signup_config_singleton" CHECK ("signup_config"."id" = 1)
);
--> statement-breakpoint
-- TEN-011: seed the singleton row. 'off' matches the current effective mode
-- (SIGNUP_MODE env defaults to "off" and no public sign-up is live yet) --
-- this row becomes the single source of truth read by both getSignupMode()
-- (app) and the before_user_created hook (00025_signup_enforcement.sql).
-- Rollback: `DELETE FROM public.signup_config WHERE id = 1; DROP TABLE public.signup_config;`
INSERT INTO public.signup_config (id, mode) VALUES (1, 'off') ON CONFLICT (id) DO NOTHING;
