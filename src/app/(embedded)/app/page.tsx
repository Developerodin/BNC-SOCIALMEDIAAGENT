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

type SyncState = { status: "idle" | "running" | "failed"; lastSyncAt: string | null; itemsRead: number; productCount: number };

async function authed(url: string, init?: RequestInit) {
  return fetch(url, { ...init, headers: { Authorization: "Bearer " + (await shopify.idToken()) } });
}

function statusLine(s: SyncState): string {
  if (s.status === "running") return `Syncing your catalog… ${s.itemsRead} items read`;
  if (s.status === "failed") return "The last sync failed.";
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

  const load = useCallback(async () => {
    const res = await authed("/api/app/sync");
    if (!res.ok) return;
    const next: SyncState = await res.json();
    if (next.status === "running") setRequestedAt(null); // the server owns the state from here
    setNow(Date.now());
    setServer(next);
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

  // C4: poll every 5 s while a sync is running or requested.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [running, load]);

  async function resync() {
    const t = Date.now();
    setNow(t);
    setRequestedAt(t);
    try {
      const res = await authed("/api/app/sync", { method: "POST" });
      if (res.ok) return; // keep polling; do not load() now, the job has not started yet
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
      <s-button onClick={resync} disabled={running}>
        Resync
      </s-button>
    </s-page>
  );
}
