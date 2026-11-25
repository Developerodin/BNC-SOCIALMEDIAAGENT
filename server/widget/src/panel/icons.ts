// Panel icons (Task 30). Built with createElementNS from static path data, so even the icons need no innerHTML.
// The header's icons are thin outlines (1.5px stroke, round caps); the dots, sparkle, check and arrows stay filled.
const NS = "http://www.w3.org/2000/svg";

const OUTLINE = {
  close: "M18 6 6 18M6 6l12 12",
  back: "M19 12H5m7-7-7 7 7 7",
  cart: "M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0",
  newchat: "M1 4v6h6M3.51 15a9 9 0 1 0 2.13-9.36L1 10",
  send: "M12 19V5M5 12l7-7 7 7",
  // A magnifier with a small four-point sparkle, and a cart with a plus: the icons over a product card's image.
  similar: "M10 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM14.5 15.5 20 21M19 2l.8 2.2L22 5l-2.2.8L19 8l-.8-2.2L16 5l2.2-.8z",
  cartplus: "M3 4h2.5l2 10h9.5l2-7.5H6.5M9.5 19.5h.01M16.5 19.5h.01M12 8v4M10 10h4",
};

const FILLED = {
  menu: "M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  sparkle: "M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z",
  check: "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  prev: "M15.41 16.59 10.83 12l4.58-4.59L14 6l-6 6 6 6z",
  next: "M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z",
};

/** An outline (stroke) SVG from path data; the thumbs use it too. */
export function strokeIcon(d: string, size = 20): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

export function icon(name: keyof typeof OUTLINE | keyof typeof FILLED, size = 20): SVGSVGElement {
  if (name in OUTLINE) return strokeIcon(OUTLINE[name as keyof typeof OUTLINE], size);
  const svg = strokeIcon(FILLED[name as keyof typeof FILLED], size);
  const path = svg.firstChild as SVGPathElement;
  path.setAttribute("fill", "currentColor");
  path.removeAttribute("stroke");
  return svg;
}
