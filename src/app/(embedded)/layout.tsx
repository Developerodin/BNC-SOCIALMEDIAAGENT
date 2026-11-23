import type { Metadata } from "next";

export const metadata: Metadata = { title: "Shop Assistant" };

// Separate root layout so the App Bridge and Polaris scripts load only on embedded pages.
export default function EmbeddedLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="shopify-api-key" content={process.env.SHOPIFY_API_KEY} />
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="https://cdn.shopify.com/shopifycloud/polaris-2.js"></script>
      </head>
      <body>{children}</body>
    </html>
  );
}
