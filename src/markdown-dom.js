/**
 * Turn a Markdown AST into DOM nodes. Message text is assigned with
 * textContent only. Remote images are never elements. Only http(s) links
 * become anchors.
 */

import { text } from "./i18n.js";
import { parseMarkdown, safeLinkHref } from "./markdown.js";

const astCache = new WeakMap();

export function cachedMarkdown(owner, source) {
  const key = owner && typeof owner === "object" ? owner : null;
  if (key) {
    const cached = astCache.get(key);
    if (cached && cached.source === source) return cached.ast;
  }
  const ast = parseMarkdown(source);
  if (key) astCache.set(key, { source, ast });
  return ast;
}

/**
 * hits: { index, range: [start, end] } in source offsets.
 * current: hit index that should carry is-current, or -1.
 */
export function renderMarkdown(parent, source, { hits = [], current = -1, locale = "en", owner = null } = {}) {
  const blocks = cachedMarkdown(owner, String(source ?? ""));
  renderBlocks(parent, blocks, hits, current, locale);
}

function renderBlocks(parent, blocks, hits, current, locale) {
  for (const block of blocks || []) renderBlock(parent, block, hits, current, locale);
}

function renderBlock(parent, block, hits, current, locale) {
  const doc = parent.ownerDocument;
  if (block.type === "heading") {
    const level = Math.min(6, Math.max(1, block.level || 1));
    const el = doc.createElement(`h${level}`);
    el.className = "md-h";
    renderInline(el, block.children, hits, current, locale);
    parent.append(el);
    return;
  }
  if (block.type === "paragraph") {
    const el = doc.createElement("p");
    el.className = "chunk";
    renderInline(el, block.children, hits, current, locale);
    parent.append(el);
    return;
  }
  if (block.type === "code") {
    renderCodeBlock(parent, block, hits, current, locale);
    return;
  }
  if (block.type === "quote") {
    const el = doc.createElement("blockquote");
    el.className = "md-quote";
    renderBlocks(el, block.blocks, hits, current, locale);
    parent.append(el);
    return;
  }
  if (block.type === "list") {
    const el = doc.createElement(block.ordered ? "ol" : "ul");
    el.className = "md-list";
    if (block.ordered && block.start > 1) el.start = String(block.start);
    for (const item of block.items) {
      const li = doc.createElement("li");
      renderBlocks(li, item.blocks, hits, current, locale);
      el.append(li);
    }
    parent.append(el);
    return;
  }
  if (block.type === "table") {
    renderTable(parent, block, hits, current, locale);
    return;
  }
  if (block.type === "hr") {
    const el = doc.createElement("hr");
    el.className = "md-hr";
    parent.append(el);
  }
}

function renderCodeBlock(parent, block, hits, current, locale) {
  const doc = parent.ownerDocument;
  const wrap = doc.createElement("div");
  wrap.className = "code-block";
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "code-copy";
  const label = text(locale, "copyCode");
  button.textContent = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", () => {
    const clipboard = doc.defaultView?.navigator?.clipboard;
    if (!clipboard || typeof clipboard.writeText !== "function") return;
    Promise.resolve(clipboard.writeText(block.text)).catch(() => {});
  });
  const pre = doc.createElement("pre");
  pre.className = "code";
  if (!block.pieces.length) pre.append(doc.createTextNode(""));
  for (const piece of block.pieces) appendPiece(pre, piece, hits, current);
  if (block.info?.text) {
    const lang = doc.createElement("span");
    lang.className = "code-lang";
    appendPiece(lang, block.info, hits, current);
    wrap.append(lang);
  }
  wrap.append(button, pre);
  parent.append(wrap);
}

