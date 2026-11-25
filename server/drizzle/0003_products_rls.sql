ALTER TABLE products ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE products FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY store_isolation ON products
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
