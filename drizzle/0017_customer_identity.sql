ALTER TABLE "conversations" ADD COLUMN "owner_customer_id" text;--> statement-breakpoint
ALTER TABLE "store_tokens" ADD COLUMN "storefront_token_enc" text;--> statement-breakpoint
CREATE INDEX "conversations_owner_idx" ON "conversations" USING btree ("store_id","owner_customer_id","created_at");