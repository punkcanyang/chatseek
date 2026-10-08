/**
 * Inline icons for the side panel and the reader. No icon font and no network.
 * Decorative only: the button carries the accessible name.
 */

const NS = "http://www.w3.org/2000/svg";

function icon(doc, paths) {
  const svg = doc.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of paths) {
    const path = doc.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.6");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
  }
  return svg;
}

export function bookIcon(doc) {
  return icon(doc, [
    "M2.4 3.2h4.2c.55 0 1.05.28 1.4.78.35-.5.85-.78 1.4-.78h4.2V12.4h-4.2c-.55 0-1.05.26-1.4.72-.35-.46-.85-.72-1.4-.72H2.4V3.2z",
    "M8 4v9.1",
  ]);
}

export function externalIcon(doc) {
  return icon(doc, [
    "M6.2 3.4H3.4v9.2h9.2V9.8",
    "M8.6 3.4h4v4",
    "M12.3 3.7L7.2 8.8",
  ]);
}
