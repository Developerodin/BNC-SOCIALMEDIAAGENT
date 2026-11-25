import { afterEach, expect, test, vi } from "vitest";

// GET /api/health: 200 while the database answers, 503 when it fails or does not answer in 3 s.

const execute = vi.hoisted(() => vi.fn());
vi.mock("@/db/client", () => ({ db: { execute } }));

import { GET } from "@/app/api/health/route";

afterEach(() => {
  vi.useRealTimers();
  execute.mockReset();
});

test("200 {ok:true} when the database answers, with nothing else in the body", async () => {
  execute.mockResolvedValue([{ "?column?": 1 }]);
  const res = await GET();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(res.headers.get("Cache-Control")).toBe("no-store");
});

test("503 when the database query fails, without echoing the error", async () => {
  execute.mockRejectedValue(new Error("connection refused: postgres://user:secret@host/db"));
  const res = await GET();
  expect(res.status).toBe(503);
  expect(await res.text()).toBe('{"ok":false}');
});

test("503 when the database does not answer within 3 s", async () => {
  vi.useFakeTimers();
  execute.mockReturnValue(new Promise(() => {}));
  const pending = GET();
  await vi.advanceTimersByTimeAsync(3000);
  expect((await pending).status).toBe(503);
});
