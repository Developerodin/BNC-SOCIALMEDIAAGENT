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

export default function AppHome() {
  const [name, setName] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncState | null>(null);

  const load = useCallback(async () => {
    const res = await authed("/api/app/sync");
    if (res.ok) setSync(await res.json());
  }, []);

  useEffect(() => {
    (async () => {
      setName((await (await authed("/api/app/me")).json()).name);
      await load();
    })();
  }, [load]);

  // C4: poll every 5 s while a sync is running.
  const running = sync?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [running, load]);

  async function resync() {
    // Show running at once; the server confirms on the next poll. A failed POST is corrected by load().
    setSync((s) => (s ? { ...s, status: "running", itemsRead: 0 } : s));
    await authed("/api/app/sync", { method: "POST" });
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
