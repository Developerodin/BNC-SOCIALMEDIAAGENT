import { createHash } from "node:crypto";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import OpenAI from "openai";
import { db, forStore } from "@/db/client";
import { chunks, products, stores } from "@/db/schema";
import { chunkText } from "@/lib/chunking";
import { CHUNKER_VERSION, EMBEDDING_DIMS, EMBEDDING_MODEL } from "@/lib/embedding-config";
import { embed } from "@/lib/embeddings";

const BATCH = 100;

/** Changing the model, the dimensions or the chunker changes every hash, so every product re-embeds. */
export function sourceHash(contentHash: string): string {
  return createHash("sha256").update(`${EMBEDDING_MODEL}|${EMBEDDING_DIMS}|${CHUNKER_VERSION}|${contentHash}`).digest("hex");
}

type Stale = { id: string; title: string; content: string; contentHash: string };
type Row = typeof chunks.$inferInsert;

/**
 * The `embed-products` handler. Removes chunks of products no longer for sale, then embeds products whose chunks are
 * missing or stale, BATCH products at a time: chunk, embed (outside any transaction), then swap that batch's chunks in
 * its own transaction. A failed batch leaves its old chunks in place; a retry skips the batches already done because
 * their hashes match.
 * ponytail: all changed products of a store are embedded in one job run. Measured on a first sync: 20k products
 * (~220 tokens each) took 163 s in 367 OpenAI calls at ~1.5M tokens/min, against pg-boss's default 15 min
 * `expireInSeconds` (soft: a retry skips the batches already done) and the key's 5M tokens/min.
 * The hard ceiling comes first: the stale-content read below binds one parameter per id, and the driver refuses more
 * than 65,534, so a run with ~65k or more changed products fails on every retry. Page them (for example 500 products
 * per run, then re-enqueue) before catalogs get there.
 */
export async function embedStore(
  { storeId }: { storeId: string },
  signal?: AbortSignal,
): Promise<{ embedded: number; removed: number; tokens: number }> {
  const [s] = await db.select({ active: stores.active, mode: stores.mode }).from(stores).where(eq(stores.id, storeId));
  if (!s?.active || s.mode === "mcp") return { embedded: 0, removed: 0, tokens: 0 };

  const { removed, stale } = await forStore(storeId, async (tx) => {
    // C8: only ACTIVE and published products are searchable. Deleted products are gone through the cascade.
    const gone = await tx
      .delete(chunks)
      .where(
        and(
          eq(chunks.storeId, storeId),
          inArray(
            chunks.productId,
            tx
              .select({ id: products.shopifyId })
              .from(products)
              .where(and(eq(products.storeId, storeId), or(ne(products.status, "ACTIVE"), eq(products.published, false)))),
          ),
        ),
      )
      .returning({ id: chunks.id });
    // Every chunk of a product is written in one swap, so one source_hash per product is enough to compare.
    const indexable = await tx
      .select({ id: products.shopifyId, contentHash: products.contentHash, hash: sql<string | null>`min(${chunks.sourceHash})` })
      .from(products)
      .leftJoin(chunks, and(eq(chunks.storeId, products.storeId), eq(chunks.productId, products.shopifyId)))
      .where(and(eq(products.storeId, storeId), eq(products.status, "ACTIVE"), eq(products.published, true)))
      .groupBy(products.shopifyId, products.contentHash);
    const ids = indexable.filter((p) => p.hash !== sourceHash(p.contentHash)).map((p) => p.id);
    // Content is read only for stale products, so an hourly run with nothing changed stays cheap.
    const stale: Stale[] = ids.length
      ? await tx
          .select({ id: products.shopifyId, title: products.title, content: products.content, contentHash: products.contentHash })
          .from(products)
          .where(and(eq(products.storeId, storeId), inArray(products.shopifyId, ids)))
          .orderBy(products.shopifyId)
      : [];
    return { removed: gone.length, stale };
  });

  let embedded = 0;
  let tokens = 0;
  for (let i = 0; i < stale.length; i += BATCH) {
    signal?.throwIfAborted();
    const r = await embedBatch(storeId, stale.slice(i, i + BATCH), signal);
    tokens += r.tokens;
    embedded += await swap(storeId, r.rows);
  }
  return { embedded, removed, tokens };
}

/** Embeds one batch. R2: a 400 re-embeds it product by product and skips (logs) any product whose own call 400s. */
async function embedBatch(storeId: string, batch: Stale[], signal?: AbortSignal): Promise<{ rows: Row[]; tokens: number }> {
  const run = async (ps: Stale[]) => {
    const texts = ps.map((p) => chunkText(p.title, p.content));
    const { vectors, tokens } = await embed(texts.flat(), { signal });
    const rows: Row[] = [];
    let k = 0;
    ps.forEach((p, j) =>
      texts[j].forEach((content, ordinal) =>
        rows.push({
          storeId,
          source: "product",
          productId: p.id,
          ordinal,
          content,
          sourceHash: sourceHash(p.contentHash),
          embedding: vectors[k++],
        }),
      ),
    );
    return { rows, tokens };
  };
  try {
    return await run(batch);
  } catch (e) {
    if (!(e instanceof OpenAI.BadRequestError)) throw e;
    if (batch.length === 1) {
      // Not retried by pg-boss; the product has no chunks, so every later run tries it again.
      console.error("embed skipped product", { storeId, productId: batch[0].id, error: e.message });
      return { rows: [], tokens: 0 };
    }
    const out = { rows: [] as Row[], tokens: 0 };
    for (const p of batch) {
      const r = await embedBatch(storeId, [p], signal);
      out.rows.push(...r.rows);
      out.tokens += r.tokens;
    }
    return out;
  }
}

/** Replaces the chunks of the batch's products that still exist, locking them so a concurrent delete can't race the insert. */
async function swap(storeId: string, rows: Row[]): Promise<number> {
  const ids = [...new Set(rows.map((r) => r.productId!))];
  if (ids.length === 0) return 0;
  return forStore(storeId, async (tx) => {
    const locked = await tx
      .select({ id: products.shopifyId })
      .from(products)
      .where(and(eq(products.storeId, storeId), inArray(products.shopifyId, ids)))
      .for("update");
    const live = new Set(locked.map((p) => p.id));
    if (live.size === 0) return 0;
    await tx.delete(chunks).where(and(eq(chunks.storeId, storeId), inArray(chunks.productId, [...live])));
    await tx.insert(chunks).values(rows.filter((r) => live.has(r.productId!)));
    return live.size;
  });
}
