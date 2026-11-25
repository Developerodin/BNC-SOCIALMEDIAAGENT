import { createHash } from "node:crypto";

const DIMS = 512;

// Deterministic bag-of-words vector: each lowercased word adds 1 to a hashed dimension, then the
// vector is normalised. Texts sharing words get closer vectors. Dimension 0 is a constant bias so
// no vector is all zeros.
export function fakeVector(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[0] = 1;
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    v[1 + (createHash("sha256").update(w).digest().readUInt32BE(0) % (DIMS - 1))] += 1;
  }
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

export async function fakeEmbed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
  return { vectors: texts.map(fakeVector), tokens: texts.length };
}
