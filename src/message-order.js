/**
 * Page order for messages already stored on a conversation.
 * No schema change: messageOrder is a plain array of message ids.
 * The reader only reads it. Capture merges a newly visible window into it.
 */

export function mergeMessageOrder(stored, pageIds) {
  const page = [];
  const seenPage = new Set();
  for (const id of pageIds || []) {
    if (!id || seenPage.has(id)) continue;
    seenPage.add(id);
    page.push(id);
  }
  const prev = [];
  const seenPrev = new Set();
  for (const id of stored || []) {
    if (!id || seenPrev.has(id)) continue;
    seenPrev.add(id);
    prev.push(id);
  }
  if (!page.length) return prev;
  if (!prev.length) return page;

  const prevIndex = new Map(prev.map((id, index) => [id, index]));
  let anchorPage = -1;
  let anchorPrev = -1;
  for (let i = 0; i < page.length; i++) {
    if (prevIndex.has(page[i])) {
      anchorPage = i;
      anchorPrev = prevIndex.get(page[i]);
      break;
    }
  }
  if (anchorPage < 0) return prev.concat(page);

  const out = [];
  const placed = new Set();
  const push = (id) => {
    if (!id || placed.has(id)) return;
    placed.add(id);
    out.push(id);
  };
  for (let i = 0; i < anchorPrev; i++) push(prev[i]);
  for (const id of page) push(id);
  for (let i = anchorPrev + 1; i < prev.length; i++) push(prev[i]);
  return out;
}

function byCapture(a, b) {
  const ca = typeof a.capturedAt === "number" ? a.capturedAt : 0;
  const cb = typeof b.capturedAt === "number" ? b.capturedAt : 0;
  if (ca !== cb) return ca - cb;
  const ia = Number.isInteger(a.captureIndex) ? a.captureIndex : Number.POSITIVE_INFINITY;
  const ib = Number.isInteger(b.captureIndex) ? b.captureIndex : Number.POSITIVE_INFINITY;
  if (ia !== ib) return ia < ib ? -1 : 1;
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}

/**
 * Capture time (then page position, then id) for every message, then the
 * ids in messageOrder are put in their stored order inside the slots they
 * already hold. A pre-1.5.0 thread that was reopened at its newest turns
 * keeps its older turns in front instead of pushing them to the end.
 * Does not write.
 */
export function orderMessages(messages, messageOrder) {
  const base = (messages || []).filter((msg) => msg && msg.id).sort(byCapture);
  const rank = new Map((messageOrder || []).map((id, index) => [id, index]));
  if (!rank.size) return base;
  const ranked = base
    .filter((msg) => rank.has(msg.id))
    .sort((a, b) => rank.get(a.id) - rank.get(b.id));
  let next = 0;
  return base.map((msg) => (rank.has(msg.id) ? ranked[next++] : msg));
}