function renderTable(parent, block, hits, current, locale) {
  const doc = parent.ownerDocument;
  const wrap = doc.createElement("div");
  wrap.className = "table-wrap";
  const table = doc.createElement("table");
  const thead = doc.createElement("thead");
  const headRow = doc.createElement("tr");
  block.header.forEach((cell, index) => {
    const th = doc.createElement("th");
    applyAlign(th, block.align[index]);
    renderInline(th, cell.children, hits, current, locale);
    headRow.append(th);
  });
  thead.append(headRow);
  const tbody = doc.createElement("tbody");
  // GFM drops cells past the header width. A reader should not hide text, so
  // a ragged row keeps its extra cells.
  for (const row of block.rows) {
    const tr = doc.createElement("tr");
    const width = Math.max(block.header.length, row.length);
    for (let index = 0; index < width; index += 1) {
      const td = doc.createElement("td");
      applyAlign(td, block.align[index]);
      renderInline(td, row[index]?.children || [], hits, current, locale);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrap.append(table);
  parent.append(wrap);
}

function applyAlign(el, align) {
  if (align === "center") el.classList.add("align-center");
  else if (align === "right") el.classList.add("align-right");
  else if (align === "left") el.classList.add("align-left");
}

function renderInline(parent, nodes, hits, current, locale) {
  for (const node of nodes || []) renderNode(parent, node, hits, current, locale);
}

function renderNode(parent, node, hits, current, locale) {
  const doc = parent.ownerDocument;
  if (node.type === "text") {
    for (const piece of node.pieces) appendPiece(parent, piece, hits, current);
    return;
  }
  if (node.type === "em" || node.type === "strong") {
    const el = doc.createElement(node.type === "em" ? "em" : "strong");
    renderInline(el, node.children, hits, current, locale);
    parent.append(el);
    return;
  }
  if (node.type === "code") {
    const el = doc.createElement("code");
    el.className = "md-code";
    if (!node.pieces?.length) el.append(doc.createTextNode(node.text || ""));
    else for (const piece of node.pieces) appendPiece(el, piece, hits, current);
    parent.append(el);
    return;
  }
  if (node.type === "link") {
    renderLink(parent, node, hits, current, locale);
    return;
  }
  if (node.type === "image") {
    renderImage(parent, node, hits, current, locale);
  }
}

function renderLink(parent, node, hits, current, locale) {
  const doc = parent.ownerDocument;
  const href = safeLinkHref(node.url);
  const el = doc.createElement(href ? "a" : "span");
  el.className = href ? "md-anchor" : "md-link";
  if (href) {
    el.setAttribute("href", href);
    el.setAttribute("target", "_blank");
    el.setAttribute("rel", "noopener noreferrer");
  }
  if (node.auto) {
    appendPiece(el, { text: node.url, start: node.urlStart, end: node.urlEnd }, hits, current);
  } else {
    renderInline(el, node.children, hits, current, locale);
    el.append(doc.createTextNode(" "));
    const url = doc.createElement("span");
    url.className = "md-url";
    appendPiece(url, { text: node.url, start: node.urlStart, end: node.urlEnd }, hits, current);
    el.append(url);
  }
  parent.append(el);
}

function renderImage(parent, node, hits, current, locale) {
  const doc = parent.ownerDocument;
  const el = doc.createElement("span");
  el.className = "md-image";
  const label = text(locale, "imageLabel");
  const alt = imageAlt(node);
  el.append(doc.createTextNode(alt ? `[${label}: ` : `[${label}] `));
  if (alt) {
    renderInline(el, node.children, hits, current, locale);
    el.append(doc.createTextNode("] "));
  }
  appendPiece(el, { text: node.url, start: node.urlStart, end: node.urlEnd }, hits, current);
  parent.append(el);
}

function imageAlt(node) {
  const parts = [];
  const walk = (nodes) => {
    for (const child of nodes || []) {
      if (child.type === "text") parts.push(child.pieces.map((piece) => piece.text).join(""));
      else if (child.type === "code") parts.push(child.text || "");
      else if (child.children) walk(child.children);
      else if (child.type === "link") parts.push(child.auto ? child.url : "");
    }
  };
  walk(node.children);
  return parts.join("").trim();
}

function appendPiece(parent, piece, hits, current) {
  if (!piece || !piece.text) return;
  const parts = piece.text.split("\n");
  let offset = 0;
  parts.forEach((part, index) => {
    if (index > 0) parent.append(parent.ownerDocument.createElement("br"));
    if (part) appendDense(parent, part, piece.start + offset, hits, current, piece.loose);
    offset += part.length + 1;
  });
}

/** Hits are sorted by start and do not overlap, so ends are sorted too. */
function hitsOverlapping(hits, start, end) {
  const list = hits || [];
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].range[1] <= start) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let i = lo; i < list.length && list[i].range[0] < end; i += 1) out.push(list[i]);
  return out;
}

function appendDense(parent, text, start, hits, current, loose) {
  const doc = parent.ownerDocument;
  const near = hitsOverlapping(hits, start, start + text.length);
  if (loose) {
    const overlap = near[0];
    if (!overlap) {
      parent.append(doc.createTextNode(text));
      return;
    }
    const mark = doc.createElement("mark");
    mark.dataset.hit = String(overlap.index);
    mark.textContent = text;
    if (overlap.index === current) mark.classList.add("is-current");
    parent.append(mark);
    return;
  }
  const end = start + text.length;
  const locals = [];
  for (const hit of near) {
    const from = Math.max(hit.range[0], start);
    const to = Math.min(hit.range[1], end);
    if (to > from) locals.push({ from: from - start, to: to - start, hit: hit.index });
  }
  locals.sort((a, b) => a.from - b.from || a.to - b.to);
  let cursor = 0;
  for (const seg of locals) {
    const from = Math.max(seg.from, cursor);
    if (from > cursor) parent.append(doc.createTextNode(text.slice(cursor, from)));
    if (seg.to > from) {
      const mark = doc.createElement("mark");
      mark.dataset.hit = String(seg.hit);
      mark.textContent = text.slice(from, seg.to);
      if (seg.hit === current) mark.classList.add("is-current");
      parent.append(mark);
      cursor = seg.to;
    }
  }
  if (cursor < text.length) parent.append(doc.createTextNode(text.slice(cursor)));
}
