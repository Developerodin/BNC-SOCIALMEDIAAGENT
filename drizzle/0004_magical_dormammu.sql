CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"source" text NOT NULL,
	"product_id" text,
	"ordinal" integer NOT NULL,
	"content" text NOT NULL,
	"source_hash" text NOT NULL,
	"embedding" halfvec(512) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunks_store_product_ordinal_uq" UNIQUE("store_id","product_id","ordinal")
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_store_id_product_id_products_store_id_shopify_id_fk" FOREIGN KEY ("store_id","product_id") REFERENCES "public"."products"("store_id","shopify_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_store_product_idx" ON "chunks" USING btree ("store_id","product_id");