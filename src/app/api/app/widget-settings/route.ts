import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { stores } from "@/db/schema";
import { readSmallJson, withStore } from "@/lib/admin-route";
import { appOrigin, resolveWidgetConfig, syncWidgetConfig } from "@/lib/widget-config";

// The merchant's "Chat widget" card. GET answers with the effective look and which fields still show a default; PUT
// {name?, accent?, avatarUrl?, welcome?, suggested?, launcher?, teaser?} saves them under stores.settings.widget
// (an empty string or null clears a field back to its default; {reset: true} clears them all), then updates the theme
// widget's metafield. The row is locked while it is read and written so other settings keys are never clobbered.

const MAX_BODY = 8 * 1024; // 4 questions of 120 chars, a welcome, a URL: well under this
const TOP = ["name", "accent", "avatarUrl", "welcome", "suggested"] as const;
const GROUPS = { launcher: ["style", "label", "side"], teaser: ["enabled", "text", "delaySec"] } as const;
// Fields this card edits; a stored bad value elsewhere (e.g. `enabled`) must not block saving these.
const EDITABLE = new Set<string>([...TOP, ...Object.entries(GROUPS).flatMap(([g, ks]) => ks.map((k) => `${g}.${k}`))]);

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

const view = (r: ReturnType<typeof resolveWidgetConfig>) => {
  const { name, accent, avatarUrl, launcher, welcome, suggested, teaser } = r.config;
  return { name, accent, avatarUrl, launcher, welcome, suggested, teaser, defaulted: r.defaulted.filter((f) => EDITABLE.has(f)) };
};

function setField(o: Obj, k: string, v: unknown) {
  if (v === null || v === "") delete o[k];
  else o[k] = typeof v === "string" ? v.trim() : v;
}

/** The stored widget with the body's fields applied. Validation is not done here: resolveWidgetConfig does it. */
function applyBody(existing: Obj, body: Obj): Obj {
  const next = { ...existing };
  if (body.reset === true) {
    for (const k of TOP) delete next[k];
    for (const g of Object.keys(GROUPS)) delete next[g];
    return next;
  }
  for (const k of TOP) if (k in body) setField(next, k, k === "suggested" && Array.isArray(body[k]) ? (body[k] as unknown[]).map((q) => (typeof q === "string" ? q.trim() : q)) : body[k]);
  for (const [g, keys] of Object.entries(GROUPS)) {
    if (!(g in body)) continue;
    const sent = obj(body[g]);
    const group = { ...obj(existing[g]) };
    for (const k of keys) if (k in sent) setField(group, k, sent[k]);
    next[g] = group;
  }
  return next;
}

/** Drops values equal to what an untouched store shows, so a default (e.g. the localized welcome) keeps following its source instead of freezing in the saved language. */
function dropDefaults(widget: Obj, defaults: Obj): Obj {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const next = { ...widget };
  for (const k of TOP) if (k in next && same(next[k], defaults[k])) delete next[k];
  for (const g of Object.keys(GROUPS)) {
    if (!(g in next)) continue;
    const group = { ...obj(next[g]) };
    for (const k of Object.keys(group)) if (same(group[k], obj(defaults[g])[k])) delete group[k];
    if (Object.keys(group).length) next[g] = group;
    else delete next[g];
  }
  return next;
}

export function GET(req: Request) {
  return withStore(req, async ({ storeId }) => {
    const [s] = await db.select({ settings: stores.settings, name: stores.name, primaryLocale: stores.primaryLocale }).from(stores).where(eq(stores.id, storeId));
    // The origin only fills apiBase, which this view leaves out.
    return Response.json(view(resolveWidgetConfig(s ?? { settings: {}, name: null }, appOrigin() ?? "")));
  });
}

export function PUT(req: Request) {
  return withStore(req, async ({ storeId, shop }) => {
    const raw = await readSmallJson(req, MAX_BODY);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return Response.json({ error: "invalid_body" }, { status: 400 });
    const body = raw as Obj;

    const res = await db.transaction(async (tx) => {
      const [s] = await tx
        .select({ settings: stores.settings, name: stores.name, primaryLocale: stores.primaryLocale })
        .from(stores)
        .where(eq(stores.id, storeId))
        .for("update");
      if (!s) return Response.json({ error: "not_found" }, { status: 404 });
      const settings = obj(s.settings);
      const apiBase = appOrigin() ?? "";
      const defaults = resolveWidgetConfig({ settings: {}, name: s.name, primaryLocale: s.primaryLocale }, apiBase).config;
      const widget = applyBody(obj(settings.widget), body);

      // The same validation the widget config is built with; a rejected value is an error here, not a silent default.
      const next = { ...settings, widget };
      const check = resolveWidgetConfig({ ...s, settings: next }, apiBase);
      const rejected = check.rejected.filter((f) => EDITABLE.has(f));
      if (rejected.length) return Response.json({ error: "invalid", errors: Object.fromEntries(rejected.map((f) => [f, "invalid"])) }, { status: 400 });

      const stored = { ...next, widget: dropDefaults(widget, defaults as unknown as Obj) };
      await tx.update(stores).set({ settings: stored }).where(eq(stores.id, storeId));
      return Response.json(view(resolveWidgetConfig({ ...s, settings: stored }, apiBase)));
    });
    // Saved: push it to the theme widget now. Never throws; if the write fails the next app load retries.
    if (res.ok) await syncWidgetConfig(storeId, shop);
    return res;
  });
}
