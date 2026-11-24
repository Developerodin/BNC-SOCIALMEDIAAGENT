CREATE TABLE "cart_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"product_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"event_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_events_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "faqs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "faqs_question_len_chk" CHECK (char_length("faqs"."question") <= 300),
	CONSTRAINT "faqs_answer_len_chk" CHECK (char_length("faqs"."answer") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "rating" smallint;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "widget_config_hash" text;--> statement-breakpoint
ALTER TABLE "cart_events" ADD CONSTRAINT "cart_events_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_events" ADD CONSTRAINT "cart_events_conversation_fk" FOREIGN KEY ("store_id","conversation_id") REFERENCES "public"."conversations"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faqs" ADD CONSTRAINT "faqs_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cart_events_conversation_idx" ON "cart_events" USING btree ("store_id","conversation_id");--> statement-breakpoint
CREATE INDEX "faqs_store_product_position_idx" ON "faqs" USING btree ("store_id","product_id","position");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_rating_chk" CHECK ("messages"."rating" in (-1, 1));