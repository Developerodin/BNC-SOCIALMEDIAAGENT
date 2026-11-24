import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { stores } from "@/db/schema";
import { authenticateEmbedded } from "@/lib/shopify/session";
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

export async function GET(req: Request) {
  try {
    const { storeId, shop } = await authenticateEmbedded(req);
    const [s] = await db.select({ settings: stores.settings }).from(stores).where(eq(stores.id, storeId));
    return Response.json({ ...state(onboardingOf(s?.settings)), themeLink: themeEditorLink(shop) });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

export async function POST(req: Request) {
  try {
    const { storeId } = await authenticateEmbedded(req);
    const text = await req.text();
    if (text.length > MAX_BODY) return Response.json({ error: "too_large" }, { status: 413 });
    let action: unknown;
    try {
      action = (JSON.parse(text) as { action?: unknown }).action;
    } catch {
      action = undefined;
    }
    if (typeof action !== "string" || !Object.hasOwn(FIELD, action)) return Response.json({ error: "invalid_action" }, { status: 400 });
    const field = FIELD[action as keyof typeof FIELD];

    return await db.transaction(async (tx) => {
      const [s] = await tx.select({ settings: stores.settings }).from(stores).where(eq(stores.id, storeId)).for("update");
      const current = onboardingOf(s.settings);
      // Keep the first timestamp when the same action arrives twice.
      const onboarding = { ...current, [field]: current[field] ?? new Date().toISOString() };
      await tx
        .update(stores)
        .set({ settings: { ...(s.settings as Record<string, unknown>), onboarding } })
        .where(eq(stores.id, storeId));
      return Response.json(state(onboarding));
    });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}
