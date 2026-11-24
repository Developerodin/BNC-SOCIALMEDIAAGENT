import { storeFor } from "@/lib/chat/cors";
import { mintSession } from "@/lib/chat/customer";
import { verifyCustomerAccessToken } from "@/lib/shopify/storefront";

// POST /api/chat/session (mobile app only): trades a legacy-customer-accounts customerAccessToken for an AskCart customer
// session (docs/mobile-api.md). Shopify's Storefront API says who the token belongs to; nothing else is trusted. The
// customerAccessToken is never logged, stored or echoed. Website requests (with an Origin) get the proxy route instead and
// are refused here: a page script handling customer tokens is exactly what the proxy avoids. No `runtime` export.

const MAX_TOKEN = 512;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "unknown_shop" }, { status: 404 });
  const found = await storeFor(req, body.shop);
  if (found instanceof Response) return found;
  const headers = { "Cache-Control": "no-store" };
  if (req.headers.get("origin")) return new Response(null, { status: 403, headers });

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
