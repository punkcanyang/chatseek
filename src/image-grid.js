/**
 * Side-panel image grid. Reads rows the cache already stored.
 * No network, no image addresses, no HTML assignment.
 * The extension CSP allows img-src 'self' data: and does not allow blob:,
 * so a visible thumbnail is a data URL. release() revokes an object URL
 * if one was ever handed in, and drops the data URL either way.
 */

import { dataUrlFromBytes } from "./image-cache.js";
import { externalIcon } from "./icons.js";
import { text } from "./i18n.js";
import { safeOriginalUrl } from "./reader-url.js";

export const PLACEHOLDER_STATUSES = ["uncached", "oversized", "timeout", "not-loaded", "cleared"];

const REASON_KEY = {
  oversized: "imageOversized",
  timeout: "imageTimeout",
  "not-loaded": "imageNotLoaded",
  cleared: "imageCleared",
  uncached: "imageUncached",
};

export function cardKey(card) {
  return `${card?.messageId || ""}\u0001${card?.index ?? ""}`;
}

export function releaseUrl(url) {
  if (typeof url === "string" && url.startsWith("blob:")) {
    try { URL.revokeObjectURL(url); } catch { /* already revoked */ }
  }
}

export function thumbUrl(bytes, mime) {
  const url = dataUrlFromBytes(bytes, mime);
  let current = url;
  return {
    url,
    release() {
      releaseUrl(current);
      current = "";
    },
  };
}

function rankOf(card) {
  return Number.isInteger(card?.messageRank) ? card.messageRank : 1_000_000_000;
}

/** Newest conversation first. Inside one conversation, page order then offset then index. */
export function sortImageCards(cards) {
  const groups = new Map();
  for (const card of cards || []) {
    if (!card) continue;
    const id = String(card.conversationId || "");
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(card);
  }
  const ordered = [...groups.values()];
  ordered.sort((a, b) => {
    const at = Number(a[0]?.updatedAt) || 0;
    const bt = Number(b[0]?.updatedAt) || 0;
    if (at !== bt) return bt - at;
    const aid = String(a[0]?.conversationId || "");
    const bid = String(b[0]?.conversationId || "");
    return aid < bid ? -1 : aid > bid ? 1 : 0;
  });
  for (const group of ordered) {
    group.sort((a, b) => {
      const ar = rankOf(a);
      const br = rankOf(b);
      if (ar !== br) return ar - br;
      const ao = Number(a.offset) || 0;
      const bo = Number(b.offset) || 0;
      if (ao !== bo) return ao - bo;
      return (Number(a.index) || 0) - (Number(b.index) || 0);
    });
  }
  return ordered.flat();
}

export function filterImageCards(cards, { platform = "", showUncached = false } = {}) {
  const plat = String(platform || "");
  const kept = [];
  for (const card of cards || []) {
    if (!card) continue;
    if (plat && card.platform !== plat) continue;
    const cached = card.status === "cached" && Number(card.bytes) > 0;
    if (cached) {
      kept.push(card);
      continue;
    }
    if (showUncached && PLACEHOLDER_STATUSES.includes(card.status)) kept.push(card);
  }
  return sortImageCards(kept);
}

export function gridLayout(width) {
  const cols = Number(width) >= 240 ? 2 : 1;
  return { cols, gap: 8, rowHeight: 148 };
}

export function visibleRange({ scrollTop = 0, viewHeight = 480, count = 0, cols = 2, rowHeight = 148, overscan = 2 } = {}) {
  const columns = Math.max(1, cols);
  const rows = Math.ceil(count / columns);
  const total = rows * rowHeight;
  if (!count) return { start: 0, end: 0, total: 0, rows: 0 };
  const top = Math.max(0, Number(scrollTop) || 0);
  const view = Math.max(rowHeight, Number(viewHeight) || rowHeight);
  const startRow = Math.max(0, Math.floor(top / rowHeight) - overscan);
  const endRow = Math.min(rows, Math.ceil((top + view) / rowHeight) + overscan);
  return {
    start: startRow * columns,
    end: Math.min(count, endRow * columns),
    total,
    rows,
  };
}

function buildCell(doc, card, locale, hooks) {
  const cell = doc.createElement("div");
  cell.className = "shot";
  cell.dataset.status = String(card.status || "");
  const open = doc.createElement("button");
  open.type = "button";
  open.className = "shot-open";
  const openLabel = text(locale, "imageOpenReader");
  open.setAttribute("aria-label", openLabel);
  open.title = openLabel;
  if (card.status === "cached" && Number(card.bytes) > 0) {
    const img = doc.createElement("img");
    img.className = "shot-img";
    img.alt = String(card.alt || "").slice(0, 200);
    img.decoding = "async";
    open.append(img);
  } else {
    open.classList.add("is-missing");
    const note = doc.createElement("p");
    note.className = "shot-missing";
    note.dataset.reason = String(card.status || "uncached");
    note.textContent = text(locale, REASON_KEY[card.status] || "imageUncached");
    open.append(note);
  }
  open.addEventListener("click", () => hooks.onOpenReader?.(card));
  cell.append(open);
  const safe = safeOriginalUrl(card.chatUrl || "");
  if (safe) {
    const site = doc.createElement("button");
    site.type = "button";
    site.className = "shot-site";
    const siteLabel = text(locale, "openOriginal");
    site.setAttribute("aria-label", siteLabel);
    site.title = siteLabel;
    site.append(externalIcon(doc));
    site.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hooks.onOpenSite?.(safe);
    });
    cell.append(site);
  }
  return cell;
}

