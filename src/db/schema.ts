import { boolean, foreignKey, halfvec, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { EMBEDDING_DIMS } from "../lib/embedding-config";

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Not RLS-protected: install and webhook lookups go by shop_domain.
export const stores = pgTable("stores", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  shopDomain: text("shop_domain").notNull().unique(),
  name: text("name"),
  active: boolean("active").notNull().default(true),
  installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
  settings: jsonb("settings").notNull().default({}),
  syncStatus: text("sync_status").$type<"idle" | "running" | "failed">().notNull().default("idle"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  bulkOperationId: text("bulk_operation_id"),
  syncStartedAt: timestamp("sync_started_at", { withTimezone: true }),
  syncObjectCount: integer("sync_object_count").notNull().default(0),
  // Why the store can't sync, in words the merchant can act on; null when nothing is wrong.
  syncError: text("sync_error"),
});

export const storeTokens = pgTable("store_tokens", {
  storeId: uuid("store_id").primaryKey().references(() => stores.id, { onDelete: "cascade" }),
  accessTokenEnc: text("access_token_enc").notNull(),
  accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
  refreshTokenEnc: text("refresh_token_enc"),
  refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }),
  keyId: text("key_id").notNull(),
});

export const webhookEvents = pgTable("webhook_events", {
  id: text("id").primaryKey(),
  topic: text("topic").notNull(),
  shopDomain: text("shop_domain").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

export const products = pgTable(
  "products",
  {
    storeId: uuid("store_id").notNull().references(() => stores.id, { onDelete: "cascade" }),
    shopifyId: text("shopify_id").notNull(),
    handle: text("handle").notNull(),
    title: text("title").notNull(),
    url: text("url"),
    imageUrl: text("image_url"),
    status: text("status").notNull(),
    published: boolean("published").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    shopifyUpdatedAt: timestamp("shopify_updated_at", { withTimezone: true }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.shopifyId] })],
);

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id, { onDelete: "cascade" }),
    // 'product' for now; M6/M7 add 'doc' and 'faq' with their own id columns.
    source: text("source").notNull(),
    productId: text("product_id"),
    ordinal: integer("ordinal").notNull(),
    content: text("content").notNull(),
    // sha256(model | dims | CHUNKER_VERSION | product contentHash), computed by the embed job.
    sourceHash: text("source_hash").notNull(),
    // D33: moving to 1536 dims needs a migration that runs DELETE FROM chunks first.
    embedding: halfvec("embedding", { dimensions: EMBEDDING_DIMS }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.storeId, t.productId], foreignColumns: [products.storeId, products.shopifyId] }).onDelete("cascade"),
    index("chunks_store_product_idx").on(t.storeId, t.productId),
    unique("chunks_store_product_ordinal_uq").on(t.storeId, t.productId, t.ordinal),
  ],
);
