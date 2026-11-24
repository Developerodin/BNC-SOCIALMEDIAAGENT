import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Built widget bundles (scripts/build-widget.mjs) and the Shopify CLI dev bundle.
    "extensions/askcart/assets/askcart-*.js",
    ".shopify/**",
  ]),
]);

export default eslintConfig;
