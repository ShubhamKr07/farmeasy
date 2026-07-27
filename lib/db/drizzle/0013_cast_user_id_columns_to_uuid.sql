ALTER TABLE "user_settings" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "accounting_connections" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "recommender_queries" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "facility_logs" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;

ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");
ALTER TABLE "accounting_connections" ADD CONSTRAINT "accounting_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");
ALTER TABLE "recommender_queries" ADD CONSTRAINT "recommender_queries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");
ALTER TABLE "facility_logs" ADD CONSTRAINT "facility_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");
