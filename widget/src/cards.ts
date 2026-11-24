// Product cards (Task 31; UD9–UD12, D30, D72, D75, C11, C26). Built with createElement and textContent only: titles,
// option names and the store's cart messages are data, never markup (Review Focus 1). Links go through safeHttpsUrl and
// images through safeImageUrl (cdn.shopify.com only), otherwise there is no link and a placeholder.
import type { Card, CardsRenderer, WidgetCtx } from "../../src/lib/widget-contract";
import { requestAdd } from "./bridge";
import { addToCart } from "./cart";
import { formatPrice, resolveHttpsUrl, safeHttpsUrl, safeImageUrl, stockLabel } from "./core/format";
import { tokenStore, uiState } from "./core/storage";
import { FULL_BELOW } from "./panel/styles";

type Variant = Card["variants"][number];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function link(href: string, cls: string, text: string): HTMLAnchorElement {
  const a = el("a", cls, text);
  a.href = href;
  a.rel = "noopener noreferrer"; // same tab (UD9): no target
  return a;
}

const optionValue = (v: Variant, name: string) => v.options.find((o) => o.name === name)?.value;

function cardEl(card: Card, ctx: WidgetCtx, messageId: string | null): HTMLElement {
  const { t, page } = ctx;
  const root = el("div", "ac-card");
  const url = safeHttpsUrl(card.url);
  // The shopper chose this product: on a phone, where the panel is full screen (UD4), don't reopen it over the product's
  // page. Set before the navigation. On a desktop the floating panel stays open; other links (View cart, the theme's own)
  // keep the UD13 reopen.
  const productLink = (href: string, cls: string, text: string) => {
    const a = link(href, cls, text);
    if (page.hosted) a.target = "_blank"; // inside the embed iframe a same-tab link would replace the chat
    a.addEventListener("click", () => {
      if (window.innerWidth < FULL_BELOW) uiState(page.shop).open.set(false);
    });
    return a;
  };

  const img = safeImageUrl(card.imageUrl);
  if (img) {
    const i = el("img", "ac-card__img");
    i.src = img;
    i.alt = ""; // the title right below names the product
    i.loading = "lazy";
    root.append(i);
  } else {
    const ph = el("div", "ac-card__img ac-card__img--placeholder");
    ph.setAttribute("aria-hidden", "true");
    root.append(ph);
  }

  const body = el("div", "ac-card__body");
  root.append(body);
  body.append(url ? productLink(url, "ac-card__title", card.title) : el("span", "ac-card__title", card.title));

  // C11 (b) fallback card: title, image and link only.
  if (card.price === null) return root;

  // C26 (b): a price in the store's currency while the shopper browses in another one is hidden; Add stays (checkout
  // charges the local price). Until C26 (c) sends local prices, page.currency null means we can't tell, so it shows.
  const otherCurrency = !!page.currency && !!card.currency && card.currency !== page.currency;
  const priceBox = el("div", "ac-card__prices");
  body.append(priceBox);
  const setPrice = (price: string, compareAt: string | null) => {
    priceBox.replaceChildren();
    if (otherCurrency) {
      priceBox.append(el("span", "ac-card__price-hint", t("price_on_product")));
      return;
    }
    const p = card.currency ? formatPrice(price, card.currency, page.locale) : null;
    if (!p) return;
    priceBox.append(el("span", "ac-card__price", p));
    const c = compareAt && card.currency && Number(compareAt) > Number(price) ? formatPrice(compareAt, card.currency, page.locale) : null;
    if (c) priceBox.append(el("s", "ac-card__compare", c));
  };
  setPrice(card.price, card.compareAtPrice);

  // D72: sold out → a badge and no Add.
  if (card.available === false) {
    body.append(el("span", "ac-card__badge", t("sold_out")));
    return root;
  }

  const stock = el("p", "ac-card__stock");
  const setStock = (s: Card["stock"]) => {
    const label = stockLabel(s, ctx.config.stockThreshold, t);
    stock.textContent = label ?? "";
    stock.hidden = !label;
  };
  setStock(card.stock);
  body.append(stock);

  // D75, C12: subscriptions and products with more variants than we fetched go to the product page.
  if (card.action === "view_options" || card.moreVariants) {
    if (url) body.append(productLink(url, "ac-card__options", t("view_options")));
    return root;
  }
  if (card.action !== "add" || card.variants.length === 0) return root;

  body.append(addControls(card, ctx, messageId, setPrice, setStock));
  return root;
}

