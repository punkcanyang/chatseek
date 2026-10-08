/**
 * In-repo Markdown subset for the reader and side-panel previews.
 * Blocks and inlines keep source offsets so search hits can be painted on
 * the rendered text. Raw HTML is never a tag: it stays ordinary characters.
 * No network, no HTML serialization.
 */

const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

export function parseMarkdown(source) {
  const text = String(source ?? "");
  const lines = splitLines(text);
  return parseBlocks(lines, 0, lines.length).blocks;
}

/** Readable text for previews. Link destinations are dropped; markers are not shown. */
export function markdownToPlain(source) {
  return blocksToPlain(parseMarkdown(source)).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function isSafeHttpUrl(raw) {
  return Boolean(safeLinkHref(raw));
}

/** Normalized http(s) href, or "" when the value must stay plain text. */
export function safeLinkHref(raw) {
  const value = String(raw ?? "").trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return "";
  if (!/^https?:\/\//i.test(value)) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  return url.href;
}

function splitLines(source) {
  const lines = [];
  let i = 0;
  if (!source) return lines;
  while (i < source.length) {
    const nl = source.indexOf("\n", i);
    if (nl === -1) {
      let end = source.length;
      if (end > i && source[end - 1] === "\r") end -= 1;
      lines.push({ text: source.slice(i, end), start: i, end, nl: -1 });
      break;
    }
    let end = nl;
    if (end > i && source[end - 1] === "\r") end -= 1;
    lines.push({ text: source.slice(i, end), start: i, end, nl });
    i = nl + 1;
  }
  return lines;
}

function isBlank(line) {
  return !line || /^[ \t]*$/.test(line.text);
}

function matchFence(line) {
  const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line.text);
  if (!m) return null;
  return { indent: m[1].length, char: m[2][0], count: m[2].length, info: m[3] };
}

function matchAtx(line) {
  const m = /^( {0,3})(#{1,6})(?:[ \t]+(.*))?$/.exec(line.text);
  if (!m) return null;
  const hashes = m[2].length;
  let rel = m[1].length + hashes;
  let raw = "";
  if (m[3] != null) {
    const after = line.text.slice(rel);
    const lead = /^[ \t]+/.exec(after);
    rel += lead ? lead[0].length : 0;
    raw = line.text.slice(rel);
    raw = raw.replace(/[ \t]+#+[ \t]*$/, "");
    raw = raw.replace(/[ \t]+$/, "");
  }
  return { level: hashes, text: raw, start: line.start + rel };
}

function isHr(line) {
  return /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line.text);
}

function isSetextUnderline(line) {
  return /^ {0,3}(?:=+|-+)[ \t]*$/.test(line.text);
}

function matchList(line) {
  const m = /^( *)([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/.exec(line.text);
  if (!m || m[1].length >= 4) return null;
  const indent = m[1].length;
  const marker = m[2];
  const restRel = indent + marker.length + m[3].length;
  return {
    indent,
    marker,
    ordered: /^\d/.test(marker),
    order: /^\d/.test(marker) ? Number.parseInt(marker, 10) : 0,
    contentColumn: indent + marker.length + 1,
    rest: line.text.slice(restRel),
    restStart: line.start + restRel,
    restEnd: line.end,
  };
}

function isQuote(line) {
  return /^ {0,3}>/.test(line.text);
}

function splitTableCells(line) {
  const text = line.text;
  let start = 0;
  let end = text.length;
  while (text[start] === " ") start += 1;
  while (end > start && text[end - 1] === " ") end -= 1;
  if (end <= start) return [];
  let s = start;
  let e = end;
  if (text[s] === "|") s += 1;
  if (e > s && text[e - 1] === "|") e -= 1;
  const cells = [];
  let cellStart = s;
  for (let i = s; i < e; i += 1) {
    if (text[i] === "\\" && text[i + 1] === "|") {
      i += 1;
      continue;
    }
    if (text[i] === "|") {
      cells.push(trimCell(text, cellStart, i, line.start));
      cellStart = i + 1;
    }
  }
  cells.push(trimCell(text, cellStart, e, line.start));
  return cells;
}

function trimCell(text, a, b, base) {
  let s = a;
  let e = b;
  while (s < e && (text[s] === " " || text[s] === "\t")) s += 1;
  while (e > s && (text[e - 1] === " " || text[e - 1] === "\t")) e -= 1;
  return { text: text.slice(s, e), start: base + s, end: base + e };
}

function isDelimiterCells(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.text) && cell.text.includes("-"));
}

function isTableStart(lines, i) {
  if (!lines[i] || !lines[i + 1]) return false;
  if (!lines[i].text.includes("|")) return false;
  if (matchFence(lines[i]) || matchAtx(lines[i]) || matchList(lines[i])) return false;
  const header = splitTableCells(lines[i]);
  const delim = splitTableCells(lines[i + 1]);
  if (!header.length || header.length !== delim.length) return false;
  return isDelimiterCells(delim);
}

function interrupts(lines, i) {
  const line = lines[i];
  if (!line || isBlank(line)) return false;
  if (matchFence(line) || matchAtx(line) || isQuote(line) || matchList(line)) return true;
  if (isTableStart(lines, i)) return true;
  if (isHr(line) && !isSetextUnderline(line)) return true;
  return false;
}

function parseBlocks(lines, start, end) {
  const blocks = [];
  let i = start;
  while (i < end) {
    if (isBlank(lines[i])) {
      i += 1;
      continue;
    }
    const fence = matchFence(lines[i]);
    if (fence) {
      const parsed = parseFence(lines, i, end, fence);
      blocks.push(parsed.block);
      i = parsed.next;
      continue;
    }
    const atx = matchAtx(lines[i]);
    if (atx) {
      blocks.push({
        type: "heading",
        level: atx.level,
        children: inlineFromSlice(atx.text, atx.start),
        start: lines[i].start,
        end: lines[i].end,
      });
      i += 1;
      continue;
    }
    if (isHr(lines[i]) && !isSetextUnderline(lines[i])) {
      blocks.push({ type: "hr", start: lines[i].start, end: lines[i].end });
      i += 1;
      continue;
    }
    if (isHr(lines[i]) && isSetextUnderline(lines[i])) {
      blocks.push({ type: "hr", start: lines[i].start, end: lines[i].end });
      i += 1;
      continue;
    }
    if (isQuote(lines[i])) {
      const parsed = parseQuote(lines, i, end);
      blocks.push(parsed.block);
      i = parsed.next;
      continue;
    }
    const list = matchList(lines[i]);
    if (list) {
      const parsed = parseList(lines, i, end, list);
      blocks.push(parsed.block);
      i = parsed.next;
      continue;
    }
    if (isTableStart(lines, i)) {
      const parsed = parseTable(lines, i, end);
      blocks.push(parsed.block);
      i = parsed.next;
      continue;
    }
    const parsed = parseParagraph(lines, i, end);
    blocks.push(parsed.block);
    i = parsed.next;
  }
  return { blocks, next: i };
}

function parseFence(lines, i, end, open) {
  const content = [];
  let j = i + 1;
  let closedAt = -1;
  while (j < end) {
    const close = matchFence(lines[j]);
    if (close && close.char === open.char && close.count >= open.count && close.info.trim() === "") {
      closedAt = j;
      break;
    }
    content.push(lines[j]);
    j += 1;
  }
  const pieces = [];
  content.forEach((line, index) => {
    if (index > 0) {
      const nl = content[index - 1].nl;
      if (nl >= 0) pieces.push({ text: "\n", start: nl, end: nl + 1 });
      else pieces.push({ text: "\n", start: line.start, end: line.start });
    }
    if (line.text.length) pieces.push({ text: line.text, start: line.start, end: line.end });
  });
  const text = pieces.map((piece) => piece.text).join("");
  const last = closedAt >= 0 ? lines[closedAt] : content[content.length - 1] || lines[i];
  return {
    block: {
      type: "code",
      text,
      pieces,
      start: lines[i].start,
      end: last.end,
    },
    next: closedAt >= 0 ? closedAt + 1 : end,
  };
}

function parseQuote(lines, i, end) {
  const inner = [];
  const start = lines[i].start;
  while (i < end && isQuote(lines[i])) {
    const text = lines[i].text;
    const gt = text.indexOf(">");
    let rel = gt + 1;
    if (text[rel] === " " || text[rel] === "\t") rel += 1;
    inner.push({
      text: text.slice(rel),
      start: lines[i].start + rel,
      end: lines[i].end,
      nl: lines[i].nl,
    });
    i += 1;
  }
  const parsed = parseBlocks(inner, 0, inner.length);
  const endLine = inner[inner.length - 1];
  return {
    block: { type: "quote", blocks: parsed.blocks, start, end: endLine ? endLine.end : start },
    next: i,
  };
}

function dedentLine(line, columns) {
  let remove = 0;
  while (remove < columns && line.text[remove] === " ") remove += 1;
  return {
    text: line.text.slice(remove),
    start: line.start + remove,
    end: line.end,
    nl: line.nl,
  };
}

function parseList(lines, i, end, first) {
  const ordered = first.ordered;
  const markerIndent = first.indent;
  const items = [];
  while (i < end) {
    if (isBlank(lines[i])) {
      let j = i + 1;
      while (j < end && isBlank(lines[j])) j += 1;
      const peek = j < end ? matchList(lines[j]) : null;
      if (peek && peek.indent === markerIndent && peek.ordered === ordered) {
        i = j;
        continue;
      }
      break;
    }
    const item = matchList(lines[i]);
    if (!item || item.indent !== markerIndent || item.ordered !== ordered) break;
    const content = [{
      text: item.rest,
      start: item.restStart,
      end: item.restEnd,
      nl: lines[i].nl,
    }];
    const itemStart = lines[i].start;
    i += 1;
    while (i < end) {
      if (isBlank(lines[i])) {
        let j = i + 1;
        while (j < end && isBlank(lines[j])) j += 1;
        if (j >= end) break;
        const peek = matchList(lines[j]);
        if (peek && peek.indent <= markerIndent) break;
        const spaces = /^( *)/.exec(lines[j].text)[1].length;
        if (spaces >= item.contentColumn || isQuote(dedentLine(lines[j], item.contentColumn))) {
          content.push(lines[i]);
          i += 1;
          continue;
        }
        break;
      }
      const peek = matchList(lines[i]);
      if (peek && peek.indent === markerIndent && peek.ordered === ordered) break;
      if (peek && peek.indent < markerIndent) break;
      const spaces = /^( *)/.exec(lines[i].text)[1].length;
      if (spaces < item.contentColumn && peek && peek.indent < item.contentColumn) break;
      if (spaces < item.contentColumn && !peek) break;
      content.push(dedentLine(lines[i], item.contentColumn));
      i += 1;
    }
    const inner = parseBlocks(content, 0, content.length);
    const endLine = content[content.length - 1];
    items.push({
      blocks: inner.blocks,
      start: itemStart,
      end: endLine ? endLine.end : itemStart,
    });
  }
  const block = {
    type: "list",
    ordered,
    start: ordered ? first.order || 1 : 1,
    items,
    startOffset: items[0]?.start ?? first.restStart,
    end: items[items.length - 1]?.end ?? first.restEnd,
  };
  return { block, next: i };
}

function alignment(cell) {
  const token = cell.text;
  const left = token.startsWith(":");
  const right = token.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "";
}

function parseTable(lines, i, end) {
  const header = splitTableCells(lines[i]).map((cell) => ({
    children: inlineFromSlice(cell.text, cell.start),
    start: cell.start,
    end: cell.end,
  }));
  const delim = splitTableCells(lines[i + 1]);
  const align = delim.map(alignment);
  const rows = [];
  let j = i + 2;
  while (j < end && !isBlank(lines[j]) && lines[j].text.includes("|") && !matchFence(lines[j]) && !matchAtx(lines[j])) {
    const cells = splitTableCells(lines[j]).map((cell) => ({
      children: inlineFromSlice(cell.text, cell.start),
      start: cell.start,
      end: cell.end,
    }));
    while (cells.length < header.length) cells.push({ children: [], start: lines[j].end, end: lines[j].end });
    rows.push(cells);
    j += 1;
  }
  return {
    block: {
      type: "table",
      header,
      align,
      rows,
      start: lines[i].start,
      end: lines[j - 1].end,
    },
    next: j,
  };
}

function parseParagraph(lines, i, end) {
  const collected = [];
  while (i < end) {
    if (isBlank(lines[i])) break;
    if (collected.length && isSetextUnderline(lines[i])) break;
    if (collected.length && interrupts(lines, i)) break;
    collected.push(lines[i]);
    i += 1;
  }
  if (collected.length && i < end && isSetextUnderline(lines[i])) {
    const level = lines[i].text.trim().startsWith("-") ? 2 : 1;
    const children = inlineFromLines(collected);
    return {
      block: {
        type: "heading",
        level,
        children,
        start: collected[0].start,
        end: lines[i].end,
      },
      next: i + 1,
    };
  }
  return {
    block: {
      type: "paragraph",
      children: inlineFromLines(collected),
      start: collected[0].start,
      end: collected[collected.length - 1].end,
    },
    next: i,
  };
}

function inlineFromSlice(text, absStart) {
  const map = new Array(text.length);
  for (let i = 0; i < text.length; i += 1) map[i] = absStart + i;
  return parseInline(text, map, true);
}

function inlineFromLines(lines) {
  let local = "";
  const map = [];
  for (let li = 0; li < lines.length; li += 1) {
    if (li) {
      local += "\n";
      const nl = lines[li - 1].nl;
      map.push(nl >= 0 ? nl : lines[li].start);
    }
    const line = lines[li];
    for (let c = 0; c < line.text.length; c += 1) {
      local += line.text[c];
      map.push(line.start + c);
    }
  }
  return parseInline(local, map, true);
}

function isWhitespace(ch) {
  return ch === "" || ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

function isPunct(ch) {
  if (!ch) return false;
  return /[\p{P}\p{S}]/u.test(ch);
}

function isAlphaNum(ch) {
  if (!ch) return false;
  return /[\p{L}\p{N}]/u.test(ch);
}

function flanking(source, from, to) {
  const before = from > 0 ? source[from - 1] : "";
  const after = to < source.length ? source[to] : "";
  const left = !isWhitespace(after) && !(isPunct(after) && !isWhitespace(before) && !isPunct(before));
  const right = !isWhitespace(before) && !(isPunct(before) && !isWhitespace(after) && !isPunct(after));
  return { left, right };
}

function parseInline(source, map, allowLinks) {
  const tokens = [];
  let i = 0;
  const pushText = (from, to) => {
    if (to > from) tokens.push({ type: "text", from, to });
  };
  while (i < source.length) {
    const c = source[i];
    if (c === "\\" && i + 1 < source.length && ESCAPABLE.test(source[i + 1])) {
      pushText(i + 1, i + 2);
      i += 2;
      continue;
    }
    if (c === "`") {
      const span = readCodeSpan(source, i);
      if (span) {
        tokens.push(span.token);
        i = span.next;
        continue;
      }
    }
    if (c === "!" && source[i + 1] === "[") {
      const image = readLinkOrImage(source, map, i + 1, true);
      if (image) {
        tokens.push(image.token);
        i = image.next;
        continue;
      }
    }
    if (allowLinks && c === "[") {
      const link = readLinkOrImage(source, map, i, false);
      if (link) {
        tokens.push(link.token);
        i = link.next;
        continue;
      }
    }
    if (c === "<") {
      const auto = readAutolink(source, i);
      if (auto) {
        tokens.push(auto.token);
        i = auto.next;
        continue;
      }
    }
    if ((c === "h" || c === "H") && looksLikeUrl(source, i)) {
      const url = readBareUrl(source, i);
      if (url) {
        tokens.push(url.token);
        i = url.next;
        continue;
      }
    }
    if (c === "*" || c === "_") {
      let j = i + 1;
      while (j < source.length && source[j] === c) j += 1;
      const { left, right } = flanking(source, i, j);
      let canOpen = left;
      let canClose = right;
      if (c === "_") {
        if (isAlphaNum(source[i - 1] || "")) canOpen = false;
        if (isAlphaNum(source[j] || "")) canClose = false;
      }
      tokens.push({
        type: "delim",
        char: c,
        from: i,
        to: j,
        canOpen,
        canClose,
      });
      i = j;
      continue;
    }
    let j = i + 1;
    while (j < source.length && !isInlineBoundary(source, j, allowLinks)) j += 1;
    pushText(i, j);
    i = j;
  }
  return tokensToNodes(tokens, source, map);
}

function isInlineBoundary(source, i, allowLinks) {
  const c = source[i];
  if (c === "\\" || c === "`" || c === "*" || c === "_" || c === "<") return true;
  if (c === "!" && source[i + 1] === "[") return true;
  if (allowLinks && c === "[") return true;
  if ((c === "h" || c === "H") && looksLikeUrl(source, i)) return true;
  return false;
}

function looksLikeUrl(source, i) {
  if (!/^https?:\/\//i.test(source.slice(i, i + 8))) return false;
  const prev = i > 0 ? source[i - 1] : "";
  return !isAlphaNum(prev) && prev !== "@";
}

function readCodeSpan(source, i) {
  let n = 0;
  while (source[i + n] === "`") n += 1;
  let j = i + n;
  while (j < source.length) {
    if (source[j] !== "`") {
      j += 1;
      continue;
    }
    let m = 0;
    while (source[j + m] === "`") m += 1;
    if (m === n) {
      const rawFrom = i + n;
      const rawTo = j;
      let from = rawFrom;
      let to = rawTo;
      let raw = source.slice(rawFrom, rawTo).replaceAll("\n", " ");
      if (raw.length >= 2 && raw.startsWith(" ") && raw.endsWith(" ") && raw.trim() !== "") {
        raw = raw.slice(1, -1);
        from += 1;
        to -= 1;
      }
      const pieces = codePieces(source, from, to, raw);
      return {
        token: { type: "code", text: raw, pieces, from: rawFrom, to: rawTo },
        next: j + n,
      };
    }
    j += m;
  }
  return null;
}

function codePieces(source, from, to, rendered) {
  if (source.slice(from, to) === rendered) {
    return [{ text: rendered, startFrom: from, startTo: to }];
  }
  const pieces = [];
  let local = "";
  for (let i = from; i < to; i += 1) {
    const ch = source[i] === "\n" ? " " : source[i];
    local += ch;
    pieces.push({ text: ch, startFrom: i, startTo: i + 1 });
  }
  if (rendered.length === local.length - 2 && local.startsWith(" ") && local.endsWith(" ")) {
    return pieces.slice(1, -1);
  }
  return [{ text: rendered, startFrom: from, startTo: to, loose: true }];
}

function readAutolink(source, i) {
  if (source[i] !== "<") return null;
  const end = source.indexOf(">", i + 1);
  if (end < 0 || end - i > 2048) return null;
  const inner = source.slice(i + 1, end);
  if (!/^https?:\/\/[^\s<>]+$/i.test(inner)) return null;
  return {
    token: {
      type: "link",
      auto: true,
      children: [],
      url: inner,
      urlFrom: i + 1,
      urlTo: end,
      from: i,
      to: end + 1,
    },
    next: end + 1,
  };
}

function readBareUrl(source, i) {
  const match = /^https?:\/\/[^\s<>"'`]+/i.exec(source.slice(i));
  if (!match) return null;
  let end = match[0].length;
  const raw = match[0];
  while (end > 0) {
    const ch = raw[end - 1];
    if (",.;:!?".includes(ch)) {
      end -= 1;
      continue;
    }
    if (ch === ")") {
      const body = raw.slice(0, end);
      const open = countChar(body, "(");
      const close = countChar(body, ")");
      if (close > open) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  if (end <= "https://".length) return null;
  const url = raw.slice(0, end);
  return {
    token: {
      type: "link",
      auto: true,
      children: [],
      url,
      urlFrom: i,
      urlTo: i + end,
      from: i,
      to: i + end,
    },
    next: i + end,
  };
}

function countChar(text, ch) {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) if (text[i] === ch) n += 1;
  return n;
}

function readLinkOrImage(source, map, i, image) {
  if (source[i] !== "[") return null;
  const labelEnd = findLabelEnd(source, i);
  if (labelEnd < 0 || source[labelEnd + 1] !== "(") return null;
  const dest = readDestination(source, labelEnd + 2);
  if (!dest) return null;
  const label = source.slice(i + 1, labelEnd);
  const labelMap = map.slice(i + 1, labelEnd);
  const children = parseInline(label, labelMap, false);
  const token = image
    ? {
      type: "image",
      children,
      url: source.slice(dest.from, dest.to),
      urlFrom: dest.from,
      urlTo: dest.to,
      from: i - 1,
      to: dest.next,
    }
    : {
      type: "link",
      auto: false,
      children,
      url: source.slice(dest.from, dest.to),
      urlFrom: dest.from,
      urlTo: dest.to,
      from: i,
      to: dest.next,
    };
  return { token, next: dest.next };
}

function findLabelEnd(source, i) {
  let depth = 1;
  let j = i + 1;
  while (j < source.length) {
    if (source[j] === "\\" && j + 1 < source.length) {
      j += 2;
      continue;
    }
    if (source[j] === "`") {
      const span = readCodeSpan(source, j);
      if (span) {
        j = span.next;
        continue;
      }
    }
    if (source[j] === "[") depth += 1;
    else if (source[j] === "]") {
      depth -= 1;
      if (depth === 0) return j;
    }
    j += 1;
  }
  return -1;
}

function readDestination(source, i) {
  while (source[i] === " " || source[i] === "\n" || source[i] === "\t") i += 1;
  if (i >= source.length) return null;
  let from;
  let to;
  if (source[i] === "<") {
    const end = source.indexOf(">", i + 1);
    if (end < 0) return null;
    from = i + 1;
    to = end;
    i = end + 1;
  } else {
    from = i;
    let depth = 0;
    while (i < source.length) {
      const c = source[i];
      if (c === "\\" && i + 1 < source.length) {
        i += 2;
        continue;
      }
      if (c === " " || c === "\n" || c === "\t") break;
      if (c === "(") depth += 1;
      else if (c === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
      i += 1;
    }
    to = i;
    if (to === from) return null;
  }
  while (source[i] === " " || source[i] === "\n" || source[i] === "\t") i += 1;
  if (source[i] === '"' || source[i] === "'" || source[i] === "(") {
    const quote = source[i] === "(" ? ")" : source[i];
    i += 1;
    while (i < source.length && source[i] !== quote) {
      if (source[i] === "\\" && i + 1 < source.length) i += 2;
      else i += 1;
    }
    if (source[i] !== quote) return null;
    i += 1;
    while (source[i] === " " || source[i] === "\n" || source[i] === "\t") i += 1;
  }
  if (source[i] !== ")") return null;
  return { from, to, next: i + 1 };
}

function tokensToNodes(tokens, source, map) {
  const opens = [];
  const matches = [];
  tokens.forEach((token, index) => {
    if (token.type !== "delim") return;
    token.index = index;
    token.remaining = token.to - token.from;
    token.liveFrom = token.from;
    token.liveTo = token.to;
    if (token.canClose) {
      while (token.remaining > 0) {
        let matched = false;
        for (let k = opens.length - 1; k >= 0; k -= 1) {
          const opener = opens[k];
          if (opener.char !== token.char || !opener.canOpen || opener.remaining <= 0 || token.remaining <= 0) continue;
          const openerBoth = opener.canOpen && opener.canClose;
          const closerBoth = token.canOpen && token.canClose;
          if (openerBoth || closerBoth) {
            const sum = opener.remaining + token.remaining;
            if (sum % 3 === 0 && (opener.remaining % 3 !== 0 || token.remaining % 3 !== 0)) continue;
          }
          const use = opener.remaining >= 2 && token.remaining >= 2 ? 2 : 1;
          const openFrom = opener.liveTo - use;
          const closeFrom = token.liveFrom;
          matches.push({
            style: use === 2 ? "strong" : "em",
            openFrom,
            openTo: openFrom + use,
            closeFrom,
            closeTo: closeFrom + use,
          });
          opener.liveTo = openFrom;
          opener.remaining -= use;
          token.liveFrom = closeFrom + use;
          token.remaining -= use;
          if (opener.remaining === 0) opens.splice(k, 1);
          matched = true;
          break;
        }
        if (!matched) break;
      }
    }
    if (token.canOpen && token.remaining > 0) opens.push(token);
  });

  const events = [];
  for (const token of tokens) {
    if (token.type === "delim") {
      const taken = matches
        .flatMap((match) => [[match.openFrom, match.openTo], [match.closeFrom, match.closeTo]])
        .filter(([from, to]) => from >= token.from && to <= token.to)
        .sort((a, b) => a[0] - b[0]);
      let cursor = token.from;
      for (const [from, to] of taken) {
        if (from > cursor) events.push({ pos: cursor, kind: "text", from: cursor, to: from });
        cursor = Math.max(cursor, to);
      }
      if (cursor < token.to) events.push({ pos: cursor, kind: "text", from: cursor, to: token.to });
      continue;
    }
    events.push({ pos: token.from, kind: "node", token });
  }
  for (const match of matches) {
    events.push({ pos: match.openFrom, kind: "open", style: match.style, to: match.openTo });
    events.push({ pos: match.closeFrom, kind: "close", style: match.style });
  }
  events.sort((a, b) => a.pos - b.pos || rank(a.kind) - rank(b.kind));

  const root = [];
  const stack = [{ children: root }];
  for (const event of events) {
    if (event.kind === "open") {
      const node = { type: event.style, children: [], start: mapAt(map, event.pos), end: mapAt(map, event.to - 1) + 1 };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else if (event.kind === "close") {
      const top = stack[stack.length - 1];
      if (stack.length > 1 && top.type === event.style) stack.pop();
    } else if (event.kind === "text") {
      pushTextNode(stack[stack.length - 1].children, source, map, event.from, event.to);
    } else if (event.token.type === "text") {
      pushTextNode(stack[stack.length - 1].children, source, map, event.token.from, event.token.to);
    } else if (event.token.type === "code") {
      stack[stack.length - 1].children.push(finishCode(event.token, map));
    } else {
      stack[stack.length - 1].children.push(finishLinkish(event.token, map));
    }
  }
  return root;
}

function rank(kind) {
  if (kind === "close") return 0;
  if (kind === "text" || kind === "node") return 1;
  return 2;
}

function mapAt(map, local) {
  if (!map.length) return local;
  if (local < 0) return map[0];
  if (local >= map.length) return map[map.length - 1] + (local - (map.length - 1));
  return map[local];
}

function pushTextNode(bucket, source, map, from, to) {
  const pieces = densePieces(source, map, from, to);
  if (!pieces.length) return;
  const last = bucket[bucket.length - 1];
  if (last && last.type === "text") last.pieces.push(...pieces);
  else bucket.push({ type: "text", pieces });
}

function densePieces(source, map, from, to) {
  const pieces = [];
  let run = from;
  for (let i = from + 1; i <= to; i += 1) {
    const split = i === to || mapAt(map, i) !== mapAt(map, i - 1) + 1;
    if (!split) continue;
    const text = source.slice(run, i);
    if (text) {
      pieces.push({ text, start: mapAt(map, run), end: mapAt(map, i - 1) + 1 });
    }
    run = i;
  }
  return pieces;
}

function finishCode(token, map) {
  const pieces = (token.pieces || []).map((piece) => {
    if (piece.loose) {
      return { text: piece.text, start: mapAt(map, piece.startFrom), end: mapAt(map, piece.startTo - 1) + 1, loose: true };
    }
    const localFrom = piece.startFrom;
    const localTo = piece.startTo;
    return {
      text: piece.text,
      start: mapAt(map, localFrom),
      end: mapAt(map, localTo - 1) + 1,
    };
  });
  return {
    type: "code",
    text: token.text,
    pieces,
    start: mapAt(map, token.from),
    end: mapAt(map, token.to - 1) + 1,
  };
}

function finishLinkish(token, map) {
  return {
    ...token,
    urlStart: mapAt(map, token.urlFrom),
    urlEnd: mapAt(map, Math.max(token.urlFrom, token.urlTo - 1)) + (token.urlTo > token.urlFrom ? 1 : 0),
    start: mapAt(map, token.from),
    end: mapAt(map, Math.max(token.from, token.to - 1)) + 1,
  };
}

function textOf(nodes) {
  let out = "";
  for (const node of nodes || []) {
    if (node.type === "text") out += node.pieces.map((piece) => piece.text).join("");
    else if (node.type === "em" || node.type === "strong") out += textOf(node.children);
    else if (node.type === "code") out += node.text;
    else if (node.type === "link") out += node.auto ? node.url : textOf(node.children);
    else if (node.type === "image") {
      const alt = textOf(node.children);
      out += alt ? `${alt} ${node.url}` : node.url;
    }
  }
  return out;
}

function blocksToPlain(blocks) {
  const parts = [];
  for (const block of blocks || []) {
    const text = blockToPlain(block);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

function blockToPlain(block) {
  if (!block) return "";
  if (block.type === "heading" || block.type === "paragraph") return textOf(block.children);
  if (block.type === "code") return block.text;
  if (block.type === "quote") return blocksToPlain(block.blocks);
  if (block.type === "list") return block.items.map((item) => blocksToPlain(item.blocks)).filter(Boolean).join("\n");
  if (block.type === "table") {
    const rowText = (cells) => cells.map((cell) => textOf(cell.children)).join(" ").trim();
    const lines = [rowText(block.header)];
    for (const row of block.rows) lines.push(rowText(row));
    return lines.filter(Boolean).join("\n");
  }
  return "";
}
