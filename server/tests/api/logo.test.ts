import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GraphqlQueryError } from "@shopify/shopify-api";

// The logo upload behind the "Chat widget" card: POST /api/app/logo (staged upload, fileCreate, poll until READY).

vi.mock("@/lib/shopify/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/shopify/session")>()),
  authenticateEmbedded: vi.fn(async (req: Request) => {
    if (!req.headers.get("authorization")) throw new Response("Unauthorized", { status: 401 });
    return { storeId: "store-1", shop: "x.myshopify.com" };
  }),
}));
const gql = vi.hoisted(() => vi.fn());
vi.mock("@/lib/shopify/admin", () => ({ adminGraphql: gql }));

import { POST } from "@/app/api/app/logo/route";
import { POLL } from "@/lib/shopify/logo";
import { resetRateLimit } from "@/lib/rate-limit";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
const CDN = "https://cdn.shopify.com/s/files/1/0001/logo.png";
const call = (body: BodyInit | null = PNG, auth = true) =>
  POST(new Request("http://x/api/app/logo", { method: "POST", headers: auth ? { authorization: "Bearer t" } : {}, body }));

let put: ReturnType<typeof vi.fn>;
const staged = { stagedUploadsCreate: { userErrors: [], stagedTargets: [{ url: "https://stage.example/up", resourceUrl: "https://stage.example/res", parameters: [{ name: "key", value: "k" }] }] } };
const created = { fileCreate: { userErrors: [], files: [{ id: "gid://shopify/MediaImage/1" }] } };
const ready = { node: { fileStatus: "READY", image: { url: CDN } } };

beforeEach(() => {
  resetRateLimit();
  gql.mockReset();
  POLL.everyMs = 1;
  POLL.maxMs = 50;
  put = vi.fn(async () => new Response(null, { status: 201 }));
  vi.stubGlobal("fetch", put);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

test("needs the embedded session", async () => {
  expect((await call(PNG, false)).status).toBe(401);
  expect(gql).not.toHaveBeenCalled();
});

test("rejects a file that is not PNG, JPEG or WebP, whatever its content type says", async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const res = await POST(new Request("http://x/api/app/logo", { method: "POST", headers: { authorization: "Bearer t", "content-type": "image/png" }, body: svg }));
  expect(res.status).toBe(415);
  expect((await call(null)).status).toBe(415);
  expect(gql).not.toHaveBeenCalled();
});

test("rejects a file over 2 MB", async () => {
  const res = await call(Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]));
  expect(res.status).toBe(413);
  expect(gql).not.toHaveBeenCalled();
});

test("happy path: staged upload, fileCreate, then the READY url", async () => {
  gql.mockResolvedValueOnce(staged).mockResolvedValueOnce(created).mockResolvedValueOnce({ node: { fileStatus: "PROCESSING", image: null } }).mockResolvedValueOnce(ready);
  const res = await call();
  expect(await res.json()).toEqual({ url: CDN });
  expect(gql).toHaveBeenCalledTimes(4);
  expect(gql.mock.calls[0][2]).toContain("stagedUploadsCreate");
  expect(gql.mock.calls[0][3].input[0]).toMatchObject({ mimeType: "image/png", resource: "IMAGE", httpMethod: "POST" });
  expect(gql.mock.calls[1][3].files[0]).toMatchObject({ originalSource: "https://stage.example/res", contentType: "IMAGE" });
  // the bytes went to the staged target with its parameters first
  expect(put.mock.calls[0][0]).toBe("https://stage.example/up");
  expect([...(put.mock.calls[0][1].body as FormData).keys()]).toEqual(["key", "file"]);
});

test("a file Shopify never finishes processing is an upload failure", async () => {
  gql.mockResolvedValueOnce(staged).mockResolvedValueOnce(created).mockResolvedValue({ node: { fileStatus: "PROCESSING", image: null } });
  expect((await call()).status).toBe(502);
});

test("a FAILED file, a refused staged upload and a bad target answer are upload failures", async () => {
  gql.mockResolvedValueOnce(staged).mockResolvedValueOnce(created).mockResolvedValueOnce({ node: { fileStatus: "FAILED", image: null } });
  expect((await call()).status).toBe(502);

  gql.mockReset().mockResolvedValueOnce({ stagedUploadsCreate: { userErrors: [{ message: "no" }], stagedTargets: [] } });
  expect((await call()).status).toBe(502);

  gql.mockReset().mockResolvedValueOnce(staged);
  put.mockResolvedValueOnce(new Response(null, { status: 403 }));
  expect((await call()).status).toBe(502);
});

test("a store that has not approved write_files gets missing_scope, not a crash", async () => {
  gql.mockRejectedValueOnce(new GraphqlQueryError({ message: "x", response: {} as unknown as Record<string, unknown>, body: { errors: { graphQLErrors: [{ message: "Access denied for stagedUploadsCreate field.", extensions: { code: "ACCESS_DENIED" } }] } } }));
  const res = await call();
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "missing_scope" });
  expect(put).not.toHaveBeenCalled();
});

test("uploads are rate limited per store", async () => {
  gql.mockResolvedValue({ stagedUploadsCreate: { userErrors: [{ message: "no" }], stagedTargets: [] } });
  for (let i = 0; i < 6; i++) expect((await call()).status).toBe(502);
  const res = await call();
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBeTruthy();
});
