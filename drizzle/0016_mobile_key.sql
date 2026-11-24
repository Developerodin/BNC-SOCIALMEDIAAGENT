ALTER TABLE "stores" ADD COLUMN "mobile_key_hash" text;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "mobile_key_prefix" text;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "mobile_key_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_mobile_key_hash_unique" UNIQUE("mobile_key_hash");