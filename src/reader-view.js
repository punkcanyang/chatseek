/**
 * Read-only conversation view. Chat text becomes text nodes and <mark> only.
 * A window of messages is mounted in normal flow between two spacer blocks;
 * the rest stay in memory so a long thread does not build thousands of DOM
 * nodes. Mounted messages are measured on every window change, so spacer
 * heights converge on the real layout and messages never overlap.
 */

import { fill, text } from "./i18n.js";
import { formatActivityLabel } from "./activity-time.js";
import { altBag, cachedMarkdown, consumedImageRanges, renderMarkdown } from "./markdown-dom.js";
import { hitMayBeMarkup, visibleRanges } from "./markdown.js";
import { fillHighlight, findMatchRanges, highlightTerms } from "./preview.js";
import { safeOriginalUrl } from "./reader-url.js";
import { externalIcon } from "./icons.js";
import { dataUrlFromBytes, snapOffset } from "./image-cache.js";
import { parseSearchQuery, syntaxRanges, syntaxBodyRanges } from "./search-query.js";

export const MAX_NODES = 60;
const OVERSCAN_PX = 480;
const HIT_MARGIN_PX = 12;

const PLATFORM_LABEL = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  grok: "Grok",
  gemini: "Gemini",
};

export function splitPlainBlocks(text) {
  const value = String(text ?? "");
  const blocks = [];
  let i = 0;
  let mode = "text";
  let start = 0;
  const push = (type, from, to) => {
    if (to <= from && type !== "code") return;
    let raw = value.slice(from, to);
    let end = to;
    if (type === "code") {
      const visible = raw.replace(/\n$/, "");
      raw = visible;
      end = from + visible.length;
    }
    if (!raw && type !== "code") return;
    blocks.push({ type, text: raw, start: from, end });
  };
  while (i <= value.length) {
    const nl = value.indexOf("\n", i);
    const lineEnd = nl === -1 ? value.length : nl;
    const line = value.slice(i, lineEnd);
    if (/^```[^\n]*$/.test(line)) {
      if (mode === "text") {
        push("text", start, i);
        mode = "code";
        start = nl === -1 ? value.length : nl + 1;
      } else {
        push("code", start, i);
        mode = "text";
        start = nl === -1 ? value.length : nl + 1;
      }
    }
    if (nl === -1) break;
    i = nl + 1;
  }
  if (start < value.length || mode === "code") {
    push(mode === "code" ? "code" : "text", start, value.length);
  }
  if (!blocks.length) blocks.push({ type: "text", text: value, start: 0, end: value.length });
  return blocks;
}

export function collectHits(title, messages, query, images) {
  const parsed = parseSearchQuery(query);
  const terms = highlightTerms(query);
  const hits = [];
  if (!terms.length) return hits;
  const titleRanges = parsed.mode === "syntax" ? syntaxRanges(title || "", parsed, "title") : findMatchRanges(title || "", terms);
  for (const range of titleRanges) {
    hits.push({ where: "title", range });
  }
  if (parsed.mode === "syntax" && !parsed.clauses.some((clause) => !clause.exclude && clause.field !== "title")) return hits;
  (messages || []).forEach((msg, messageIndex) => {
    const body = msg?.body || "";
    const ranges = parsed.mode === "syntax" ? syntaxBodyRanges(body, parsed, /[*_`#|[\]>]|https?:\/\//i.test(body) ? cachedMarkdown(msg, body) : undefined) : findMatchRanges(body, terms);
    if (!ranges.length) return;
    // A hit that lands only on markup is not painted, so it is not counted.
    // The parse is skipped when no hit could be markup; otherwise the AST is
    // cached on the message and reused when it scrolls into view.
    const shown = ranges.some((range) => hitMayBeMarkup(body, range))
      ? visibleRanges(cachedMarkdown(msg, body))
      : null;
    const shots = images?.get?.(msg?.id) || [];
    const hidden = shots.length
      ? consumedImageRanges(body, shots.map((shot) => shot?.alt || ""))
      : [];
    for (const range of ranges) {
      if (hidden.some(([start, end]) => range[0] >= start && range[1] <= end)) continue;
      if (!shown || overlapsAny(shown, range)) hits.push({ where: "message", messageIndex, range });
    }
  });
  return hits;
}

function overlapsAny(sorted, [start, end]) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid][1] <= start) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length && sorted[lo][0] < end;
}

