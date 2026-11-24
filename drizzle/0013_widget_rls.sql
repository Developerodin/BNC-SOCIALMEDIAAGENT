ALTER TABLE cart_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE cart_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY store_isolation ON cart_events
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE faqs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE faqs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY store_isolation ON faqs
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
--> statement-breakpoint
-- 0001's default privileges already cover tables the migration role creates; stated here so these two don't depend on it.
GRANT SELECT, INSERT, UPDATE, DELETE ON cart_events, faqs TO app_user;
