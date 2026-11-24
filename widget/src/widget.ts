// Entry for askcart-widget.js (Task 30), injected by the launcher on the first click (C20: served from Shopify's CDN).
// Exposes window.AskCart = { open, close, mount }:
//   - open({ productId, focus }) mounts the panel once into the launcher's <askcart-host> and shows it,
//   - mount(host, config, page) builds the panel in any host's shadow root; M7's Settings preview reuses it (UD20).
import type { PageContext, WidgetConfig } from "../../src/lib/widget-contract";
import { createApi } from "./core/api";
import { createPanel, type OpenArgs, type Panel, type PanelOptions } from "./panel/panel";
import { renderCards, renderFeedback } from "./panel/seams";

export function mount(host: HTMLElement, config: WidgetConfig, page: PageContext, opts: Partial<PanelOptions> = {}): Panel {
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  return createPanel(shadow, config, page, {
    renderCards,
    renderFeedback,
    ...opts,
    api: opts.api ?? createApi(config.apiBase, page.shop, { customer: page.loggedIn === true }),
  });
}

let panel: Panel | null = null;

function ensure(): Panel | null {
  if (panel) return panel;
  const root = document.getElementById("askcart-root");
  const host = document.querySelector<HTMLElement>("askcart-host");
  if (!root || !host?.shadowRoot) return null;
  try {
    const config = JSON.parse(root.dataset.config ?? "") as WidgetConfig;
    const page = JSON.parse(root.dataset.page ?? "") as PageContext;
    panel = mount(host, config, page, { launcher: host.shadowRoot.querySelector<HTMLElement>("button.l") });
  } catch (e) {
    console.warn("AskCart: the chat could not start.", e);
    return null;
  }
  return panel;
}

export function open(args: OpenArgs = {}): void {
  void ensure()?.open(args);
}

export function close(): void {
  panel?.close();
}

if (typeof window !== "undefined") (window as unknown as { AskCart: unknown }).AskCart = { open, close, mount };
