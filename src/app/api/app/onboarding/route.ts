import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { stores } from "@/db/schema";
import { readSmallJson, withStore } from "@/lib/admin-route";
import { themeEditorLink } from "@/lib/website-check";

// The admin home's setup guide. The merchant confirms the theme-editor step themselves (Shopify gives apps no way to
// see whether an app embed is on), so that and "dismissed" are remembered in stores.settings.onboarding. GET returns
// them with the theme-editor link; POST {action} records one. The row is locked while read and written so this can't
// clobber a concurrent write to another settings key (embedDomains, widget settings, ...).

const MAX_BODY = 256;
const FIELD = { confirm_chat: "chatConfirmedAt", dismiss: "dismissedAt" } as const;

type Onboarding = { chatConfirmedAt?: string; dismissedAt?: string };

function onboardingOf(settings: unknown): Onboarding {
  const o = (settings as { onboarding?: Onboarding } | null)?.onboarding;
  return o && typeof o === "object" ? o : {};
}

const state = (o: Onboarding) => ({ chatConfirmed: !!o.chatConfirmedAt, dismissed: !!o.dismissedAt });

export function GET(req: Request) {
  return withStore(req, async ({ storeId, shop }) => {
    const [s] = await db.select({ settings: stores.settings }).from(stores).where(eq(stores.id, storeId));
    return Response.json({ ...state(onboardingOf(s?.settings)), themeLink: themeEditorLink(shop) });
  });
}

export function POST(req: Request) {
  return withStore(req, async ({ storeId }) => {
    const action = ((await readSmallJson(req, MAX_BODY)) as { action?: unknown } | undefined)?.action;
    if (typeof action !== "string" || !Object.hasOwn(FIELD, action)) return Response.json({ error: "invalid_action" }, { status: 400 });
    const field = FIELD[action as keyof typeof FIELD];

    return db.transaction(async (tx) => {
      const [s] = await tx.select({ settings: stores.settings }).from(stores).where(eq(stores.id, storeId)).for("update");
      if (!s) return Response.json({ error: "not_found" }, { status: 404 }); // the row vanished after authentication
      const current = onboardingOf(s.settings);
      // Keep the first timestamp when the same action arrives twice.
      const onboarding = { ...current, [field]: current[field] ?? new Date().toISOString() };
      await tx
        .update(stores)
        .set({ settings: { ...(s.settings as Record<string, unknown>), onboarding } })
        .where(eq(stores.id, storeId));
      return Response.json(state(onboarding));
    });
  });
}
