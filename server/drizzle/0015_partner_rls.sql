-- Task P1: RLS for the two store-owned partner tables, and app_user's rights on the two that aren't.
ALTER TABLE partner_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE partner_grants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY store_isolation ON partner_grants
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE partner_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE partner_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY store_isolation ON partner_tokens
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
--> statement-breakpoint
-- The bearer guard and DELETE /api/partner/token know only the token, not the store. With app.partner_token_hash set
-- (forTokenHash, transaction-local) the one row with that hash is readable; nothing else is, and the row can't be
-- written through this key. Knowing the hash means holding the token (sha256 of 256 random bits), so a caller can
-- only ever reach the store whose token it holds. Permissive policies OR together, so SELECT sees store OR hash,
-- while INSERT, UPDATE and DELETE stay on store_isolation alone.
CREATE POLICY token_lookup ON partner_tokens FOR SELECT
  USING (token_hash = nullif(current_setting('app.partner_token_hash', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON partner_grants, partner_tokens, partner_connect_requests TO app_user;
--> statement-breakpoint
-- Clients are registered only by scripts/partner-client.mjs on the admin URL; the app only reads them.
-- The REVOKE undoes 0001's default privileges for this table.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON partner_clients FROM app_user;
--> statement-breakpoint
GRANT SELECT ON partner_clients TO app_user;
