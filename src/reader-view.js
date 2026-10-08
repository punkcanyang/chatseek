/**
 * Read-only conversation view. Chat text becomes text nodes and <mark> only.
 * A window of messages is mounted; the rest stay in memory so a long thread
 * does not build thousands of DOM nodes.
 */

import { fill, text } from "./i18n.js";
import { formatActivityLabel } from "./activity-time.js";
import { fillHighlight, findMatchRanges, highlightTerms } from "./preview.js";
import { orderMessages } from "./message-order.js";
import { safeOriginalUrl } from "./reader-url.js";

const MAX_NODES = 32;
const OVERSCAN_PX = 240;

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

export function collectHits(title, messages, query) {
  const terms = highlightTerms(query);
  const hits = [];
  if (!terms.length) return hits;
  for (const range of findMatchRanges(title || "", terms)) {
    hits.push({ where: "title", range });
  }
  (messages || []).forEach((msg, messageIndex) => {
    for (const range of findMatchRanges(msg?.body || "", terms)) {
      hits.push({ where: "message", messageIndex, range });
    }
  });
  return hits;
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

function rangesInBlock(block, hits, messageIndex) {
  const local = [];
  const ids = [];
  hits.forEach((hit, hitIndex) => {
    if (hit.where !== "message" || hit.messageIndex !== messageIndex) return;
    const [start, end] = hit.range;
    const from = Math.max(start, block.start);
    const to = Math.min(end, block.end);
    if (to > from) {
      local.push([from - block.start, to - block.start]);
      ids.push(hitIndex);
    }
  });
  return { local, ids };
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

function appendBlock(parent, block, hits, messageIndex, current) {
  const doc = parent.ownerDocument;
  const { local, ids } = rangesInBlock(block, hits, messageIndex);
  const node = block.type === "code" ? doc.createElement("pre") : doc.createElement("div");
  if (block.type === "code") node.className = "code";
  else node.className = "chunk";
  fillHighlight(node, block.text, local);
  paintMarks(node, ids, current);
  parent.append(node);
}

function renderMessage(doc, msg, index, hits, current) {
  const article = doc.createElement("article");
  article.className = `msg msg-${msg?.role === "assistant" ? "assistant" : "user"}`;
  article.dataset.index = String(index);
  const role = doc.createElement("div");
  role.className = "msg-role";
  role.dataset.role = msg?.role === "assistant" ? "assistant" : "user";
  const body = doc.createElement("div");
  body.className = "msg-body";
  for (const block of splitPlainBlocks(msg?.body || "")) {
    appendBlock(body, block, hits, index, current);
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
  const locale = options.locale || "en";
  const query = String(options.query || "");
  const conversation = options.conversation || null;
  const messages = orderMessages(options.messages || [], conversation?.messageOrder);
  const hits = options.missing || options.error || !conversation
    ? []
    : collectHits(conversation.title || conversation.platformId || "", messages, query);
  let hitIndex = hits.length ? 0 : -1;
  const heights = messages.map(estimateHeight);
  let prefix = buildPrefix(heights);
  let renderedKey = "";
  let measurePasses = 0;
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
  const spacer = doc.createElement("div");
  spacer.className = "spacer";
  const pool = doc.createElement("div");
  pool.className = "pool";
  spacer.append(pool);
  scroller.append(spacer);
  root.append(header, scroller);

  const original = safeOriginalUrl(conversation?.url || "");
  if (original) openBtn.dataset.url = original;

  function applyCopy() {
    const code = options.locale || locale;
    const label = (key, ...args) => fill(text(code, key), ...args);
    doc.documentElement.lang = code;
    prevBtn.textContent = label("prevHit");
    nextBtn.textContent = label("nextHit");
    openBtn.textContent = label("openOriginal");
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
      const when = formatActivityLabel(conversation, Date.now(), code);
      time.textContent = when.text;
      time.title = when.title || "";
      if (when.source) time.dataset.source = when.source;
      time.classList.toggle("is-approx", !!when.approx);
      time.classList.toggle("is-unknown", !!when.unknown);
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
    if (!hits.length) counter.textContent = mode === "messages" || mode === "title-only"
      ? label("noHits")
      : "";
    else counter.textContent = label("hitCount", hitIndex + 1, hits.length);
    prevBtn.disabled = hitIndex <= 0;
    nextBtn.disabled = hitIndex < 0 || hitIndex >= hits.length - 1;
  }

  function windowBounds() {
    const viewH = scroller.clientHeight || options.viewportHeight || 720;
    const top = Math.max(0, scrollCursor - OVERSCAN_PX);
    const bottom = scrollCursor + viewH + OVERSCAN_PX;
    if (!messages.length) return { start: 0, end: -1 };
    let start = indexAt(prefix, top);
    let end = indexAt(prefix, bottom);
    if (end < start) end = start;
    if (end - start + 1 > MAX_NODES) end = start + MAX_NODES - 1;
    if (end >= messages.length) {
      end = messages.length - 1;
      start = Math.max(0, end - MAX_NODES + 1);
    }
    return { start, end };
  }

  function renderWindow() {
    if (mode !== "messages") {
      pool.replaceChildren();
      spacer.style.height = "0px";
      renderedKey = "";
      return;
    }
    const { start, end } = windowBounds();
    const key = `${start}:${end}:${hitIndex}`;
    spacer.style.height = `${prefix[prefix.length - 1] || 0}px`;
    if (key === renderedKey) {
      pool.querySelectorAll("mark[data-hit]").forEach((mark) => {
        mark.classList.toggle("is-current", Number(mark.dataset.hit) === hitIndex);
      });
      title.querySelectorAll("mark[data-hit]").forEach((mark) => {
        mark.classList.toggle("is-current", Number(mark.dataset.hit) === hitIndex);
      });
      return;
    }
    renderedKey = key;
    pool.replaceChildren();
    for (let i = start; i <= end && i < messages.length; i++) {
      const el = renderMessage(doc, messages[i], i, hits, hitIndex);
      el.style.position = "absolute";
      el.style.left = "0";
      el.style.right = "0";
      el.style.top = `${prefix[i]}px`;
      const role = el.querySelector(".msg-role");
      if (role) {
        role.textContent = messages[i]?.role === "assistant"
          ? text(options.locale || locale, "roleAssistant")
          : text(options.locale || locale, "roleUser");
      }
      pool.append(el);
    }
    scheduleMeasure();
  }

  function measure() {
    let changed = false;
    pool.querySelectorAll(".msg").forEach((el) => {
      const index = Number(el.dataset.index);
      const h = el.offsetHeight;
      if (!h || !Number.isInteger(index) || index < 0 || index >= heights.length) return;
      if (Math.abs(h - heights[index]) > 8) {
        heights[index] = h;
        changed = true;
      }
    });
    if (!changed) return false;
    prefix = buildPrefix(heights);
    renderedKey = "";
    renderWindow();
    return true;
  }

  function scheduleMeasure() {
    if (measurePasses > 2) return;
    const view = doc.defaultView;
    if (!view || typeof view.requestAnimationFrame !== "function") return;
    view.requestAnimationFrame(() => {
      const sample = pool.querySelector(".msg");
      if (!sample || sample.offsetHeight <= 0) return;
      measurePasses += 1;
      measure();
    });
  }

  function focusHit() {
    const mark = root.querySelector(`mark[data-hit="${hitIndex}"]`);
    if (mark && typeof mark.scrollIntoView === "function") {
      try { mark.scrollIntoView({ block: "center", inline: "nearest" }); } catch { /* jsdom */ }
    }
  }

  function go(next) {
    if (!hits.length) {
      hitIndex = -1;
      applyCopy();
      renderWindow();
      return;
    }
    hitIndex = Math.max(0, Math.min(hits.length - 1, next));
    const hit = hits[hitIndex];
    if (hit.where === "message") {
      const top = prefix[hit.messageIndex] || 0;
      scrollCursor = Math.max(0, top - 12);
    } else {
      scrollCursor = 0;
    }
    spacer.style.height = `${prefix[prefix.length - 1] || 0}px`;
    scroller.scrollTop = scrollCursor;
    if ((scroller.clientHeight || 0) > 0) scrollCursor = scroller.scrollTop || 0;
    renderedKey = "";
    applyCopy();
    renderWindow();
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
  openBtn.addEventListener("click", () => {
    if (!original || typeof options.onOpenOriginal !== "function") return;
    options.onOpenOriginal(original);
  });
  scroller.addEventListener("scroll", () => {
    if ((scroller.clientHeight || 0) > 0) scrollCursor = scroller.scrollTop || 0;
    renderWindow();
  });

  applyCopy();
  if (hits.length) go(0);
  else renderWindow();

  return {
    hitCount: () => hits.length,
    hitIndex: () => hitIndex,
    prev: () => step(-1),
    next: () => step(1),
    renderedMessages: () => pool.querySelectorAll(".msg").length,
    mode: () => mode,
  };
}
