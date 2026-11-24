import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // `shopify app dev` serves the app through a new Cloudflare tunnel hostname each run; dev-only setting.
  allowedDevOrigins: ["*.trycloudflare.com"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
