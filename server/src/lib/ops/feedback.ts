import { sql } from "drizzle-orm";
import { db, forStore } from "@/db/client";
import { FEEDBACK_REASONS, type FeedbackReason } from "@/db/schema";

// Internal feedback analytics for the AskCart team (never shown to merchants): thumbs per store and in total, the reasons
// behind the thumbs-down, and the latest thumbs-down answers with the question that led to each.
//
// This reads across stores without bypassing RLS: like the retention job, it lists the stores (no RLS on that table) and
// runs one forStore() read per store on the normal app_user connection. All statements are selects. Ceiling: one
// transaction per store per page view, fine for tens to low hundreds of stores; past that, add a read-only role or a
// summary table instead of widening app_user.

export const TEXT_MAX = 300;
export const LATEST = 50;
const DAY_MS = 86_400_000;

export type Range = { from: Date; to: Date }; // from inclusive, to exclusive, both UTC midnights
export type Counts = { answers: number; up: number; down: number; reasons: Record<FeedbackReason | "none", number> };
export type StoreStats = { storeId: string; shop: string } & Counts;
export type DownAnswer = { shop: string; at: Date; reason: FeedbackReason | null; question: string | null; answer: string };
export type FeedbackReport = { stores: StoreStats[]; total: Counts; latest: DownAnswer[] };

const emptyCounts = (): Counts => ({
  answers: 0,
  up: 0,
  down: 0,
  reasons: { wrong_products: 0, wrong_price_stock: 0, misunderstood: 0, unclear: 0, other: 0, none: 0 },
});

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
function day(v: string): Date | null {
  const m = DATE.exec(v);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? d : null;
}

/** `from` and `to` are inclusive UTC dates (YYYY-MM-DD). Both absent → the last 30 days up to and including today. null = invalid. */
export function parseRange(from: string | null, to: string | null, now = new Date()): Range | null {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = from ? day(from) : new Date(today.getTime() - 29 * DAY_MS);
  const last = to ? day(to) : today;
  if (!start || !last || start > last) return null;
  if ((last.getTime() - start.getTime()) / DAY_MS > 366) return null; // keeps one page view cheap
  return { from: start, to: new Date(last.getTime() + DAY_MS) };
}

const clip = (s: string) => (s.length > TEXT_MAX ? s.slice(0, TEXT_MAX) + "…" : s);