function estimateHeight(msg) {
  const body = String(msg?.body || "");
  const lines = body.split("\n").length;
  const extra = Math.ceil(body.length / 56);
  return Math.min(720, 72 + lines * 22 + extra * 10);
}

function buildPrefix(heights) {
  const prefix = new Array(heights.length + 1);
  prefix[0] = 0;
  for (let i = 0; i < heights.length; i++) prefix[i + 1] = prefix[i] + heights[i];
  return prefix;
}

function indexAt(prefix, y) {
  let lo = 0;
  let hi = Math.max(0, prefix.length - 2);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (prefix[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function paintMarks(node, hitIds, current) {
  const marks = node.querySelectorAll("mark");
  marks.forEach((mark, index) => {
    const hit = hitIds[index];
    if (hit == null) return;
    mark.dataset.hit = String(hit);
    mark.classList.toggle("is-current", hit === current);
  });
}

function messageHits(hits, messageIndex) {
  const local = [];
  hits.forEach((hit, index) => {
    if (hit.where !== "message" || hit.messageIndex !== messageIndex) return;
    local.push({ index, range: hit.range });
  });
  return local;
}

function shiftHits(hits, from, to) {
  const local = [];
  for (const hit of hits || []) {
    const start = hit.range[0];
    const end = hit.range[1];
    if (end <= from || start >= to) continue;
    local.push({
      index: hit.index,
      range: [Math.max(0, start - from), Math.min(to, end) - from],
    });
  }
  return local;
}

function imageSlot(doc, shot, locale, onOpen) {
  const fig = doc.createElement("figure");
  fig.className = "image-slot";
  if (shot?.messageId) fig.dataset.messageId = String(shot.messageId);
  if (Number.isInteger(shot?.index)) fig.dataset.imageIndex = String(shot.index);
  const cachedUrl = shot?.status === "cached"
    ? (shot.dataUrl || dataUrlFromBytes(shot.blob, shot.mime))
    : "";
  if (typeof cachedUrl === "string" && cachedUrl.startsWith("data:image/")) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "thumb-btn";
    const label = text(locale, "openOriginal");
    btn.setAttribute("aria-label", label);
    btn.title = label;
    const img = doc.createElement("img");
    img.className = "cached-thumb";
    const alt = String(shot.alt || shot.prompt || text(locale, "imageLabel")).slice(0, 200);
    img.alt = alt;
    img.src = cachedUrl;
    btn.append(img);
    btn.addEventListener("click", () => onOpen?.());
    fig.append(btn);
    return fig;
  }
  fig.classList.add("image-missing");
  const reason = shot?.status === "oversized"
    ? ["oversized", "imageOversized"]
    : shot?.status === "timeout"
      ? ["timeout", "imageTimeout"]
      : shot?.status === "not-loaded"
        ? ["not-loaded", "imageNotLoaded"]
        : shot?.status === "cleared"
          ? ["cleared", "imageCleared"]
          : ["site", "imageUncached"];
  fig.dataset.reason = reason[0];
  const note = doc.createElement("p");
  note.className = "image-missing-text";
  note.textContent = text(locale, reason[1]);
  const btn = doc.createElement("button");
  btn.type = "button";
  btn.className = "link image-open";
  btn.textContent = text(locale, "openOriginal");
  btn.addEventListener("click", () => onOpen?.());
  fig.append(note, btn);
  return fig;
}

function renderBodyWithImages(parent, msg, shots, hits, current, locale, onOpen) {
  const body = String(msg?.body || "");
  const points = [];
  for (const shot of [...shots].sort((a, b) => (a.index || 0) - (b.index || 0))) {
    const at = snapOffset(body, shot?.offset);
    let group = points.find((row) => row.at === at);
    if (!group) {
      group = { at, shots: [] };
      points.push(group);
    }
    group.shots.push(shot);
  }
  points.sort((a, b) => a.at - b.at);
  let cursor = 0;
  const skipAlts = altBag(shots.map((shot) => shot?.alt || ""));
  const paint = (from, to) => {
    if (to <= from && body) return;
    renderMarkdown(parent, body.slice(from, to), {
      hits: shiftHits(hits, from, to),
      current,
      locale,
      owner: null,
      skipAlts,
    });
  };
  for (const group of points) {
    const at = Math.max(cursor, Math.min(body.length, group.at));
    if (at > cursor) paint(cursor, at);
    for (const shot of group.shots) parent.append(imageSlot(parent.ownerDocument, shot, locale, onOpen));
    cursor = at;
  }
  if (cursor < body.length) paint(cursor, body.length);
}

function renderMessage(doc, msg, index, hits, current, locale, images, onOpen) {
  const assistant = msg?.role === "assistant";
  const article = doc.createElement("article");
  article.className = `msg msg-${assistant ? "assistant" : "user"}`;
  article.dataset.index = String(index);
  const role = doc.createElement("div");
  role.className = "msg-role";
  role.dataset.role = assistant ? "assistant" : "user";
  role.textContent = text(locale, assistant ? "roleAssistant" : "roleUser");
  const body = doc.createElement("div");
  body.className = "msg-body";
  const shots = images?.get?.(msg?.id) || [];
  const localHits = messageHits(hits, index);
  if (shots.length) {
    renderBodyWithImages(body, msg, shots, localHits, current, locale, onOpen);
  } else {
    renderMarkdown(body, msg?.body || "", {
      hits: localHits,
      current,
      locale,
      owner: msg,
    });
  }
  article.append(role, body);
  return article;
}

function platformName(id) {
  return PLATFORM_LABEL[id] || PLATFORM_LABEL.chatgpt;
}

/**
 * Fills root. Returns controls tests can call without clicking.
 * onOpenOriginal(url) is the only side effect; nothing here writes IndexedDB.
 */
export function mountReader(root, options = {}) {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  const locale = options.locale || "en";
  const query = String(options.query || "");
  const searching = highlightTerms(query).length > 0;
  const conversation = options.conversation || null;
  // Already in page order (readConversation). The view does not reorder.
  const messages = (options.messages || []).filter((msg) => msg && msg.id);
  let imageMap = options.images instanceof Map ? options.images : new Map();
  const hits = options.missing || options.error || !conversation
    ? []
    : collectHits(conversation.title || conversation.platformId || "", messages, query, imageMap);
  let hitIndex = hits.length ? 0 : -1;
  const focus = options.focus && options.focus.messageId && Number.isInteger(options.focus.index)
    ? { messageId: String(options.focus.messageId), index: options.focus.index }
    : null;
  let focusDone = false;
  let flashTimer = 0;
  const heights = messages.map(estimateHeight);
  let prefix = buildPrefix(heights);
  let live = new Map();
  let renderedStart = -1;
  let renderedEnd = -1;
  // Logical scroll offset. A layout-less document clamps scrollTop to 0, so
  // hit jumps keep this value and only trust scrollTop once the box has height.
  let scrollCursor = 0;

  root.replaceChildren();
  root.classList.add("reader");
  const mode = options.error
    ? "error"
    : !conversation || options.missing
      ? "missing"
      : messages.length
        ? "messages"
        : "title-only";
  root.dataset.state = mode;
  if (conversation?.archived === true) root.dataset.archived = "true";
  else delete root.dataset.archived;

  const header = doc.createElement("header");
  header.className = "reader-top";
  const title = doc.createElement("h1");
  title.id = "readerTitle";
  title.className = "reader-title";
  const meta = doc.createElement("div");
  meta.className = "reader-meta";
  const plat = doc.createElement("span");
  plat.id = "readerPlatform";
  plat.className = `plat ${conversation?.platform || ""}`;
  const time = doc.createElement("time");
  time.id = "readerDate";
  let clockConv = conversation;

  function paintClock(conv, now = Date.now()) {
    if (!conv) {
      time.textContent = "";
      time.title = "";
      delete time.dataset.source;
      time.classList.remove("is-approx", "is-unknown");
      return;
    }
    const when = formatActivityLabel(conv, now, locale);
    time.textContent = when.text;
    time.title = when.title || "";
    if (when.source) time.dataset.source = when.source;
    else delete time.dataset.source;
    time.classList.toggle("is-approx", !!when.approx);
    time.classList.toggle("is-unknown", !!when.unknown);
  }
  const badge = doc.createElement("span");
  badge.id = "archivedBadge";
  badge.className = "badge-archived";
  badge.hidden = conversation?.archived !== true;
  const nav = doc.createElement("div");
  nav.className = "reader-nav";
  const prevBtn = doc.createElement("button");
  prevBtn.type = "button";
  prevBtn.id = "prevHit";
  prevBtn.className = "btn";
  const counter = doc.createElement("span");
  counter.id = "hitCount";
  counter.className = "hit-count";
  counter.setAttribute("aria-live", "polite");
  const nextBtn = doc.createElement("button");
  nextBtn.type = "button";
  nextBtn.id = "nextHit";
  nextBtn.className = "btn";
  const openBtn = doc.createElement("button");
  openBtn.type = "button";
  openBtn.id = "openOriginal";
  openBtn.className = "btn btn-open";
  nav.append(prevBtn, counter, nextBtn, openBtn);

  const note = doc.createElement("p");
  note.id = "readerNote";
  note.className = "reader-note";

  header.append(title, meta, nav, note);
  meta.append(plat, time, badge);

  const scroller = doc.createElement("div");
  scroller.className = "thread";
  scroller.id = "thread";
  const topPad = doc.createElement("div");
  topPad.className = "spacer spacer-top";
  const pool = doc.createElement("div");
  pool.className = "pool";
  const bottomPad = doc.createElement("div");
  bottomPad.className = "spacer spacer-bottom";
  scroller.append(topPad, pool, bottomPad);
  root.append(header, scroller);

  const original = safeOriginalUrl(conversation?.url || "");
  if (original) openBtn.dataset.url = original;

  function applyCopy() {
    const label = (key, ...args) => fill(text(locale, key), ...args);
    doc.documentElement.lang = locale;
    prevBtn.textContent = label("prevHit");
    nextBtn.textContent = label("nextHit");
    const openLabel = label("openOriginal");
    openBtn.setAttribute("aria-label", openLabel);
    openBtn.title = openLabel;
    if (!openBtn.querySelector("svg")) openBtn.append(externalIcon(doc));
    badge.textContent = label("archivedBadge");
    if (!conversation) {
      title.textContent = "Chatseek";
      plat.textContent = "";
      time.textContent = "";
    } else {
      const name = conversation.title || conversation.platformId || "";
      const titleHits = [];
      const titleIds = [];
      hits.forEach((hit, index) => {
        if (hit.where !== "title") return;
        titleHits.push(hit.range);
        titleIds.push(index);
      });
      fillHighlight(title, name, titleHits);
      paintMarks(title, titleIds, hitIndex);
      plat.textContent = platformName(conversation.platform);
      plat.className = `plat ${conversation.platform || ""}`;
      paintClock(clockConv);
      if (conversation.title) doc.title = `${conversation.title} · Chatseek`;
    }
    openBtn.hidden = !original || mode === "missing" || mode === "error";
    nav.hidden = mode === "missing" || mode === "error";
    if (mode === "missing") note.textContent = label("missingChat");
    else if (mode === "error") note.textContent = label("error");
    else if (mode === "title-only") note.textContent = label("titleOnly");
    else note.textContent = "";
    note.hidden = mode === "messages";
    note.classList.toggle("is-title-only", mode === "title-only");
    // Opened from a row without a search: no hit controls at all.
    counter.hidden = !searching;
    prevBtn.hidden = !hits.length;
    nextBtn.hidden = !hits.length;
    if (!hits.length) counter.textContent = searching ? label("noHits") : "";
    else counter.textContent = label("hitCount", hitIndex + 1, hits.length);
    prevBtn.disabled = hitIndex <= 0;
    nextBtn.disabled = hitIndex < 0 || hitIndex >= hits.length - 1;
  }

  function hasLayout() {
    return (scroller.clientHeight || 0) > 0;
  }

  function viewTop() {
    return hasLayout() ? scroller.scrollTop || 0 : scrollCursor;
  }

  function setViewTop(y) {
    const next = Math.max(0, Math.round(y));
    scrollCursor = next;
    if (hasLayout()) {
      scroller.scrollTop = next;
      scrollCursor = scroller.scrollTop || 0;
    }
  }

  function windowFor(top) {
    const viewH = scroller.clientHeight || options.viewportHeight || 720;
    let start = indexAt(prefix, Math.max(0, top - OVERSCAN_PX));
    let end = indexAt(prefix, top + viewH + OVERSCAN_PX);
    if (end < start) end = start;
    if (end - start + 1 > MAX_NODES) end = start + MAX_NODES - 1;
    if (end >= messages.length) {
      end = messages.length - 1;
      start = Math.max(0, Math.min(start, end - MAX_NODES + 1));
    }
    return { start, end };
  }

  function paintCurrent() {
    root.querySelectorAll("mark[data-hit]").forEach((mark) => {
      mark.classList.toggle("is-current", Number(mark.dataset.hit) === hitIndex);
    });
  }

  function mountRange(start, end) {
    const next = new Map();
    const nodes = [];
    for (let i = start; i <= end; i++) {
      const el = live.get(i) || renderMessage(
        doc,
        messages[i],
        i,
        hits,
        hitIndex,
        locale,
        imageMap,
        openOriginalNow,
      );
      next.set(i, el);
      nodes.push(el);
    }
    live = next;
    pool.replaceChildren(...nodes);
    renderedStart = start;
    renderedEnd = end;
    if (typeof options.onWindow === "function" && mode === "messages") {
      const ids = [];
      for (let i = start; i <= end; i += 1) {
        if (messages[i]?.id) ids.push(messages[i].id);
      }
      options.onWindow(ids);
    }
  }

  function placePads() {
    const total = prefix[prefix.length - 1] || 0;
    const top = renderedStart >= 0 ? prefix[renderedStart] : 0;
    const below = renderedEnd >= 0 ? total - prefix[renderedEnd + 1] : 0;
    topPad.style.height = `${Math.max(0, top)}px`;
    bottomPad.style.height = `${Math.max(0, below)}px`;
  }

  function measure() {
    let changed = false;
    for (const [index, el] of live) {
      const h = el.offsetHeight;
      if (!h) continue;
      if (Math.abs(h - heights[index]) > 1) {
        heights[index] = h;
        changed = true;
      }
    }
    if (changed) prefix = buildPrefix(heights);
    return changed;
  }

  /**
   * Mount the messages around the viewport and keep `anchor` at the same
   * distance from the top of the viewport while estimates turn into real
   * heights. Without an explicit anchor the first visible message is kept.
   */
  function renderWindow({ anchor, offset, force = false } = {}) {
    if (mode !== "messages") {
      pool.replaceChildren();
      live = new Map();
      renderedStart = -1;
      renderedEnd = -1;
      placePads();
      return;
    }
    let top = viewTop();
    const pin = Number.isInteger(anchor) ? anchor : indexAt(prefix, top);
    const gap = Number.isFinite(offset) ? offset : top - prefix[pin];
    for (let pass = 0; pass < 4; pass++) {
      const { start, end } = windowFor(top);
      const same = start === renderedStart && end === renderedEnd;
      if (same && !force && pass === 0) return;
      if (!same || pass === 0) mountRange(start, end);
      placePads();
      if (!measure() && same) break;
      placePads();
      const wanted = Math.max(0, prefix[pin] + gap);
      if (Math.abs(wanted - top) > 0.5) setViewTop(wanted);
      top = viewTop();
      if (pass > 0 && same) break;
    }
    paintCurrent();
  }

  function revealWide(mark) {
  const wide = mark.closest?.(".code, .table-wrap");
  if (!wide || typeof wide.getBoundingClientRect !== "function") return;
  const markBox = mark.getBoundingClientRect();
  const box = wide.getBoundingClientRect();
  if (!box.width || !markBox.width) return;
  if (markBox.left < box.left) wide.scrollLeft -= box.left - markBox.left + 8;
  else if (markBox.right > box.right) wide.scrollLeft += markBox.right - box.right + 8;
}

function focusHit() {
  const mark = root.querySelector("mark.is-current") || root.querySelector(`mark[data-hit="${hitIndex}"]`);
  if (!mark) return;
  revealWide(mark);
  if (typeof mark.scrollIntoView !== "function") return;
  try {
    mark.scrollIntoView({ block: "center", inline: "nearest" });
    revealWide(mark);
  } catch { /* jsdom */ }
}

  function go(next) {
    if (!hits.length) {
      hitIndex = -1;
      applyCopy();
      renderWindow({ force: true });
      return;
    }
    hitIndex = Math.max(0, Math.min(hits.length - 1, next));
    const hit = hits[hitIndex];
    applyCopy();
    if (hit.where === "message") {
      const m = hit.messageIndex;
      setViewTop(prefix[m] - HIT_MARGIN_PX);
      renderWindow({ anchor: m, offset: -HIT_MARGIN_PX, force: true });
    } else {
      setViewTop(0);
      renderWindow({ force: true });
    }
    paintCurrent();
    focusHit();
  }

  function step(delta) {
    if (!hits.length) return;
    const next = hitIndex + delta;
    if (next < 0 || next >= hits.length) return;
    go(next);
  }

  prevBtn.addEventListener("click", () => step(-1));
  nextBtn.addEventListener("click", () => step(1));
  function openOriginalNow() {
    if (!original || typeof options.onOpenOriginal !== "function") return;
    options.onOpenOriginal(original);
  }

  openBtn.addEventListener("click", openOriginalNow);
  scroller.addEventListener("scroll", () => {
    if (hasLayout()) scrollCursor = scroller.scrollTop || 0;
    renderWindow();
  });
  // A width change rewraps every mounted message. Observing the scroller
  // itself lets a remount (language switch) drop the old view with its node.
  if (typeof view?.ResizeObserver === "function") {
    let lastWidth = -1;
    new view.ResizeObserver(() => {
      const width = scroller.clientWidth;
      if (width === lastWidth) return;
      lastWidth = width;
      renderWindow({ force: true });
      if (hitIndex >= 0) focusHit();
    }).observe(scroller);
  }

  function findFocusSlot() {
    if (!focus) return null;
    for (const fig of root.querySelectorAll(".image-slot")) {
      if (fig.dataset.messageId === focus.messageId && Number(fig.dataset.imageIndex) === focus.index) return fig;
    }
    return null;
  }

  function focusMessageIndex() {
    if (!focus) return -1;
    return messages.findIndex((msg) => msg.id === focus.messageId);
  }

  function revealFocus() {
    if (focusDone || !focus) return false;
    const idx = focusMessageIndex();
    if (idx >= 0) {
      setViewTop(Math.max(0, prefix[idx] - HIT_MARGIN_PX));
      renderWindow({ anchor: idx, offset: -HIT_MARGIN_PX, force: true });
    }
    const fig = findFocusSlot();
    if (!fig) return false;
    fig.classList.add("is-target");
    if (hasLayout() && typeof fig.getBoundingClientRect === "function") {
      const box = fig.getBoundingClientRect();
      const host = scroller.getBoundingClientRect();
      if (box.height && host.height) {
        const delta = box.top - host.top - HIT_MARGIN_PX;
        if (Math.abs(delta) > 4) {
          setViewTop(viewTop() + delta);
          renderWindow({ force: true });
        }
      }
    }
    const marked = findFocusSlot();
    if (marked && marked !== fig) marked.classList.add("is-target");
    focusDone = true;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      findFocusSlot()?.classList.remove("is-target");
    }, 4000);
    return true;
  }

  applyCopy();
  const focusIdx = focusMessageIndex();
  if (focusIdx >= 0) {
    setViewTop(Math.max(0, prefix[focusIdx] - HIT_MARGIN_PX));
    renderWindow({ anchor: focusIdx, offset: -HIT_MARGIN_PX, force: true });
    revealFocus();
  } else if (hits.length) go(0);
  else renderWindow({ force: true });

  return {
    hitCount: () => hits.length,
    hitIndex: () => hitIndex,
    prev: () => step(-1),
    next: () => step(1),
    renderedMessages: () => pool.querySelectorAll(".msg").length,
    mode: () => mode,
    setImages(next) {
      imageMap = next instanceof Map ? next : new Map();
      live = new Map();
      renderedStart = -1;
      renderedEnd = -1;
      const idx = focusMessageIndex();
      if (idx >= 0 && !focusDone) {
        setViewTop(Math.max(0, prefix[idx] - HIT_MARGIN_PX));
        renderWindow({ anchor: idx, offset: -HIT_MARGIN_PX, force: true });
        revealFocus();
      } else {
        renderWindow({ force: true });
      }
    },
    targetImage() {
      const fig = root.querySelector(".image-slot.is-target");
      if (!fig) return null;
      return { messageId: fig.dataset.messageId || "", index: Number(fig.dataset.imageIndex) };
    },
    setActivity(conv, now = Date.now()) {
      if (!clockConv || !conv) return;
      if (conv.updatedAt != null) clockConv.updatedAt = conv.updatedAt;
      if (conv.updatedAtSource) clockConv.updatedAtSource = conv.updatedAtSource;
      if ("olderThanAt" in conv) {
        if (conv.olderThanAt) clockConv.olderThanAt = conv.olderThanAt;
        else delete clockConv.olderThanAt;
      }
      if (conv.firstSeenAt) clockConv.firstSeenAt = conv.firstSeenAt;
      paintClock(clockConv, now);
    },
  };
}
