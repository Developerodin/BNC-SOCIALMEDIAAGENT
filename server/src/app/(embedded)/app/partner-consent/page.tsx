"use client";

import { useEffect, useState } from "react";

// Task P5: the consent screen inside Shopify admin. Reached by the deep link from /partner/connect with ?request=<id>.
// D49: the wording below is a draft until the user approves it.

// App Bridge global, loaded by the embedded layout.
declare const shopify: { idToken(): Promise<string> };

// The s-* tags are typed in (embedded)/polaris.d.ts.

type Consent = { clientName: string; shop: { domain: string; name: string | null }; scopes: string[]; expiresAt: string };

const READS: Record<string, string> = {
  "read:shop": "Your store's name and currency",
  "read:products": "Your active products: titles, descriptions, images, prices, SKUs and stock levels",
  "read:orders": "Your orders' numbers, dates, totals, discounts, taxes, shipping charges and refunds",
};

const ERRORS: Record<string, string> = {
  not_found: "This connection request isn't valid for this store, or it was already answered. Start again from the app that asked to connect.",
  expired: "This connection request has expired. Start again from the app that asked to connect.",
  already_decided: "This connection request was already answered.",
  approver_not_allowed: "Your account can't approve connections for this store. Ask the store owner to approve it.",
  shopify_unavailable: "Shopify didn't respond. Try again in a moment.",
};

function errorText(body: { error?: string; missing?: string[] } | null, status: number): string {
  if (body?.error === "staff_permission_missing") {
    const what = (body.missing ?? []).map((s) => (s === "read_orders" ? "orders" : s === "read_products" ? "products" : s));
    return `You need permission to view ${what.join(" and ")} in Shopify admin to share them. Ask the store owner to approve this connection.`;
  }
  return (body?.error && ERRORS[body.error]) || (status === 401 ? "Your session has ended. Reload the page." : "Something went wrong. Try again.");
}

async function authed(url: string, init?: RequestInit) {
  return fetch(url, {
    ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), Authorization: "Bearer " + (await shopify.idToken()) },
  });
}

export default function PartnerConsent() {
  const [requestId, setRequestId] = useState<string | null>(null);
  const [consent, setConsent] = useState<Consent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("request");
    (async () => {
      if (!id) return setError(ERRORS.not_found);
      setRequestId(id);
      try {
        const res = await authed(`/api/app/partner-consent?request=${encodeURIComponent(id)}`);
        const body = await res.json().catch(() => null);
        if (res.ok) setConsent(body);
        else setError(errorText(body, res.status));
      } catch {
        setError(ERRORS.shopify_unavailable);
      }
    })();
  }, []);

  async function decide(decision: "allow" | "deny") {
    if (busy || done) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authed("/api/app/partner-consent", { method: "POST", body: JSON.stringify({ requestId, decision }) });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.redirectUrl) {
        setDone(true);
        // Leave the admin iframe: App Bridge turns window.open(url, "_top") into a top-level navigation.
        window.open(body.redirectUrl, "_top");
        return;
      }
      // The request can't be answered any more: hide the buttons and show why.
      if (res.status === 404 || res.status === 409 || res.status === 410) setConsent(null);
      setError(errorText(body, res.status));
    } catch {
      setError(ERRORS.shopify_unavailable);
    }
    setBusy(false);
  }

  const portal = consent?.clientName ?? "an app";
  const store = consent ? consent.shop.name ?? consent.shop.domain : "";

  return (
    <s-page heading={`Connect ${portal}`}>
      {error && <s-banner tone="critical">{error}</s-banner>}
      {consent && (
        <s-section heading={`${portal} wants to read data from ${store}`}>
          <s-stack direction="block" gap="base">
            <s-paragraph>If you allow it, {portal} can read:</s-paragraph>
            <s-unordered-list>
              {consent.scopes.map((s) => (
                <s-list-item key={s}>{READS[s] ?? s}</s-list-item>
              ))}
            </s-unordered-list>
            <s-paragraph>It can’t:</s-paragraph>
            <s-unordered-list>
              <s-list-item>See customer names, emails, phone numbers or addresses</s-list-item>
              <s-list-item>Change anything in your store</s-list-item>
            </s-unordered-list>
            <s-paragraph>
              You can disconnect it at any time from {portal} or by uninstalling AskCart. This request expires at{" "}
              {new Date(consent.expiresAt).toLocaleTimeString()}.
            </s-paragraph>
            {done && <s-paragraph>Returning you to {portal}…</s-paragraph>}
            <s-stack direction="inline" gap="base">
              {/* variant isn't in app/page.tsx's s-button type; passed by spread to keep that declaration untouched. */}
              <s-button {...{ variant: "primary" }} onClick={() => decide("allow")} disabled={busy || done}>
                Allow
              </s-button>
              <s-button onClick={() => decide("deny")} disabled={busy || done}>
                Cancel
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}
