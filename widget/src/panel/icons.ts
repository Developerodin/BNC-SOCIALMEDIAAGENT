// Panel icons (Task 30). Built with createElementNS from static path data, so even the icons need no innerHTML.
const NS = "http://www.w3.org/2000/svg";

const PATHS = {
  close: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
  back: "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z",
  menu: "M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  expand: "M21 11V3h-8l3.29 3.29-10 10L3 13v8h8l-3.29-3.29 10-10z",
  collapse: "M22 3.41 16.71 8.7 20 12h-8V4l3.3 3.29L20.59 2 22 3.41zM3.41 22l5.29-5.29L12 20v-8H4l3.29 3.3L2 20.59 3.41 22z",
  send: "M2.01 21 23 12 2.01 3 2 10l15 2-15 2z",
};

export function icon(name: keyof typeof PATHS): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", PATHS[name]);
  svg.append(path);
  return svg;
}
