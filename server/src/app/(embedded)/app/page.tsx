"use client";

import { useCallback, useEffect, useState } from "react";

// App Bridge global, loaded by the embedded layout. The s-* tags are Polaris web components (typed in (embedded)/polaris.d.ts).
declare const shopify: { idToken(): Promise<string> };

type SyncState = {
  status: "idle" | "running" | "failed";
  lastSyncAt: string | null;
  itemsRead: number;
  /** Why the store can't sync, in words for the merchant. */
  syncError: string | null;
  /** Searchable: ACTIVE and published to the Online Store. */
  productCount: number;
  totalCount: number;
  embeddedCount: number;
};

async function authed(url: string, init?: RequestInit) {
  return fetch(url, { ...init, headers: { Authorization: "Bearer " + (await shopify.idToken()) } });
}

/** The text of a Polaris field (s-text-field, s-text-area, s-select): its `input` and `change` events carry no React-typed value. */
const valueOf = (e: React.SyntheticEvent) => (e.currentTarget as unknown as { value: string }).value;

function statusLine(s: SyncState): string {
  if (s.status === "running") return `Syncing your catalog… ${s.itemsRead} items read`;
  if (s.status === "failed") return s.syncError ? `The last sync failed. ${s.syncError}` : "The last sync failed.";
  const when = s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString() : "never";
  return `${s.productCount} products synced · last synced ${when}`;
}

const GRACE_MS = 30_000;

