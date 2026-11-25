import { storeFor } from "@/lib/chat/cors";
import { MOBILE_KEY_HEADER } from "@/lib/chat/mobile-key";
import { mintSession } from "@/lib/chat/customer";
import { verifyCustomerAccessToken } from "@/lib/shopify/storefront";

// POST /api/chat/session (mobile app only): trades a legacy-customer-accounts customerAccessToken for an AskCart customer
// session (docs/mobile-api.md). Shopify's Storefront API says who the token belongs to; nothing else is trusted. The
// customerAccessToken is never logged, stored or echoed. Website requests (with an Origin) get the proxy route instead and
// are refused here: a page script handling customer tokens is exactly what the proxy avoids. No `runtime` export.

const MAX_TOKEN = 512;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "invalid_body" }, { status: 400 });
  const headers = { "Cache-Control": "no-store" };
  // Always the app key: storeFor would also let a Sec-Fetch-Site or website-Origin caller through, and this route is a
  // customer-token oracle, so only the key-checked, rate-limited app path may reach it.
  if (req.headers.get("origin") || !req.headers.get(MOBILE_KEY_HEADER)) return new Response(null, { status: 403, headers });
  const found = await storeFor(req, body.shop);
  if (found instanceof Response) return found;

  const t = body.customerAccessToken;
  if (typeof t !== "string" || !t || t.length > MAX_TOKEN) return Response.json({ error: "invalid_customer" }, { status: 401, headers });
  const checked = await verifyCustomerAccessToken(found.store.id, found.store.shopDomain, t);
  if (!checked.ok) {
    return checked.reason === "invalid"
      ? Response.json({ error: "invalid_customer" }, { status: 401, headers })
      : Response.json({ error: "session_unavailable" }, { status: 503, headers: { ...headers, "Retry-After": "30" } });
  }
  const { token, expiresAt } = mintSession(found.store.id, checked.customerGid);
  return Response.json({ sessionToken: token, expiresAt }, { headers });
}
