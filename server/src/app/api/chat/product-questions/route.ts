import { preflight, storeFor } from "@/lib/chat/cors";
import { productQuestionsFor } from "@/lib/chat/product-questions";
import { productGid } from "@/lib/ids";
import type { ProductQuestionsResponse } from "@/lib/widget-contract";

// GET /api/chat/product-questions?shop=…&product=<numeric id or GID>&locale=<e.g. fr-CA>: public, CORS and rate limits like
// the other chat routes. 0 to 3 AI-written questions for the product-page block when the merchant wrote none. Always 200
// with a list once shop, Origin, product and locale are valid: an mcp store, an unknown or unpublished product, a gift
// card or any OpenAI or database problem is an empty list, never a 500. `locale` is optional (English); it only picks
// one of the widget's six languages. Cached an hour by the browser; a failed generation only 60 s, so it retries soon.
// No `runtime` export (cacheComponents doesn't support it).

const LOCALE = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8}){0,3}$/;

export function OPTIONS(req: Request) {
  return preflight(req, { methods: "GET, OPTIONS", headers: "Content-Type" });
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const found = await storeFor(req, params.get("shop"));
  if (found instanceof Response) return found;

  const bad = (error: string) => Response.json({ error }, { status: 400, headers: { ...found.cors, "Cache-Control": "no-store" } });
  const product = productGid(params.get("product"));
  if (!product) return bad("invalid_product");
  const locale = params.get("locale") ?? "en";
  if (!LOCALE.test(locale)) return bad("invalid_locale");

  const reply = (body: ProductQuestionsResponse, maxAge: number) =>
    Response.json(body, { headers: { ...found.cors, "Cache-Control": `public, max-age=${maxAge}` } });
  // An mcp store has no synced products.
  if (found.store.mode === "mcp") return reply({ questions: [] }, 3600);
  try {
    const r = await productQuestionsFor(found.store.id, product, locale);
    return reply({ questions: r.questions }, r.failed ? 60 : 3600);
  } catch (err) {
    console.warn("product questions route failed", { reason: (err as { code?: string } | null)?.code ?? "error" });
    return reply({ questions: [] }, 60);
  }
}
