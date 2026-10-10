/** Shared, bounded search syntax. User input never becomes a RegExp. */
import { queryTokens, tokenSpans, tokenize, titleContainsQuery } from "./tokenize.js";
import { parseMarkdown } from "./markdown.js";

export const QUERY_LIMITS = { chars: 4096, clauses: 32, globChars: 128 };
const normalize = (value) => String(value || "").toLowerCase().normalize("NFKC");
const WORDS = /[a-z0-9]+|[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af\u3005]+/g;
const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });

export function parseSearchQuery(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  const plain = { mode: "plain", raw, clauses: [] };
  if (!raw || raw.length > QUERY_LIMITS.chars) return plain;
  const clauses = [];
  const ordinary = [];
  let syntax = false;
  let i = 0;
  while (i < raw.length) {
    while (/\s/.test(raw[i] || "") && i < raw.length) i++;
    if (i >= raw.length) break;
    let exclude = false;
    let field = "any";
    if (raw[i] === "-") { exclude = true; syntax = true; i++; }
    if (raw.slice(i, i + 6).toLowerCase() === "title:") {
      field = "title"; syntax = true; i += 6;
    }
    let value;
    let kind = "words";
    if (raw[i] === '"') {
      syntax = true; kind = "phrase";
      const end = raw.indexOf('"', i + 1);
      if (end < 0) return plain;
      value = raw.slice(i + 1, end);
      i = end + 1;
      if (i < raw.length && !/\s/.test(raw[i])) return plain;
    } else {
      const start = i;
      while (i < raw.length && !/\s/.test(raw[i])) i++;
      value = raw.slice(start, i);
      if (value.includes('"') || value.startsWith("-")) return plain;
      if (value.includes("*")) { syntax = true; kind = "glob"; }
    }
    if (!value?.trim() || (kind === "glob" && (!value.replaceAll("*", "") || value.length > QUERY_LIMITS.globChars))) return plain;
    if (kind === "words" && !exclude && field === "any") ordinary.push(value);
    else clauses.push({ kind, value, normalized: normalize(value), field, exclude, tokens: queryTokens(value) });
    if (clauses.length + ordinary.length > QUERY_LIMITS.clauses) return plain;
  }
  if (!syntax) return plain;
  // Apply the existing stopword policy to ordinary words as a group.
  if (ordinary.length) {
    const value = ordinary.join(" ");
    clauses.unshift({ kind: "words", value, normalized: normalize(value), field: "any", exclude: false, tokens: queryTokens(value) });
  }
  if (!clauses.some((clause) => !clause.exclude)) return plain;
  return { mode: "syntax", raw, clauses };
}

export function asSearchQuery(query) {
  return query?.mode === "syntax" || query?.mode === "plain" ? query : parseSearchQuery(query);
}

/** Ordered literal pieces, with anchored edges. Each search moves forward;
 * no backtracking, recursion, regex construction, or wildcard expansion. */
export function globMatches(word, pattern) {
  const parts = pattern.split("*");
  if (parts.length === 1) return word === pattern;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!word.startsWith(first) || !word.endsWith(last)) return false;
  let cursor = first.length;
  const end = word.length - last.length;
  for (let i = 1; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!part) continue;
    const at = word.indexOf(part, cursor);
    if (at < 0 || at + part.length > end) return false;
    cursor = at + part.length;
  }
  return cursor <= end;
}

function normalizedMap(text) {
  if (/^[\x00-\x7f]*$/.test(text)) return { text: text.toLowerCase() };
  const normalizedText = normalize(text);
  if (normalizedText.length === text.length && !/\p{M}/u.test(text)
      && /^[\x00-\x7f\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af\u3005]*$/.test(text)) {
    return { text: normalizedText };
  }
  // Keep offsets through NFKC expansion (e.g. fullwidth letters / ligatures).
  const starts = [], ends = [];
  for (const match of graphemes.segment(text)) {
    const normalized = normalize(match.segment);
    for (let i = 0; i < normalized.length; i++) {
      starts.push(match.index); ends.push(match.index + match.segment.length);
    }
  }
  // Whole-string case conversion also handles contextual forms (Greek sigma).
  return { text: normalizedText, starts, ends };
}

/** Literal lookup also serves malformed/overlong legacy queries. It never
 * compiles user text, so fallback cannot hit a regex engine size limit. */
export function literalRanges(text, value, wholeWord = false) {
  const mapped = normalizedMap(String(text || ""));
  const needle = normalize(value);
  const ranges = [];
  if (!needle) return ranges;
  const hay = mapped.text;
  for (let at = hay.indexOf(needle); at >= 0;) {
    const end = at + needle.length;
    const matched = !wholeWord || (!/[a-z0-9]/.test(hay[at - 1] || "") && !/[a-z0-9]/.test(hay[end] || ""));
    if (matched) ranges.push([mapped.starts?.[at] ?? at, mapped.ends?.[end - 1] ?? end]);
    at = hay.indexOf(needle, at + (matched ? needle.length : 1));
  }
  return ranges;
}

