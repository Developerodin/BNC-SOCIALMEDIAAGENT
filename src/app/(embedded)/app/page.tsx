"use client";

import { useCallback, useEffect, useState } from "react";

// App Bridge global, loaded by the embedded layout.
declare const shopify: { idToken(): Promise<string> };

type PolarisProps = React.HTMLAttributes<HTMLElement> & { heading?: string; disabled?: boolean };
declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "s-page": PolarisProps;
      "s-text": PolarisProps;
      "s-button": PolarisProps;
    }
  }
}

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
      <s-text>Connected to {name}</s-text>
      <SetupGuideCard sync={sync} />
      {sync && <s-text>{statusLine(sync)}</s-text>}
      {refused && <s-text>A sync is already queued.</s-text>}
      {sync && sync.status === "idle" && sync.syncError && <s-text>{sync.syncError}</s-text>}
      {sync && sync.status === "idle" && sync.productCount === 0 && sync.totalCount > 0 && (
        <s-text>None of your {sync.totalCount} products is both active and published to the Online Store, so search has nothing to show.</s-text>
      )}
      <s-button onClick={resync} disabled={running}>
        Resync
      </s-button>
      <ConnectWebsiteCard />
      <MobileKeyCard />
      <WidgetSettingsCard />
    </s-page>
  );
}