export default function AppHome() {
  const [name, setName] = useState<string | null>(null);
  const [server, setServer] = useState<SyncState | null>(null);
  // When Resync was clicked. The worker sets 'running' later than the POST returns, so for GRACE_MS a non-running server status is not trusted.
  const [requestedAt, setRequestedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0); // advanced by each load and click, so render stays pure
  // Set when the last Resync found a sync already queued: the status and lastSyncAt seen then. Polling continues while set,
  // and it clears when either changes (the queued sync started, finished or failed), so the message can't outlive that sync.
  const [refused, setRefused] = useState<Pick<SyncState, "status" | "lastSyncAt"> | null>(null);

  const load = useCallback(async (): Promise<SyncState | null> => {
    const res = await authed("/api/app/sync");
    if (!res.ok) return null;
    const next: SyncState = await res.json();
    if (next.status === "running") setRequestedAt(null); // the server owns the state from here
    // The queued sync has started, or started and ended between two polls.
    setRefused((r) => (r && (next.status === "running" || next.status !== r.status || next.lastSyncAt !== r.lastSyncAt) ? null : r));
    setNow(Date.now());
    setServer(next);
    return next;
  }, []);

  useEffect(() => {
    (async () => {
      setName((await (await authed("/api/app/me")).json()).name);
      await load();
    })();
  }, [load]);

  const pending = requestedAt !== null && now - requestedAt < GRACE_MS;
  const sync: SyncState | null = server && pending && server.status !== "running" ? { ...server, status: "running", itemsRead: 0 } : server;
  const running = sync?.status === "running";

  // C4: poll every 5 s while a sync is running, requested, or refused as already queued.
  const polling = running || refused !== null;
  useEffect(() => {
    if (!polling) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [polling, load]);

  async function resync() {
    const t = Date.now();
    setNow(t);
    setRequestedAt(t);
    setRefused(null);
    try {
      const res = await authed("/api/app/sync", { method: "POST" });
      if (res.ok) return; // keep polling; do not load() now, the job has not started yet
      if (res.status === 409) {
        setRequestedAt(null);
        const s = (await load()) ?? server;
        if (s) setRefused({ status: s.status, lastSyncAt: s.lastSyncAt });
        return;
      }
    } catch {
      // idToken or fetch threw: fall through to clear the optimistic state
    }
    setRequestedAt(null);
    await load();
  }

  return (
    <s-page heading="Shop Assistant">
      <s-stack direction="block" gap="base">
        <s-paragraph>Connected to {name}</s-paragraph>
        <SetupGuideCard sync={sync} />
        <WidgetSettingsCard />
        <ConnectWebsiteCard />
        <MobileKeyCard />
        <s-section heading="Product sync">
          <s-stack direction="block" gap="base">
            {sync && (
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-badge tone={sync.status === "failed" ? "critical" : running ? "info" : sync.lastSyncAt ? "success" : "neutral"}>
                  {sync.status === "failed" ? "Failed" : running ? "Syncing" : sync.lastSyncAt ? "Synced" : "Not synced"}
                </s-badge>
                <s-text>{statusLine(sync)}</s-text>
              </s-stack>
            )}
            {refused && <s-banner tone="info">A sync is already queued.</s-banner>}
            {sync && sync.status === "idle" && sync.syncError && <s-banner tone="warning">{sync.syncError}</s-banner>}
            {sync && sync.status === "idle" && sync.productCount === 0 && sync.totalCount > 0 && (
              <s-banner tone="warning">
                None of your {sync.totalCount} products is both active and published to the Online Store, so search has nothing to show.
              </s-banner>
            )}
            <s-stack direction="inline" gap="base">
              <s-button variant="secondary" onClick={resync} disabled={running}>
                Resync
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

type Onboarding = { chatConfirmed: boolean; dismissed: boolean; themeLink: string | null; productBlockLink: string | null };

/** Opens the theme editor with the "Ask our AI agent" block added to the product template. Used in the setup guide and in the Chat widget card. */
function ProductBlockButton({ link }: { link: string }) {
  return (
    <s-stack direction="block" gap="small">
      <s-stack direction="inline" gap="base">
        {/* target _top: the theme editor can't open inside the admin iframe. */}
        <s-button onClick={() => window.open(link, "_top")}>Add to product pages</s-button>
      </s-stack>
      <s-paragraph>Then drag it below the Buy buttons.</s-paragraph>
    </s-stack>
  );
}

/** One checklist row: a status badge, the step, and its actions on their own line. */
function Step({ done, title, children }: { done: boolean; title: string; children?: React.ReactNode }) {
  return (
    <s-stack direction="block" gap="small">
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-badge tone={done ? "success" : "neutral"}>{done ? "✓ Done" : "To do"}</s-badge>
        <s-text>{title}</s-text>
      </s-stack>
      {children}
    </s-stack>
  );
}

/** First-run guide (POST /api/app/onboarding keeps its state). The theme step is confirmed by the merchant, since Shopify gives apps no way to see whether an app embed is on. */
function SetupGuideCard({ sync }: { sync: SyncState | null }) {
  const [state, setState] = useState<Onboarding | null>(null);
  const [error, setError] = useState(false);
  // Whether both steps were already done when the page loaded: then there is nothing to celebrate, so the guide stays hidden.
  const [doneAtLoad, setDoneAtLoad] = useState<boolean | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await authed("/api/app/onboarding");
        if (res.ok) setState(await res.json());
      } catch {
        // the card just stays hidden
      }
    })();
  }, []);

  async function act(action: "confirm_chat" | "dismiss") {
    setError(false);
    try {
      const res = await authed("/api/app/onboarding", { method: "POST", body: JSON.stringify({ action }) });
      if (!res.ok) throw new Error(String(res.status));
      const next = await res.json();
      setState((s) => s && { ...s, ...next });
    } catch {
      setError(true);
    }
  }

  const synced = !!sync?.lastSyncAt && sync.productCount > 0; // not tied to status: a resync or a failed one must not bring the guide back
  const allDone = synced && !!state?.chatConfirmed;
  if (doneAtLoad === null && state && sync) setDoneAtLoad(allDone);
  if (!state || !sync || state.dismissed || doneAtLoad) return null;

  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-heading>Set up AskCart</s-heading>
          <s-button variant="tertiary" onClick={() => act("dismiss")}>
            Dismiss guide
          </s-button>
        </s-stack>
        {allDone ? (
          <s-banner tone="success">You&apos;re all set. Shoppers can now use the chat on your store.</s-banner>
        ) : (
          <>
            <Step done={synced} title={synced ? "Products synced" : sync.status === "running" ? `Syncing your products... ${sync.itemsRead} items read` : "Sync your products. Use Resync in Product sync below."} />
            <s-divider />
            <Step done={state.chatConfirmed} title="Turn on the chat in your theme">
              {state.themeLink ? (
                <>
                  <s-stack direction="inline" gap="base">
                    {/* target _top: the theme editor can't open inside the admin iframe. */}
                    <s-button variant="primary" onClick={() => window.open(state.themeLink!, "_top")}>
                      Turn on chat
                    </s-button>
                    {!state.chatConfirmed && <s-button onClick={() => act("confirm_chat")}>I&apos;ve turned it on</s-button>}
                  </s-stack>
                  <s-paragraph>In the theme editor, click Save.</s-paragraph>
                </>
              ) : (
                <>
                  <s-paragraph>In your theme editor, open App embeds and turn on AskCart, then click Save.</s-paragraph>
                  {!state.chatConfirmed && (
                    <s-stack direction="inline" gap="base">
                      <s-button onClick={() => act("confirm_chat")}>I&apos;ve turned it on</s-button>
                    </s-stack>
                  )}
                </>
              )}
            </Step>
            {state.productBlockLink && (
              <>
                <s-divider />
                {/* Link only: Shopify can't tell us whether the block was placed, so there is no done state. */}
                <s-stack direction="block" gap="small">
                  <s-text>Add &apos;Ask our AI agent&apos; to product pages</s-text>
                  <ProductBlockButton link={state.productBlockLink} />
                </s-stack>
              </>
            )}
            <s-paragraph>Using another website or a mobile app? See Connect your website and Mobile app key below.</s-paragraph>
          </>
        )}
        {error && <s-banner tone="critical">That didn&apos;t work. Try again.</s-banner>}
      </s-stack>
    </s-section>
  );
}

