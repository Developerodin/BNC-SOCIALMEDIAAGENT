// Product cards (Task 31; UD9–UD12, D30, D72, D75, C11, C26). Built with createElement and textContent only: titles,
// option names and the store's cart messages are data, never markup (Review Focus 1). Links go through safeHttpsUrl and
// images through safeImageUrl (cdn.shopify.com only), otherwise there is no link and a placeholder.
import type { Card, CardsRenderer, WidgetCtx } from "../../src/lib/widget-contract";
import { requestAdd } from "./bridge";
import { addToCart, CART_CHANGED, cartState, type CartState } from "./cart";
import { formatPrice, resolveHttpsUrl, safeHttpsUrl, safeImageUrl, stockLabel } from "./core/format";
import { tokenStore, uiState } from "./core/storage";
import { trapTab } from "./panel/a11y";
import { icon } from "./panel/icons";
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

/** A round icon button over the image's bottom corner: a 36 px light circle inside a 44 px target. `label` is its
 * accessible name and tooltip. */
function fab(cls: string, ic: Parameters<typeof icon>[0], label: string): HTMLButtonElement {
  const b = el("button", `ac-fab ${cls}`);
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.title = label;
  const c = el("span", "ac-fab__c");
  c.append(icon(ic, 20));
  b.append(c);
  return b;
}

/** Paints the cart icon like the card's Add button: the cart-plus icon, a spinner while adding, a check once added. */
function paintFab(b: HTMLButtonElement, mode: "idle" | "busy" | "done", label: string): void {
  b.firstElementChild!.replaceChildren(mode === "busy" ? el("span", "ac-spin") : icon(mode === "done" ? "check" : "cartplus", 20));
  b.setAttribute("aria-label", label);
  b.title = label;
  if (mode === "busy") b.setAttribute("aria-busy", "true");
  else b.removeAttribute("aria-busy");
}

const optionValue = (v: Variant, name: string) => v.options.find((o) => o.name === name)?.value;

/** How many units of this product (any of its variants) are in the cart. */
const cartQty = (card: Card, s: CartState) => card.variants.reduce((n, v) => n + (s.quantities.get(v.id) ?? 0), 0);

/** "In your cart", or "2 in your cart" for more than one. */
const inCartText = (t: WidgetCtx["t"], qty: number) => (qty > 1 ? t("in_cart_n", { count: qty }) : t("in_cart"));

/** Calls `fn` with this product's cart quantity now, and again after every add from the chat or a re-read of the cart.
 * Store pages only: the hosted page can't read the store's cart. The listener goes away at the first cart change after
 * `owner` (the tile's list item) has left the page, e.g. after New chat or Delete chat; without an owner it lives as long
 * as the page. */
function watchInCart(card: Card, page: WidgetCtx["page"], fn: (qty: number, state: CartState) => void, owner?: Element): void {
  if (page.hosted) return;
  const run = () => void cartState(page).then((s) => fn(cartQty(card, s), s));
  run();
  const on = () => (owner && !owner.isConnected ? window.removeEventListener(CART_CHANGED, on) : run());
  window.addEventListener(CART_CHANGED, on);
}

const reduced = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Fades an image in once it has loaded (CSS `.ac-ld`). The listeners go on before `src`, and an image that is already
 * complete (cached) is shown at once, so a missed `load` event can't leave it invisible. */
function loadImage(i: HTMLImageElement, src: string): void {
  const show = () => i.classList.add("ac-ld");
  i.addEventListener("load", show);
  i.addEventListener("error", show);
  i.src = src;
  if (i.complete) show();
}

/** The check + "In your cart" badge. */
function cartBadge(cls: string): { badge: HTMLElement; set: (text: string) => void } {
  const badge = el("span", cls);
  badge.hidden = true;
  const label = el("span");
  badge.append(icon("check", 12), label);
  return { badge, set: (text) => { label.textContent = text; badge.hidden = !text; } };
}

/** Called once per confirmed add from a card, with the store's cart URL (null when there is none). */
export type OnAdded = (title: string, cartHref: string | null) => void;

/** The shopper chose this product: on a phone, where the panel is full screen (UD4), don't reopen it over the product's
 * page. Set before the navigation. On a desktop the floating panel stays open; other links (View cart, the theme's own)
 * keep the UD13 reopen. */
