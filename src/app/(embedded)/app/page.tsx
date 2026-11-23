"use client";

import { useEffect, useState } from "react";

// App Bridge global, loaded by the embedded layout.
declare const shopify: { idToken(): Promise<string> };

type PolarisProps = React.HTMLAttributes<HTMLElement> & { heading?: string };
declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "s-page": PolarisProps;
      "s-text": PolarisProps;
    }
  }
}

export default function AppHome() {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      const res = await fetch("/api/app/me", { headers: { Authorization: "Bearer " + (await shopify.idToken()) } });
      setName((await res.json()).name);
    })();
  }, []);
  return (
    <s-page heading="Shop Assistant">
      <s-text>Connected to {name}</s-text>
    </s-page>
  );
}
