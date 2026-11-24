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
    </s-page>
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

  const showOwn = result && (result.kind === "other" || !result.reachable);
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
          <s-button onClick={() => window.open(result.themeLink!, "_top")}>Turn on chat</s-button>
          <s-text>In the theme editor, click Save to publish it.</s-text>
        </>
      )}
      {result?.kind === "shopify_other_store" && (
        <s-text>{result.host} belongs to a different Shopify store. AskCart has to be installed on that store to add the chat there.</s-text>
      )}
      {showOwn && (
        <>
          <s-text>
            {result.reachable ? `${result.host} isn't a Shopify store we can see.` : `We couldn't check ${result.host}, so here are both ways to connect it.`}
          </s-text>
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
