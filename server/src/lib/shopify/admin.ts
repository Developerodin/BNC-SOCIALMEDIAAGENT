import { Session } from "@shopify/shopify-api";
import { shopify } from "./api";
import { recordThrottle, recordThrottled } from "./throttle";
import { getAccessToken } from "./tokens";

/** Runs an Admin GraphQL operation with the store's offline token and returns `data`. The only place that builds a Shopify GraphQL client. Throws on GraphQL errors. Remembers the cost bucket's state (throttle.ts). */
export async function adminGraphql<T>(storeId: string, shop: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const session = new Session({ id: `offline_${shop}`, shop, state: "", isOnline: false, accessToken: await getAccessToken(storeId) });
  try {
    const { data, extensions } = await new shopify.clients.Graphql({ session }).request<T>(query, { variables });
    recordThrottle(storeId, (extensions as { cost?: Parameters<typeof recordThrottle>[1] } | undefined)?.cost);
    return data!;
  } catch (e) {
    // THROTTLED comes back as a GraphQL error: take the bucket as empty so the product-sync worker waits for it to refill.
    if (/throttl/i.test(e instanceof Error ? e.message : "")) recordThrottled(storeId);
    throw e;
  }
}
