import { beforeEach, expect, test, vi } from "vitest";

const create = vi.fn();
vi.mock("openai", () => ({
  default: vi.fn(function () {
    return { embeddings: { create } };
  }),
}));

import { embed, EMBEDDING_DIMS, EMBEDDING_MODEL } from "@/lib/embeddings";

beforeEach(() => {
  create.mockReset();
  process.env.OPENAI_API_KEY = "test";
  create.mockImplementation(async ({ input }: { input: string[] }) => ({
    data: input.map((t) => ({ embedding: [Number(t)] })),
    usage: { total_tokens: input.length * 2 },
  }));
});

test("250 texts make 3 calls of 100/100/50, in order, with model and dimensions", async () => {
  const texts = Array.from({ length: 250 }, (_, i) => String(i));
  const { vectors, tokens } = await embed(texts);
  expect(create).toHaveBeenCalledTimes(3);
  expect(create.mock.calls.map((c) => c[0].input.length)).toEqual([100, 100, 50]);
  expect(create.mock.calls[0][0]).toMatchObject({ model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMS });
  expect(EMBEDDING_DIMS).toBe(512);
  expect(vectors).toHaveLength(250);
  expect(vectors.map((v) => v[0])).toEqual(texts.map(Number));
  expect(tokens).toBe(500);
});

test("empty input makes no call", async () => {
  expect(await embed([])).toEqual({ vectors: [], tokens: 0 });
  expect(create).not.toHaveBeenCalled();
});

test("batches split on the estimated token budget (CJK = 2 tokens per char)", async () => {
  const big = "漢".repeat(60_000);
  await embed(["1", big, big]);
  expect(create.mock.calls.map((c) => c[0].input.length)).toEqual([2, 1]);
});

test("passes the abort signal and does not retry in the SDK", async () => {
  const ac = new AbortController();
  await embed(["1"], { signal: ac.signal });
  expect(create.mock.calls[0][1]).toMatchObject({ signal: ac.signal });
  const OpenAI = (await import("openai")).default as unknown as ReturnType<typeof vi.fn>;
  expect(OpenAI.mock.calls.at(-1)![0]).toMatchObject({ maxRetries: 0 });
});

test("an OpenAI error propagates", async () => {
  create.mockRejectedValueOnce(new Error("boom"));
  await expect(embed(["1"])).rejects.toThrow("boom");
});
