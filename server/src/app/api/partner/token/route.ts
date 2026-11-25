import { revokeByBearer, tokenPost } from "./tokens";

// POST /api/partner/token: exchange a connect code (or, under C32 (c) only, a refresh token) for an ack_ token.
// DELETE /api/partner/token: revoke the presented token's whole grant. Server to server, so no CORS.
// Dynamic because it reads the request; no `runtime` export under cacheComponents.

export async function POST(req: Request) {
  return tokenPost(req);
}

export async function DELETE(req: Request) {
  return revokeByBearer(req);
}
