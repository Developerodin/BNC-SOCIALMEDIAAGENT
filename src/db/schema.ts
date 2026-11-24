import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, halfvec, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
  // Task 24: hash of the widget config last written to the AppInstallation metafield, so an unchanged config isn't rewritten.
  widgetConfigHash: text("widget_config_hash"),
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

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    pageUrl: text("page_url"),
    // D81: set while a turn runs (one turn at a time); null when free. A crashed turn frees itself when it expires.
    busyUntil: timestamp("busy_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Target of messages' (store_id, conversation_id) FK, so a message can't point at another store's conversation.
  (t) => [unique("conversations_store_id_id_uq").on(t.storeId, t.id)],
);

// store_id is not in §7.13's Message; RLS needs it (D42).
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull(),
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
    // D81: the client's id for a user message, so a retry of the same message isn't answered twice. Null on assistant rows.
    requestId: uuid("request_id"),
    // UD14: the shopper's thumbs on an answer, 1 or -1; null when unrated. C27: it can be changed or cleared.
    rating: smallint("rating").$type<-1 | 1>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.storeId, t.conversationId], foreignColumns: [conversations.storeId, conversations.id] }).onDelete("cascade"),
    index("messages_conversation_created_idx").on(t.conversationId, t.createdAt),
    uniqueIndex("messages_conversation_request_uq").on(t.conversationId, t.requestId).where(sql`${t.requestId} is not null`),
    check("messages_role_chk", sql`${t.role} in ('user', 'assistant')`),
    check("messages_model_chk", sql`${t.model} in ('small', 'large')`),
    check("messages_status_chk", sql`${t.status} in ('ok', 'cut_off')`),
    check("messages_rating_chk", sql`${t.rating} in (-1, 1)`),
  ],
);

// §7.6: an Add to cart from a chat card (UD21 metric, UD22 filter). Deleted with its conversation (D84, retention).
export const cartEvents = pgTable(
  "cart_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull(),
    // The answer whose card was added; no FK, a message of another conversation is stored as null (Task 27).
    messageId: uuid("message_id"),
    productId: text("product_id").notNull(),
    variantId: text("variant_id").notNull(),
    quantity: integer("quantity").notNull(),
    // The client's id for this add, so a retried log isn't counted twice.
    eventId: uuid("event_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Named: the generated name is over Postgres' 63-character limit.
    foreignKey({
      name: "cart_events_conversation_fk",
      columns: [t.storeId, t.conversationId],
      foreignColumns: [conversations.storeId, conversations.id],
    }).onDelete("cascade"),
    // Serves the cascade when a conversation is deleted (D84, retention).
    index("cart_events_conversation_idx").on(t.storeId, t.conversationId),
  ],
);

// §7.13 Faq (D32). product_id is a Product GID with no FK to products: FAQs are merchant content and outlive a resync.
export const faqs = pgTable(
  "faqs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id, { onDelete: "cascade" }),
    productId: text("product_id").notNull(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    position: integer("position").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("faqs_store_product_position_idx").on(t.storeId, t.productId, t.position),
    check("faqs_question_len_chk", sql`char_length(${t.question}) <= 300`),
    check("faqs_answer_len_chk", sql`char_length(${t.answer}) <= 2000`),
  ],
);
