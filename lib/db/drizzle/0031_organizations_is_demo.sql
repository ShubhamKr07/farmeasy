-- Rollback: ALTER TABLE "organizations" DROP COLUMN "is_demo";
ALTER TABLE "organizations" ADD COLUMN "is_demo" boolean DEFAULT false NOT NULL;