function productAnchor(page: WidgetCtx["page"], href: string, cls: string, text: string): HTMLAnchorElement {
  const a = link(href, cls, text);
  if (page.hosted) a.target = "_blank"; // inside the embed iframe a same-tab link would replace the chat
  a.addEventListener("click", () => {
    if (window.innerWidth < FULL_BELOW) uiState(page.shop).open.set(false);
  });
  return a;
}

/** Per product, shared by the card's Add button and the sheet's: one add at a time, and the "Buy on the store" fallback. */
type AddState = { busy: boolean; fellBack: boolean; owner?: Element };

/** What an add shows, per surface (the card's button or the sheet). `runAdd` drives it. */
type AddView = {
  busy(): void;
  done(unconfirmed: boolean, cartHref: string | null): void;
  idle(): void; // the resting label (it can change to "Buy on the store")
  error(msg: string): void;
};

// Cart bridge (docs/embed.md): on the hosted page inside a store's embed, Add to cart asks the store page to add it.
const isBridged = (page: WidgetCtx["page"]) => page.hosted === true && page.bridge === true && (page.parentOrigins ?? []).length > 0;

const idleLabel = (ctx: WidgetCtx, st: AddState) =>
  ctx.t(ctx.page.hosted && (!isBridged(ctx.page) || st.fellBack) ? "buy_on_store" : "add_to_cart");

/** Paints an Add button: its label, a spinner while adding, or a check and the result for 1.5 s. Nothing is disabled
 * while adding (a disabled look is "can't"), `runAdd` ignores a second click instead. */
function addButtonView(
  btn: HTMLButtonElement, ctx: WidgetCtx, st: AddState,
  hooks: { clear(): void; error(msg: string): void; done?(unconfirmed: boolean, cartHref: string | null): void },
): AddView {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const paint = (mode: "idle" | "busy" | "done", text: string, swap = false) => {
    clearTimeout(timer);
    btn.replaceChildren();
    if (mode === "busy") btn.setAttribute("aria-busy", "true");
    else btn.removeAttribute("aria-busy");
    if (mode === "idle" && !swap) {
      btn.textContent = text;
      return;
    }
    const label = el("span", swap ? "ac-swap" : undefined, text);
    if (mode === "busy") btn.append(el("span", "ac-spin"), label);
    else if (mode === "done") btn.append(icon("check", 16), label);
    else btn.append(label);
  };
  const idle = (swap = false) => paint("idle", idleLabel(ctx, st), swap);
  return {
    busy() {
      hooks.clear();
      paint("busy", ctx.t("adding"));
    },
    done(unconfirmed, cartHref) {
      paint("done", ctx.t(unconfirmed ? "check_cart" : "added"), true);
      timer = setTimeout(() => idle(true), 1500);
      hooks.done?.(unconfirmed, cartHref);
    },
    idle: () => idle(),
    error(msg) {
      idle();
      hooks.error(msg);
    },
  };
}

/** The one add flow, for the card's button and the sheet's (Review Focus 6; D30, UD11). The bridge, the fallback to the
 * store's own page, the cart add, the chat note and the cart-event log all live here. */