function addControls(
  card: Card,
  ctx: WidgetCtx,
  messageId: string | null,
  setPrice: (price: string, compareAt: string | null) => void,
  setStock: (s: Card["stock"]) => void,
): HTMLElement {
  const { t, page } = ctx;
  const box = el("div", "ac-card__actions");
  const variants = card.variants;
  const names = variants.length > 1 ? variants[0].options.map((o) => o.name) : [];
  const selected = new Map<string, string>(names.map((n) => [n, ""]));
  const available = variants.filter((v) => v.available);
  // Preselected when there's a single (default) variant or a single available one.
  if (available.length === 1) for (const n of names) selected.set(n, optionValue(available[0], n) ?? "");

  const selects: HTMLSelectElement[] = names.map((name) => {
    const label = el("label", "ac-card__picker");
    label.append(el("span", "ac-card__picker-name", name));
    const select = el("select", "ac-card__select");
    const placeholder = el("option", undefined, `${t("option")}: ${name}`);
    placeholder.value = "";
    select.append(placeholder);
    for (const value of new Set(variants.map((v) => optionValue(v, name) ?? ""))) {
      if (!value) continue;
      const o = el("option", undefined, value);
      o.value = value;
      select.append(o);
    }
    select.value = selected.get(name) ?? "";
    select.addEventListener("change", () => {
      selected.set(name, select.value);
      update();
    });
    label.append(select);
    box.append(label);
    return select;
  });

  const hosted = page.hosted === true;
  // Cart bridge (docs/embed.md): on the hosted page inside a store's embed, Add to cart asks the store page to add it.
  const origins = page.parentOrigins ?? [];
  let bridged = hosted && page.bridge === true && origins.length > 0;
  let addLabel = t(hosted && !bridged ? "buy_on_store" : "add_to_cart");
  const button = el("button", "ac-card__add", addLabel);
  button.type = "button";
  const status = el("p", "ac-card__status");
  status.setAttribute("aria-live", "polite");
  box.append(button, status);

  let busy = false;
  let chosen: Variant | null = null;
  const matches = (v: Variant, skip?: string) =>
    names.every((n) => n === skip || !selected.get(n) || optionValue(v, n) === selected.get(n));

  function update() {
    // D72: an option value is disabled when no available variant has it together with the other current choices.
    names.forEach((name, i) => {
      for (const o of selects[i].options) {
        if (o.value) o.disabled = !available.some((v) => optionValue(v, name) === o.value && matches(v, name));
      }
    });
    chosen =
      names.length === 0
        ? (variants[0].available ? variants[0] : null)
        : names.every((n) => selected.get(n))
          ? (available.find((v) => matches(v)) ?? null)
          : null;
    if (chosen && names.length > 0) {
      // A picked variant shows its own price and stock; a single-variant card already shows them.
      setPrice(chosen.price, chosen.compareAtPrice);
      setStock(chosen.stock);
    }
    button.disabled = busy || !chosen;
  }
  update();

  button.addEventListener("click", async (ev) => {
    const variant = chosen;
    if (busy || !variant) return; // the disabled button plus this guard: a double click adds once
    // Only a real click starts a cart add through the bridge: never a script, never model output.
    if (hosted && bridged && !ev.isTrusted) return;
    if (hosted && !bridged) {
      // No storefront cart here: open the product on the store with this variant selected.
      const href = resolveHttpsUrl(card.url);
      if (href && /^\d+$/.test(variant.id)) {
        const u = new URL(href);
        u.searchParams.set("variant", variant.id);
        window.open(u.href, "_blank", "noopener,noreferrer");
      }
      return;
    }
    busy = true;
    button.disabled = true;
    button.textContent = t("adding");
    status.replaceChildren();
    status.className = "ac-card__status";
    const quantity = 1;
    let cartHref = hosted ? null : resolveHttpsUrl(page.cartUrl);
    let res: Awaited<ReturnType<typeof addToCart>>;
    if (hosted) {
      const reply = await requestAdd(origins, variant.id, quantity);
      if (!reply) {
        // Nobody valid answered (not a Shopify page, or an old embed.js): this chat has no cart, so go back to the product link.
        bridged = false;
        addLabel = t("buy_on_store");
        busy = false;
        button.textContent = addLabel;
        update();
        return; // not an error to show: the button itself has changed
      }
      cartHref = resolveHttpsUrl(reply.origin + "/cart"); // origin was matched against parentOrigins in bridge.ts
      res = reply.res;
    } else res = await addToCart(page, variant.id, quantity);
    busy = false;
    button.textContent = addLabel;
    update();

    if (res.ok) {
      // UD11: "Added · View cart".
      status.className = "ac-card__status ac-card__added";
      status.append(t("added"));
      if (cartHref) {
        const a = link(cartHref, "ac-card__cart", t("view_cart"));
        if (hosted) a.target = "_top"; // leave the iframe: the cart is the store's page
        status.append(" · ", a);
      }
      ctx.announce(t("added"));
      const token = tokenStore(page.shop).get();
      // Fire and forget; the eventId is fixed per add, so a replayed log is counted once.
      if (token) {
        void ctx.api.logCartAdd(token, { messageId, productId: card.id, variantId: variant.id, quantity, eventId: crypto.randomUUID() });
      }
      return;
    }
    // 422: the store's own description, already in the store's language, shown as is.
    const msg =
      res.message ?? (res.status === 429 ? t("cart_rate_limited") : t("cart_error"));
    status.className = "ac-card__status ac-card__error";
    status.textContent = msg;
    ctx.announce(msg);
  });

  return box;
}

