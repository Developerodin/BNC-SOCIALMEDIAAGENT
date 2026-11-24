import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, halfvec, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
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
  // The storefront hosts chat requests may come from (lowercased): myshopify, primary and every other domain (refreshShopInfo).
  domains: text("domains").array().notNull().default(sql`'{}'::text[]`),
  // D76: the store's language, from the primary domain; null when Shopify doesn't give one (no query translation then).
  primaryLocale: text("primary_locale"),
  currencyCode: text("currency_code"),
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
    // D74: gift cards are searched only when the shopper asks for one.
    isGiftCard: boolean("is_gift_card").notNull().default(false),
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

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id").notNull().references(() => stores.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  pageUrl: text("page_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// store_id is not in §7.13's Message; RLS needs it (D42).
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant">().notNull(),
    // Already masked (D41).
    content: text("content").notNull(),
    productIds: text("product_ids").array().notNull().default(sql`'{}'::text[]`),
    // C15: the cards exactly as the shopper saw them.
    cards: jsonb("cards"),
    model: text("model").$type<"small" | "large">(),
    // C19: an answer cut off mid-stream is saved as shown.
    status: text("status").$type<"ok" | "cut_off">().notNull().default("ok"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("messages_conversation_created_idx").on(t.conversationId, t.createdAt),
    check("messages_role_chk", sql`${t.role} in ('user', 'assistant')`),
    check("messages_model_chk", sql`${t.model} in ('small', 'large')`),
    check("messages_status_chk", sql`${t.status} in ('ok', 'cut_off')`),
  ],
);
