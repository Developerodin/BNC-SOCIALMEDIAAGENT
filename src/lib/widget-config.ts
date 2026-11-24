import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { stores } from "@/db/schema";
import { stockThreshold } from "@/lib/chat/turn";
import { setAppDataJson } from "@/lib/shopify/app-metafield";
import type { WidgetConfig } from "@/lib/widget-contract";

// The embed reads `app.metafields.askcart.widget.value` (extensions/askcart/blocks/askcart-embed.liquid).
export const WIDGET_NAMESPACE = "askcart";
export const WIDGET_KEY = "widget";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

/**
 * C23: the look is edited only in M7 Settings, which saves it under `stores.settings.widget` (same field names as
 * WidgetConfig); until then every store gets the defaults. Each bad value falls back to its default and is logged.
 * Never throws. The value is public (page source), so nothing secret goes in here.
 */
export function buildWidgetConfig(store: { settings: unknown; name: string | null }, apiBase: string): WidgetConfig {
  const settings = obj(store.settings);
  const w = obj(settings.widget);
  const launcher = obj(w.launcher);
  const teaser = obj(w.teaser);

  // Takes the merchant's value when it passes `ok`, else the default; logs only values that were set and rejected.
  function pick<T>(field: string, v: unknown, ok: (v: unknown) => boolean, def: T): T {
    if (v === undefined || v === null) return def;
    if (ok(v)) return v as T;
    console.warn("widget config: bad value replaced by its default", { field });
    return def;
  }
  const text = (max: number) => (v: unknown) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
  const int = (min: number, max: number) => (v: unknown) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
  const bool = (v: unknown) => typeof v === "boolean";
  const oneOf = (...xs: unknown[]) => (v: unknown) => xs.includes(v);

  const suggestedRaw = Array.isArray(w.suggested) ? w.suggested : pick<unknown[]>("suggested", w.suggested, () => false, []);
  const suggested = suggestedRaw.filter((q) => text(120)(q)) as string[];
  if (suggested.length !== suggestedRaw.length || suggested.length > 4) console.warn("widget config: suggested questions dropped", { field: "suggested" });

  return {
    v: 1,
    enabled: pick("enabled", w.enabled, bool, true),
    apiBase,
    name: pick("name", w.name, text(40), store.name ?? ""),
    accent: pick("accent", w.accent, (v) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v), "#0A0A0A"),
    avatarUrl: pick("avatarUrl", w.avatarUrl, isShopifyCdnUrl, null), // UD7b
    launcher: {
      style: pick("launcher.style", launcher.style, oneOf("pill", "icon"), "pill"),
      label: pick("launcher.label", launcher.label, text(40), null),
      side: pick("launcher.side", launcher.side, oneOf("right", "left"), "right"),
      offset: pick("launcher.offset", launcher.offset, int(0, 200), 20),
    },
    welcome: pick("welcome", w.welcome, text(300), null),
    suggested: suggested.slice(0, 4),
    teaser: {
      enabled: pick("teaser.enabled", teaser.enabled, bool, false),
      // No limit set by the plan for the teaser line; 120 like a suggested question.
      text: pick("teaser.text", teaser.text, text(120), null),
      delaySec: pick("teaser.delaySec", teaser.delaySec, int(0, 120), 8),
    },
    stockThreshold: stockThreshold(settings), // the server's own threshold, so cards and widget agree
    // D41 retention lives at the top of settings (no editor before M7).
    retentionDays: pick("retentionDays", settings.retentionDays, oneOf(30, 90, 365), 30),
  };
}

function isShopifyCdnUrl(v: unknown): boolean {
  if (typeof v !== "string" || !v.startsWith("https://cdn.shopify.com/")) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname === "cdn.shopify.com";
  } catch {
    return false;
  }
}

/** Our app's https origin. `shopify app dev` sets APP_URL (the tunnel), not SHOPIFY_APP_URL (as in shopify/api.ts). */
export function appOrigin(): string | null {
  const raw = process.env.SHOPIFY_APP_URL || process.env.APP_URL || "";
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Builds the store's widget config and writes it to the app installation metafield, skipping the write when it equals
 * the last one written (stores.widget_config_hash). Called on every app load and by M7's Settings save. Never throws:
 * a failed write leaves the old metafield and no hash, so the next app load retries.
 * Ceilings: in dev a new tunnel reaches the storefront only after the app is opened again; a store never opened since
 * M5 shipped has no metafield, so the embed renders nothing (`// ponytail:` backfill every active store in M10).
 * Two loads at once may both write the same value; harmless.
 */
export async function syncWidgetConfig(storeId: string, shop: string): Promise<void> {
  try {
    const apiBase = appOrigin();
    if (!apiBase) {
      console.error("widget config not written: SHOPIFY_APP_URL/APP_URL is not an https URL", { storeId });
      return;
    }
    const [s] = await db
      .select({ settings: stores.settings, name: stores.name, hash: stores.widgetConfigHash })
      .from(stores)
      .where(eq(stores.id, storeId));
    if (!s) return;
    const config = buildWidgetConfig(s, apiBase);
    const hash = createHash("sha256").update(JSON.stringify(config)).digest("hex");
    if (hash === s.hash) return;

    const errors = await setAppDataJson(storeId, shop, WIDGET_NAMESPACE, WIDGET_KEY, config);
    if (errors.length) {
      console.error("widget config metafieldsSet failed", { storeId, errors });
      return;
    }
    await db.update(stores).set({ widgetConfigHash: hash }).where(eq(stores.id, storeId));
  } catch (e) {
    console.error("widget config sync failed", { storeId }, e);
  }
}
