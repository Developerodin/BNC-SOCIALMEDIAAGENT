import { eq } from "drizzle-orm";
import { forStore } from "@/db/client";
import { storeTokens } from "@/db/schema";
import { isCustomerGid } from "@/lib/chat/customer";
import { decrypt, encrypt } from "@/lib/crypto";
import { adminGraphql } from "./admin";

// Verifying a legacy-customer-accounts `customerAccessToken` (the mobile app holds one) needs the Storefront API, which
// takes its own token. AskCart creates one per store with the Admin API (storefrontAccessTokenCreate, offline token) and
// keeps it encrypted in store_tokens. It carries the app's unauthenticated_* scopes as of creation time, so a token made
// before the merchant approved unauthenticated_read_customers can't read customers: such a store answers "unavailable"
// until its storefront token is deleted (store_tokens.storefront_token_enc cleared) and a fresh one is made.

// Matches ApiVersion.October26 in api.ts.
const STOREFRONT_VERSION = "2026-10";

const CREATE = `mutation($input: StorefrontAccessTokenInput!) {
  storefrontAccessTokenCreate(input: $input) { storefrontAccessToken { accessToken } userErrors { message } }
}`;

export type CustomerCheck = { ok: true; customerGid: string } | { ok: false; reason: "invalid" | "unavailable" };

async function cached(storeId: string): Promise<string | null> {
  return forStore(storeId, async (tx) => {
    const [t] = await tx.select({ enc: storeTokens.storefrontTokenEnc }).from(storeTokens).where(eq(storeTokens.storeId, storeId));
    return t?.enc ? decrypt(t.enc, storeId) : null;
  });
}

async function save(storeId: string, token: string): Promise<void> {
  await forStore(storeId, (tx) =>
    tx.update(storeTokens).set({ storefrontTokenEnc: encrypt(token, storeId) }).where(eq(storeTokens.storeId, storeId)),
  );
}

/** Two first sign-ins at once each create a token and the later save wins; the spare is harmless (Shopify allows 100 per app and store). */
async function create(storeId: string, shop: string): Promise<string> {
  const data = await adminGraphql<{
    storefrontAccessTokenCreate: { storefrontAccessToken: { accessToken: string } | null; userErrors: unknown[] };
  }>(storeId, shop, CREATE, { input: { title: "AskCart customer sign-in" } });
  const token = data.storefrontAccessTokenCreate.storefrontAccessToken?.accessToken;
  if (!token) throw new Error("storefrontAccessTokenCreate returned no token");
  await save(storeId, token);
  return token;
}

/** Asks the Storefront API who owns `customerAccessToken`. null = Shopify says no such (or expired) customer; "denied" = our storefront token was refused. */
async function whoOwns(shop: string, storefrontToken: string, customerAccessToken: string): Promise<string | null | "denied"> {
  const res = await fetch(`https://${shop}/api/${STOREFRONT_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Storefront-Access-Token": storefrontToken },
    body: JSON.stringify({
      query: "query($t: String!) { customer(customerAccessToken: $t) { id } }",
      variables: { t: customerAccessToken },
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 401 || res.status === 403) return "denied";
  if (!res.ok) throw new Error(`Storefront API ${res.status}`);
  const body = (await res.json()) as { data?: { customer: { id: string } | null } | null; errors?: unknown[] };
  // An ACCESS_DENIED error means the token lacks unauthenticated_read_customers; treat like a refused token.
  if (body.errors?.length || !body.data) return "denied";
  return body.data.customer?.id ?? null;
}

/**
 * Verifies a legacy customer's access token. Never logs or returns the token. "unavailable" (→ 503) covers every failure that
 * isn't Shopify saying the customer is invalid: no Admin token, scope not approved yet, Shopify down, timeout.
 */
export async function verifyCustomerAccessToken(storeId: string, shop: string, customerAccessToken: string): Promise<CustomerCheck> {
  try {
    let token = await cached(storeId);
    let owner = token ? await whoOwns(shop, token, customerAccessToken) : "denied";
    if (owner === "denied") {
      // None stored yet, merchant deleted ours, or it predates the scope approval: make a new one and retry once.
      token = await create(storeId, shop);
      owner = await whoOwns(shop, token, customerAccessToken);
    }
    if (owner === "denied") return { ok: false, reason: "unavailable" };
    // Storefront GIDs can carry a "?key=" suffix; the canonical GID is what conversations are owned by.
    const gid = owner?.split("?")[0];
    return isCustomerGid(gid) ? { ok: true, customerGid: gid } : { ok: false, reason: "invalid" };
  } catch (err) {
    console.error("customer token check failed", { storeId, error: err instanceof Error ? err.name : typeof err });
    return { ok: false, reason: "unavailable" };
  }
}