async function runAdd(
  card: Card, variant: Variant, ctx: WidgetCtx, messageId: string | null, onAdded: OnAdded | undefined,
  st: AddState, view: AddView, ev: Event,
): Promise<void> {
  const { t, page } = ctx;
  if (st.busy) return; // a double click adds once
  const hosted = page.hosted === true;
  const bridged = isBridged(page);
  // Only a real click starts a cart add through the bridge: never a script, never model output.
  if (hosted && bridged && !ev.isTrusted) return;
  if (hosted && (!bridged || st.fellBack)) {
    if (st.fellBack) {
      st.fellBack = false;
      view.idle();
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
  st.busy = true;
  view.busy();
  const quantity = 1;
  let cartHref = hosted ? null : resolveHttpsUrl(page.cartUrl);
  let res: Awaited<ReturnType<typeof addToCart>>;
  let unconfirmed = false; // acked but no final answer (slow cart): say "Check your cart", don't claim success or failure
  if (hosted) {
    const reply = await requestAdd(page.parentOrigins ?? [], variant.id, quantity);
    if (!reply) {
      // Never acked (not a Shopify page, or an old embed.js): offer the product link for the next click.
      st.fellBack = true;
      st.busy = false;
      view.idle();
      return; // not an error to show: the button itself has changed
    }
    cartHref = resolveHttpsUrl(reply.origin + "/cart"); // origin was matched against parentOrigins in bridge.ts
    unconfirmed = reply.kind === "unconfirmed";
    res = reply.kind === "done" ? reply.res : { ok: true };
  } else res = await addToCart(page, variant.id, quantity);
  st.busy = false;

  if (res.ok) {
    view.done(unconfirmed, cartHref);
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
  const msg = res.message ?? (res.status === 429 ? t("cart_rate_limited") : t("cart_error"));
  view.error(msg);
  ctx.announce(msg);
}

function cardEl(card: Card, ctx: WidgetCtx, messageId: string | null, st: AddState, onAdded?: OnAdded): HTMLElement {
  const root = cardBody(card, ctx, messageId, st, onAdded);
  // "View product" ends the actions (they stay in view on a phone), or the body when the card has none.
  const url = safeHttpsUrl(card.url);
  if (url) (root.querySelector(".ac-card__actions") ?? root.querySelector(".ac-card__body"))?.append(productAnchor(ctx.page, url, "ac-sheet__view", ctx.t("view_product")));
  return root;
}

function cardBody(card: Card, ctx: WidgetCtx, messageId: string | null, st: AddState, onAdded?: OnAdded): HTMLElement {
  const { t, page } = ctx;
  const root = el("div", "ac-card");
  const url = safeHttpsUrl(card.url);
  const productLink = (href: string, cls: string, text: string) => productAnchor(page, href, cls, text);

  const media = el("div", "ac-card__media"); // light box behind the whole image (contain, never cropped)
  const img = safeImageUrl(card.imageUrl);
  if (img) {
    const i = el("img", "ac-card__img");
    i.alt = ""; // the title right below names the product
    i.loading = "lazy";
    loadImage(i, img);
    media.append(i);
  } else {
    const ph = el("div", "ac-card__img ac-card__img--placeholder");
    ph.setAttribute("aria-hidden", "true");
    media.append(ph);
  }
  root.append(media);

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

  body.append(addControls(card, ctx, messageId, st, setPrice, setStock, onAdded));
  return root;
}

function addControls(
  card: Card,
  ctx: WidgetCtx,
  messageId: string | null,
  st: AddState,
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
  // Starts on the first available variant, so Add to cart is ready; a variant already in the cart replaces it below
  // (until the shopper picks something themselves).
  if (available[0]) for (const n of names) selected.set(n, optionValue(available[0], n) ?? "");
  let touched = false;

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
      touched = true; // the shopper's own pick is never replaced by a late cart read
      selected.set(name, select.value);
      update();
    });
    label.append(select);
    box.append(label);
    return select;
  });

  const hosted = page.hosted === true;
  const cartHref = hosted ? null : resolveHttpsUrl(page.cartUrl);
  const button = el("button", "ac-card__add", idleLabel(ctx, st));
  button.type = "button";
  const status = el("p", "ac-card__status ac-card__error"); // errors only; success shows on the button and in the cart row
  status.setAttribute("aria-live", "polite");
  const hint = el("p", "ac-card__hint");
  hint.id = `ac-hint-${Math.random().toString(36).slice(2, 8)}`;
  // "✓ In your cart · View cart", drawn from the cart itself so it survives a reload, a redrawn history and "View product".
  const row = el("p", "ac-card__cartrow");
  row.hidden = true;
  const setRow = (text: string, href: string | null) => {
    row.replaceChildren();
    row.hidden = !text;
    if (!text) return;
    row.append(icon("check", 14), text);
    if (href) {
      const a = link(href, "ac-card__cart", t("view_cart"));
      if (hosted) a.target = "_top"; // leave the iframe: the cart is the store's page
      row.append(" · ", a);
    }
  };
  box.append(row, button, status, hint);

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
    button.disabled = !chosen;
    // Say why Add to cart is greyed: name the first option still to pick.
    const todo = names.find((n) => !selected.get(n));
    hint.textContent = todo ? t("choose_first", { option: todo }) : "";
    if (todo) button.setAttribute("aria-describedby", hint.id);
    else button.removeAttribute("aria-describedby");
  }
  update();

  const pick = (v: Variant) => {
    names.forEach((n, i) => {
      selected.set(n, optionValue(v, n) ?? "");
      selects[i].value = selected.get(n)!;
    });
    update();
  };
  watchInCart(card, page, (qty, state) => {
    setRow(qty > 0 ? inCartText(t, qty) : "", cartHref);
    if (touched || names.length === 0) return;
    // The variant that is in the cart (the one with the most units; a sold-out one is skipped).
    const inCart = available.filter((v) => (state.quantities.get(v.id) ?? 0) > 0);
    const best = inCart.reduce<Variant | null>((b, v) => (!b || (state.quantities.get(v.id) ?? 0) > (state.quantities.get(b.id) ?? 0) ? v : b), null);
    if (best) pick(best);
  }, st.owner);

  const view = addButtonView(button, ctx, st, {
    clear: () => status.replaceChildren(),
    error: (msg) => { status.textContent = msg; },
    // Hosted: there is no cart to read, so the add itself is what the row says.
    done: (unconfirmed, href) => { if (hosted) setRow(t(unconfirmed ? "check_cart" : "added"), href); },
  });
  button.addEventListener("click", (ev) => {
    if (chosen) void runAdd(card, chosen, ctx, messageId, onAdded, st, view, ev);
  });

  return box;
}

