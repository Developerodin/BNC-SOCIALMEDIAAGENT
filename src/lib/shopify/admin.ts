import { Session } from "@shopify/shopify-api";
import { shopify } from "./api";
import { getAccessToken } from "./tokens";

/** Runs an Admin GraphQL operation with the store's offline token and returns `data`. The only place that builds a Shopify GraphQL client. Throws on GraphQL errors. */
export async function adminGraphql<T>(storeId: string, shop: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const session = new Session({ id: `offline_${shop}`, shop, state: "", isOnline: false, accessToken: await getAccessToken(storeId) });
  const { data } = await new shopify.clients.Graphql({ session }).request<T>(query, { variables });
  return data!;
}