export async function feedbackReport(range: Range): Promise<FeedbackReport> {
  const from = range.from.toISOString();
  const to = range.to.toISOString();
  const shops = await db.execute<{ id: string; shop_domain: string }>(sql`select id, shop_domain from stores order by shop_domain`);
  const stores: StoreStats[] = [];
  const total = emptyCounts();
  const latest: DownAnswer[] = [];

  for (const s of shops) {
    const { counts, down } = await forStore(s.id, async (tx) => {
      await tx.execute(sql`set transaction read only`);
      const rows = await tx.execute<{ answers: number; up: number; down: number; reason: FeedbackReason | null }>(sql`
        select count(*)::int as answers,
               count(*) filter (where rating = 1)::int as up,
               count(*) filter (where rating = -1)::int as down,
               feedback_reason as reason
        from messages
        where store_id = ${s.id} and role = 'assistant' and status = 'ok'
          and created_at >= ${from}::timestamptz and created_at < ${to}::timestamptz
        group by feedback_reason`);
      const counts = emptyCounts();
      for (const r of rows) {
        counts.answers += r.answers;
        counts.up += r.up;
        counts.down += r.down;
        counts.reasons[r.reason ?? "none"] += r.down; // a reason only exists on a thumbs-down (check constraint)
      }
      const down = await tx.execute<{ created_at: Date; reason: FeedbackReason | null; answer: string; question: string | null }>(sql`
        select m.created_at, m.feedback_reason as reason, left(m.content, ${TEXT_MAX + 1}) as answer,
               (select left(u.content, ${TEXT_MAX + 1}) from messages u
                 where u.store_id = m.store_id and u.conversation_id = m.conversation_id and u.role = 'user'
                   and u.created_at <= m.created_at
                 order by u.created_at desc limit 1) as question
        from messages m
        where m.store_id = ${s.id} and m.role = 'assistant' and m.rating = -1
          and m.created_at >= ${from}::timestamptz and m.created_at < ${to}::timestamptz
        order by m.created_at desc limit ${LATEST}`);
      return { counts, down };
    });
    stores.push({ storeId: s.id, shop: s.shop_domain, ...counts });
    total.answers += counts.answers;
    total.up += counts.up;
    total.down += counts.down;
    for (const k of Object.keys(total.reasons) as (keyof Counts["reasons"])[]) total.reasons[k] += counts.reasons[k];
    for (const d of down) {
      latest.push({ shop: s.shop_domain, at: new Date(d.created_at), reason: d.reason, question: d.question === null ? null : clip(d.question), answer: clip(d.answer) });
    }
  }
  latest.sort((a, b) => b.at.getTime() - a.at.getTime());
  stores.sort((a, b) => b.down - a.down || b.answers - a.answers || a.shop.localeCompare(b.shop));
  return { stores, total, latest: latest.slice(0, LATEST) };
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v: string | number) => String(v).replace(/[&<>"']/g, (c) => ESC[c]);

export const REASON_LABEL: Record<FeedbackReason | "none", string> = {
  wrong_products: "Wrong products",
  wrong_price_stock: "Wrong price/stock",
  misunderstood: "Misunderstood",
  unclear: "Too long/unclear",
  other: "Other",
  none: "No reason",
};

const pct = (c: Counts) => (c.up + c.down === 0 ? "-" : `${((c.down / (c.up + c.down)) * 100).toFixed(1)}%`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Plain server-rendered HTML; every dynamic value goes through esc(), so shopper text is only ever text. */
export function renderReport(r: FeedbackReport, range: Range): string {
  const keys = [...FEEDBACK_REASONS, "none"] as const;
  const row = (label: string, c: Counts, strong = false) =>
    `<tr${strong ? ' class="t"' : ""}><th scope="row">${esc(label)}</th><td>${c.answers}</td><td>${c.up}</td><td>${c.down}</td><td>${pct(c)}</td>${keys
      .map((k) => `<td>${c.reasons[k]}</td>`)
      .join("")}</tr>`;
  const recent = r.latest
    .map(
      (d) =>
        `<tr><td>${esc(d.shop)}</td><td>${esc(d.at.toISOString().slice(0, 16).replace("T", " "))}</td><td>${esc(REASON_LABEL[d.reason ?? "none"])}</td><td class="x">${
          d.question === null ? "-" : esc(d.question)
        }</td><td class="x">${esc(d.answer)}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Feedback (internal)</title>
<style>body{font:14px/1.4 system-ui,sans-serif;margin:16px;color:#111}table{border-collapse:collapse;margin:8px 0 24px}th,td{border:1px solid #ccc;padding:4px 8px;text-align:right;vertical-align:top}th[scope=row],td.x,thead th{text-align:left}td.x{max-width:420px;white-space:pre-wrap;overflow-wrap:anywhere}tr.t{font-weight:600;background:#f3f3f3}.s{overflow-x:auto}</style></head><body>
<h1>Feedback across stores</h1>
<form method="get"><label>From <input type="date" name="from" value="${esc(ymd(range.from))}"></label> <label>To (inclusive) <input type="date" name="to" value="${esc(
    ymd(new Date(range.to.getTime() - DAY_MS)),
  )}"></label> <button type="submit">Show</button> <small>UTC dates. Answers = finished assistant answers; % down = thumbs down of rated answers.</small></form>
<div class="s"><table><thead><tr><th>Store</th><th>Answers</th><th>Up</th><th>Down</th><th>% down</th>${keys.map((k) => `<th>${esc(REASON_LABEL[k])}</th>`).join("")}</tr></thead><tbody>${row(
    "All stores",
    r.total,
    true,
  )}${r.stores.map((s) => row(s.shop, s)).join("")}</tbody></table></div>
<h2>Latest ${LATEST} thumbs-down answers</h2>
<div class="s"><table><thead><tr><th>Store</th><th>When (UTC)</th><th>Reason</th><th>Shopper asked</th><th>Answer</th></tr></thead><tbody>${recent || '<tr><td colspan="5">None in this range.</td></tr>'}</tbody></table></div>
</body></html>`;
}
