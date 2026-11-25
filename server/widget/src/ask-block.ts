// askcart-ask.js: the "Ask about this product" app block (UD5). Shopify loads it once per page for every instance.
// A click only asks the launcher to open the chat for this product (C25): it never sends a message, so no
// message is spent until the shopper types or taps a suggestion. The launcher (Task 26) listens for the event.
//
// Hand-off: window.dispatchEvent(new CustomEvent("askcart:open", { detail: { productId } })), productId being
// the numeric product id as a string (the same shape as PageContext.productId).
//
// With the AskCart embed off there is no #askcart-root and nobody listens, so the button is hidden rather than
// left doing nothing. `hidden` alone loses to theme rules like `.button { display: inline-flex }`, so the inline
// display is set too.

const SEL = "[data-askcart-ask]";

export function initAskBlocks(doc: Document = document): void {
  const run = () => {
    const hasRoot = doc.getElementById("askcart-root") !== null;
    doc.querySelectorAll<HTMLElement>(SEL).forEach((btn) => {
      if (!hasRoot) {
        btn.hidden = true;
        btn.style.display = "none";
        return;
      }
      if (btn.dataset.askcartBound) return; // re-runs (theme editor section reloads) must not bind twice
      btn.dataset.askcartBound = "1";
      btn.addEventListener("click", () => {
        const productId = btn.dataset.product || null;
        window.dispatchEvent(new CustomEvent("askcart:open", { detail: { productId } }));
      });
    });
  };
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
  // The theme editor re-renders a section in place when the merchant adds or moves the block.
  doc.addEventListener("shopify:section:load", run);
}

initAskBlocks(document);
