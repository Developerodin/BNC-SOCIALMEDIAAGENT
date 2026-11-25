CREATE TABLE "product_sales" (
	"store_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"units" integer NOT NULL,
	"order_count" integer NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	CONSTRAINT "product_sales_store_id_product_id_pk" PRIMARY KEY("store_id","product_id")
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "rating" real;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "rating_count" integer;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "sales_snapshot_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_sales" ADD CONSTRAINT "product_sales_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;