type WebsiteResult = {
  kind: "shopify_store" | "shopify_other_store" | "other";
  host: string;
  reachable: boolean;
  themeLink: string | null;
  embedSnippet: string | null;
  chatLink: string | null;
};

/** A read-only field with a Copy button. navigator.clipboard can be blocked inside the admin iframe, so on failure the text is selected for Ctrl+C. */
function CopyField({ label, value }: { label: string; value: string }) {
  const [note, setNote] = useState("");
  async function copy(e: React.MouseEvent) {
    const input = (e.currentTarget.parentElement as HTMLElement).querySelector("input")!;
    try {
      await navigator.clipboard.writeText(value);
      setNote("Copied");
    } catch {
      input.select();
      setNote("Press Ctrl+C (or Cmd+C) to copy");
    }
  }
  return (
    <s-stack direction="block" gap="small">
      <s-text>{label}</s-text>
      <s-stack direction="inline" gap="small" alignItems="center">
        {/* Native input on purpose: monospace, and select() for the clipboard fallback. */}
        <input readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} style={{ flex: 1, minWidth: 0, fontFamily: "monospace", padding: 6 }} />
        <s-button onClick={copy}>Copy</s-button>
      </s-stack>
      {note && <s-text>{note}</s-text>}
    </s-stack>
  );
}

