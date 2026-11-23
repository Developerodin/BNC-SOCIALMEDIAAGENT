import { afterAll, expect, test } from "vitest";
import postgres from "postgres";
import { gid, node, newStore, upsert } from "../helpers/seed";

// Calls OpenAI for real, so it runs only when OPENAI_API_KEY is set: `npx vitest run tests/live`.
test.skipIf(!process.env.OPENAI_API_KEY)("a real embedding ranks the boots first for a rainy-trail query", async () => {
  const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  const { embedStore } = await import("@/lib/indexing");
  const { search } = await import("@/lib/retrieval");
  const storeId = await newStore(admin);
  await upsert(
    storeId,
    node("1", { title: "Waterproof hiking boots", description: "Sturdy boots with a grippy sole" }),
    node("2", { title: "Cotton summer dress", description: "Light and breezy" }),
    node("3", { title: "Stainless steel water bottle", description: "Keeps drinks cold all day" }),
  );

  await embedStore({ storeId });
  const hits = await search(storeId, "shoes for rainy mountain trails", 3);

  expect(hits[0].productId).toBe(gid("1"));
  await admin.end();
});

afterAll(async () => {
  if (process.env.OPENAI_API_KEY) await (await import("@/db/client")).sql.end();
});
