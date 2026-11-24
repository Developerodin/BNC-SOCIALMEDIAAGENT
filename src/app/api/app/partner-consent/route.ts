import { decideConsent, getConsent } from "@/lib/partner/consent";

// Task P5: the consent screen's API. The contract lives in src/lib/partner/consent.ts.
export function GET(req: Request) {
  return getConsent(req);
}

export function POST(req: Request) {
  return decideConsent(req);
}