/** The price line under a thumbnail: nothing for a fallback card or another currency (C26), "Sold out" when it is (D72),
 * and the struck-through compare-at price next to it on sale. */
function tilePrice(card: Card, ctx: WidgetCtx): { price: string; compareAt: string | null } | null {
  if (card.available === false) return { price: ctx.t("sold_out"), compareAt: null };
  const { page } = ctx;
  if (card.price === null || !card.currency || (!!page.currency && card.currency !== page.currency)) return null;
  const price = formatPrice(card.price, card.currency, page.locale);
  if (!price) return null;
  const onSale = card.compareAtPrice && Number(card.compareAtPrice) > Number(card.price);
  return { price, compareAt: onSale ? formatPrice(card.compareAtPrice!, card.currency, page.locale) : null };
}

/** The inline detail sheet: covers the panel (or `into` when there is no panel), shows the full card and gives focus back
 * to what opened it on close. The rest of the panel is inert meanwhile. It slides in from the right and back out. */
function openSheet(into: HTMLElement, opener: HTMLElement, card: Card, full: HTMLElement, ctx: WidgetCtx) {
  const host = into.closest<HTMLElement>(".panel") ?? into;
  // A sheet still sliding out from a moment ago would be covered (and inert) by this one: drop it first.
  for (const old of host.querySelectorAll(":scope > .ac-sheet.out")) old.remove();
  const sheet = el("div", "ac-sheet");
  sheet.setAttribute("role", "group");
  sheet.setAttribute("aria-label", card.title);
  const bar = el("div", "ac-sheet__bar");
  const back = el("button", "ac-sheet__back");
  back.type = "button";
  back.setAttribute("aria-label", ctx.t("back"));
  back.append(icon("back"));
  bar.append(back, el("span", "ac-sheet__heading", ctx.t("product_details")));
  const body = el("div", "ac-sheet__body");
  body.append(full);
  sheet.append(bar, body);
  const covered = [...host.children].filter((c): c is HTMLElement => c instanceof HTMLElement);
  for (const c of covered) c.inert = true;
  host.append(sheet);
  void sheet.offsetWidth; // one reflow, so the slide starts from off-screen
  sheet.classList.add("on");
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const c of covered) c.inert = false;
    if (opener.isConnected) opener.focus();
    sheet.inert = true;
    if (reduced()) {
      sheet.remove();
      return;
    }
    const gone = () => sheet.remove();
    sheet.addEventListener("transitionend", (e) => { if (e.target === sheet && e.propertyName === "transform") gone(); });
    setTimeout(gone, 400); // in case the transition never ends (a hidden tab)
    sheet.classList.add("out");
    sheet.classList.remove("on");
  };
  back.addEventListener("click", close);
  sheet.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation(); // Esc closes the sheet, not the panel
      close();
    } else if (trapTab(e, sheet, (sheet.getRootNode() as Document | ShadowRoot).activeElement)) e.stopPropagation();
  });
  back.focus();
}

/**
 * UD9, UD12: a row of square thumbnails with name and price. A thumbnail opens the inline detail sheet with the full card
 * (pickers, Add to cart, View product). Under it a single-variant product has its own Add to cart, other products a
 * View options button that opens the sheet. Arrows appear only when the row overflows.
 * `messageId` is the answer the cards came with; a cart add logs it (null for an answer the server sent without one).
 */
