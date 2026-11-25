// Product cards (Task 31; UD9–UD12, D30, D72, D75, C11, C26). Built with createElement and textContent only: titles,
// option names and the store's cart messages are data, never markup (Review Focus 1). Links go through safeHttpsUrl and
// images through safeImageUrl (cdn.shopify.com only), otherwise there is no link and a placeholder.
import type { Card, CardsRenderer, WidgetCtx } from "../../src/lib/widget-contract";
import { requestAdd } from "./bridge";
import { addToCart, cartVariantIds } from "./cart";
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

/** Called once per confirmed add from a card, with the store's cart URL (null when there is none). */
export type OnAdded = (title: string, cartHref: string | null) => void;

function cardEl(card: Card, ctx: WidgetCtx, messageId: string | null, onAdded?: OnAdded): HTMLElement {
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

  body.append(addControls(card, ctx, messageId, setPrice, setStock, onAdded));
  return root;
}

function addControls(
  card: Card,
  ctx: WidgetCtx,
  messageId: string | null,
  setPrice: (price: string, compareAt: string | null) => void,
  setStock: (s: Card["stock"]) => void,
  onAdded?: OnAdded,
): HTMLElement {
  const { t, page } = ctx;
  const box = el("div", "ac-card__actions");
  const variants = card.variants;
  const names = variants.length > 1 ? variants[0].options.map((o) => o.name) : [];
  const selected = new Map<string, string>(names.map((n) => [n, ""]));
  const available = variants.filter((v) => v.available);
  // Preselected when an option has only one value among the available variants (a single available variant fills all).
  for (const n of names) {
    const vals = new Set(available.map((v) => optionValue(v, n) ?? ""));
    if (vals.size === 1) selected.set(n, [...vals][0]);
  }

  const selects: HTMLSelectElement[] = names.map((name) => {
    const label = el("label", "ac-card__picker");
    label.append(el("span", "ac-card__picker-name", name));
    const select = el("select", "ac-card__select");
    const placeholder = el("option", undefined, t("choose", { option: name }));
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
  const bridged = hosted && page.bridge === true && origins.length > 0;
  let fellBack = false; // one unanswered add shows "Buy on the store" for the next click only; the bridge is tried again after
  let addLabel = t(hosted && !bridged ? "buy_on_store" : "add_to_cart");
  const button = el("button", "ac-card__add", addLabel);
  button.type = "button";
  const status = el("p", "ac-card__status");
  status.setAttribute("aria-live", "polite");
  const hint = el("p", "ac-card__hint");
  hint.id = `ac-hint-${Math.random().toString(36).slice(2, 8)}`;
  box.append(button, status, hint);
  // Already in the cart (any variant): say so, so it survives a reload or a redrawn history. Store pages only: the hosted
  // page can't read the store's cart. An add's own "Added" line wins if it came first.
  if (!hosted) {
    void cartVariantIds(page).then((ids) => {
      const href = resolveHttpsUrl(page.cartUrl);
      if (status.childNodes.length || !variants.some((v) => ids.has(v.id))) return;
      status.className = "ac-card__status ac-card__added";
      status.append(t("in_cart"));
      if (href) status.append(" · ", link(href, "ac-card__cart", t("view_cart")));
    });
  }

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
    // Say why Add to cart is greyed: name the first option still to pick.
    const todo = names.find((n) => !selected.get(n));
    hint.textContent = todo ? t("choose_first", { option: todo }) : "";
    if (todo) button.setAttribute("aria-describedby", hint.id);
    else button.removeAttribute("aria-describedby");
  }
  update();

  button.addEventListener("click", async (ev) => {
    const variant = chosen;
    if (busy || !variant) return; // the disabled button plus this guard: a double click adds once
    // Only a real click starts a cart add through the bridge: never a script, never model output.
    if (hosted && bridged && !ev.isTrusted) return;
    if (hosted && (!bridged || fellBack)) {
      if (fellBack) {
        fellBack = false;
        addLabel = t("add_to_cart");
        button.textContent = addLabel;
      }
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
    let unconfirmed = false; // acked but no final answer (slow cart): say "Check your cart", don't claim success or failure
    if (hosted) {
      const reply = await requestAdd(origins, variant.id, quantity);
      if (!reply) {
        // Never acked (not a Shopify page, or an old embed.js): offer the product link for the next click.
        fellBack = true;
        addLabel = t("buy_on_store");
        busy = false;
        button.textContent = addLabel;
        update();
        return; // not an error to show: the button itself has changed
      }
      cartHref = resolveHttpsUrl(reply.origin + "/cart"); // origin was matched against parentOrigins in bridge.ts
      unconfirmed = reply.kind === "unconfirmed";
      res = reply.kind === "done" ? reply.res : { ok: true };
    } else res = await addToCart(page, variant.id, quantity);
    busy = false;
    button.textContent = addLabel;
    update();

    if (res.ok) {
      // UD11: "Added · View cart".
      status.className = "ac-card__status ac-card__added";
      status.append(t(unconfirmed ? "check_cart" : "added"));
      if (cartHref) {
        const a = link(cartHref, "ac-card__cart", t("view_cart"));
        if (hosted) a.target = "_top"; // leave the iframe: the cart is the store's page
        status.append(" · ", a);
      }
      ctx.announce(t(unconfirmed ? "check_cart" : "added"));
      if (!unconfirmed) onAdded?.(card.title, cartHref); // an unconfirmed add is not claimed in the chat log
      const token = tokenStore(page.shop).get();
      // Fire and forget; the eventId is fixed per add, so a replayed log is counted once. An acked add is logged here, at
      // the end of this one click: the bridge listener is gone by now, so a late reply can't log it a second time.
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
export function renderCards(into: HTMLElement, cards: Card[], ctx: WidgetCtx, messageId: string | null = null, onAdded?: OnAdded): void {
  if (cards.length === 0) return;
  const wrap = el("div", `ac-cards ${cards.length === 1 ? "ac-cards--single" : "ac-cards--carousel"}`);
  if (cards.length === 1) {
    wrap.append(cardEl(cards[0], ctx, messageId, onAdded));
    into.append(wrap);
    return;
  }

  const track = el("ul", "ac-cards__track");
  track.tabIndex = 0;
  cards.forEach((c, i) => {
    const li = el("li", "ac-cards__slide");
    const card = cardEl(c, ctx, messageId, onAdded);
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
.ac-cards{position:relative;margin:4px 0}
.ac-cards__track{display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;list-style:none;margin:0;padding:0 0 6px;scrollbar-width:thin}
.ac-cards__slide{flex:0 0 74%;scroll-snap-align:start}
.ac-cards__nav{position:absolute;top:70px;width:30px;height:30px;border-radius:15px;border:1px solid #d0d0d0;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.14);cursor:pointer;z-index:1}
.ac-cards__nav--prev{left:-8px}.ac-cards__nav--next{right:-8px}
.ac-card{display:flex;flex-direction:column;height:100%;border:1px solid #e3e3e3;border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.ac-card__img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;background:#f2f2f2}
.ac-card__body{display:flex;flex-direction:column;gap:6px;flex:1;padding:10px 12px 12px;font-size:13px;line-height:18px}
.ac-card__title{font-weight:600;font-size:14px;line-height:19px;color:inherit;text-decoration:none;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
a.ac-card__title:hover{text-decoration:underline}
.ac-card__prices{display:flex;gap:6px;align-items:baseline}
.ac-card__price{font-weight:700;font-size:15px}
.ac-card__compare,.ac-card__price-hint,.ac-card__stock{color:#6b6b6b;font-size:12px;margin:0}
.ac-card__badge{align-self:flex-start;padding:2px 8px;border-radius:10px;background:#eee;font-size:12px}
.ac-card__actions{display:flex;flex-direction:column;gap:8px;margin-top:auto}
.ac-card__picker{display:flex;flex-direction:column;gap:2px;font-size:12px;color:#444}
.ac-card__select{font:inherit;font-size:13px;padding:6px 8px;border:1px solid #8a8a8a;border-radius:8px;background:#fff;color:#111}
.ac-card__add{font:inherit;font-size:14px;font-weight:600;width:100%;padding:10px 12px;border:0;border-radius:10px;cursor:pointer;background:var(--ac-accent,#111);color:var(--ac-on-accent,#fff)}
.ac-card__add:hover:not(:disabled){filter:brightness(.92)}
.ac-card__add:disabled{opacity:.5;cursor:default}
.ac-card__options{display:block;text-align:center;font-weight:600;color:inherit;padding:9px 12px;border:1px solid #8a8a8a;border-radius:10px;text-decoration:none}
.ac-card__options:hover{background:#f4f4f4}
.ac-card__status{margin:0;font-size:12px}
.ac-card__hint{margin:0;font-size:12px;color:#6b6b6b}
.ac-card__hint:empty{display:none}
.ac-card__error{color:#b00020}
@media (prefers-reduced-motion:reduce){.ac-cards__track{scroll-behavior:auto}}
`;
