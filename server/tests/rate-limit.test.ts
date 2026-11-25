import { beforeEach, expect, test } from "vitest";
import { rateLimit, rateLimitSize, resetRateLimit } from "@/lib/rate-limit";

beforeEach(resetRateLimit);

test("counts per key in a one-minute window and reports the wait", () => {
  for (let i = 0; i < 3; i++) expect(rateLimit("k", 1000, 3)).toBe(0);
  expect(rateLimit("k", 1000, 3)).toBe(60);
  expect(rateLimit("other", 1000, 3)).toBe(0);
  expect(rateLimit("k", 61_000, 3)).toBe(0);
});

test("expired windows are dropped once the map is large, so one-off keys don't leak", () => {
  for (let i = 0; i < 5000; i++) rateLimit(`ip:${i}`, 0);
  expect(rateLimitSize()).toBe(5000);
  rateLimit("fresh", 120_000);
  expect(rateLimitSize()).toBe(1);
});

test("live windows survive the sweep", () => {
  for (let i = 0; i < 5000; i++) rateLimit(`ip:${i}`, 100_000);
  rateLimit("fresh", 120_000);
  expect(rateLimitSize()).toBe(5001);
});