export function renderCards(
  into: HTMLElement, cards: Card[], ctx: WidgetCtx, messageId: string | null = null, onAdded?: OnAdded,
  /** The "similar products" icon: asks the chat for products like this one. Without it the icon is not drawn. */
  onSimilar?: (card: Card) => void,
): void {
  if (cards.length === 0) return;
  const wrap = el("div", "ac-cards");
  const track = el("ul", "ac-cards__track");
  for (const c of cards) {
    const li = el("li", "ac-cards__slide");
    const tile = el("button", "ac-tile");
    tile.type = "button";
    tile.setAttribute("aria-haspopup", "dialog");
    const media = el("span", "ac-tile__media"); // grey square behind the image, clips the hover zoom
    const img = safeImageUrl(c.imageUrl);
    if (img) {
      const i = el("img", "ac-tile__img");
      i.alt = ""; // the name right below names the product
      i.loading = "lazy";
      loadImage(i, img);
      media.append(i);
    } else {
      const ph = el("span", "ac-tile__img ac-tile__img--placeholder");
      ph.setAttribute("aria-hidden", "true");
      media.append(ph);
    }
    const incart = cartBadge("ac-tile__badge");
    media.append(incart.badge);
    let before = -1; // the first read only sets it; a later rise from none pops the badge in
    watchInCart(c, ctx.page, (qty) => {
      incart.set(qty > 0 ? inCartText(ctx.t, qty) : "");
      if (before === 0 && qty > 0) {
        incart.badge.classList.remove("ac-pop");
        void incart.badge.offsetWidth;
        incart.badge.classList.add("ac-pop"); // CSS: off under prefers-reduced-motion
      }
      before = qty;
    }, li);
    tile.append(media, el("span", "ac-tile__title", c.title));
    const price = tilePrice(c, ctx);
    if (price) {
      const row = el("span", "ac-tile__prices");
      row.append(el("span", "ac-tile__price", price.price));
      if (price.compareAt) row.append(el("s", "ac-tile__compare", price.compareAt));
      tile.append(row);
    }
    const st: AddState = { busy: false, fellBack: false, owner: li };
    let full: HTMLElement | null = null; // built on the first open, then kept so a chosen option survives closing
    const open = (opener: HTMLElement) => openSheet(into, opener, c, (full ??= cardEl(c, ctx, messageId, st, onAdded)), ctx);
    tile.addEventListener("click", () => open(tile));
    li.append(tile);

    // The two icons over the image's bottom corners: similar products (left), add to cart or View options (right).
    // They sit in the slide, not in the tile (a button can't hold buttons), over the image's square.
    const tools = el("div", "ac-tile__tools");
    if (onSimilar) {
      const sim = fab("ac-fab--similar", "similar", ctx.t("similar_label", { title: c.title }));
      sim.addEventListener("click", () => onSimilar(c));
      tools.append(sim);
    }

    // The card's own button. Sold out: none (the price row says so). One variant: Add to cart, straight from here.
    // Anything else (options to pick, a link to the store, no price): View options, which opens the sheet.
    const single = c.action === "add" && !c.moreVariants && c.price !== null && c.variants.length === 1 && c.variants[0].available;
    if (c.available !== false) {
      const btn = el("button", "ac-tile__add");
      btn.type = "button";
      if (single) {
        btn.textContent = idleLabel(ctx, st);
        const fail = el("p", "ac-tile__err");
        fail.setAttribute("aria-live", "polite");
        const view = addButtonView(btn, ctx, st, { clear: () => fail.replaceChildren(), error: (msg) => { fail.textContent = msg; } });
        // The icon is a second trigger of the same add: same runAdd, same state, so one add at a time and one log per add.
        const cartFab = fab("ac-fab--cart", "cartplus", idleLabel(ctx, st));
        let fabTimer: ReturnType<typeof setTimeout> | undefined;
        const rest = () => { clearTimeout(fabTimer); paintFab(cartFab, "idle", idleLabel(ctx, st)); };
        const both: AddView = {
          busy() { view.busy(); clearTimeout(fabTimer); paintFab(cartFab, "busy", ctx.t("adding")); },
          done(unconfirmed, href) {
            view.done(unconfirmed, href);
            paintFab(cartFab, "done", ctx.t(unconfirmed ? "check_cart" : "added"));
            fabTimer = setTimeout(rest, 1500);
          },
          idle() { view.idle(); rest(); },
          error(msg) { view.error(msg); rest(); },
        };
        const go = (ev: Event) => void runAdd(c, c.variants[0], ctx, messageId, onAdded, st, both, ev);
        btn.addEventListener("click", go);
        cartFab.addEventListener("click", go);
        tools.append(cartFab);
        li.append(btn, fail);
      } else {
        btn.textContent = ctx.t("view_options");
        btn.addEventListener("click", () => open(btn));
        const optionsFab = fab("ac-fab--cart", "cartplus", ctx.t("view_options"));
        optionsFab.addEventListener("click", () => open(optionsFab));
        tools.append(optionsFab);
        li.append(btn);
      }
    }
    if (tools.childElementCount) li.append(tools);
    track.append(li);
  }
  const step = (dir: 1 | -1) => {
    const w = track.clientWidth * 0.8 || 200;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    track.scrollBy?.({ left: dir * w, behavior: reduced ? "auto" : "smooth" });
  };
  const nav = (dir: 1 | -1, label: string) => {
    const b = el("button", `ac-cards__nav ac-cards__nav--${dir === 1 ? "next" : "prev"}`);
    b.append(icon(dir === 1 ? "next" : "prev"));
    b.type = "button";
    b.hidden = true;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", () => step(dir));
    return b;
  };
  const prev = nav(-1, ctx.t("previous"));
  const next = nav(1, ctx.t("next"));
  const sync = () => {
    const over = track.scrollWidth > track.clientWidth + 1;
    const hidePrev = !over || track.scrollLeft <= 1;
    const hideNext = !over || track.scrollLeft + track.clientWidth >= track.scrollWidth - 1;
    // A hidden button can't keep focus (it would fall to <body>, outside the dialog): hand it to the tile it scrolled to.
    const at = (track.getRootNode() as Document | ShadowRoot).activeElement;
    if (hideNext && at === next) track.querySelector<HTMLElement>("li:last-child .ac-tile")?.focus();
    if (hidePrev && at === prev) track.querySelector<HTMLElement>("li:first-child .ac-tile")?.focus();
    prev.hidden = hidePrev;
    next.hidden = hideNext;
  };
  track.addEventListener("scroll", sync);
  wrap.append(prev, track, next);
  into.append(wrap);
  requestAnimationFrame(sync); // the sizes are known only once it is in the page
}
// Compile-time check that it still fits the shared seam.
const _contract: CardsRenderer = renderCards;
void _contract;

