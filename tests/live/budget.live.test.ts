import { beforeAll, describe, expect, test } from "vitest";
import { loadEnv } from "vite";
import { rewriteQuery } from "@/lib/chat/rewrite";

// D87: the rewrite's budget and price-order extraction against real OpenAI. Runs only when OPENAI_API_KEY is set:
// `npx vitest run tests/live/budget.live.test.ts`. Two small-model calls; no database or Shopify.

const live = !!process.env.OPENAI_API_KEY;
const T = 30_000;

// vitest.config passes only the key to tests; the chat models come from .env too.
beforeAll(() => {
  const env = loadEnv("test", process.cwd(), "");
  for (const k of ["OPENAI_MODEL_SMALL", "OPENAI_REASONING_SMALL"]) {
    if (env[k] && !process.env[k]) process.env[k] = env[k];
  }
});

describe.skipIf(!live)("rewrite budget extraction (live)", () => {
  test(
    '"a gift under 1000 rupees" in an INR store gives max 1000 and no sort',
    async () => {
      const r = await rewriteQuery({
        message: "a gift under 1000 rupees",
        history: [],
        storeLocale: "en",
        storeCurrency: "INR",
        signal: new AbortController().signal,
      });
      console.info("live rewrite", JSON.stringify(r));
      expect(r.budget?.max).toBe(1000);
      expect(r.budget?.min).toBeUndefined();
      expect(r.sort).toBeNull();
      expect(r.tokens.input).toBeGreaterThan(0); // a real answer, not the fallback
    },
    T,
  );

  test(
    '"cheapest snowboard" gives sort cheapest and no budget',
    async () => {
      const r = await rewriteQuery({
        message: "cheapest snowboard",
        history: [],
        storeLocale: "en",
        storeCurrency: "INR",
        signal: new AbortController().signal,
      });
      console.info("live rewrite", JSON.stringify(r));
      expect(r.sort).toBe("cheapest");
      expect(r.budget).toBeNull();
      expect(r.query.toLowerCase()).toContain("snowboard");
      expect(r.tokens.input).toBeGreaterThan(0);
    },
    T,
  );
});
