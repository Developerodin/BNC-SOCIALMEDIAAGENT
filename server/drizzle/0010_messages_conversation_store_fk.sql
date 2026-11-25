ALTER TABLE "conversations" ADD CONSTRAINT "conversations_store_id_id_uq" UNIQUE("store_id","id");--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_conversation_id_conversations_id_fk";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_store_id_conversation_id_conversations_store_id_id_fk" FOREIGN KEY ("store_id","conversation_id") REFERENCES "public"."conversations"("store_id","id") ON DELETE cascade ON UPDATE no action;
