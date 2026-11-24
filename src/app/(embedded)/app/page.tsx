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
      <MobileKeyCard />
    </s-page>
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
