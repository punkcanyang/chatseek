/**
 * Identity of a turn that survives a re-keyed message id.
 * Role plus the normalized body, compared in page order. Equal text sent
 * twice stays twice, because each copy keeps its own position. The comparison
 * uses the normalized text itself so two different sentences cannot collapse
 * through a hash collision.
 */

import { isProgressText } from "./image-progress.js";

export function canonicalRole(role) {
  return role === "user" ? "user" : "assistant";
}

/** Markdown markers and whitespace only. URLs stay, so a different link is a different turn. */
export function normalizeTurn(body) {
  return String(body || "")
    .replace(/[*_`#[\]()>~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function turnStamp(role, body) {
  const norm = normalizeTurn(body);
  if (!norm) return "";
  return `${canonicalRole(role)}\n${norm}`;
}

/** A wording change. Markdown-only and a shorter repaint are not. */
export function activityBodyChanged(prev, next) {
  const stored = normalizeTurn(prev);
  const page = normalizeTurn(next);
  if (!page || stored === page) return false;
  if (stored && stored.startsWith(page) && page.length < stored.length) return false;
  return true;
}

function growsTurn(storedBody, pageBody) {
  const stored = normalizeTurn(storedBody);
  const page = normalizeTurn(pageBody);
  if (!stored || !page || page.length <= stored.length) return false;
  return page.startsWith(stored);
}

function shrinksTurn(storedBody, pageBody) {
  const stored = normalizeTurn(storedBody);
  const page = normalizeTurn(pageBody);
  if (!stored || !page || page.length >= stored.length) return false;
  if (!stored.startsWith(page)) return false;
  return page.length >= 24 && page.length >= stored.length * 0.8;
}

/**
 * Map a page id onto the stored id of the same turn.
 * `page` items are this write only: { id, role, body, index } where index is
 * the position in the full page id list. Same-index growth or trim links a
 * streamed tail. A later bubble keeps its own id.
 */
export function alignRekeyedTurns(stored, page) {
  const rows = stored || [];
  const items = page || [];
  const n = rows.length;
  const m = items.length;
  const map = new Map();
  const usedS = new Set();
  const usedP = new Set();
  const stampS = rows.map((msg) => turnStamp(msg?.role, msg?.body));

  for (let j = 0; j < m; j++) {
    const item = items[j];
    if (!item?.id) continue;
    const hit = rows.findIndex((msg, i) => !usedS.has(i) && msg?.id === item.id);
    if (hit >= 0) {
      usedS.add(hit);
      usedP.add(j);
    }
  }

  let best = null;
  const bodyCount = items.filter((item) => item?.body).length;
  for (let d = 1 - m; d <= n - 1; d++) {
    const pairs = [];
    for (let j = 0; j < m; j++) {
      if (usedP.has(j)) continue;
      const item = items[j];
      const stamp = item?.body ? turnStamp(item.role, item.body) : "";
      if (!stamp || !item?.id) continue;
      const index = Number.isInteger(item.index) ? item.index : j;
      const i = index + d;
      if (i < 0 || i >= n || usedS.has(i)) continue;
      if (stampS[i] && stampS[i] === stamp) pairs.push([i, j]);
    }
    if (!pairs.length) continue;
    const coversTail = pairs.some(([i]) => i === n - 1);
    const score = pairs.length * 4 + (coversTail ? 2 : 0);
    if (!best || score > best.score || (score === best.score && d > best.d)) {
      best = { d, pairs, score, coversTail };
    }
    if (best && best.pairs.length === bodyCount && best.coversTail) break;
  }
  if (best) {
    for (const [i, j] of best.pairs) {
      usedS.add(i);
      usedP.add(j);
      const item = items[j];
      if (item.id !== rows[i].id) map.set(item.id, rows[i].id);
    }
  }

  for (let j = 0; j < m; j++) {
    if (usedP.has(j)) continue;
    const item = items[j];
    if (!item?.id || !item.body || map.has(item.id)) continue;
    const index = Number.isInteger(item.index) ? item.index : j;
    if (index < 0 || index >= n || usedS.has(index)) continue;
    if (!growsTurn(rows[index].body, item.body) && !shrinksTurn(rows[index].body, item.body)) {
      continue;
    }
    usedS.add(index);
    if (item.id !== rows[index].id) map.set(item.id, rows[index].id);
  }
  // Transition write. An older capture stored a live image-generation status
  // turn under its own hash id; the page now shows the next status line or the
  // settled turn under a fresh id. A window-local slot is not enough: both
  // rows must carry the same persisted turn identity. Otherwise preserve the
  // legacy row rather than overwrite a turn from a different window. A status
  // must never overwrite an unrelated stored user or legitimate short answer.
  for (let j = 0; j < m; j++) {
    if (usedP.has(j)) continue;
    const item = items[j];
    if (!item?.id || !item.body || map.has(item.id)) continue;
    const index = Number.isInteger(item.index) ? item.index : j;
    if (index < 0 || index >= n || usedS.has(index)) continue;
    const row = rows[index];
    if (!row?.body) continue;
    if (typeof row.turnId !== "string" || !row.turnId || row.turnId !== item.turnId) continue;
    if (row.role !== "assistant" || !Number.isInteger(row.captureIndex) ||
        row.captureIndex !== index) continue;
    if (canonicalRole(row.role) !== canonicalRole(item.role)) continue;
    if (!isProgressText(row.body)) continue;
    usedS.add(index);
    usedP.add(j);
    if (item.id !== row.id) map.set(item.id, row.id);
  }
  return map;
}

/**
 * A stored transcript that is the same turns repeated, while the page shows
 * one copy. Returns pairs to drop: the extra row, and the copy that stays.
 * One repeated sentence is not a clone of a whole transcript (length < 2).
 * A page that itself shows both copies is not collapsed.
 */
export function planCloneDrops(stored, pageIds, pageMessages) {
  const empty = [];
  const ids = (pageIds || []).filter(Boolean);
  const L = ids.length;
  const rows = stored || [];
  if (L < 2 || rows.length < L * 2 || rows.length % L !== 0) return empty;
  const copies = rows.length / L;
  if (copies < 2 || copies > 8) return empty;
  const keys = rows.map((msg) => turnStamp(msg?.role, msg?.body));
  if (keys.some((key) => !key)) return empty;
  for (let c = 1; c < copies; c++) {
    for (let i = 0; i < L; i++) {
      if (keys[i] !== keys[c * L + i]) return empty;
    }
  }
  const byId = new Map();
  for (const msg of pageMessages || []) {
    if (msg?.id) byId.set(msg.id, msg);
  }
  let checked = 0;
  for (let i = 0; i < L; i++) {
    const msg = byId.get(ids[i]);
    if (!msg?.body) continue;
    checked += 1;
    if (turnStamp(msg.role, msg.body) !== keys[i]) return empty;
  }
  if (!checked) return empty;

  const blocks = [];
  for (let c = 0; c < copies; c++) {
    blocks.push(rows.slice(c * L, (c + 1) * L).map((msg) => msg.id));
  }
  let keep = copies - 1;
  for (let c = 0; c < copies; c++) {
    if (ids.some((id) => blocks[c].includes(id))) {
      keep = c;
      break;
    }
  }
  const moves = [];
  for (let c = 0; c < copies; c++) {
    if (c === keep) continue;
    for (let i = 0; i < L; i++) {
      if (blocks[c][i] && blocks[c][i] !== blocks[keep][i]) {
        moves.push({ from: blocks[c][i], to: blocks[keep][i] });
      }
    }
  }
  return moves;
}
