// Entry for public/askcart-hosted.js: the hosted chat page (GET /chat/<shop>, src/app/chat/[shop]/route.ts) outside Shopify.
// The server renders the config and page context into #askcart-data; this mounts the same panel the storefront uses,
// always open and filling the window (`inline`). The embed's iframe (embed.ts) shows this page on other sites.
import type { PageContext, WidgetConfig } from "../../src/lib/widget-contract";
import { mount } from "./widget";

try {
  const data = JSON.parse(document.getElementById("askcart-data")?.textContent ?? "") as { config: WidgetConfig; page: PageContext };
  const host = document.createElement("askcart-host");
  document.body.append(host);
  void mount(host, data.config, data.page, { inline: true }).open({ focus: false });
  // Inside the embed's iframe, Escape asks the embedding page to close the panel (capture: the panel stops Escape itself).
  // A constant string, so "*" leaks nothing; as a plain page, parent is this window and nobody listens.
  window.addEventListener("keydown", (e) => e.key === "Escape" && window.parent !== window && window.parent.postMessage("askcart:close", "*"), true);
} catch (e) {
  console.warn("AskCart: the chat could not start.", e);
}
