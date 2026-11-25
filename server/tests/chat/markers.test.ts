import { expect, test } from "vitest";
import { createMarkerParser } from "@/lib/chat/markers";

const allowed = new Map([
  ["1", "gid://shopify/Product/101"],
  ["2", "gid://shopify/Product/102"],
]);

function run(deltas: string[]) {
  const p = createMarkerParser(allowed);
  let text = "";
  const products: string[] = [];
  for (const d of [...deltas.map((x) => p.push(x)), p.end()]) {
    text += d.text;
    products.push(...d.products);
  }
  return { text, products };
}

test("a marker split across deltas is parsed and stripped", () => {
  expect(run(["Try [[prod", "uct:2]] and"])).toEqual({ text: "Try  and", products: ["gid://shopify/Product/102"] });
});

test("the partial marker is held back, not emitted early", () => {
  const p = createMarkerParser(allowed);
  expect(p.push("Try [[prod")).toEqual({ text: "Try ", products: [] });
  expect(p.push("uct:1]]!")).toEqual({ text: "!", products: ["gid://shopify/Product/101"] });
});

test("a number not in the allowed set gives no product", () => {
  expect(run(["See [[product:9]] here"])).toEqual({ text: "See  here", products: [] });
});

test("the same product twice is emitted once", () => {
  expect(run(["[[product:2]] and again [[product:2]]"]).products).toEqual(["gid://shopify/Product/102"]);
});

test("malformed markers, URLs and a later [[escalate]] are dropped from the text", () => {
  const r = run(["a [[product:x]] b [[https://evil.example/p]] c [[escalate]] d [[product:gid://shopify/Product/101]] e"]);
  expect(r).toEqual({ text: "a  b  c  d  e", products: [] });
});

test("a trailing unfinished marker is dropped at the end; a lone [ is kept", () => {
  expect(run(["Hello [[product:1"]).text).toBe("Hello ");
  expect(run(["array[", "0]"]).text).toBe("array[0]");
  expect(run(["end ["]).text).toBe("end [");
});

test("[[ with no ]] within 40 characters is released without its brackets", () => {
  const long = "x".repeat(50);
  const r = run([`a [[${long}`, " b ]]"]);
  expect(r.text).not.toContain("[[");
  expect(r.text).toContain(long);
});
