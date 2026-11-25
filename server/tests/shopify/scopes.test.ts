import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { shopify } from "@/lib/shopify/api";

// write_files / read_files serve only the optional logo upload, so they are asked for at upload time, not at install.

const FILE_SCOPES = ["write_files", "read_files"];

for (const name of ["shopify.app.toml", "shopify.app.askcart.toml"]) {
  test(`${name}: the file scopes are optional, not required`, () => {
    const toml = readFileSync(resolve(__dirname, "../../..", name), "utf8");
    const required = /^scopes = "([^"]*)"/m.exec(toml)![1].split(",");
    for (const s of FILE_SCOPES) expect(required).not.toContain(s);
    expect(/^optional_scopes = \[ "write_files", "read_files" \]/m.test(toml)).toBe(true);
  });
}

test("the app's configured required scopes leave the file scopes out", () => {
  const scopes = shopify.config.scopes!.toArray();
  for (const s of FILE_SCOPES) expect(scopes).not.toContain(s);
});
