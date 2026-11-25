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

const RETENTION_DAYS = [30, 90, 365] as const;
/** How long chats are kept (D41), shown in the widget and enforced by src/lib/retention.ts; anything but 30, 90 or 365 is 30. */
export function retentionDays(settings: unknown): 30 | 90 | 365 {
  const v = obj(settings).retentionDays;
  return RETENTION_DAYS.find((d) => d === v) ?? 30;
}

// What a store shows before the merchant writes anything: a welcome and generic questions, in the widget's six
// locales (UD18; English for any other). Merchant text is never translated, so these apply only while unset.
const DEFAULT_COPY: Record<string, { welcome: string; suggested: string[] }> = {
  en: {
    welcome: "Hi! I can help you find products, compare options and answer questions about orders and shipping.",
    suggested: ["What's popular right now?", "Help me find a gift", "What's your return policy?", "Do you ship to my country?"],
  },
  fr: {
    welcome: "Bonjour ! Je peux vous aider à trouver des produits, comparer des options et répondre à vos questions sur les commandes et la livraison.",
    suggested: ["Qu'est-ce qui est populaire en ce moment ?", "Aidez-moi à trouver un cadeau", "Quelle est votre politique de retour ?", "Livrez-vous dans mon pays ?"],
  },
  de: {
    welcome: "Hallo! Ich helfe Ihnen, Produkte zu finden, Optionen zu vergleichen und Fragen zu Bestellungen und Versand zu beantworten.",
    suggested: ["Was ist gerade beliebt?", "Hilf mir, ein Geschenk zu finden", "Wie lautet Ihre Rückgaberegelung?", "Liefern Sie in mein Land?"],
  },
  es: {
    welcome: "¡Hola! Puedo ayudarte a encontrar productos, comparar opciones y resolver dudas sobre pedidos y envíos.",
    suggested: ["¿Qué es lo más popular ahora?", "Ayúdame a encontrar un regalo", "¿Cuál es su política de devoluciones?", "¿Envían a mi país?"],
  },
  it: {
    welcome: "Ciao! Posso aiutarti a trovare prodotti, confrontare opzioni e rispondere a domande su ordini e spedizioni.",
    suggested: ["Cosa va per la maggiore adesso?", "Aiutami a trovare un regalo", "Qual è la vostra politica sui resi?", "Spedite nel mio paese?"],
  },
  nl: {
    welcome: "Hoi! Ik help je graag producten te vinden, opties te vergelijken en vragen over bestellingen en verzending te beantwoorden.",
    suggested: ["Wat is er nu populair?", "Help me een cadeau te vinden", "Wat is jullie retourbeleid?", "Verzenden jullie naar mijn land?"],
  },
};
/** One of the widget's six locales (en, fr, de, es, it, nl) for a storefront locale like "fr-CA"; English for anything else. */
export const widgetLocale = (locale: string | null | undefined): string => {
  const l = (locale ?? "").slice(0, 2).toLowerCase();
  return Object.hasOwn(DEFAULT_COPY, l) ? l : "en";
};
const defaultCopy = (locale: string | null | undefined) => DEFAULT_COPY[widgetLocale(locale)];

export type WidgetResolution = {
  config: WidgetConfig;
  /** Fields (dotted, as in settings.widget) showing their default because the merchant set nothing usable. */
  defaulted: string[];
  /** Fields the merchant set that failed validation (the config shows the default instead); PUT answers 400 with these. */
  rejected: string[];
};

type StoreInput = { settings: unknown; name: string | null; primaryLocale?: string | null };

/**
 * C23: the look is edited in the admin's "Chat widget" card (PUT /api/app/widget-settings), which saves it under
 * `stores.settings.widget` (same field names as WidgetConfig); a field the merchant never set gets its default. Each
 * bad value falls back to its default and is logged. This is the one validation, for reading and for saving.
 * Never throws. The value is public (page source), so nothing secret goes in here.
 */
