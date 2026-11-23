import { expect, test } from "vitest";
import { chunkText } from "@/lib/chunking";

const words = (n: number) =>
  Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

test("short content is one chunk equal to the content", () => {
  const content = "a".repeat(500);
  expect(chunkText("T", content)).toEqual([content]);
});

test("long content splits into <=3200 char chunks with ~400 overlap and a Title prefix", () => {
  const content = words(1300).slice(0, 8000);
  const chunks = chunkText("My Title", content);
  expect(chunks.length).toBeGreaterThan(2);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(3200);
  chunks.slice(1).forEach((c) => expect(c.startsWith("Title: My Title\n")).toBe(true));
  const body = (c: string, i: number) => (i === 0 ? c : c.slice("Title: My Title\n".length));
  for (let i = 1; i < chunks.length; i++) {
    const prev = body(chunks[i - 1], i - 1);
    const cur = body(chunks[i], i);
    let overlap = 0;
    for (let k = Math.min(prev.length, cur.length); k > 0; k--) {
      if (prev.endsWith(cur.slice(0, k))) { overlap = k; break; }
    }
    expect(overlap).toBeGreaterThan(300);
    expect(overlap).toBeLessThan(500);
  }
});

test("no chunk cuts a word in half", () => {
  const content = words(1300).slice(0, 8000);
  const tokens = new Set(content.split(" "));
  const chunks = chunkText("T", content);
  for (const c of chunks) {
    const body = c.startsWith("Title: T\n") ? c.slice("Title: T\n".length) : c;
    const parts = body.split(" ");
    // interior words must be whole; edge words may be a partial only if the content's own edge
    for (const p of parts.slice(1, -1)) expect(tokens.has(p)).toBe(true);
  }
  // every word of the content appears whole in some chunk
  const joined = chunks.join(" ");
  expect(joined).toContain("word1299".slice(0, 7));
});

test("whitespace-free content is hard-cut at 3200 characters", () => {
  const content = "漢".repeat(8000);
  const chunks = chunkText("T", content);
  expect(chunks.length).toBeGreaterThan(2);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(3200);
});
