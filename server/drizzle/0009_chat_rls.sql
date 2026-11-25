ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY store_isolation ON conversations
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY store_isolation ON messages
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