/** Asks which kind of website this is (POST /api/app/website-check) and shows how to put the chat on it. */
function ConnectWebsiteCard() {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<WebsiteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-fill with the store's own address, so most merchants just click Check.
  useEffect(() => {
    (async () => {
      const res = await authed("/api/app/website-check");
      if (res.ok) {
        const { domain } = await res.json();
        setUrl((u) => u || domain || "");
      }
    })();
  }, []);

  async function check() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await authed("/api/app/website-check", { method: "POST", body: JSON.stringify({ url }) });
      if (res.status === 400) setError("Enter your website address, like yourbrand.com.");
      else if (res.status === 429) setError("Too many checks. Wait a minute and try again.");
      else if (!res.ok) throw new Error(String(res.status));
      else setResult(await res.json());
    } catch {
      setError("That didn't work. Try again.");
    }
    setBusy(false);
  }

  // The embed allow-list (docs/embed.md): the snippet and link only work on sites the merchant allowed here.
  const [allowed, setAllowed] = useState<string[] | null>(null);
  const [allowError, setAllowError] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      const res = await authed("/api/app/embed-domains");
      if (res.ok) setAllowed((await res.json()).domains);
    })();
  }, []);

  async function setAllowedHost(host: string, allow: boolean) {
    setAllowError(null);
    try {
      const res = await authed("/api/app/embed-domains", { method: allow ? "POST" : "DELETE", body: JSON.stringify({ host }) });
      if (res.status === 409) setAllowError("You can allow up to 10 websites. Remove one first.");
      else if (res.status === 400) setAllowError("This address can't be allowed.");
      else if (!res.ok) throw new Error(String(res.status));
      else setAllowed((await res.json()).domains);
    } catch {
      setAllowError("That didn't work. Try again.");
    }
  }

  const showOwn = result && (result.kind === "other" || !result.reachable);
  const isAllowed = !!result && !!allowed?.includes(result.host);
  return (
    <s-section heading="Connect your website">
      <s-stack direction="block" gap="base">
        <s-paragraph>Enter your website address and we&apos;ll show you how to add the chat to it.</s-paragraph>
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-text-field
            label="Website address"
            value={url}
            placeholder="yourbrand.com"
            onInput={(e) => setUrl(valueOf(e))}
            onKeyDown={(e) => e.key === "Enter" && !busy && check()}
          />
          <s-button variant="primary" onClick={check} disabled={busy || !url.trim()}>
            Check
          </s-button>
        </s-stack>
        {error && <s-banner tone="critical">{error}</s-banner>}
        {result?.kind === "shopify_store" && (
          <s-stack direction="block" gap="small">
            <s-paragraph>{result.host} is your Shopify store. The chat is added through your theme.</s-paragraph>
            {/* target _top: the theme editor can't open inside the admin iframe. */}
            {result.themeLink ? (
              <>
                <s-stack direction="inline" gap="base">
                  <s-button variant="primary" onClick={() => window.open(result.themeLink!, "_top")}>
                    Turn on chat
                  </s-button>
                </s-stack>
                <s-paragraph>In the theme editor, click Save to publish it.</s-paragraph>
              </>
            ) : (
              <s-paragraph>We can&apos;t open the theme editor right now. In your theme editor, open App embeds and turn on AskCart.</s-paragraph>
            )}
          </s-stack>
        )}
        {result?.kind === "shopify_other_store" && (
          <s-banner tone="warning">{result.host} belongs to a different Shopify store. AskCart has to be installed on that store to add the chat there.</s-banner>
        )}
        {showOwn && (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              {result.reachable ? `${result.host} doesn't look like a Shopify theme store (it may be a custom or headless site).` : `We couldn't check ${result.host}, so here are both ways to connect it.`}
            </s-paragraph>
            <s-divider />
            {isAllowed ? (
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-badge tone="success">Allowed</s-badge>
                <s-text>The chat is allowed on {result.host}.</s-text>
                <s-button variant="tertiary" onClick={() => setAllowedHost(result.host, false)}>
                  Stop allowing {result.host}
                </s-button>
              </s-stack>
            ) : (
              <s-stack direction="block" gap="small">
                <s-paragraph>First allow the chat on this website. Other websites can&apos;t show your chat.</s-paragraph>
                <s-stack direction="inline" gap="base">
                  <s-button variant="primary" onClick={() => setAllowedHost(result.host, true)}>
                    Allow chat on {result.host}
                  </s-button>
                </s-stack>
              </s-stack>
            )}
            {allowError && <s-banner tone="critical">{allowError}</s-banner>}
            {result.embedSnippet && (
              <>
                <s-paragraph>Add this line to your website&apos;s pages:</s-paragraph>
                <CopyField label="Embed code" value={result.embedSnippet} />
              </>
            )}
            {result.chatLink && (
              <>
                <s-paragraph>Or share this link to a page that is just the chat:</s-paragraph>
                <CopyField label="Chat link" value={result.chatLink} />
              </>
            )}
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}

type MobileKey = { prefix: string | null; createdAt: string | null };

/** docs/mobile-api.md: the key the store's own mobile app sends to use the chat. Replace and Revoke ask twice, since both break the live app. */
function MobileKeyCard() {
  const [current, setCurrent] = useState<MobileKey | null>(null);
  const [shown, setShown] = useState<string | null>(null); // the new key, shown once
  const [confirming, setConfirming] = useState<"replace" | "revoke" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await authed("/api/app/mobile-key");
      if (res.ok) setCurrent(await res.json());
    })();
  }, []);

  async function act(method: "POST" | "DELETE") {
    setBusy(true);
    setError(false);
    setConfirming(null);
    try {
      const res = await authed("/api/app/mobile-key", { method });
      if (!res.ok) throw new Error(String(res.status));
      if (method === "POST") {
        const k: MobileKey & { key: string } = await res.json();
        setShown(k.key);
        setCurrent({ prefix: k.prefix, createdAt: k.createdAt });
      } else {
        setShown(null);
        setCurrent({ prefix: null, createdAt: null });
      }
    } catch {
      setError(true);
    }
    setBusy(false);
  }

  if (!current) return null;
  const has = current.prefix !== null;
  return (
    <s-section heading="Mobile app key">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone={has ? "success" : "neutral"}>{has ? "Active key" : "No key"}</s-badge>
          {has && current.createdAt && (
            <s-text>
              {current.prefix}… · created {new Date(current.createdAt).toLocaleString()}
            </s-text>
          )}
        </s-stack>
        <s-paragraph>Your mobile app sends this key to use the same chat assistant as your store.</s-paragraph>
        <s-paragraph>Your app must show shoppers they&apos;re chatting with an AI (see the API guide).</s-paragraph>
        {!has && <s-paragraph>No key yet. Your mobile app can&apos;t use the chat until you create one.</s-paragraph>}
        {shown && (
          <s-stack direction="block" gap="small">
            <s-banner tone="warning">Copy this key now. It won&apos;t be shown again.</s-banner>
            <CopyField label="New key" value={shown} />
          </s-stack>
        )}
        {error && <s-banner tone="critical">That didn&apos;t work. Try again.</s-banner>}
        {confirming && (
          <s-banner tone="warning">
            {confirming === "replace"
              ? "The old key stops working right away, so your app needs the new one. Click again to replace it."
              : "Your app stops working with the chat right away. Click again to revoke the key."}
          </s-banner>
        )}
        <s-stack direction="inline" gap="base">
          {!has ? (
            <s-button variant="primary" onClick={() => act("POST")} disabled={busy}>
              Create key
            </s-button>
          ) : (
            <>
              <s-button onClick={() => (confirming === "replace" ? act("POST") : setConfirming("replace"))} disabled={busy}>
                {confirming === "replace" ? "Yes, replace key" : "Replace key"}
              </s-button>
              <s-button tone="critical" onClick={() => (confirming === "revoke" ? act("DELETE") : setConfirming("revoke"))} disabled={busy}>
                {confirming === "revoke" ? "Yes, revoke key" : "Revoke key"}
              </s-button>
            </>
          )}
        </s-stack>
      </s-stack>
    </s-section>
  );
}

