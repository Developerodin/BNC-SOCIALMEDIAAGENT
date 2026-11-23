ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE chunks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY store_isolation ON chunks
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE chunks ADD CONSTRAINT chunks_product_source_chk CHECK (source <> 'product' OR product_id IS NOT NULL);
