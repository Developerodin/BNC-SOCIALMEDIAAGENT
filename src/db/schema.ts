import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
