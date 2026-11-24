import { authenticateEmbedded } from "@/lib/shopify/session";

// Shared plumbing for the admin's /api/app/* routes (embedded App Bridge calls).

/** Authenticates the embedded request and runs `run`; a thrown Response (401, or readSmallJson's 413) is the answer. */
export async function withStore(
  req: Request,
  run: (auth: { storeId: string; shop: string }) => Promise<Response>,
): Promise<Response> {
  try {
    return await run(await authenticateEmbedded(req));
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

/**
 * The JSON body, read as a stream and counted in bytes so a huge body is never buffered (a declared content-length is
 * only a hint). Throws Response 413 `body_too_large` over `maxBytes`; returns undefined for an empty or non-JSON body.
 */
export async function readSmallJson(req: Request, maxBytes: number): Promise<unknown> {
  const tooLarge = () => Response.json({ error: "body_too_large" }, { status: 413 });
  if (Number(req.headers.get("content-length") ?? 0) > maxBytes) throw tooLarge();
  const reader = req.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}
