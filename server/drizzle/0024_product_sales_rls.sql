ALTER TABLE product_sales ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE product_sales FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY store_isolation ON product_sales
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
--> statement-breakpoint
-- 0001's default privileges already cover tables the migration role creates; stated here so this one doesn't depend on it.
GRANT SELECT, INSERT, UPDATE, DELETE ON product_sales TO app_user;