type WidgetForm = {
  name: string;
  accent: string;
  avatarUrl: string;
  style: "pill" | "icon";
  label: string;
  side: "right" | "left";
  scope: "all" | "product" | "none";
  welcome: string;
  suggested: string[];
  teaserOn: boolean;
  teaserText: string;
  teaserDelay: string;
};
type WidgetView = {
  name: string;
  accent: string;
  avatarUrl: string | null;
  launcher: { style: "pill" | "icon"; label: string | null; side: "right" | "left"; scope: "all" | "product" | "none" };
  welcome: string | null;
  suggested: string[];
  teaser: { enabled: boolean; text: string | null; delaySec: number };
};

const toForm = (v: WidgetView): WidgetForm => ({
  name: v.name,
  accent: v.accent,
  avatarUrl: v.avatarUrl ?? "",
  style: v.launcher.style,
  label: v.launcher.label ?? "",
  side: v.launcher.side,
  scope: v.launcher.scope,
  welcome: v.welcome ?? "",
  suggested: v.suggested,
  teaserOn: v.teaser.enabled,
  teaserText: v.teaser.text ?? "",
  teaserDelay: String(v.teaser.delaySec),
});

const FIELD_LABELS: Record<string, string> = {
  name: "Name",
  accent: "Accent color",
  avatarUrl: "Avatar URL",
  welcome: "Welcome message",
  suggested: "Suggested questions",
  "launcher.style": "Button style",
  "launcher.label": "Button label",
  "launcher.side": "Button side",
  "launcher.scope": "Chat button",
  "teaser.text": "Teaser text",
  "teaser.delaySec": "Teaser delay",
};