/**
 * UD9, UD12: one card full width, two or more in a scroll-snap carousel with arrows, keyboard and "n of m" labels.
 * `messageId` is the answer the cards came with; a cart add logs it (null for an answer the server sent without one).
 */
export function renderCards(into: HTMLElement, cards: Card[], ctx: WidgetCtx, messageId: string | null = null): void {
  if (cards.length === 0) return;
  const wrap = el("div", `ac-cards ${cards.length === 1 ? "ac-cards--single" : "ac-cards--carousel"}`);
  if (cards.length === 1) {
    wrap.append(cardEl(cards[0], ctx, messageId));
    into.append(wrap);
    return;
  }

  const track = el("ul", "ac-cards__track");
  track.tabIndex = 0;
  cards.forEach((c, i) => {
    const li = el("li", "ac-cards__slide");
    const card = cardEl(c, ctx, messageId);
    card.setAttribute("role", "group");
    card.setAttribute("aria-roledescription", "slide");
    card.setAttribute("aria-label", `${i + 1} / ${cards.length}`);
    li.append(card);
    track.append(li);
  });
  const step = (dir: 1 | -1) => {
    const w = (track.firstElementChild as HTMLElement | null)?.offsetWidth || track.clientWidth;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    track.scrollBy?.({ left: dir * w, behavior: reduced ? "auto" : "smooth" });
  };
  track.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      step(e.key === "ArrowRight" ? 1 : -1);
    }
  });
  const nav = (dir: 1 | -1, label: string, glyph: string) => {
    const b = el("button", `ac-cards__nav ac-cards__nav--${dir === 1 ? "next" : "prev"}`, glyph);
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.addEventListener("click", () => step(dir));
    return b;
  };
  wrap.append(nav(-1, ctx.t("previous"), "‹"), track, nav(1, ctx.t("next"), "›"));
  into.append(wrap);
}
// Compile-time check that it still fits the shared seam.
const _contract: CardsRenderer = renderCards;
void _contract;

/** Card styles for the panel's shadow root (Task 30 owns styles.ts and includes this). px only (Global Constraints). */
export const CARDS_CSS = `
.ac-cards{position:relative;margin:8px 0}
.ac-cards__track{display:flex;gap:8px;overflow-x:auto;scroll-snap-type:x mandatory;list-style:none;margin:0;padding:0 0 4px}
.ac-cards__slide{flex:0 0 72%;scroll-snap-align:start}
.ac-cards__nav{position:absolute;top:60px;width:28px;height:28px;border-radius:14px;border:1px solid #d0d0d0;background:#fff;cursor:pointer;z-index:1}
.ac-cards__nav--prev{left:-6px}.ac-cards__nav--next{right:-6px}
.ac-card{display:flex;flex-direction:column;height:100%;border:1px solid #e3e3e3;border-radius:10px;overflow:hidden;background:#fff}
.ac-card__img{width:100%;aspect-ratio:1/1;object-fit:cover;display:block;background:#f2f2f2}
.ac-card__body{display:flex;flex-direction:column;gap:4px;padding:8px 10px 10px;font-size:13px;line-height:18px}
.ac-card__title{font-weight:600;color:inherit;text-decoration:none}
a.ac-card__title:hover{text-decoration:underline}
.ac-card__prices{display:flex;gap:6px;align-items:baseline}
.ac-card__compare,.ac-card__price-hint,.ac-card__stock{color:#6b6b6b;font-size:12px;margin:0}
.ac-card__badge{align-self:flex-start;padding:2px 8px;border-radius:10px;background:#eee;font-size:12px}
.ac-card__actions{display:flex;flex-direction:column;gap:6px;margin-top:auto}
.ac-card__picker{display:flex;flex-direction:column;gap:2px;font-size:12px}
.ac-card__select{font:inherit;font-size:13px;padding:4px;border:1px solid #8a8a8a;border-radius:6px}
.ac-card__add{font:inherit;font-size:13px;padding:8px;border:0;border-radius:8px;cursor:pointer;background:var(--ac-accent,#111);color:var(--ac-on-accent,#fff)}
.ac-card__add:disabled{opacity:.5;cursor:default}
.ac-card__options{font-weight:600;color:inherit}
.ac-card__status{margin:0;font-size:12px}
.ac-card__error{color:#b00020}
`;
