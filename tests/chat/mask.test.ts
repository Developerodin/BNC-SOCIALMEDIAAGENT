import { expect, test } from "vitest";
import { maskPII } from "@/lib/chat/mask";

// Agreed contact details that must be masked (D41).
const MASKED: [string, string][] = [
  ["a.b+c@example.co.uk", "[email]"],
  ["+33 6 12 34 56 78", "[phone]"],
  ["(555) 123-4567", "[phone]"],
  ["06.12.34.56.78", "[phone]"],
];

// Agreed guard against false positives: none of these may be masked.
const NOT_MASKED = ["size 42", "120x200 cm", "SKU 12345", "2026-11-24", "€129.99", "order 1001"];

test.each(MASKED)("masks %s", (input, expected) => {
  expect(maskPII(input)).toBe(expected);
  expect(maskPII(`call me at ${input} please`)).toBe(`call me at ${expected} please`);
});

test.each(NOT_MASKED)("does not mask %s", (input) => {
  expect(maskPII(input)).toBe(input);
});

test("masks both kinds in one message", () => {
  expect(maskPII("Email jo@shop.fr or ring 06 12 34 56 78, size 42")).toBe(
    "Email [email] or ring [phone], size 42",
  );
});

test("masking twice gives the same result as masking once", () => {
  const text = `Reach me: a.b+c@example.co.uk, +33 6 12 34 56 78, (555) 123-4567. ${NOT_MASKED.join(", ")}`;
  const once = maskPII(text);
  expect(maskPII(once)).toBe(once);
});