/**
 * Virtual grid. Only the visible window is built, and only those thumbnails
 * are decoded. Leaving the window releases the URL.
 */
export function mountImageGrid(scroller, options = {}) {
  const doc = scroller.ownerDocument;
  const locale = options.locale || "en";
  scroller.replaceChildren();
  const spacer = doc.createElement("div");
  spacer.className = "image-spacer";
  const pool = doc.createElement("div");
  pool.className = "image-pool";
  scroller.append(spacer, pool);

  let cards = options.cards || [];
  let gridLocale = locale;
  let generation = 0;
  const loaded = new Map();
  const cells = new Map();

  function metrics() {
    const width = scroller.clientWidth || options.width || 292;
    const viewHeight = scroller.clientHeight || options.viewHeight || 480;
    const layout = gridLayout(width);
    return { width, viewHeight, ...layout };
  }

  function releaseKey(key) {
    const box = loaded.get(key);
    if (!box) return;
    loaded.delete(key);
    box.release?.();
  }

  function paintThumb(img, card, token) {
    const key = cardKey(card);
    if (loaded.has(key) || typeof options.loadThumb !== "function") return;
    const pending = { release() {}, pending: true };
    loaded.set(key, pending);
    Promise.resolve(options.loadThumb(card)).then((packed) => {
      if (loaded.get(key) !== pending || token !== generation || !img.isConnected) {
        packed?.release?.();
        if (loaded.get(key) === pending) loaded.delete(key);
        return;
      }
      if (typeof packed?.url !== "string" || !packed.url.startsWith("data:image/")) {
        packed?.release?.();
        loaded.delete(key);
        return;
      }
      loaded.set(key, packed);
      img.src = packed.url;
    }).catch(() => {
      if (loaded.get(key) === pending) loaded.delete(key);
    });
  }

  function dropCell(key, cell) {
    const img = cell.querySelector("img");
    if (img) img.removeAttribute("src");
    releaseKey(key);
    cell.remove();
    cells.delete(key);
  }

  function render() {
    const { width, viewHeight, cols, gap, rowHeight } = metrics();
    let scrollTop = scroller.scrollTop || 0;
    let range = visibleRange({
      scrollTop,
      viewHeight,
      count: cards.length,
      cols,
      rowHeight,
    });
    const maxScroll = Math.max(0, range.total - viewHeight);
    if (scrollTop > maxScroll) {
      scrollTop = maxScroll;
      scroller.scrollTop = maxScroll;
      range = visibleRange({
        scrollTop,
        viewHeight,
        count: cards.length,
        cols,
        rowHeight,
      });
    }
    spacer.style.height = `${range.total}px`;
    const seen = new Set();
    const placed = [];
    const cellW = Math.max(40, (width - gap * (cols - 1)) / cols);
    for (let i = range.start; i < range.end; i += 1) {
      const card = cards[i];
      const key = cardKey(card);
      seen.add(key);
      let cell = cells.get(key);
      if (cell && cell.dataset.status !== String(card.status || "")) {
        dropCell(key, cell);
        cell = null;
      }
      if (!cell) {
        cell = buildCell(doc, card, gridLocale, options);
        cells.set(key, cell);
        const img = cell.querySelector("img");
        if (img) paintThumb(img, card, generation);
      }
      const row = Math.floor(i / cols);
      const col = i % cols;
      cell.style.top = `${row * rowHeight}px`;
      cell.style.left = `${col * (cellW + gap)}px`;
      cell.style.width = `${cellW}px`;
      cell.style.height = `${rowHeight - gap}px`;
      placed.push(cell);
    }
    for (const cell of placed) pool.append(cell);
    for (const [key, cell] of cells) {
      if (seen.has(key)) continue;
      dropCell(key, cell);
    }
  }

  function onScroll() {
    render();
  }
  scroller.addEventListener("scroll", onScroll);
  let lastWidth = scroller.clientWidth || 0;
  const ResizeObserverImpl = doc.defaultView?.ResizeObserver;
  const resizeObserver = typeof ResizeObserverImpl === "function"
    ? new ResizeObserverImpl(() => {
      const width = scroller.clientWidth || 0;
      if (width === lastWidth) return;
      lastWidth = width;
      render();
    })
    : null;
  resizeObserver?.observe(scroller);
  render();

  return {
    count: () => cards.length,
    mounted: () => pool.children.length,
    setCards(next, opts = {}) {
      const nextLocale = opts.locale || gridLocale;
      if (nextLocale !== gridLocale) {
        gridLocale = nextLocale;
        generation += 1;
        for (const [key, cell] of [...cells]) dropCell(key, cell);
      }
      cards = next || [];
      render();
    },
    redraw: render,
    destroy() {
      generation += 1;
      scroller.removeEventListener("scroll", onScroll);
      resizeObserver?.disconnect();
      for (const [key, cell] of [...cells]) dropCell(key, cell);
      scroller.replaceChildren();
    },
  };
}
