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
 * The body bytes, read as a stream and counted so a huge body is never buffered (a declared content-length is only a
 * hint). Throws Response 413 `body_too_large` over `maxBytes`; returns undefined when there is no body.
 */
export async function readSmallBytes(req: Request, maxBytes: number): Promise<Buffer | undefined> {
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
  return Buffer.concat(chunks);
}

/** The JSON body (see readSmallBytes); undefined for an empty or non-JSON body. */
export async function readSmallJson(req: Request, maxBytes: number): Promise<unknown> {
  const bytes = await readSmallBytes(req, maxBytes);
  if (!bytes) return undefined;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}
