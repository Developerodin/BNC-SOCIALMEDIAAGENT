import { boolean, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
