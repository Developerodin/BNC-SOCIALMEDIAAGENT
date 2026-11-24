// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { initAskBlocks } from "../../widget/src/ask-block";

function page(withRoot: boolean, productId = "8123456789") {
  document.body.innerHTML =
    `<button type="button" class="button button--secondary" data-askcart-ask data-product="${productId}">Ask</button>` +
    (withRoot ? `<div id="askcart-root" hidden></div>` : "");
  return document.querySelector<HTMLButtonElement>("[data-askcart-ask]")!;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Ask about this product block (UD5, C25)", () => {
  it("dispatches askcart:open on window with the product id, once per click", () => {
    const btn = page(true);
    initAskBlocks(document);
    initAskBlocks(document); // a second init (theme editor reload) must not double-bind
    const seen = vi.fn();
    window.addEventListener("askcart:open", seen);
    btn.click();
    window.removeEventListener("askcart:open", seen);
    expect(seen).toHaveBeenCalledTimes(1);
    expect((seen.mock.calls[0][0] as CustomEvent).detail).toEqual({ productId: "8123456789" });
    expect(btn.hidden).toBe(false);
  });

  it("only opens: the event carries no message to send (C25)", () => {
    const btn = page(true);
    initAskBlocks(document);
    const seen = vi.fn();
    window.addEventListener("askcart:open", seen);
    btn.click();
    window.removeEventListener("askcart:open", seen);
    expect(Object.keys((seen.mock.calls[0][0] as CustomEvent).detail)).toEqual(["productId"]);
  });

  it("hides the button when the embed is off (no #askcart-root)", () => {
    const btn = page(false);
    initAskBlocks(document);
    expect(btn.hidden).toBe(true);
    expect(btn.style.display).toBe("none");
    const seen = vi.fn();
    window.addEventListener("askcart:open", seen);
    btn.click();
    window.removeEventListener("askcart:open", seen);
    expect(seen).not.toHaveBeenCalled();
  });

  it("waits for DOMContentLoaded while the document is still loading", () => {
    const btn = page(false);
    const spy = vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    initAskBlocks(document);
    expect(btn.hidden).toBe(false); // not decided yet: the embed root is at the end of <body>
    document.body.insertAdjacentHTML("beforeend", `<div id="askcart-root" hidden></div>`);
    spy.mockRestore();
    document.dispatchEvent(new Event("DOMContentLoaded"));
    expect(btn.hidden).toBe(false);
    const seen = vi.fn();
    window.addEventListener("askcart:open", seen);
    btn.click();
    window.removeEventListener("askcart:open", seen);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe("askcart-ask.liquid", () => {
  const liquid = readFileSync(path.resolve(__dirname, "../../extensions/askcart/blocks/askcart-ask.liquid"), "utf8");
  const schema = JSON.parse(liquid.split("{% schema %}")[1].split("{% endschema %}")[0]);

  it("is a product-page block that loads askcart-ask.js", () => {
    expect(schema.target).toBe("section");
    expect(schema.enabled_on).toEqual({ templates: ["product"] });
    expect(schema.javascript).toBe("askcart-ask.js");
  });

  it("renders a theme-styled button with the product id and the translated label", () => {
    expect(liquid).toMatch(/class="button button--secondary/);
    expect(liquid).toContain("data-askcart-ask");
    expect(liquid).toContain('data-product="{{ product.id | escape }}"');
    expect(liquid).toContain("'ask_block.button' | t");
  });
});
