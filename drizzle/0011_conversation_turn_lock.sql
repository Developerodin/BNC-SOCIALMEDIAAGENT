ALTER TABLE "conversations" ADD COLUMN "busy_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "request_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_conversation_request_uq" ON "messages" USING btree ("conversation_id","request_id") WHERE "messages"."request_id" is not null;