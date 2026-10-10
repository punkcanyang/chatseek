import { markdownToPlain } from "./markdown.js";
import { queryTokens } from "./tokenize.js";
import { asSearchQuery, syntaxRanges, searchProjection, literalRanges } from "./search-query.js";

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
  const first = presentPreview(conv?.firstUserPreview);
  if (first) return { kind: "first-user", text: clipPreviewText(first) };
  const last = presentPreview(conv?.lastPreview);
  if (last) return { kind: "last", text: clipPreviewText(last) };
  return { kind: "title-only", text: "" };
}

export function flattenPreview(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

/**
 * Side-panel text. Markdown markers are removed at display time; the stored
 * excerpt stays source text. Excerpts saved before 1.5.1 were flattened to one
 * line, so block markers there no longer sit at a line start and the parser
 * cannot see them; the one-line cleanup below takes the unambiguous ones out.
 */
export function presentPreview(text) {
  const source = String(text || "");
  const plain = flattenPreview(markdownToPlain(source));
  return source.includes("\n") ? plain : stripFlatMarkers(plain);
}

function stripFlatMarkers(text) {
  return flattenPreview(
    text
      .replace(/`{3,}/g, " ")
      .replace(/(^|\s)\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*\|?)?(?=\s|$)/g, "$1")
      .replace(/(^|\s)\|(?=\s|$)/g, "$1")
      .replace(/(^|\s)#{1,6}(?=\s)/g, "$1")
      .replace(/(^|\s)(?:-{3,}|\*{3,}|_{3,})(?=\s|$)/g, "$1"),
  );
}

export function clipPreviewText(text, max = PREVIEW_STORE_CHARS) {
  const flat = flattenPreview(text);
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max).trimEnd()}…`;
}

/**
 * Stored excerpt: same length cap as the shown text, but line breaks stay so
 * headings, lists, fences, and tables can still be recognised when shown.
 */
export function clipPreviewSource(text, max = PREVIEW_STORE_CHARS) {
  const kept = String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (kept.length <= max) return kept;
  return `${kept.slice(0, max).trimEnd()}…`;
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

function isWordTerm(term) {
  return !CJK.test(term) && /^[A-Za-z0-9]+$/.test(term);
}

export function findMatchRanges(text, terms) {
  const hay = String(text || "");
  const ranges = [];
  for (const term of terms || []) {
    if (!term) continue;
    for (const range of literalRanges(hay, term, isWordTerm(term))) ranges.push(range);
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
function collapseSyntaxRanges(source, ranges) {
  const map = new Array(source.length).fill(-1);
  const pieces = [];
  let size = 0;
  for (const match of source.matchAll(/\S+/g)) {
    if (pieces.length) { pieces.push(" "); size++; }
    pieces.push(match[0]);
    for (let i = 0; i < match[0].length; i++) map[match.index + i] = size + i;
    size += match[0].length;
  }
  return { text: pieces.join(""), ranges: ranges.flatMap(([start, end]) => {
    while (start < end && map[start] < 0) start++;
    while (end > start && map[end - 1] < 0) end--;
    return end > start ? [[map[start], map[end - 1] + 1]] : [];
  }) };
}

export function snippetAround(text, terms, { before = 28, after = 120, maxLen = 180 } = {}) {
  const parsed = Array.isArray(terms) ? null : asSearchQuery(terms);
  const wanted = parsed?.mode === "syntax" ? parsed : Array.isArray(terms) ? terms : highlightTerms(parsed.raw);
  const source = String(text || "");
  const collapsed = parsed?.mode === "syntax" ? collapseSyntaxRanges(source, syntaxRanges(source, parsed)) : null;
  const flat = collapsed?.text ?? flattenPreview(source);
  const found = collapsed?.ranges ?? findMatchRanges(flat, wanted);
  if (!found.length) return null;
  const anchorStart = found[0][0];
  const anchorEnd = found[0][1];
  let start = Math.max(0, anchorStart - before);
  let end = Math.min(flat.length, anchorEnd + after);
  const matchLen = anchorEnd - anchorStart;
  if (parsed?.mode === "syntax") maxLen = Math.max(maxLen, matchLen);
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
  // Clip the original ranges: re-matching a cut word would invent wildcard hits.
  const local = found.filter(([from, to]) => to > start && from < end)
    .map(([from, to]) => [Math.max(from, start) - start + lead.length, Math.min(to, end) - start + lead.length]);
  return {
    text: `${lead}${slice}${suffix ? "…" : ""}`,
    ranges: local,
  };
}

export function bestSnippet(bodies, terms, options) {
  const parsed = Array.isArray(terms) ? null : asSearchQuery(terms);
  const wanted = parsed?.mode === "syntax" ? parsed : highlightTerms(Array.isArray(terms) ? terms.join(" ") : parsed.raw);
  if (Array.isArray(wanted) && !wanted.length) return null;
  let best = null;
  let bestScore = -1;
  for (const body of bodies || []) {
    const flat = wanted?.mode === "syntax" ? searchProjection(body).text : presentPreview(body);
    const ranges = wanted?.mode === "syntax" ? syntaxRanges(flat, wanted) : findMatchRanges(flat, wanted);
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
  const parsed = asSearchQuery(query);
  const terms = parsed.mode === "syntax" ? parsed : highlightTerms(parsed.raw);
  const searching = parsed.raw.length > 0;
  const title = String(conv?.title || "");
  const titleRanges = parsed.mode === "syntax" ? syntaxRanges(title, parsed, "title") : findMatchRanges(title, terms);
  if (searching) {
    const snip = bestSnippet(bodies, terms);
    if (snip) {
      return { kind: "snippet", text: snip.text, ranges: snip.ranges, titleRanges };
    }
  }
  const idle = selectIdlePreview(conv);
  if (idle.kind === "title-only") {
    // Messages are stored but no excerpt could be read: not "title only".
    const kind = Number(conv?.messageCount) > 0 ? "none" : "title-only";
    return { kind, text: "", ranges: [], titleRanges };
  }
  // Stored idle excerpts already fold whitespace and may be clipped. Only
  // full source bodies can prove an exact syntax match.
  if (searching && parsed.mode !== "syntax") {
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
 * when both are on the page. When the stored prompt is not on the page, the
 * page's top prompt replaces it only if that prompt was never stored before
 * (an edited first prompt, or older history that just loaded). Gemini reopens
 * a long thread at its latest turns; those were stored on an earlier visit,
 * so that window keeps the real first prompt. A legacy excerpt with no
 * message id was guessed from index order and yields to any page.
 * freshIds: ids this write inserts for the first time; omitted means all.
 */
export function nextPreviewFields(conv, messages, pageMessageIds, { freshIds } = {}) {
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
    if (isPrompt(current)) next.firstUserPreview = clipPreviewSource(current.body);
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
    const fresh = freshIds == null || freshIds.has(earliest.id);
    const replace = !next.firstUserPreview ||
      !next.firstUserMessageId ||
      (prevIdx >= 0 && earliestIdx < prevIdx) ||
      (prevIdx < 0 && earliestIdx === 0 && fresh);
    if (replace) {
      next.firstUserMessageId = earliest.id;
      next.firstUserPreview = clipPreviewSource(earliest.body);
    }
  }

  const tailId = order.length ? order[order.length - 1] : "";
  const tail = tailId ? byId.get(tailId) : null;
  if (tail && typeof tail.body === "string" && tail.body.trim()) {
    next.lastPreview = clipPreviewSource(tail.body);
    next.lastPreviewRole = tail.role === "assistant" ? "assistant" : "user";
  }
  return next;
}
