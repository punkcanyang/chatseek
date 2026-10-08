import { queryTokens } from "./tokenize.js";

/** Stored on the conversation so the idle list does not read the messages store. */
export const PREVIEW_STORE_CHARS = 360;

const CJK =
  /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/;

/**
 * Idle rows show the first user prompt, not the latest message.
 * The opening line is what a person remembers the chat by, and a two-line
 * clamp shows that opening instead of the start of a long assistant reply.
 * The last message is the fallback when no user prompt was stored.
 */
export function selectIdlePreview(conv) {
  const first = flattenPreview(conv?.firstUserPreview);
  if (first) return { kind: "first-user", text: clipPreviewText(first) };
  const last = flattenPreview(conv?.lastPreview);
  if (last) return { kind: "last", text: clipPreviewText(last) };
  return { kind: "title-only", text: "" };
}

export function flattenPreview(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export function clipPreviewText(text, max = PREVIEW_STORE_CHARS) {
  const flat = flattenPreview(text);
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max).trimEnd()}…`;
}

export function highlightTerms(query) {
  return String(query || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
}

/** Longest index tokens only, so a snippet lookup does not walk every unigram. */
export function snippetTokens(query) {
  const tokens = queryTokens(query);
  const longer = tokens.filter((token) => token.length >= 2);
  const pool = (longer.length ? longer : tokens).slice();
  pool.sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  return pool.slice(0, 3);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWordTerm(term) {
  return !CJK.test(term) && /^[A-Za-z0-9]+$/.test(term);
}

export function findMatchRanges(text, terms) {
  const hay = String(text || "");
  const ranges = [];
  for (const term of terms || []) {
    if (!term) continue;
    const word = isWordTerm(term);
    const re = word
      ? new RegExp(`(^|[^A-Za-z0-9])(${escapeRegExp(term)})(?=[^A-Za-z0-9]|$)`, "gi")
      : new RegExp(escapeRegExp(term), "gi");
    let match;
    while ((match = re.exec(hay))) {
      const start = word ? match.index + match[1].length : match.index;
      const end = start + (word ? match[2].length : match[0].length);
      if (end > start) ranges.push([start, end]);
      if (match.index === re.lastIndex) re.lastIndex += 1;
    }
  }
  return mergeRanges(ranges);
}

function mergeRanges(ranges) {
  const sorted = (ranges || [])
    .filter((range) => range && range[1] > range[0])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (!last || start > last[1]) out.push([start, end]);
    else last[1] = Math.max(last[1], end);
  }
  return out;
}

/**
 * Window around the earliest match. A short prefix keeps the highlight inside
 * the two collapsed lines; the rest is context for hover.
 */
export function snippetAround(text, terms, { before = 28, after = 120, maxLen = 180 } = {}) {
  const flat = flattenPreview(text);
  const ranges = findMatchRanges(flat, highlightTerms(Array.isArray(terms) ? terms.join(" ") : terms));
  const wanted = Array.isArray(terms) ? terms : highlightTerms(terms);
  const found = wanted.length ? findMatchRanges(flat, wanted) : ranges;
  if (!found.length) return null;
  const anchorStart = found[0][0];
  const anchorEnd = found[0][1];
  let start = Math.max(0, anchorStart - before);
  let end = Math.min(flat.length, anchorEnd + after);
  const matchLen = anchorEnd - anchorStart;
  if (end - start > maxLen) {
    if (matchLen >= maxLen) {
      start = anchorStart;
      end = Math.min(flat.length, anchorStart + maxLen);
    } else {
      const room = maxLen - matchLen;
      const beforeRoom = Math.min(before, Math.floor(room * 0.25));
      start = Math.max(0, anchorStart - beforeRoom);
      end = Math.min(flat.length, start + maxLen);
      if (end < anchorEnd) end = Math.min(flat.length, anchorEnd);
    }
  }
  if (end < anchorEnd && matchLen < maxLen) {
    end = Math.min(flat.length, anchorEnd);
    start = Math.max(0, Math.min(start, end - maxLen));
  }
  const prefix = start > 0;
  const suffix = end < flat.length;
  const slice = flat.slice(start, end);
  const lead = prefix ? "…" : "";
  const local = findMatchRanges(slice, wanted).map(([from, to]) => [from + lead.length, to + lead.length]);
  return {
    text: `${lead}${slice}${suffix ? "…" : ""}`,
    ranges: local,
  };
}

export function bestSnippet(bodies, terms, options) {
  const wanted = highlightTerms(Array.isArray(terms) ? terms.join(" ") : terms);
  if (!wanted.length) return null;
  let best = null;
  let bestScore = -1;
  for (const body of bodies || []) {
    const flat = flattenPreview(body);
    const ranges = findMatchRanges(flat, wanted);
    if (!ranges.length) continue;
    const score = ranges.length * 100000 - ranges[0][0];
    if (score <= bestScore) continue;
    const snip = snippetAround(flat, wanted, options);
    if (!snip?.ranges?.length) continue;
    best = snip;
    bestScore = score;
  }
  return best;
}

export function buildPreview(conv, query, bodies) {
  const terms = highlightTerms(query);
  const title = String(conv?.title || "");
  const titleRanges = terms.length ? findMatchRanges(title, terms) : [];
  if (terms.length) {
    const snip = bestSnippet(bodies, terms);
    if (snip) {
      return { kind: "snippet", text: snip.text, ranges: snip.ranges, titleRanges };
    }
  }
  const idle = selectIdlePreview(conv);
  if (idle.kind === "title-only") {
    return { kind: "title-only", text: "", ranges: [], titleRanges };
  }
  if (terms.length) {
    const snip = snippetAround(idle.text, terms);
    if (snip?.ranges?.length) {
      return { kind: idle.kind, text: snip.text, ranges: snip.ranges, titleRanges };
    }
  }
  return { kind: idle.kind, text: idle.text, ranges: [], titleRanges };
}

/** DOM text nodes only. Chat text is never parsed as HTML. */
export function fillHighlight(parent, text, ranges) {
  const doc = parent.ownerDocument;
  const value = String(text || "");
  parent.replaceChildren();
  const merged = mergeRanges(ranges);
  if (!merged.length) {
    parent.append(doc.createTextNode(value));
    return;
  }
  let cursor = 0;
  for (const [start, end] of merged) {
    const from = Math.max(0, Math.min(value.length, start));
    const to = Math.max(from, Math.min(value.length, end));
    if (from > cursor) parent.append(doc.createTextNode(value.slice(cursor, from)));
    if (to > from) {
      const mark = doc.createElement("mark");
      mark.textContent = value.slice(from, to);
      parent.append(mark);
    }
    cursor = Math.max(cursor, to);
  }
  if (cursor < value.length) parent.append(doc.createTextNode(value.slice(cursor)));
}

function isPrompt(msg) {
  if (!msg || typeof msg.body !== "string" || !msg.body.trim()) return false;
  return msg.role !== "assistant" && msg.role !== "system" && msg.role !== "tool";
}

/**
 * Page order, top to bottom. An earlier user prompt replaces the stored one
 * when it is still on the page, or when this page starts at that prompt
 * (the previous prompt has scrolled off and this view includes the top).
 * A later window that does not include the stored prompt keeps it.
 */
export function nextPreviewFields(conv, messages, pageMessageIds) {
  const next = {
    firstUserMessageId: conv?.firstUserMessageId || "",
    firstUserPreview: conv?.firstUserPreview || "",
    lastPreview: conv?.lastPreview || "",
    lastPreviewRole: conv?.lastPreviewRole || "",
  };
  const byId = new Map();
  for (const msg of messages || []) {
    if (msg?.id) byId.set(msg.id, msg);
  }
  const order = Array.isArray(pageMessageIds) && pageMessageIds.length
    ? pageMessageIds
    : (messages || []).map((msg) => msg?.id).filter(Boolean);

  if (next.firstUserMessageId && byId.has(next.firstUserMessageId)) {
    const current = byId.get(next.firstUserMessageId);
    if (isPrompt(current)) next.firstUserPreview = clipPreviewText(current.body);
  }

  let earliest = null;
  let earliestIdx = -1;
  for (let i = 0; i < order.length; i++) {
    const msg = byId.get(order[i]);
    if (!isPrompt(msg)) continue;
    earliest = msg;
    earliestIdx = i;
    break;
  }
  if (earliest) {
    const prevIdx = next.firstUserMessageId ? order.indexOf(next.firstUserMessageId) : -1;
    const replace = !next.firstUserPreview ||
      (prevIdx >= 0 && earliestIdx < prevIdx) ||
      (prevIdx < 0 && earliestIdx === 0);
    if (replace) {
      next.firstUserMessageId = earliest.id;
      next.firstUserPreview = clipPreviewText(earliest.body);
    }
  }

  const tailId = order.length ? order[order.length - 1] : "";
  const tail = tailId ? byId.get(tailId) : null;
  if (tail && typeof tail.body === "string" && tail.body.trim()) {
    next.lastPreview = clipPreviewText(tail.body);
    next.lastPreviewRole = tail.role === "assistant" ? "assistant" : "user";
  }
  return next;
}
