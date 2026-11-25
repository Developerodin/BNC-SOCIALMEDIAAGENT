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

  it("fills variables, falls back to English, and to the key", () => {
    expect(translator("en")("only_left", { n: 3 })).toBe("Only 3 left");
    expect(translator("fr-FR")("only_left", { n: 3 })).toBe(DICTS.fr.only_left.replace("{n}", "3"));
    expect(translator("xx")("sold_out")).toBe("Sold out");
    expect(translator("fr")("no_such_key")).toBe("no_such_key");
  });
});
