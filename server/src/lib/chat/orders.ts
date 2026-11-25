import type { FunctionTool } from "openai/resources/responses/responses";
import { adminGraphql } from "@/lib/shopify/admin";
import { httpsUrl } from "@/lib/shopify/live-products";
import { withTimeout } from "./openai";
import { sanitizeData } from "./prompt";
import type { ToolContext } from "./tools";

// order_status: a signed-in shopper's own recent orders, read live from the Admin API. The customer is always the
// session's verified GID (ToolContext.customer, set by the route from the signed X-AskCart-Customer session): the model
// passes no id, and orders are never searched store-wide, by number alone or by email. Only the fields below are kept, so
// addresses, emails, phones, payment data, notes and prices never reach the model.
// The orders are read with the root `orders(query: "customer_id:<id>")`, which needs only read_orders; `customer(id:)` would
// need read_customers, which the app doesn't have.
// Failure modes: Admin error, timeout or a missing token -> one "temporarily unavailable" sentence (the tool loop never sees
// a throw). Ceiling: only the 5 most recent orders are fetched, so an older order is "not found among recent orders" and the
// model points the shopper to the store's account page.

const TIMEOUT_MS = 3000;
const ORDERS = 5;
const LINE_ITEMS = 10;
const MAX_CHARS = 3000;
const MAX_TEXT = 100;

export const ORDER_STATUS_DEF: FunctionTool = {
  type: "function",
  name: "order_status",
  description:
    "Look up the signed-in shopper's own recent orders: order status, delivery, shipping and tracking. Call it when the shopper asks about their own order, delivery, shipping status or tracking. Only their 5 most recent orders are visible.",
  strict: true,
  parameters: {
    type: "object",
    properties: {
      order_number: { type: ["string", "null"], description: "The order number the shopper mentioned, for example '#1042' or '1042'. Null to list their recent orders." },
    },
    required: ["order_number"],
    additionalProperties: false,
  },
};

const QUERY = `query CustomerOrders($query: String!) {
  orders(first: ${ORDERS}, sortKey: CREATED_AT, reverse: true, query: $query) {
    nodes {
      name createdAt displayFinancialStatus displayFulfillmentStatus cancelledAt
      lineItems(first: ${LINE_ITEMS}) { nodes { title variantTitle quantity } }
      fulfillments(first: 5) { status trackingInfo(first: 3) { company number url } }
    }
  }
}`;

type OrderNode = {
  name?: unknown;
  createdAt?: unknown;
  displayFinancialStatus?: unknown;
  displayFulfillmentStatus?: unknown;
  cancelledAt?: unknown;
  lineItems?: { nodes?: { title?: unknown; variantTitle?: unknown; quantity?: unknown }[] };
  fulfillments?: { status?: unknown; trackingInfo?: { company?: unknown; number?: unknown; url?: unknown }[] }[];
};

const WINDOW_NOTE = "Only the 5 most recent orders are visible here; an older order may exist that is not shown, and the shopper can find it on the store's account page.";
const UNAVAILABLE = "Order lookup is temporarily unavailable. Suggest the shopper checks their order confirmation email or the store's account page.";

const str = (v: unknown, max = MAX_TEXT): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const day = (v: unknown): string => str(v, 10);
const status = (v: unknown): string => str(v, 40).toLowerCase().replace(/_/g, " ") || "unknown";
const arr = <T>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : []);

/** "#1042", "1042" and "# 1042" all compare as "1042". */
const normalize = (n: string) => n.replace(/[#\s]/g, "").toLowerCase();
/** An exact name match, or a bare number matching the digits an order name ends with (a store prefix such as "AC-1042"). */
function sameOrder(name: string, wanted: string): boolean {
  const a = normalize(name);
  return a === wanted || (/^\d+$/.test(wanted) && a.endsWith(wanted) && !/\d/.test(a.charAt(a.length - wanted.length - 1)));
}

function describe(o: OrderNode): string {
  const lines = [`Order ${str(o.name, 40)}, placed ${day(o.createdAt)}`];
  lines.push(`Payment: ${status(o.displayFinancialStatus)}. Fulfillment: ${status(o.displayFulfillmentStatus)}.`);
  lines.push(o.cancelledAt ? `Cancelled: yes, on ${day(o.cancelledAt)}` : "Cancelled: no");
  for (const li of arr(o.lineItems?.nodes).slice(0, LINE_ITEMS)) {
    const variant = str(li.variantTitle);
    const qty = typeof li.quantity === "number" ? li.quantity : 0;
    lines.push(`Item: ${str(li.title)}${variant && variant !== "Default Title" ? ` (${variant})` : ""} x${qty}`);
  }
  for (const f of arr(o.fulfillments)) {
    lines.push(`Shipment: ${status(f.status)}`);
    for (const t of arr(f.trackingInfo)) {
      const url = httpsUrl(typeof t.url === "string" ? t.url : null);
      const parts = [str(t.company) && `carrier ${str(t.company)}`, str(t.number) && `tracking number ${str(t.number)}`, url && `tracking link ${url}`].filter(Boolean);
      if (parts.length) lines.push(`  ${parts.join(", ")}`);
    }
  }
  return sanitizeData(lines.join("\n"));
}

async function fetchOrders(ctx: ToolContext, customer: string): Promise<OrderNode[] | null> {
  try {
    // The numeric id of the verified session GID, never anything the model or the shopper wrote.
    const id = customer.slice(customer.lastIndexOf("/") + 1);
    const data = await withTimeout(
      adminGraphql<{ orders?: { nodes?: OrderNode[] } }>(ctx.store.id, ctx.store.shopDomain, QUERY, { query: `customer_id:${id}` }),
      TIMEOUT_MS,
      ctx.signal,
    );
    return arr(data?.orders?.nodes);
  } catch (err) {
    // Store id and error name only: never order contents or the shopper's text.
    console.warn("order lookup failed", { storeId: ctx.store.id, error: err instanceof Error ? err.name : typeof err });
    return null;
  }
}

/** The order_status result text (the caller wraps it in <store_data>). Never throws. */
export async function orderStatus(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  // Defence in depth: turn.ts only offers the tool to a verified customer of an installed store.
  if (!ctx.customer || ctx.store.mode === "mcp") return "Order lookup needs the shopper to be signed in to their store account.";
  const wanted = typeof args.order_number === "string" ? normalize(args.order_number.slice(0, 40)) : "";
  const all = await fetchOrders(ctx, ctx.customer);
  if (all === null) return UNAVAILABLE;
  if (all.length === 0) return "No orders found for this shopper.";

  const orders = wanted ? all.filter((o) => sameOrder(str(o.name, 40), wanted)) : all;
  if (orders.length === 0) return sanitizeData(`Order ${str(args.order_number, 40)} was not found among the shopper's ${all.length} most recent orders. ${WINDOW_NOTE}`);

  const out: string[] = [];
  let size = 0;
  for (const o of orders) {
    const block = describe(o);
    if (out.length && size + block.length > MAX_CHARS) break;
    out.push(block.slice(0, MAX_CHARS));
    size += block.length;
  }
  if (out.length < orders.length) out.push(`(${orders.length - out.length} more recent orders not listed)`);
  out.push(WINDOW_NOTE);
  return out.join("\n\n");
}
