import { createHash, timingSafeEqual } from "node:crypto";
import { feedbackReport, parseRange, renderReport } from "@/lib/ops/feedback";

// GET /ops/feedback?from=YYYY-MM-DD&to=YYYY-MM-DD: internal feedback analytics for the AskCart team (all stores), plain
// server-rendered HTML. HTTP Basic auth: any user name, the password is OPS_SECRET. OPS_SECRET unset or empty → 404, so
// the page is never open. Never cached, never indexed.

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
const sha = (s: string) => createHash("sha256").update(s).digest();

function authorized(req: Request, secret: string): boolean {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return false;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;
  // Hash both sides so the compare is constant-time and doesn't leak the secret's length.
  return timingSafeEqual(sha(decoded.slice(colon + 1)), sha(secret));
}

export async function GET(req: Request) {
  const secret = process.env.OPS_SECRET;
  if (!secret) return new Response("Not found", { status: 404, headers: HEADERS });
  if (!authorized(req, secret)) {
    return new Response("Unauthorized", { status: 401, headers: { ...HEADERS, "WWW-Authenticate": 'Basic realm="AskCart ops", charset="UTF-8"' } });
  }
  const q = new URL(req.url).searchParams;
  const range = parseRange(q.get("from"), q.get("to"));
  if (!range) return new Response("Bad date range (from/to as YYYY-MM-DD, from <= to, at most 366 days)", { status: 400, headers: HEADERS });
  const html = renderReport(await feedbackReport(range), range);
  return new Response(html, { headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8" } });
}