export function resolveWidgetConfig(store: StoreInput, apiBase: string): WidgetResolution {
  const settings = obj(store.settings);
  const w = obj(settings.widget);
  const launcher = obj(w.launcher);
  const teaser = obj(w.teaser);
  const copy = defaultCopy(store.primaryLocale);
  const defaulted: string[] = [];
  const rejected: string[] = [];

  // Takes the merchant's value when it passes `ok`, else the default; logs only values that were set and rejected.
  function pick<T>(field: string, v: unknown, ok: (v: unknown) => boolean, def: T): T {
    if (v === undefined || v === null) {
      defaulted.push(field);
      return def;
    }
    if (ok(v)) return v as T;
    console.warn("widget config: bad value replaced by its default", { field });
    rejected.push(field);
    defaulted.push(field);
    return def;
  }
  const text = (max: number) => (v: unknown) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
  const int = (min: number, max: number) => (v: unknown) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
  const bool = (v: unknown) => typeof v === "boolean";
  const oneOf = (...xs: unknown[]) => (v: unknown) => xs.includes(v);

  // Absent means "use the generic questions"; an array, even an empty one, is the merchant's deliberate choice.
  let suggested: string[];
  if (w.suggested === undefined || w.suggested === null) {
    defaulted.push("suggested");
    suggested = copy.suggested;
  } else if (Array.isArray(w.suggested)) {
    suggested = w.suggested.filter((q) => text(120)(q)) as string[];
    if (suggested.length !== w.suggested.length || suggested.length > 4) {
      console.warn("widget config: suggested questions dropped", { field: "suggested" });
      rejected.push("suggested");
    }
  } else {
    console.warn("widget config: bad value replaced by its default", { field: "suggested" });
    rejected.push("suggested");
    defaulted.push("suggested");
    suggested = copy.suggested;
  }

  const config: WidgetConfig = {
    v: 1,
    enabled: pick("enabled", w.enabled, bool, true),
    apiBase,
    // Shopify store names can be longer than 40; the default is cut so an untouched name never fails the check on save.
    name: pick("name", w.name, text(40), (store.name ?? "").slice(0, 40)),
    accent: pick("accent", w.accent, (v) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v), "#0A0A0A"),
    avatarUrl: pick("avatarUrl", w.avatarUrl, isShopifyCdnUrl, null), // UD7b
    launcher: {
      style: pick("launcher.style", launcher.style, oneOf("pill", "icon"), "pill"),
      label: pick("launcher.label", launcher.label, text(40), null),
      side: pick("launcher.side", launcher.side, oneOf("right", "left"), "right"),
      offset: pick("launcher.offset", launcher.offset, int(0, 200), 20),
      scope: pick("launcher.scope", launcher.scope, oneOf("all", "product", "none"), "all"),
    },
    welcome: pick("welcome", w.welcome, text(300), copy.welcome),
    suggested: suggested.slice(0, 4),
    teaser: {
      enabled: pick("teaser.enabled", teaser.enabled, bool, false),
      // No limit set by the plan for the teaser line; 120 like a suggested question.
      text: pick("teaser.text", teaser.text, text(120), null),
      delaySec: pick("teaser.delaySec", teaser.delaySec, int(0, 120), 8),
    },
    stockThreshold: stockThreshold(settings), // the server's own threshold, so cards and widget agree
    // D41 retention lives at the top of settings (no editor before M7).
    retentionDays: pick("retentionDays", settings.retentionDays, oneOf(...RETENTION_DAYS), 30),
  };
  return { config, defaulted, rejected };
}

export function buildWidgetConfig(store: StoreInput, apiBase: string): WidgetConfig {
  return resolveWidgetConfig(store, apiBase).config;
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
 * the last one written (stores.widget_config_hash). Called on every app load and by the Chat widget card's save. Never
 * throws: a failed write leaves the old metafield and no hash, so the next app load retries.
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
      .select({ settings: stores.settings, name: stores.name, primaryLocale: stores.primaryLocale, hash: stores.widgetConfigHash, mode: stores.mode })
      .from(stores)
      .where(eq(stores.id, storeId));
    if (!s || s.mode === "mcp") return; // an mcp store has no app installation to hold the metafield (the embed tag carries its config)
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