/** Card styles for the panel's shadow root (Task 30 owns styles.ts and includes this). px only (Global Constraints). */
export const CARDS_CSS = `
.ac-cards{position:relative;margin:4px 0}
.ac-cards__track{display:flex;gap:12px;overflow-x:auto;list-style:none;margin:-4px;padding:4px 4px 10px;scrollbar-width:none;scroll-snap-type:x mandatory;scroll-padding:0 4px}
.ac-cards__track::-webkit-scrollbar{display:none}
.ac-cards__slide{flex:0 0 168px;width:168px;scroll-snap-align:start;display:flex;flex-direction:column;gap:8px}
.ac-cards__slide{position:relative}
.ac-tile__tools{position:absolute;top:0;left:0;right:0;aspect-ratio:1;box-sizing:border-box;padding:4px;display:flex;align-items:flex-end;pointer-events:none}
.ac-fab{pointer-events:auto;position:relative;display:flex;align-items:center;justify-content:center;flex:none;width:44px;height:44px;padding:0;border:0;background:none;color:#111;cursor:pointer;touch-action:manipulation}
.ac-fab--cart{margin-left:auto}
.ac-fab__c{display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:18px;background:rgba(255,255,255,.88);box-shadow:0 1px 4px rgba(0,0,0,.25);transition:background-color .15s ease,transform .12s cubic-bezier(0.22,1,0.36,1)}
.ac-fab:focus-visible{outline:none}
.ac-fab:focus-visible .ac-fab__c{outline:2px solid #2563eb;outline-offset:2px}
@media (hover:hover){.ac-fab:hover .ac-fab__c{background:#fff}}
.ac-fab:active .ac-fab__c{transform:scale(.94)}
.ac-fab[aria-busy=true]{cursor:progress}
.ac-tile{flex:1;display:flex;flex-direction:column;gap:6px;width:100%;text-align:left;font-size:13px;line-height:18px;color:inherit;border-radius:14px}
.ac-tile:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
.ac-tile__media{position:relative;display:block;width:100%;aspect-ratio:1;border-radius:14px;overflow:hidden;background:#f2f2f2}
.ac-tile__img{display:block;width:100%;height:100%;object-fit:cover;background:#f2f2f2}
img.ac-tile__img,img.ac-card__img{opacity:0;transition:opacity .2s ease-out}
img.ac-ld{opacity:1}
.ac-tile__add,.ac-card__add{display:flex;align-items:center;justify-content:center;gap:8px;font:inherit;font-weight:600;cursor:pointer;touch-action:manipulation}
.ac-tile__add{width:100%;min-height:40px;padding:0 12px;border:1px solid #8a8a8a;border-radius:20px;background:#fff;color:#111;font-size:13px;line-height:18px;transition:border-color .15s ease,background-color .15s ease,transform .12s cubic-bezier(0.22,1,0.36,1)}
@media (hover:hover){.ac-tile__add:hover{border-color:#111}}
.ac-tile__add:active{transform:scale(.97)}
.ac-tile__err{margin:0;font-size:12px;line-height:16px;color:#b00020}
.ac-tile__err:empty{display:none}
@media (max-width:639px){.ac-tile__add{min-height:44px}}
.ac-tile__badge{display:inline-flex;align-items:center;gap:4px;font-size:12px;line-height:16px;font-weight:500}
.ac-tile__badge[hidden]{display:none}
.ac-tile__badge{position:absolute;top:8px;left:8px;max-width:calc(100% - 16px);padding:3px 8px 3px 6px;border-radius:12px;background:#fff;color:#111;box-shadow:0 1px 3px rgba(0,0,0,.18)}
.ac-tile__badge svg{flex:none}
.ac-card__cartrow{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin:0;font-size:13px;line-height:18px;font-weight:500;color:#1a6b3a}
.ac-card__cartrow[hidden]{display:none}
.ac-card__cartrow svg{flex:none}
.ac-card__cart{color:inherit;font-weight:600;text-decoration:underline;padding:4px 0}
.ac-tile__badge.ac-pop{animation:ac-pop .18s cubic-bezier(0.22,1,0.36,1)}
@keyframes ac-pop{from{opacity:0;transform:scale(.9)}}
@keyframes ac-up{from{opacity:0;transform:translateY(8px)}}
@keyframes ac-fade{from{opacity:0}}
@keyframes ac-swap{from{opacity:0;transform:translateY(4px);filter:blur(2px)}}
@keyframes ac-rot{to{transform:rotate(360deg)}}
.ac-spin{flex:none;width:16px;height:16px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:ac-rot .7s linear infinite}
.ac-swap{animation:ac-swap .18s cubic-bezier(0.22,1,0.36,1)}
.cards.in .ac-cards__slide{animation:ac-up .24s cubic-bezier(0.22,1,0.36,1) both}
.cards.in .ac-cards__slide:nth-child(2){animation-delay:40ms}.cards.in .ac-cards__slide:nth-child(3){animation-delay:80ms}.cards.in .ac-cards__slide:nth-child(4){animation-delay:120ms}.cards.in .ac-cards__slide:nth-child(n+5){animation-delay:160ms}
.ac-tile__title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-overflow:ellipsis;overflow-wrap:anywhere;font-size:14px;line-height:19px;font-weight:500;color:#111}
.ac-tile__prices{display:flex;flex-wrap:wrap;gap:2px 6px;align-items:baseline;font-size:13px;line-height:18px;color:#6b6b6b}
.ac-cards__nav{position:absolute;top:66px;display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:18px;border:0;background:#fff;color:#111;box-shadow:0 1px 6px rgba(0,0,0,.22);cursor:pointer;z-index:1}
.ac-cards__nav::before{content:"";position:absolute;inset:-4px}
.ac-cards__nav[hidden]{display:none}
.ac-cards__nav--prev{left:4px}.ac-cards__nav--next{right:4px}
@media (max-width:639px){.ac-cards__slide{flex-basis:148px;width:148px}.ac-cards__nav{top:56px}}
@media (hover:hover) and (prefers-reduced-motion:no-preference){.ac-tile__img{transition:transform .2s ease}.ac-tile:hover .ac-tile__img{transform:scale(1.03)}}
.ac-sheet{position:absolute;top:0;right:0;bottom:0;left:0;z-index:5;display:flex;flex-direction:column;background:#fff;color:#111;transform:translateX(100%);transition:transform .3s cubic-bezier(0.32,0.72,0,1)}
.ac-sheet.on{transform:none}
:host(:dir(rtl)) .ac-sheet{transform:translateX(-100%)}:host(:dir(rtl)) .ac-sheet.on{transform:none}
.ac-sheet.out{transition-duration:.2s}
.ac-sheet__bar{display:flex;align-items:center;gap:8px;padding:8px 12px;flex:none;border-bottom:1px solid #eee}
.ac-sheet__back{display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:22px;cursor:pointer;border:0;background:none;color:inherit}
.ac-sheet__back:hover{background:#f2f2f2}
.ac-sheet__heading{font-weight:600;font-size:15px}
.ac-sheet__body{flex:1;overflow-y:auto;padding:16px 20px 0;display:flex;flex-direction:column;gap:14px}
.ac-sheet .ac-card{width:100%;max-width:440px;margin:0 auto;flex:1;border:0;box-shadow:none;border-radius:0;overflow:visible;height:auto}
.ac-card__media{width:100%;max-width:360px;aspect-ratio:1;margin:0 auto;border-radius:12px;overflow:hidden;background:#f4f4f4}
.ac-card__img{display:block;width:100%;height:100%;object-fit:contain;mix-blend-mode:multiply}
.ac-sheet .ac-card__body{padding:16px 0 0}
.ac-sheet .ac-card__title{font-size:18px;line-height:24px}
.ac-sheet .ac-card__price{font-size:17px;line-height:24px}
.ac-sheet .ac-card__compare,.ac-sheet .ac-card__stock{font-size:13px}
.ac-sheet .ac-card__actions{position:sticky;bottom:0;margin:auto -20px 0;padding:12px 20px calc(12px + env(safe-area-inset-bottom));background:#fff;box-shadow:0 -1px 0 #eee}
.ac-sheet__view{display:flex;align-items:center;justify-content:center;min-height:44px;border:1px solid #8a8a8a;border-radius:24px;font-size:14px;font-weight:600;color:inherit;text-decoration:none}
@media (hover:hover){.ac-sheet__view:hover{border-color:#111}}
@media (prefers-reduced-motion:reduce){.ac-sheet{transform:none;opacity:0;transition:opacity .15s ease}.ac-sheet.on{opacity:1}}
.ac-card{display:flex;flex-direction:column;background:#fff}
.ac-card__body{display:flex;flex-direction:column;gap:6px;flex:1;font-size:13px;line-height:18px}
.ac-card__title{font-weight:600;font-size:16px;line-height:21px;color:inherit;text-decoration:none}
a.ac-card__title:hover{text-decoration:underline}
.ac-card__prices{display:flex;gap:6px;align-items:baseline}
.ac-card__price{font-weight:700;font-size:15px}
.ac-card__compare,.ac-card__price-hint,.ac-card__stock{color:#6b6b6b;font-size:12px;margin:0}
.ac-card__badge{align-self:flex-start;padding:2px 8px;border-radius:10px;background:#eee;font-size:12px}
.ac-card__actions{display:flex;flex-direction:column;gap:8px;margin-top:auto}
.ac-card__picker{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:500;color:#444}
.ac-card__select{font:inherit;font-size:16px;line-height:20px;min-height:44px;width:100%;padding:0 12px;border:1px solid #8a8a8a;border-radius:10px;background:#fff;color:#111}
.ac-card__add{width:100%;min-height:48px;padding:0 12px;border:0;border-radius:24px;font-size:15px;background:var(--ac-accent,#111);color:var(--ac-on-accent,#fff)}
.ac-card__add:hover:not(:disabled){filter:brightness(.92)}
.ac-card__add:disabled{opacity:.5;cursor:default}
.ac-card__add[aria-busy=true]{opacity:1;cursor:progress}
.ac-card__options{display:block;text-align:center;font-weight:600;color:inherit;padding:9px 12px;border:1px solid #8a8a8a;border-radius:10px;text-decoration:none}
.ac-card__options:hover{background:#f4f4f4}
.ac-card__status{margin:0;font-size:13px}
.ac-card__status:empty{display:none}
.ac-card__hint{margin:0;font-size:12px;color:#6b6b6b}
.ac-card__hint:empty{display:none}
.ac-card__error{color:#b00020}
@media (prefers-reduced-motion:reduce){.ac-cards__track{scroll-behavior:auto}.ac-spin{animation:none;border-right-color:currentColor;opacity:.5}.ac-swap{animation-name:ac-fade}.cards.in .ac-cards__slide{animation-name:ac-fade;animation-delay:0s!important}.ac-tile__badge.ac-pop{animation:none}img.ac-tile__img,img.ac-card__img{transition:none}.ac-tile__add{transition:none}.ac-fab__c{transition:none}}
`;
