CREATE TABLE "product_questions" (
	"store_id" uuid NOT NULL,
	"shopify_id" text NOT NULL,
	"locale" text NOT NULL,
	"content_hash" text NOT NULL,
	"questions" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_questions_store_id_shopify_id_locale_pk" PRIMARY KEY("store_id","shopify_id","locale")
);
--> statement-breakpoint
ALTER TABLE "product_questions" ADD CONSTRAINT "product_questions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;