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
  // The merchant's mobile app key (docs/mobile-api.md): sha256 hex only, the key itself is never stored. One per store;
  // creating a new one replaces it, and null means none (native requests are then refused).
  mobileKeyHash: text("mobile_key_hash").unique(),
  // First 12 characters ('ackm_' + 7), shown in the admin so the merchant can tell keys apart.
  mobileKeyPrefix: text("mobile_key_prefix"),
  mobileKeyCreatedAt: timestamp("mobile_key_created_at", { withTimezone: true }),
});

export const storeTokens = pgTable("store_tokens", {
  storeId: uuid("store_id").primaryKey().references(() => stores.id, { onDelete: "cascade" }),
  accessTokenEnc: text("access_token_enc").notNull(),
  accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
  refreshTokenEnc: text("refresh_token_enc"),
  refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }),
  keyId: text("key_id").notNull(),
  // Storefront API token AskCart created for this store (storefrontAccessTokenCreate), used only to check a mobile
  // customer's customerAccessToken. Encrypted like the tokens above; null until the first customer sign-in.
  storefrontTokenEnc: text("storefront_token_enc"),
  // When we last asked Shopify for a storefront token; limits minting to one an hour (the cap is 100 per app and store).
  storefrontTokenMintedAt: timestamp("storefront_token_minted_at", { withTimezone: true }),
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
    // Customer GID of the signed-in shopper who started this conversation; null for guests. Set once at creation, never
    // changed, so a guest chat is not claimed later. Ownership is checked against the customer session, never the body.
    ownerCustomerId: text("owner_customer_id"),
    // D81: set while a turn runs (one turn at a time); null when free. A crashed turn frees itself when it expires.
    busyUntil: timestamp("busy_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Target of messages' (store_id, conversation_id) FK, so a message can't point at another store's conversation.
  (t) => [
    unique("conversations_store_id_id_uq").on(t.storeId, t.id),
    // Serves GET /api/chat/conversations (a customer's list, latest first).
    index("conversations_owner_idx").on(t.storeId, t.ownerCustomerId, t.createdAt),
  ],
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

// --- Partner connect (plan 2026-11-24, Task P1) ---

// A registered portal (C36: only ours, seeded by scripts/partner-client.mjs). No store_id, so no RLS; app_user may only SELECT.
export const partnerClients = pgTable("partner_clients", {
  clientId: text("client_id").primaryKey(),
  name: text("name").notNull(),
  // sha256 hex of the client secret; the secret itself is never stored.
  secretHash: text("secret_hash").notNull(),
  // Exact strings, matched without normalisation.
  redirectUris: text("redirect_uris").array().notNull(),
  allowedScopes: text("allowed_scopes").array().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
});

export type PartnerConnectStatus = "pending" | "approved" | "denied" | "exchanged" | "expired";

// One portal-initiated connect attempt. Keyed by shop domain (the store may not be installed yet), so no store_id and no RLS:
// every app query on it must filter by the shop the session token proves (P5).
export const partnerConnectRequests = pgTable(
  "partner_connect_requests",
  {
    // Goes in the consent deep link; 122 random bits.
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: text("client_id").notNull().references(() => partnerClients.clientId),
    shopDomain: text("shop_domain").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    state: text("state").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    scopes: text("scopes").array().notNull(),
    status: text("status").$type<PartnerConnectStatus>().notNull(),
    // now() + 10 minutes, set by the DB clock.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // sha256 hex of the authorization code; the code itself is never stored.
    codeHash: text("code_hash").unique(),
    codeExpiresAt: timestamp("code_expires_at", { withTimezone: true }),
    approvedByUserId: text("approved_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    exchangedAt: timestamp("exchanged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("partner_connect_requests_shop_domain_idx").on(t.shopDomain),
    index("partner_connect_requests_expires_at_idx").on(t.expiresAt),
    check("partner_connect_requests_status_chk", sql`${t.status} in ('pending', 'approved', 'denied', 'exchanged', 'expired')`),
  ],
);

export type PartnerRevokedReason = "portal" | "app_uninstalled" | "code_replay" | "refresh_replay" | "reconnect" | "merchant";

// The merchant's approval: one store, one client, a scope set. The unit of revocation (revoked_at kills every token of it).
export const partnerGrants = pgTable(
  "partner_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id, { onDelete: "cascade" }),
    // Denormalised for logs and the M7 list.
    shopDomain: text("shop_domain").notNull(),
    clientId: text("client_id").notNull().references(() => partnerClients.clientId),
    scopes: text("scopes").array().notNull(),
    // One grant per code: a second exchange of the same code can't create a second grant.
    connectRequestId: uuid("connect_request_id").unique(),
    // Shopify staff user id; no email.
    grantedByUserId: text("granted_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason").$type<PartnerRevokedReason>(),
  },
  (t) => [
    // Named: the generated name is over Postgres' 63-character limit.
    foreignKey({
      name: "partner_grants_connect_request_fk",
      columns: [t.connectRequestId],
      foreignColumns: [partnerConnectRequests.id],
    }).onDelete("set null"),
    // C33: a reconnect replaces the old grant, so at most one active grant per store and client. Revoke the old one
    // before inserting the new one in the same transaction; a concurrent second exchange gets a unique violation (23505).
    uniqueIndex("partner_grants_active_store_client_uq").on(t.storeId, t.clientId).where(sql`${t.revokedAt} is null`),
    // Target of partner_tokens' (store_id, grant_id) FK, so a token can't carry another store's id.
    unique("partner_grants_store_id_id_uq").on(t.storeId, t.id),
    check(
      "partner_grants_revoked_reason_chk",
      sql`${t.revokedReason} in ('portal', 'app_uninstalled', 'code_replay', 'refresh_replay', 'reconnect', 'merchant')`,
    ),
  ],
);

// A bearer token under a grant. Valid = not expired, grant not revoked, store active (checked by the guard, P7).
export const partnerTokens = pgTable(
  "partner_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    grantId: uuid("grant_id").notNull(),
    // Copy of the grant's store_id, for RLS; the composite FK keeps them equal.
    storeId: uuid("store_id").notNull().references(() => stores.id, { onDelete: "cascade" }),
    // C32 (a) issues only 'access'; 'refresh' is there for the access + refresh switch.
    kind: text("kind").$type<"access" | "refresh">().notNull(),
    // sha256 hex of the token; the token itself is never stored.
    tokenHash: text("token_hash").notNull().unique(),
    // First 12 characters ('ack_' + 8), for logs and the M7 list.
    tokenPrefix: text("token_prefix").notNull(),
    // Null = valid until the grant is revoked (C32 (a)).
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // Refresh rotation only: a used old refresh token is a theft signal and revokes the grant.
    replacedAt: timestamp("replaced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "partner_tokens_grant_fk",
      columns: [t.storeId, t.grantId],
      foreignColumns: [partnerGrants.storeId, partnerGrants.id],
    }).onDelete("cascade"),
    index("partner_tokens_grant_id_idx").on(t.grantId),
    check("partner_tokens_kind_chk", sql`${t.kind} in ('access', 'refresh')`),
  ],
);