type Onboarding = { chatConfirmed: boolean; dismissed: boolean; themeLink: string | null };

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
    <s-section heading="Set up AskCart">
      {allDone ? (
        <s-text>You&apos;re all set. Shoppers can now use the chat on your store.</s-text>
      ) : (
        <>
          <s-text>{synced ? "Step 1: Products synced. Done." : sync.status === "running" ? `Step 1: Syncing your products... ${sync.itemsRead} items read` : "Step 1: Sync your products. Use Resync below."}</s-text>
          <s-text>Step 2: Turn on the chat in your theme.{state.chatConfirmed ? " Done." : ""}</s-text>
          {state.themeLink ? (
            <>
              {/* target _top: the theme editor can't open inside the admin iframe. */}
              <s-button onClick={() => window.open(state.themeLink!, "_top")}>Turn on chat</s-button>
              <s-text>In the theme editor, click Save.</s-text>
            </>
          ) : (
            <s-text>In your theme editor, open App embeds and turn on AskCart, then click Save.</s-text>
          )}
          {!state.chatConfirmed && <s-button onClick={() => act("confirm_chat")}>I&apos;ve turned it on</s-button>}
          <s-text>Using another website or a mobile app? See Connect your website and Mobile app key below.</s-text>
        </>
      )}
      {error && <s-text>That didn&apos;t work. Try again.</s-text>}
      <s-button onClick={() => act("dismiss")}>Dismiss guide</s-button>
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
    <div>
      <s-text>{label}</s-text>
      <div>
        <input readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} style={{ width: "100%" }} />
        <s-button onClick={copy}>Copy</s-button> {note && <s-text>{note}</s-text>}
      </div>
    </div>
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
      <s-text>Enter your website address and we&apos;ll show you how to add the chat to it.</s-text>
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !busy && check()}
        placeholder="yourbrand.com"
        aria-label="Website address"
      />
      <s-button onClick={check} disabled={busy || !url.trim()}>
        Check
      </s-button>
      {error && <s-text>{error}</s-text>}
      {result?.kind === "shopify_store" && (
        <>
          <s-text>{result.host} is your Shopify store. The chat is added through your theme.</s-text>
          {/* target _top: the theme editor can't open inside the admin iframe. */}
          {result.themeLink ? (
            <>
              <s-button onClick={() => window.open(result.themeLink!, "_top")}>Turn on chat</s-button>
              <s-text>In the theme editor, click Save to publish it.</s-text>
            </>
          ) : (
            <s-text>We can&apos;t open the theme editor right now. In your theme editor, open App embeds and turn on AskCart.</s-text>
          )}
        </>
      )}
      {result?.kind === "shopify_other_store" && (
        <s-text>{result.host} belongs to a different Shopify store. AskCart has to be installed on that store to add the chat there.</s-text>
      )}
      {showOwn && (
        <>
          <s-text>
            {result.reachable ? `${result.host} doesn't look like a Shopify theme store (it may be a custom or headless site).` : `We couldn't check ${result.host}, so here are both ways to connect it.`}
          </s-text>
          {isAllowed ? (
            <>
              <s-text>The chat is allowed on {result.host}.</s-text>
              <s-button onClick={() => setAllowedHost(result.host, false)}>Stop allowing {result.host}</s-button>
            </>
          ) : (
            <>
              <s-text>First allow the chat on this website. Other websites can&apos;t show your chat.</s-text>
              <s-button onClick={() => setAllowedHost(result.host, true)}>Allow chat on {result.host}</s-button>
            </>
          )}
          {allowError && <s-text>{allowError}</s-text>}
          {result.embedSnippet && (
            <>
              <s-text>Add this line to your website&apos;s pages:</s-text>
              <CopyField label="Embed code" value={result.embedSnippet} />
            </>
          )}
          {result.chatLink && (
            <>
              <s-text>Or share this link to a page that is just the chat:</s-text>
              <CopyField label="Chat link" value={result.chatLink} />
            </>
          )}
        </>
      )}
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
      <s-text>Your mobile app sends this key to use the same chat assistant as your store.</s-text>
      {has && current.createdAt && (
        <s-text>
          Active key {current.prefix}… · created {new Date(current.createdAt).toLocaleString()}
        </s-text>
      )}
      {!has && <s-text>No key yet. Your mobile app can&apos;t use the chat until you create one.</s-text>}
      {shown && <s-text>New key (copy it now, it won&apos;t be shown again): {shown}</s-text>}
      {error && <s-text>That didn&apos;t work. Try again.</s-text>}
      {confirming && (
        <s-text>
          {confirming === "replace"
            ? "The old key stops working right away, so your app needs the new one. Click again to replace it."
            : "Your app stops working with the chat right away. Click again to revoke the key."}
        </s-text>
      )}
      {!has ? (
        <s-button onClick={() => act("POST")} disabled={busy}>
          Create key
        </s-button>
      ) : (
        <>
          <s-button onClick={() => (confirming === "replace" ? act("POST") : setConfirming("replace"))} disabled={busy}>
            {confirming === "replace" ? "Yes, replace key" : "Replace key"}
          </s-button>
          <s-button onClick={() => (confirming === "revoke" ? act("DELETE") : setConfirming("revoke"))} disabled={busy}>
            {confirming === "revoke" ? "Yes, revoke key" : "Revoke key"}
          </s-button>
        </>
      )}
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
  launcher: { style: "pill" | "icon"; label: string | null; side: "right" | "left" };
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
  const [note, setNote] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

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
        setErrors(Object.keys(e ?? {}));
        setNote("Some fields need a fix.");
      } else if (!res.ok) throw new Error(String(res.status));
      else {
        setForm(toForm(await res.json()));
        setNote("reset" in body ? "Reset to defaults." : "Saved.");
      }
    } catch {
      setNote("That didn't work. Try again.");
    }
    setBusy(false);
  }

  if (!form) return null;
  const set = <K extends keyof WidgetForm>(k: K, v: WidgetForm[K]) => setForm((f) => f && { ...f, [k]: v });
  const validAccent = /^#[0-9a-fA-F]{6}$/.test(form.accent);

  function submit() {
    if (!form) return;
    save({
      name: form.name,
      accent: form.accent,
      avatarUrl: form.avatarUrl,
      welcome: form.welcome,
      suggested: form.suggested.map((q) => q.trim()).filter(Boolean),
      launcher: { style: form.style, label: form.label, side: form.side },
      teaser: { enabled: form.teaserOn, text: form.teaserText, delaySec: form.teaserDelay.trim() === "" ? null : Number(form.teaserDelay) },
    });
  }

  return (
    <s-section heading="Chat widget">
      <s-text>Change how the chat looks on your store. Anything you leave unchanged uses our defaults.</s-text>
      <div>
        <label>
          <s-text>Name</s-text>
          <input value={form.name} maxLength={40} onChange={(e) => set("name", e.target.value)} style={{ width: "100%" }} />
        </label>
        <label>
          <s-text>Accent color</s-text>
          <div>
            <input type="color" value={validAccent ? form.accent : "#000000"} onChange={(e) => set("accent", e.target.value)} aria-label="Accent color picker" />{" "}
            <input value={form.accent} maxLength={7} onChange={(e) => set("accent", e.target.value)} aria-label="Accent color hex" />
          </div>
        </label>
        <label>
          <s-text>Avatar URL (upload the image in Content, then Files, and paste its cdn.shopify.com link)</s-text>
          <input value={form.avatarUrl} onChange={(e) => set("avatarUrl", e.target.value)} placeholder="https://cdn.shopify.com/..." style={{ width: "100%" }} />
        </label>
        <label>
          <s-text>Button style</s-text>
          <select value={form.style} onChange={(e) => set("style", e.target.value as WidgetForm["style"])}>
            <option value="pill">Pill with label</option>
            <option value="icon">Icon only</option>
          </select>
        </label>{" "}
        <label>
          <s-text>Button side</s-text>
          <select value={form.side} onChange={(e) => set("side", e.target.value as WidgetForm["side"])}>
            <option value="right">Right</option>
            <option value="left">Left</option>
          </select>
        </label>
        <label>
          <s-text>Button label (empty uses the theme&apos;s default)</s-text>
          <input value={form.label} maxLength={40} onChange={(e) => set("label", e.target.value)} style={{ width: "100%" }} />
        </label>
        <label>
          <s-text>Welcome message</s-text>
          <textarea value={form.welcome} maxLength={300} rows={3} onChange={(e) => set("welcome", e.target.value)} style={{ width: "100%" }} />
        </label>
        <s-text>Suggested questions (up to 4)</s-text>
        {form.suggested.map((q, i) => (
          <div key={i}>
            <input
              value={q}
              maxLength={120}
              aria-label={`Suggested question ${i + 1}`}
              onChange={(e) => set("suggested", form.suggested.map((x, j) => (j === i ? e.target.value : x)))}
              style={{ width: "80%" }}
            />{" "}
            <s-button onClick={() => set("suggested", form.suggested.filter((_, j) => j !== i))}>Remove</s-button>
          </div>
        ))}
        {form.suggested.length < 4 && <s-button onClick={() => set("suggested", [...form.suggested, ""])}>Add question</s-button>}
        <div>
          <label>
            <input type="checkbox" checked={form.teaserOn} onChange={(e) => set("teaserOn", e.target.checked)} /> <s-text>Show a teaser bubble</s-text>
          </label>
        </div>
        {form.teaserOn && (
          <>
            <label>
              <s-text>Teaser text</s-text>
              <input value={form.teaserText} maxLength={120} onChange={(e) => set("teaserText", e.target.value)} style={{ width: "100%" }} />
            </label>
            <label>
              <s-text>Show after (seconds, 0 to 120)</s-text>
              <input type="number" min={0} max={120} value={form.teaserDelay} onChange={(e) => set("teaserDelay", e.target.value)} />
            </label>
          </>
        )}
      </div>
      {/* Not the real widget: only the accent and the text color the widget will pick on it. */}
      <div aria-label="Button preview">
        <span style={{ display: "inline-block", padding: "8px 16px", borderRadius: 999, background: validAccent ? form.accent : "#0A0A0A", color: textOn(validAccent ? form.accent : "#0A0A0A") }}>
          {form.style === "icon" ? "Chat" : form.label || "Ask us anything"}
        </span>
      </div>
      {errors.length > 0 && <s-text>Check: {errors.map((f) => FIELD_LABELS[f] ?? f).join(", ")}.</s-text>}
      {note && <s-text>{note}</s-text>}
      <s-button onClick={submit} disabled={busy || !validAccent}>
        Save
      </s-button>
      <s-button onClick={() => save({ reset: true })} disabled={busy}>
        Reset to defaults
      </s-button>
    </s-section>
  );
}
