CREATE TABLE "products" (
	"store_id" uuid NOT NULL,
	"shopify_id" text NOT NULL,
	"handle" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"image_url" text,
	"status" text NOT NULL,
	"published" boolean NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"shopify_updated_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_store_id_shopify_id_pk" PRIMARY KEY("store_id","shopify_id")
);
--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "sync_status" text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "last_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "bulk_operation_id" text;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "sync_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "sync_object_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;