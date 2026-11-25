import { expect, test } from "vitest";
import { createMarkerParser } from "@/lib/chat/markers";

const allowed = new Map([
  ["1", "gid://shopify/Product/101"],
  ["2", "gid://shopify/Product/102"],
]);
const titles: Record<string, string> = { "gid://shopify/Product/101": "Margot Sofa", "gid://shopify/Product/102": "Oak Table" };

function run(deltas: string[], withTitles = false) {
  const p = createMarkerParser(allowed, withTitles ? (g) => titles[g] : undefined);
  let text = "";
  const products: string[] = [];
  for (const d of [...deltas.map((x) => p.push(x)), p.end()]) {
    text += d.text;
    products.push(...d.products);
  }
  return { text, products };
}
/** The answer in one piece, and again one character at a time: the same text either way. */
function both(text: string, withTitles = true) {
  const whole = run([text], withTitles);
  const chars = run([...text], withTitles);
  expect(chars).toEqual(whole);
  return whole;
}

test("a marker split across deltas is parsed and stripped", () => {
  expect(run(["Try [[prod", "uct:2]] and"])).toEqual({ text: "Try and", products: ["gid://shopify/Product/102"] });
});

test("the partial marker is held back, not emitted early", () => {
  const p = createMarkerParser(allowed);
  expect(p.push("Try [[prod")).toEqual({ text: "Try", products: [] });
  // The card is announced at once; the text after the marker waits to see whether a name follows it.
  expect(p.push("uct:1]]!")).toEqual({ text: "", products: ["gid://shopify/Product/101"] });
  expect(p.end()).toEqual({ text: "!", products: [] });
});

test("a number not in the allowed set gives no product", () => {
  expect(run(["See [[product:9]] here"])).toEqual({ text: "See here", products: [] });
});

test("the same product twice is emitted once", () => {
  expect(run(["[[product:2]] and again [[product:2]]"]).products).toEqual(["gid://shopify/Product/102"]);
});

test("malformed markers, URLs and a later [[escalate]] are dropped from the text", () => {
  const r = run(["a [[product:x]] b [[https://evil.example/p]] c [[escalate]] d [[product:gid://shopify/Product/101]] e"]);
  expect(r).toEqual({ text: "a b c d e", products: [] });
});

test("a trailing unfinished marker is dropped at the end; a lone [ is kept", () => {
  expect(run(["Hello [[product:1"]).text).toBe("Hello");
  expect(run(["array[", "0]"]).text).toBe("array[0]");
  expect(run(["end ["]).text).toBe("end [");
});

test("[[ with no ]] within 40 characters is released without its brackets", () => {
  const long = "x".repeat(50);
  const r = run([`a [[${long}`, " b ]]"]);
  expect(r.text).not.toContain("[[");
  expect(r.text).toContain(long);
});

// Fix #2: a marker where a name is needed becomes the product's title.
test("a marker that stands for the name is replaced by the title, and the card still comes", () => {
  expect(both("For a small flat, [[product:1]] is the best fit.")).toEqual({
    text: "For a small flat, Margot Sofa is the best fit.",
    products: ["gid://shopify/Product/101"],
  });
  expect(both("[[product:2]] is solid oak.").text).toBe("Oak Table is solid oak.");
  expect(both("Voici le choix : [[product:2]], en chêne massif.").text).toBe("Voici le choix: Oak Table, en chêne massif.");
  expect(both("I like the [[product:1]] and [[product:2]].").text).toBe("I like the Margot Sofa and Oak Table.");
});

test("a marker after the name, or ending a sentence, is just removed", () => {
  expect(both("The Margot Sofa [[product:1]] is great.").text).toBe("The Margot Sofa is great.");
  expect(both("I would pick the Oak Table. [[product:2]]").text).toBe("I would pick the Oak Table.");
  expect(both("I would pick the Oak Table [[product:2]].").text).toBe("I would pick the Oak Table.");
  expect(both("Two options:\n[[product:1]]\n[[product:2]]\nWhich one?").text).toBe("Two options:\n\nWhich one?");
});

test("a bullet that holds only a marker gets the title, not an empty bullet", () => {
  expect(both("Options:\n- [[product:1]]\n- [[product:2]]\n").text).toBe("Options:\n- Margot Sofa\n- Oak Table\n");
});

test("a name the model wrote next to the marker is not repeated", () => {
  expect(both("- [[product:1]] **Margot Sofa** is great\n- [[product:2]] Oak Table, solid").text).toBe("- **Margot Sofa** is great\n- Oak Table, solid");
  expect(both("**Margot Sofa** [[product:1]], is great").text).toBe("**Margot Sofa**, is great");
  expect(both("- [[product:1]] — Margot Sofa, compact\n").text).toBe("- Margot Sofa, compact\n");
});

test("a marker for a product with no title or no card is dropped without a hole being filled", () => {
  expect(run(["[[product:1]] is nice"], false).text).toBe("is nice");
  expect(both("[[product:9]] is nice").text).toBe("is nice");
});

test("a colon before a removed marker is not left dangling", () => {
  expect(both("Here is the sofa: [[product:1]]").text).toBe("Here is the sofa:"); // the card sits right below
  expect(both("Here is the sofa: [[product:1]].").text).toBe("Here is the sofa.");
  expect(both("Voici : [[product:1]] Il est solide.").text).toBe("Voici. Il est solide.");
});

test("no space before ! ? ; : , . and no double or trailing spaces", () => {
  expect(both("Bonjour !  Voici la liste :  ok ?   ", false).text).toBe("Bonjour! Voici la liste: ok?");
  expect(both("a   b \nc  ", false).text).toBe("a b\nc");
  expect(both("It fits well [[product:1]] .").text).toBe("It fits well.");
});