export function clauseRanges(text, clause) {
  const mapped = normalizedMap(String(text || ""));
  const hay = mapped.text;
  const ranges = [];
  const add = (start, end) => {
    if (end > start) ranges.push([mapped.starts?.[start] ?? start, mapped.ends?.[end - 1] ?? end]);
  };
  if (clause.kind === "glob") {
    for (const match of hay.matchAll(WORDS)) {
      if (globMatches(match[0], clause.normalized)) add(match.index, match.index + match[0].length);
    }
  } else if (clause.kind === "phrase") {
    const needle = clause.normalized;
    for (let at = hay.indexOf(needle); needle && at >= 0; at = hay.indexOf(needle, at + Math.max(1, needle.length))) {
      add(at, at + needle.length);
    }
  } else {
    const tokens = new Set(clause.tokens);
    for (const span of tokenSpans(hay)) {
      if (tokens.has(span.token)) add(span.start, span.start + span.token.length);
    }
    if (!tokens.size && clause.normalized) {
      for (let at = hay.indexOf(clause.normalized); at >= 0; at = hay.indexOf(clause.normalized, at + clause.normalized.length)) {
        add(at, at + clause.normalized.length);
      }
    }
  }
  return mergeQueryRanges(ranges);
}

export function clauseMatchesText(text, clause) {
  if (clause.kind !== "words") return clauseRanges(text, clause).length > 0;
  if (titleContainsQuery(text, clause.value)) return true;
  const tokens = new Set(tokenize(text));
  return clause.tokens.length > 0 && clause.tokens.every((token) => tokens.has(token));
}

export function mergeQueryRanges(ranges) {
  const out = [];
  for (const range of ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = out[out.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else out.push([...range]);
  }
  return out;
}

/** Positive clauses only; title: never highlights message bodies. */
export function syntaxRanges(text, query, field = "body") {
  const parsed = asSearchQuery(query);
  return mergeQueryRanges(parsed.clauses
    .filter((clause) => !clause.exclude && (field === "title" || clause.field !== "title"))
    .flatMap((clause) => clauseRanges(text, clause)));
}

/** Visible Markdown characters and their original offsets. Destinations and
 * fences are omitted just as in the index; separators prevent false joins. */
export function searchProjection(source, blocks) {
  const raw = String(source || "");
  if (!/[*_`#|[\]>]|https?:\/\//i.test(raw)) return { text: raw, map: null };
  const parts = [], map = [];
  const add = (value, start = -1, end = -1) => {
    parts.push(value);
    for (let i = 0; i < value.length; i++) map.push(start < 0 ? -1 : Math.min(end - 1, start + i));
  };
  const piece = (p) => { if (p?.text) add(p.text, p.start, p.end); };
  const inline = (nodes) => {
    for (const node of nodes || []) {
      if (node.type === "text" || node.type === "code") node.pieces?.forEach(piece);
      else if (node.type === "em" || node.type === "strong") inline(node.children);
      else if (node.type === "link" || node.type === "image") {
        if (!node.auto) inline(node.children);
        else add(" ");
      }
    }
  };
  const walk = (list) => {
    for (const block of list || []) {
      if (block.type === "heading" || block.type === "paragraph") inline(block.children);
      else if (block.type === "code") block.pieces.forEach(piece);
      else if (block.type === "quote") walk(block.blocks);
      else if (block.type === "list") block.items.forEach((item) => walk(item.blocks));
      else if (block.type === "table") {
        for (const cells of [block.header, ...block.rows]) {
          cells.forEach((cell, i) => { if (i) add(" "); inline(cell.children); });
          add("\n");
        }
      }
      add("\n");
    }
  };
  walk(blocks || parseMarkdown(raw));
  // Retain the old index's URL exclusion even for visible code samples.
  const text = parts.join("").replace(/https?:\/\/\S+/gi, (url) => " ".repeat(url.length));
  return { text, map };
}

export function syntaxBodyRanges(source, query, blocks) {
  const projected = searchProjection(source, blocks);
  const ranges = syntaxRanges(projected.text, query);
  if (!projected.map) return ranges;
  return ranges.flatMap(([start, end]) => {
    while (start < end && projected.map[start] < 0) start++;
    while (end > start && projected.map[end - 1] < 0) end--;
    return end > start ? [[projected.map[start], projected.map[end - 1] + 1]] : [];
  });
}
