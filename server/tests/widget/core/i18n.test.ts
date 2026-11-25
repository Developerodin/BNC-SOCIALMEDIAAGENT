// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { DICTS, pickLocale, translator } from "../../../widget/src/core/i18n";

const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();

describe("i18n", () => {
  it("picks the language from a locale", () => {
    expect(pickLocale("fr-CA")).toBe("fr");
    expect(pickLocale("DE")).toBe("de");
    expect(pickLocale("nl_BE")).toBe("nl");
    expect(pickLocale("pt-BR")).toBe("en");
    expect(pickLocale("")).toBe("en");
  });

  it.each(["fr", "de", "es", "it", "nl"] as const)("%s has every English key, all non-empty, with the same placeholders", (lang) => {
    const dict: Record<string, string> = DICTS[lang];
    expect(Object.keys(dict).sort()).toEqual(Object.keys(DICTS.en).sort());
    for (const [k, en] of Object.entries(DICTS.en)) {
      expect(dict[k].trim(), `${lang}.${k}`).not.toBe("");
      expect(vars(dict[k]), `${lang}.${k}`).toEqual(vars(en));
    }
  });

  it.each(["en", "fr", "de", "es", "it", "nl"] as const)("%s has the editorial panel strings", (lang) => {
    const dict: Record<string, string> = DICTS[lang];
    for (const k of ["expert", "viewing", "continue_placeholder", "cart", "product_details", "view_product"]) expect(dict[k]?.trim(), `${lang}.${k}`).toBeTruthy();
    expect(dict.expert).toContain("{store}");
  });

  it.each(["en", "fr", "de", "es", "it", "nl"] as const)("%s has a status line for every step", (lang) => {
    const dict: Record<string, string> = DICTS[lang];
    for (const s of ["understanding", "searching", "checking", "policies", "collection", "orders", "writing"]) expect(dict[`status_${s}`]?.trim(), `${lang}.${s}`).toBeTruthy();
  });

  it("English status lines are exact", () => {
    expect([DICTS.en.status_understanding, DICTS.en.status_searching, DICTS.en.status_checking, DICTS.en.status_policies, DICTS.en.status_collection, DICTS.en.status_orders, DICTS.en.status_writing]).toEqual([
      "Understanding your question…", "Searching the catalogue…", "Checking prices and stock…", "Looking up store policies…", "Browsing the collection…", "Checking your orders…", "Writing the answer…",
    ]);
  });

  it.each(["en", "fr", "de", "es", "it", "nl"] as const)("%s has the in-cart strings with a {count} placeholder", (lang) => {
    const dict: Record<string, string> = DICTS[lang];
    expect(dict.in_cart_n).toContain("{count}");
    expect(dict.cart_items).toContain("{count}");
    expect(dict.cart_item?.trim()).toBeTruthy();
    expect(dict.cart_item).not.toContain("{count}");
  });

  it("fills variables, falls back to English, and to the key", () => {
    expect(translator("en")("only_left", { n: 3 })).toBe("Only 3 left");
    expect(translator("fr-FR")("only_left", { n: 3 })).toBe(DICTS.fr.only_left.replace("{n}", "3"));
    expect(translator("xx")("sold_out")).toBe("Sold out");
    expect(translator("fr")("no_such_key")).toBe("no_such_key");
  });
});
