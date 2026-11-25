import { adminGraphql } from "./admin";

// App-data metafields live on our own AppInstallation: only this app can read or write them (Admin GraphQL, or the
// Liquid `app` object in our theme app extension), so a plain namespace works and `$app` isn't needed. Writing to the
// app's own installation needs no access scope. Docs, 2026-10:
// https://shopify.dev/docs/apps/build/custom-data/ownership (App-data metafields)
// https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/metafieldsSet
const INSTALLATION = `{ currentAppInstallation { id } }`;
const SET = `mutation SetAppData($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } }
}`;

type SetData = { metafieldsSet: { metafields: { id: string }[] | null; userErrors: { field: string[] | null; message: string }[] } };

/**
 * Writes one `json` metafield on the app's installation in the shop. Returns the userErrors' messages (empty on success).
 * Throws when the Admin call itself fails (throttled, expired token).
 * ponytail: two calls per write; the installation id could be cached, but writes only happen when the value changes.
 */
export async function setAppDataJson(storeId: string, shop: string, namespace: string, key: string, value: unknown): Promise<string[]> {
  const { currentAppInstallation } = await adminGraphql<{ currentAppInstallation: { id: string } }>(storeId, shop, INSTALLATION);
  const { metafieldsSet } = await adminGraphql<SetData>(storeId, shop, SET, {
    metafields: [{ ownerId: currentAppInstallation.id, namespace, key, type: "json", value: JSON.stringify(value) }],
  });
  return metafieldsSet.userErrors.map((e) => `${(e.field ?? []).join(".")}: ${e.message}`);
}
