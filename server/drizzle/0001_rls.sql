-- No password here: dev/test get one from docker/initdb/app-user.sql; production sets it out of band (ALTER ROLE) at deploy (M10).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
--> statement-breakpoint
-- Every future store-owned table repeats these three statements. `stores` is intentionally not protected.
ALTER TABLE store_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE store_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY store_isolation ON store_tokens
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
