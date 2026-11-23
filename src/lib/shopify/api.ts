import "@shopify/shopify-api/adapters/web-api";
import { ApiVersion, shopifyApi } from "@shopify/shopify-api";

// The installed library (15.1.2) has no LATEST_API_VERSION export; October26 is its newest stable enum value.
export const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET!,
  scopes: ["read_products", "read_inventory"],
  hostName: (process.env.SHOPIFY_APP_URL ?? "").replace(/^https?:\/\//, ""),
  apiVersion: ApiVersion.October26,
  isEmbeddedApp: true,
});
