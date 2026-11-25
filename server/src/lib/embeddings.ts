import OpenAI from "openai";
import { EMBEDDING_DIMS, EMBEDDING_MODEL } from "./embedding-config";

export { EMBEDDING_DIMS, EMBEDDING_MODEL, CHUNKER_VERSION } from "./embedding-config";

const MAX_INPUTS = 100;
const MAX_BATCH_TOKENS = 200_000;

// The UTF-8 byte length is a safe upper bound in every script: one token is never more than one byte.
// ponytail: about 4x the real count for English, so batches are smaller than they could be (more calls, same tokens).
function estimateTokens(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

// An OpenAI error (including a 400 for one bad input) propagates: the caller (embed job)
// decides to skip that product. maxRetries: 0 so pg-boss owns retrying.
export async function embed(
  texts: string[],
  opts: { signal?: AbortSignal } = {},
): Promise<{ vectors: number[][]; tokens: number }> {
  if (texts.length === 0) return { vectors: [], tokens: 0 };
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
  const batches: string[][] = [];
  let cur: string[] = [];
  let curTokens = 0;
  for (const t of texts) {
    const est = estimateTokens(t);
    if (cur.length > 0 && (cur.length >= MAX_INPUTS || curTokens + est > MAX_BATCH_TOKENS)) {
      batches.push(cur);
      cur = [];
      curTokens = 0;
    }
    cur.push(t);
    curTokens += est;
  }
  batches.push(cur);

  const vectors: number[][] = [];
  let tokens = 0;
  for (const input of batches) {
    const res = await openai.embeddings.create(
      { model: EMBEDDING_MODEL, input, dimensions: EMBEDDING_DIMS },
      { signal: opts.signal },
    );
    for (const d of res.data) vectors.push(d.embedding);
    tokens += res.usage.total_tokens;
  }
  return { vectors, tokens };
}
