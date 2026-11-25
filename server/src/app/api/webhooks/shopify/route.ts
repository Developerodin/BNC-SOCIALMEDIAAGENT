import { handleWebhook } from "@/lib/shopify/webhooks";

// No `export const runtime = "nodejs"`: Node.js is the only runtime under cacheComponents, and Next 16 rejects the export there.
export const POST = handleWebhook;
