// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { parseSse } from "../../../widget/src/core/sse";
import { streamOf } from "./helpers";

async function all(chunks: string[]) {
  const out: { event: string; data: unknown }[] = [];
  for await (const e of parseSse(streamOf(chunks))) out.push(e);
  return out;
}

describe("parseSse", () => {
  it("joins an event split across chunks", async () => {
    expect(await all(['event: text\ndata: {"delta":"Hi', '"}\n\n'])).toEqual([{ event: "text", data: { delta: "Hi" } }]);
  });

  it("skips ping comments", async () => {
    expect(await all([": ping\n\n", 'event: done\ndata: {"conversationToken":"t"}\n\n', ": ping\n\n"])).toEqual([
      { event: "done", data: { conversationToken: "t" } },
    ]);
  });

  it("parses CRLF line ends, even with the CR and LF in different chunks", async () => {
    expect(await all(['event: text\r\ndata: {"delta":"a"}\r', '\n\r\nevent: text\r\ndata: {"delta":"b"}\r\n\r\n'])).toEqual([
      { event: "text", data: { delta: "a" } },
      { event: "text", data: { delta: "b" } },
    ]);
  });

  it("parses a last event with no blank line at stream end, and ends", async () => {
    expect(await all(['event: done\ndata: {"conversationToken":"t"}'])).toEqual([{ event: "done", data: { conversationToken: "t" } }]);
  });

  it("keeps a non-JSON payload as a string and defaults the event name", async () => {
    expect(await all(["data: hello\n\n"])).toEqual([{ event: "message", data: "hello" }]);
  });
});
