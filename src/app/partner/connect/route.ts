import { startConnect } from "@/lib/partner/connect";

// Task P4: the portal sends the merchant's browser here. Reading request.url makes this dynamic; no runtime export
// (cacheComponents is on). See src/lib/partner/connect.ts for the contract.
export async function GET(request: Request): Promise<Response> {
  return startConnect(new URL(request.url));
}
