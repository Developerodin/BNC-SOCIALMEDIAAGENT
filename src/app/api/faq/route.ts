import { preflight, storeFor } from "@/lib/chat/cors";
import { faqProductGid, productFaqs } from "@/lib/faq";

// GET /api/faq?shop=…&product=<numeric id or GID> (Task 28, D32, D7): public, CORS like chat, one product's FAQ.
// Caching: with cacheComponents a GET handler is prerendered only when it touches no request data; this one reads
// req.url and the Origin, so it runs per request (route-handlers.md, "With Cache Components"). The 5-minute cache is
// the browser's, via Cache-Control, with Vary: Origin because the CORS header echoes the Origin. An FAQ edit (M7) can
// therefore take up to 5 minutes to show. An unknown product's empty list is cached too. No `runtime` export.

export function OPTIONS(req: Request) {
  return preflight(req, { methods: "GET, OPTIONS", headers: "Content-Type" });
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const found = await storeFor(req, params.get("shop"));
  if (found instanceof Response) return found;

  const product = faqProductGid(params.get("product"));
  if (!product) return Response.json({ error: "invalid_product" }, { status: 400, headers: { ...found.cors, "Cache-Control": "no-store" } });

  const items = await productFaqs(found.store.id, product);
  return Response.json({ items }, { headers: { ...found.cors, "Cache-Control": "public, max-age=300" } });
}
