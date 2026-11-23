import type { Metadata } from "next";
import "../globals.css";

export const metadata: Metadata = { title: "Shop Assistant" };

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
