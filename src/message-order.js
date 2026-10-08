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

/** Stored page order, then capture time, then id. Does not write. */
export function orderMessages(messages, messageOrder) {
  const list = (messages || []).filter((msg) => msg && msg.id);
  const rank = new Map((messageOrder || []).map((id, index) => [id, index]));
  return list.slice().sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : Number.POSITIVE_INFINITY;
    const rb = rank.has(b.id) ? rank.get(b.id) : Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    const ca = typeof a.capturedAt === "number" ? a.capturedAt : 0;
    const cb = typeof b.capturedAt === "number" ? b.capturedAt : 0;
    if (ca !== cb) return ca - cb;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  });
}
