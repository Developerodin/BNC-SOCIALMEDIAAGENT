import { readSmallBytes, withStore } from "@/lib/admin-route";
import { rateLimit } from "@/lib/rate-limit";
import { LogoUploadError, MAX_LOGO_BYTES, sniffLogoType, uploadLogo } from "@/lib/shopify/logo";
import { forceTokenExchange } from "@/lib/shopify/session";

// The "Chat widget" card's logo upload: the request body is the image itself (PNG, JPG or WebP, up to 2 MB). It is
// stored in the store's Shopify Files and the answer is its cdn.shopify.com URL, which the card then saves as avatarUrl.
// Needs the optional write_files and read_files scopes; a store that has not approved them yet gets 403 missing_scope.

const UPLOADS_PER_MINUTE = 6;

export function POST(req: Request) {
  return withStore(req, async ({ storeId, shop }) => {
    const wait = rateLimit(`logo:${storeId}`, Date.now(), UPLOADS_PER_MINUTE);
    if (wait) return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(wait) } });

    // Over the cap is 413 before anything is buffered; the type comes from the bytes, not the Content-Type header.
    const bytes = await readSmallBytes(req, MAX_LOGO_BYTES);
    const type = bytes && sniffLogoType(bytes);
    if (!bytes || !type) return Response.json({ error: "invalid_type" }, { status: 415 });

    try {
      try {
        return Response.json({ url: await uploadLogo(storeId, shop, bytes, type) });
      } catch (e) {
        if (!(e instanceof LogoUploadError && e.kind === "missing_scope")) throw e;
        // The merchant may have approved the scopes just now, while the stored token predates it: one new token exchange,
        // then one more try. Still denied means they have not approved (the card asks via App Bridge, then retries).
        await forceTokenExchange(req);
        return Response.json({ url: await uploadLogo(storeId, shop, bytes, type) });
      }
    } catch (e) {
      if (e instanceof Response) return e; // 401 from the exchange
      if (e instanceof LogoUploadError && e.kind === "missing_scope") return Response.json({ error: "missing_scope" }, { status: 403 });
      console.error("logo upload failed:", e instanceof Error ? e.message : "error"); // never the file
      return Response.json({ error: "upload_failed" }, { status: 502 });
    }
  });
}
