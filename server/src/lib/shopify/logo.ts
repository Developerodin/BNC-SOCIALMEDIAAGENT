import { GraphqlQueryError } from "@shopify/shopify-api";
import { withTimeout } from "@/lib/chat/openai";
import { adminGraphql } from "./admin";

// Puts the merchant's logo into their Shopify Files and returns its cdn.shopify.com URL, which is what the widget's
// avatarUrl setting holds. Needs the write_files and read_files scopes. The image bytes are never logged.

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;
export type LogoType = keyof typeof TYPES;

/** Polling of the new file until Shopify has processed it. Exported so a test can shorten it. */
export const POLL = { everyMs: 1000, maxMs: 20_000 };
const CALL_MS = 10_000; // one Admin call
const PUT_MS = 20_000; // the upload to the staged target

/** The image type from the first bytes (the browser's Content-Type is not trusted), or null if it is not PNG, JPEG or WebP. */
export function sniffLogoType(b: Uint8Array): LogoType | null {
  if (b.length > 3 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 2 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  const at = (o: number, s: string) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  if (b.length > 12 && at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  return null;
}

/** `missing_scope`: the store has not approved write_files/read_files yet. `failed`: anything else (Shopify refused, timed out, file failed). */
export class LogoUploadError extends Error {
  constructor(readonly kind: "missing_scope" | "failed", detail: string) {
    super(detail);
  }
}

function isAccessDenied(e: unknown): boolean {
  if (e instanceof GraphqlQueryError) {
    const errs = e.body?.errors?.graphQLErrors ?? e.body?.errors;
    if (Array.isArray(errs) && errs.some((x) => x?.extensions?.code === "ACCESS_DENIED")) return true;
  }
  return e instanceof Error && /access denied|ACCESS_DENIED/i.test(e.message);
}

type UserErrors = { userErrors: { message: string }[] };

async function gql<T>(storeId: string, shop: string, query: string, variables: Record<string, unknown>): Promise<T> {
  try {
    return await withTimeout(adminGraphql<T>(storeId, shop, query, variables), CALL_MS);
  } catch (e) {
    if (isAccessDenied(e)) throw new LogoUploadError("missing_scope", "write_files not approved");
    throw new LogoUploadError("failed", e instanceof Error ? e.message : String(e));
  }
}

const STAGE = `mutation($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { message } }
}`;
const CREATE = `mutation($files: [FileCreateInput!]!) {
  fileCreate(files: $files) { files { id } userErrors { message } }
}`;
const STATUS = `query($id: ID!) { node(id: $id) { ... on MediaImage { fileStatus image { url } } } }`;

/** Staged upload, fileCreate, then poll until READY. Returns the image's cdn.shopify.com URL. Throws LogoUploadError. */
export async function uploadLogo(storeId: string, shop: string, bytes: Uint8Array, type: LogoType): Promise<string> {
  const filename = `askcart-logo-${Date.now()}.${TYPES[type]}`;

  const staged = await gql<{ stagedUploadsCreate: UserErrors & { stagedTargets: { url: string; resourceUrl: string; parameters: { name: string; value: string }[] }[] } }>(
    storeId, shop, STAGE,
    { input: [{ filename, mimeType: type, httpMethod: "POST", resource: "IMAGE", fileSize: String(bytes.length) }] },
  );
  const target = staged.stagedUploadsCreate.stagedTargets[0];
  if (staged.stagedUploadsCreate.userErrors.length || !target) throw new LogoUploadError("failed", "stagedUploadsCreate refused");

  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append("file", new Blob([bytes as BlobPart], { type }), filename);
  let put: Response;
  try {
    put = await fetch(target.url, { method: "POST", body: form, signal: AbortSignal.timeout(PUT_MS) });
  } catch (e) {
    throw new LogoUploadError("failed", `upload to the staged target failed: ${e instanceof Error ? e.name : "error"}`);
  }
  if (!put.ok) throw new LogoUploadError("failed", `staged target answered ${put.status}`);

  const created = await gql<{ fileCreate: UserErrors & { files: { id: string }[] } }>(
    storeId, shop, CREATE,
    { files: [{ originalSource: target.resourceUrl, contentType: "IMAGE", filename, alt: "Chat logo" }] },
  );
  const id = created.fileCreate.files[0]?.id;
  if (created.fileCreate.userErrors.length || !id) throw new LogoUploadError("failed", "fileCreate refused");

  for (const start = Date.now(); ; ) {
    const { node } = await gql<{ node: { fileStatus?: string; image?: { url?: string } | null } | null }>(storeId, shop, STATUS, { id });
    if (node?.fileStatus === "FAILED") throw new LogoUploadError("failed", "Shopify could not process the file");
    if (node?.fileStatus === "READY" && node.image?.url) return node.image.url;
    if (Date.now() - start >= POLL.maxMs) throw new LogoUploadError("failed", "timed out waiting for the file to be ready");
    await new Promise((r) => setTimeout(r, POLL.everyMs));
  }
}