/** Black or white, whichever reads better on the accent (WCAG relative luminance). */
function textOn(hex: string): string {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 0.179 ? "#000000" : "#ffffff";
}

/** The look of the chat on the store's theme (GET/PUT /api/app/widget-settings). Saving also updates the theme widget. */
function WidgetSettingsCard() {
  const [form, setForm] = useState<WidgetForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "success" | "critical"; text: string } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [blockLink, setBlockLink] = useState<string | null>(null);

  // The setup guide hides once setup is done, so the product-block link is offered here as well.
  useEffect(() => {
    (async () => {
      try {
        const res = await authed("/api/app/onboarding");
        if (res.ok) setBlockLink(((await res.json()) as Onboarding).productBlockLink);
      } catch {
        // no link shown
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await authed("/api/app/widget-settings");
        if (res.ok) setForm(toForm(await res.json()));
      } catch {
        // the card just stays hidden
      }
    })();
  }, []);

  async function save(body: object) {
    setBusy(true);
    setNote(null);
    setErrors([]);
    try {
      const res = await authed("/api/app/widget-settings", { method: "PUT", body: JSON.stringify(body) });
      if (res.status === 400) {
        const { errors: e } = await res.json();
        const fields = Object.keys(e ?? {});
        setErrors(fields);
        setNote({ tone: "critical", text: fields.length ? `Check: ${fields.map((f) => FIELD_LABELS[f] ?? f).join(", ")}.` : "That didn't work. Try again." });
      } else if (!res.ok) throw new Error(String(res.status));
      else {
        setForm(toForm(await res.json()));
        setNote({ tone: "success", text: "reset" in body ? "Reset to defaults." : "Saved." });
      }
    } catch {
      setNote({ tone: "critical", text: "That didn't work. Try again." });
    }
    setBusy(false);
  }

  if (!form) return null;
  const set = <K extends keyof WidgetForm>(k: K, v: WidgetForm[K]) => setForm((f) => f && { ...f, [k]: v });
  const validAccent = /^#[0-9a-fA-F]{6}$/.test(form.accent);
  const accent = validAccent ? form.accent : "#0A0A0A";
  const err = (f: string) => (errors.includes(f) ? "Not valid" : undefined);

  function submit() {
    if (!form) return;
    save({
      name: form.name,
      accent: form.accent,
      avatarUrl: form.avatarUrl,
      welcome: form.welcome,
      suggested: form.suggested.map((q) => q.trim()).filter(Boolean),
      launcher: { style: form.style, label: form.label, side: form.side, scope: form.scope },
      teaser: { enabled: form.teaserOn, text: form.teaserText, delaySec: teaserDelayValue(form.teaserDelay) },
    });
  }

  // s-text-field has no numeric mode: keep digits only, so letters can't silently fall back to the default delay.
  function teaserDelayValue(raw: string): number | null {
    const t = raw.trim();
    return /^\d{1,3}$/.test(t) ? Number(t) : t === "" ? null : -1; // -1 fails the server check and shows the field error
  }

  return (
    <s-section heading="Chat widget">
      <s-stack direction="block" gap="base">
        <s-paragraph>Change how the chat looks on your store. Anything you leave unchanged uses our defaults.</s-paragraph>
        <s-text-field label="Name" value={form.name} maxLength={40} error={err("name")} onInput={(e) => set("name", valueOf(e))} />
        <s-paragraph>Shoppers must be able to tell they&apos;re chatting with an AI: keep it clear it&apos;s an assistant, not a real person.</s-paragraph>
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-text-field label="Accent color" value={form.accent} maxLength={7} error={err("accent") ?? (validAccent ? undefined : "Use a color like #0A0A0A")} onInput={(e) => set("accent", valueOf(e))} />
          <input type="color" value={accent} onChange={(e) => set("accent", e.target.value)} aria-label="Accent color picker" />
          {/* Not the real widget: only the accent and the text color the widget will pick on it. */}
          <span style={{ display: "inline-block", padding: "6px 16px", borderRadius: 999, background: accent, color: textOn(accent) }}>
            {form.style === "icon" ? "Chat" : form.label || "Ask us anything"}
          </span>
        </s-stack>
        <s-text-field
          label="Avatar URL"
          value={form.avatarUrl}
          placeholder="https://cdn.shopify.com/..."
          details="Upload the image in Content, then Files, and paste its cdn.shopify.com link."
          error={err("avatarUrl")}
          onInput={(e) => set("avatarUrl", valueOf(e))}
        />
        <s-stack direction="inline" gap="base">
          <s-select label="Button style" value={form.style} onChange={(e) => set("style", valueOf(e) as WidgetForm["style"])}>
            <s-option value="pill">Pill with label</s-option>
            <s-option value="icon">Icon only</s-option>
          </s-select>
          <s-select label="Button side" value={form.side} onChange={(e) => set("side", valueOf(e) as WidgetForm["side"])}>
            <s-option value="right">Right</s-option>
            <s-option value="left">Left</s-option>
          </s-select>
        </s-stack>
        <s-select label="Chat button" value={form.scope} onChange={(e) => set("scope", valueOf(e) as WidgetForm["scope"])}>
          <s-option value="all">On every page</s-option>
          <s-option value="product">On product pages only</s-option>
          <s-option value="none">Hidden (product block only)</s-option>
        </s-select>
        {blockLink && <ProductBlockButton link={blockLink} />}
        <s-text-field label="Button label" value={form.label} maxLength={40} details="Empty uses the theme's default." error={err("launcher.label")} onInput={(e) => set("label", valueOf(e))} />
        <s-text-area label="Welcome message" details="Leave empty to use the default greeting in your store's language." value={form.welcome} maxLength={300} rows={3} error={err("welcome")} onInput={(e) => set("welcome", valueOf(e))} />
        <s-divider />
        <s-heading>Suggested questions (up to 4)</s-heading>
        {form.suggested.map((q, i) => (
          <s-stack key={i} direction="inline" gap="base" alignItems="end">
            <s-text-field
              label={`Question ${i + 1}`}
              value={q}
              maxLength={120}
              onInput={(e) => set("suggested", form.suggested.map((x, j) => (j === i ? valueOf(e) : x)))}
            />
            <s-button variant="tertiary" tone="critical" onClick={() => set("suggested", form.suggested.filter((_, j) => j !== i))}>
              Remove
            </s-button>
          </s-stack>
        ))}
        {form.suggested.length < 4 && (
          <s-stack direction="inline" gap="base">
            <s-button variant="secondary" onClick={() => set("suggested", [...form.suggested, ""])}>
              Add question
            </s-button>
          </s-stack>
        )}
        <s-divider />
        <s-checkbox label="Show a teaser bubble" checked={form.teaserOn} onChange={(e) => set("teaserOn", (e.currentTarget as unknown as { checked: boolean }).checked)} />
        {form.teaserOn && (
          <s-stack direction="inline" gap="base">
            <s-text-field label="Teaser text" value={form.teaserText} maxLength={120} error={err("teaser.text")} onInput={(e) => set("teaserText", valueOf(e))} />
            <s-text-field label="Show after (seconds, 0 to 120)" type="number" value={form.teaserDelay} error={err("teaser.delaySec")} onInput={(e) => set("teaserDelay", valueOf(e))} />
          </s-stack>
        )}
        {note && <s-banner tone={note.tone}>{note.text}</s-banner>}
        <s-stack direction="inline" gap="base">
          <s-button variant="primary" onClick={submit} disabled={busy || !validAccent}>
            Save
          </s-button>
          <s-button variant="secondary" onClick={() => save({ reset: true })} disabled={busy}>
            Reset to defaults
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
