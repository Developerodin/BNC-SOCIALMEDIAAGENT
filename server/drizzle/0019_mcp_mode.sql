ALTER TABLE "stores" ADD COLUMN "mode" text DEFAULT 'app' NOT NULL;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_mode_chk" CHECK ("stores"."mode" in ('app', 'mcp'));