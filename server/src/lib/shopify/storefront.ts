import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { forStore } from "@/db/client";
import { storeTokens } from "@/db/schema";
import { isCustomerGid } from "@/lib/chat/customer";
import { decrypt, encrypt } from "@/lib/crypto";
import { adminGraphql } from "./admin";

// Verifying a legacy-customer-accounts `customerAccessToken` (the mobile app holds one) needs the Storefront API, which
// takes its own token. AskCart creates one per store with the Admin API (storefrontAccessTokenCreate, offline token) and
// keeps it encrypted in store_tokens. It carries the app's unauthenticated_* scopes as of creation time, so a token made
// before the merchant approved unauthenticated_read_customers can't read customers. Such a token is refused, and a
// refusal makes a replacement, but at most one an hour per store (store_tokens.storefront_token_minted_at): until the
// scope is approved the store answers "unavailable" rather than minting toward Shopify's cap of 100 per app and store.
// Our earlier tokens are deleted from Shopify when the new one is saved.

// Matches ApiVersion.October26 in api.ts.
const STOREFRONT_VERSION = "2026-10";

const CREATE = `mutation($input: StorefrontAccessTokenInput!) {
  storefrontAccessTokenCreate(input: $input) { storefrontAccessToken { accessToken } userErrors { message } }
}`;

const MINT_TITLE = "AskCart customer sign-in";
const LIST = `{ shop { storefrontAccessTokens(first: 100) { nodes { id accessToken title } } } }`;
const DELETE = `mutation($input: StorefrontAccessTokenDeleteInput!) { storefrontAccessTokenDelete(input: $input) { userErrors { message } } }`;

type CustomerCheck = { ok: true; customerGid: string } | { ok: false; reason: "invalid" | "unavailable" };

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

/**
 * Claims the right to mint: succeeds for at most one caller per store per hour (an atomic update, so two sign-ins at
 * once can't both mint). Returns the previous claim time so a failed mint can give the claim back.
 */
async function claimMint(storeId: string): Promise<{ prev: Date | null } | null> {
  return forStore(storeId, async (tx) => {
    const [t] = await tx.select({ at: storeTokens.storefrontTokenMintedAt }).from(storeTokens).where(eq(storeTokens.storeId, storeId));
    const at = storeTokens.storefrontTokenMintedAt;
    const won = await tx
      .update(storeTokens)
      .set({ storefrontTokenMintedAt: sql`now()` })
      .where(and(eq(storeTokens.storeId, storeId), or(isNull(at), lt(at, sql`now() - interval '1 hour'`))))
      .returning({ id: storeTokens.storeId });
    return won.length ? { prev: t?.at ?? null } : null;
  });
}

/** Best effort: removes our earlier storefront tokens (by title) from Shopify so spares don't pile up toward the cap of 100. */
async function deleteOld(storeId: string, shop: string, keep: string): Promise<void> {
  try {
    const data = await adminGraphql<{ shop?: { storefrontAccessTokens?: { nodes: { id: string; accessToken: string; title: string }[] } } }>(storeId, shop, LIST);
    for (const n of data?.shop?.storefrontAccessTokens?.nodes ?? []) {
      if (n.title === MINT_TITLE && n.accessToken !== keep) await adminGraphql(storeId, shop, DELETE, { input: { id: n.id } });
    }
  } catch (err) {
    console.warn("old storefront token cleanup failed", { storeId, error: err instanceof Error ? err.name : typeof err });
  }
}

/** Makes and saves a storefront token, or returns null when one was already made within the hour. */
async function create(storeId: string, shop: string): Promise<string | null> {
  const claim = await claimMint(storeId);
  if (!claim) return null;
  try {
    const data = await adminGraphql<{
      storefrontAccessTokenCreate: { storefrontAccessToken: { accessToken: string } | null; userErrors: unknown[] };
    }>(storeId, shop, CREATE, { input: { title: MINT_TITLE } });
    const token = data.storefrontAccessTokenCreate.storefrontAccessToken?.accessToken;
    if (!token) throw new Error("storefrontAccessTokenCreate returned no token");
    await save(storeId, token);
    // Not awaited: up to ~99 Admin calls on the first replacement shouldn't hold up this sign-in; deleteOld never throws.
    void deleteOld(storeId, shop, token);
    return token;
  } catch (err) {
    // Nothing was made (or it couldn't be kept): give the claim back so the next sign-in can try.
    await forStore(storeId, (tx) =>
      tx.update(storeTokens).set({ storefrontTokenMintedAt: claim.prev }).where(eq(storeTokens.storeId, storeId)),
    );
    throw err;
  }
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
  // Only an ACCESS_DENIED error counts (a throttle or outage must not mint tokens up to Shopify's cap of 100).
  const errors = (body.errors ?? []) as { extensions?: { code?: string } }[];
  if (errors.some((e) => e.extensions?.code === "ACCESS_DENIED")) return "denied";
  if (errors.length || !body.data) throw new Error("Storefront API error");
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
      // None stored yet, merchant deleted ours, or it predates the scope approval: make a new one and retry once,
      // unless one was made in the last hour (then the store stays "unavailable" until the scope is approved).
      token = await create(storeId, shop);
      if (!token) return { ok: false, reason: "unavailable" };
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
