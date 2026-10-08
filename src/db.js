import { queryTokens, titleContainsQuery, tokenSpans, tokenize } from "./tokenize.js";
import { applySidebarEstimates, mergeActivityTime } from "./activity-time.js";
import {
  buildPreview,
  clipPreviewText,
  nextPreviewFields,
  snippetTokens,
} from "./preview.js";
import { mergeMessageOrder, orderMessages } from "./message-order.js";
import { compareConversations, RELEVANCE_WEIGHT, relevanceScore } from "./sort-list.js";

const DB_NAME = "chatseek";
const DB_VERSION = 3;

let dbPromise;

function requestDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("aborted"));
  });
}

function dropIfCurrent(db) {
  const pending = dbPromise;
  if (!pending) return;
  pending.then((current) => {
    if (current === db) dbPromise = null;
  }).catch(() => {
    dbPromise = null;
  });
}

export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        dbPromise = null;
        reject(err);
        return;
      }
      req.onerror = () => {
        dbPromise = null;
        reject(req.error || new Error("indexedDB open failed"));
      };
      req.onupgradeneeded = (event) => {
        const db = req.result;
        if (!db.objectStoreNames.contains("conversations")) {
          const conv = db.createObjectStore("conversations", { keyPath: "id" });
          conv.createIndex("updatedAt", "updatedAt");
          conv.createIndex("platform", "platform");
        }
        if (!db.objectStoreNames.contains("messages")) {
          const msg = db.createObjectStore("messages", { keyPath: "id" });
          msg.createIndex("conversationId", "conversationId");
        }
        // Inverted index: one row per (token, conversation, source).
        // Search opens a bounded cursor here — never getAll() on messages.
        if (!db.objectStoreNames.contains("tokenMap")) {
          db.createObjectStore("tokenMap", {
            keyPath: ["token", "conversationId", "source"],
          });
        }
        // Capture health and other small flags. Not part of search.
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: "key" });
        }
        // 1.4.0: archived is a plain field filtered in the cursor (booleans are
        // not IndexedDB keys, and 1.3.0 rows have no field). The token index
        // lets removing one conversation skip a full tokenMap scan.
        if (event.oldVersion < 3) {
          const tx = req.transaction;
          const tokens = tx.objectStore("tokenMap");
          if (!tokens.indexNames.contains("conversationId")) {
            tokens.createIndex("conversationId", "conversationId");
          }
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onclose = () => dropIfCurrent(db);
        db.onversionchange = () => {
          dropIfCurrent(db);
          try { db.close(); } catch { /* already closing */ }
        };
        resolve(db);
      };
    });
  }
  return dbPromise;
}

function isDeadConnection(err) {
  if (!err) return false;
  if (err.name === "InvalidStateError") return true;
  return /database connection is closed|connection is closing/i.test(
    String(err.message || err),
  );
}

/** One retry after Chrome drops the extension IDB connection. */
async function withDb(fn) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = await openDb();
    try {
      return await fn(db);
    } catch (err) {
      lastErr = err;
      if (!isDeadConnection(err)) throw err;
      dbPromise = null;
    }
  }
  throw lastErr;
}

function isGenericTitle(title) {
  const t = (title || "").trim();
  if (!t) return true;
  return /^(new chat|chatgpt|claude|grok|gemini|google gemini|untitled|无标题|新对话|新對話|新聊天)$/i.test(t);
}

// 2020-01-01; must match Chatseek.MIN_MS in content/shared.js.
const MIN_PAGE_MS = 1577836800000;

/** Plausible millisecond epoch from a page (rejects unix seconds). */
function isValidPageMs(ts) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return false;
  return ts >= MIN_PAGE_MS && ts <= Date.now() + 86400000 * 366;
}

function pageMs(value) {
  if (isValidPageMs(value)) return Math.floor(value);
  if (typeof value === "number" && value >= 1e9 && value < 1e11) {
    const ms = Math.floor(value * 1000);
    return isValidPageMs(ms) ? ms : null;
  }
  return null;
}

function writeTokens(tokenStore, text, conversationId, source, role) {
  const grouped = new Map();
  const cap = RELEVANCE_WEIGHT.POSITION_CAP;
  for (const span of tokenSpans(text)) {
    let positions = grouped.get(span.token);
    if (!positions) {
      positions = [];
      grouped.set(span.token, positions);
    }
    if (positions.length < cap) positions.push(span.start);
  }
  const storedRole = role === "user" || role === "title" ? role : "assistant";
  for (const [token, positions] of grouped) {
    tokenStore.put({ token, conversationId, source, role: storedRole, positions });
  }
}

function deleteTokens(tokenStore, tokens, conversationId, source) {
  for (const token of tokens) {
    tokenStore.delete([token, conversationId, source]);
  }
}

/**
 * archived true only when this observation explicitly says so.
 * archived false restores active (seen again outside an archive banner/list).
 * Omitted leaves the stored flag alone — leaving the sidebar is not a signal.
 */
function applyArchiveState(next, old, incoming, now) {
  if (incoming.archived === true) {
    const source = String(incoming.archiveSource || "explicit").slice(0, 80);
    const changed = old?.archived !== true || old?.archiveSource !== source;
    next.archived = true;
    next.archiveSource = source;
    next.archivedAt = !changed && isValidPageMs(old?.archivedAt) ? old.archivedAt : now;
    return;
  }
  if (incoming.archived === false) {
    next.archived = false;
    delete next.archiveSource;
    delete next.archivedAt;
    return;
  }
  if (old?.archived === true) {
    next.archived = true;
    if (old.archiveSource) next.archiveSource = old.archiveSource;
    if (isValidPageMs(old.archivedAt)) next.archivedAt = old.archivedAt;
  }
}

export function passesScope(conv, { platform = "", scope = "all" } = {}) {
  if (!conv) return false;
  if (platform && conv.platform !== platform) return false;
  if (scope === "active") return conv.archived !== true;
  if (scope === "archived") return conv.archived === true;
  return true;
}

export async function upsertConversations(list) {
  if (!list?.length) return;
  return withDb((db) => writeConversations(db, list));
}

const REMOVED_PREFIX = "removed:";

/**
 * reopened: the chat is open with messages on the page. Only that clears a
 * remove-from-index tombstone; sidebar and archive-list rescans skip it.
 */
async function writeConversations(db, list, { reopened = false } = {}) {
  const tx = db.transaction(["conversations", "tokenMap", "meta"], "readwrite");
  const convStore = tx.objectStore("conversations");
  const tokenStore = tx.objectStore("tokenMap");
  const metaStore = tx.objectStore("meta");
  const drafts = [];

  for (const incoming of list) {
    const old = await requestDone(convStore.get(incoming.id));
    if (!old) {
      const removedKey = REMOVED_PREFIX + incoming.id;
      if (await requestDone(metaStore.get(removedKey))) {
        if (!reopened) continue;
        metaStore.delete(removedKey);
      }
    }
    const incomingUpdated = pageMs(incoming.updatedAt);
    const incomingCreated = pageMs(incoming.createdAt);
    const now = Date.now();
    const merged = mergeActivityTime(old, {
      updatedAt: incomingUpdated,
      updatedAtSource: incoming.updatedAtSource,
    }, now);
    const firstSeenAt = isValidPageMs(old?.firstSeenAt)
      ? old.firstSeenAt
      : isValidPageMs(old?.createdAt)
        ? old.createdAt
        : now;

    const next = old ? { ...old } : {
      id: incoming.id,
      platform: incoming.platform,
      platformId: incoming.platformId,
      messageCount: 0,
    };
    next.platform = incoming.platform;
    next.platformId = incoming.platformId;
    next.url = incoming.url || next.url;
    if (!isGenericTitle(incoming.title) || isGenericTitle(next.title)) {
      next.title = (incoming.title || next.title || "").trim() || next.title;
    }
    if (!next.title) next.title = next.platformId;
    next.updatedAt = merged.updatedAt;
    next.updatedAtSource = merged.updatedAtSource;
    next.firstSeenAt = firstSeenAt;
    // createdAt from the page only when creating or still missing.
    if (!isValidPageMs(next.createdAt)) {
      next.createdAt = incomingCreated || firstSeenAt;
    }
    // Pre-1.0.2 builds could store a bogus 2001 date parsed from a title.
    if (!isValidPageMs(next.updatedAt)) next.updatedAt = now;
    next.sidebarIndex = Number.isInteger(incoming.sidebarIndex)
      ? incoming.sidebarIndex
      : null;
    drafts.push({ old, next, incoming });
  }

  const ordered = drafts
    .filter((row) => row.next.sidebarIndex != null)
    .sort((a, b) => a.next.sidebarIndex - b.next.sidebarIndex);
  if (ordered.length) {
    const estimated = applySidebarEstimates(
      ordered.map((row) => row.next),
      Date.now(),
    );
    estimated.forEach((row, index) => {
      ordered[index].next.updatedAt = row.updatedAt;
      ordered[index].next.updatedAtSource = row.updatedAtSource;
      if (isValidPageMs(row.olderThanAt)) ordered[index].next.olderThanAt = row.olderThanAt;
      else delete ordered[index].next.olderThanAt;
    });
  }

  for (const { old, next, incoming } of drafts) {
    delete next.sidebarIndex;
    if (next.updatedAtSource !== "sidebar-rank" || !isValidPageMs(next.olderThanAt)) {
      delete next.olderThanAt;
    }
    applyArchiveState(next, old, incoming, Date.now());
    const oldTitleTokens = tokenize(old?.title || "");
    if (old && old.title !== next.title) {
      deleteTokens(tokenStore, oldTitleTokens, next.id, "title");
    }
    if (!old || old.title !== next.title) {
      writeTokens(tokenStore, next.title, next.id, "title", "title");
    }
    convStore.put(next);
  }

  await txDone(tx);
}

/** Resolves { observed } — true when this write saw a new tail on a stored thread. */
export async function upsertMessages(conversation, messages, meta = {}) {
  if (!conversation?.id || !messages?.length) return { observed: false };
  // A one-row batch has no neighbours. Interpolating it alone would rewrite an
  // undated row's sidebar sort key as if it were the last row in the sidebar.
  const { sidebarIndex: _ignored, ...row } = conversation;
  await withDb((db) => writeConversations(db, [row], { reopened: true }));
  return withDb((db) => writeMessages(db, row, messages, meta));
}

/**
 * A new tail id (or a longer tail body) on a conversation that already had
 * messages is observed activity. The first ingest — including later chunks of
 * that same capture — is not: those messages were already on the page.
 */
function sawNewTail(baselineCount, baselineTail, pageMessageIds, tailBodyChanged) {
  if (!baselineCount || !baselineTail || !pageMessageIds?.length) return false;
  if (!pageMessageIds.includes(baselineTail)) return false;
  const pageTail = pageMessageIds[pageMessageIds.length - 1];
  if (pageTail !== baselineTail) return true;
  return !!tailBodyChanged;
}

async function writeMessages(db, conversation, messages, meta = {}) {
  const tx = db.transaction(
    ["conversations", "messages", "tokenMap"],
    "readwrite",
  );
  const convStore = tx.objectStore("conversations");
  const msgStore = tx.objectStore("messages");
  const tokenStore = tx.objectStore("tokenMap");

  const conv = await requestDone(convStore.get(conversation.id));
  let baselineCount = conv?.messageCount || 0;
  let baselineTail = conv?.tailMessageId || "";
  if (conv && meta.captureId && conv.captureToken !== meta.captureId) {
    conv.captureToken = meta.captureId;
    conv.captureBaselineCount = baselineCount;
    conv.captureBaselineTail = baselineTail;
  } else if (conv && meta.captureId && conv.captureToken === meta.captureId) {
    baselineCount = conv.captureBaselineCount ?? baselineCount;
    baselineTail = conv.captureBaselineTail || baselineTail;
  }

  let changed = 0;
  let tailBodyChanged = false;
  let observedNow = false;
  const freshIds = new Set();
  for (const msg of messages) {
    if (!msg?.id || typeof msg.body !== "string" || !msg.body) continue;
    const existing = await requestDone(msgStore.get(msg.id));
    if (!existing) freshIds.add(msg.id);
    if (existing && existing.body === msg.body) continue;

    if (existing) {
      deleteTokens(
        tokenStore,
        tokenize(existing.body),
        conversation.id,
        msg.id,
      );
    }
    if (msg.id === baselineTail) tailBodyChanged = true;
    const record = {
      id: msg.id,
      conversationId: conversation.id,
      role: msg.role === "assistant" ? "assistant" : "user",
      body: msg.body,
      capturedAt: Date.now(),
    };
    msgStore.put(record);
    writeTokens(
      tokenStore,
      msg.body,
      conversation.id,
      msg.id,
      record.role,
    );
    changed += 1;
  }

  if (conv && (changed || (meta.captureId && conv.captureToken === meta.captureId))) {
    const fields = nextPreviewFields(conv, messages, meta.pageMessageIds, { freshIds });
    if (fields.firstUserPreview) {
      conv.firstUserPreview = fields.firstUserPreview;
      conv.firstUserMessageId = fields.firstUserMessageId;
    }
    if (fields.lastPreview) {
      conv.lastPreview = fields.lastPreview;
      conv.lastPreviewRole = fields.lastPreviewRole;
    }
    const prevTitle = conv.title;
    if (!isGenericTitle(conversation.title)) conv.title = conversation.title;
    if (conversation.url) conv.url = conversation.url;
    const now = Date.now();
    const incomingUpdated = pageMs(conversation.updatedAt);
    if (changed) {
      const merged = mergeActivityTime(conv, {
        updatedAt: incomingUpdated,
        updatedAtSource: conversation.updatedAtSource,
      }, now);
      conv.updatedAt = merged.updatedAt;
      conv.updatedAtSource = merged.updatedAtSource;
      if (!isValidPageMs(conv.firstSeenAt)) conv.firstSeenAt = merged.firstSeenAt || now;
      const incomingCreated = pageMs(conversation.createdAt);
      if (incomingCreated && !isValidPageMs(conv.createdAt)) {
        conv.createdAt = incomingCreated;
      }
      const pageIds = Array.isArray(meta.pageMessageIds) ? meta.pageMessageIds : [];
      if (sawNewTail(baselineCount, baselineTail, pageIds, tailBodyChanged)) {
        const observed = mergeActivityTime(conv, {
          updatedAt: now,
          updatedAtSource: "observed",
        }, now);
        conv.updatedAt = observed.updatedAt;
        conv.updatedAtSource = observed.updatedAtSource;
        observedNow = observed.updatedAtSource === "observed";
      }
      if (pageIds.length) conv.tailMessageId = pageIds[pageIds.length - 1];
      conv.messageCount = await requestDone(
        msgStore.index("conversationId").count(conversation.id),
      );
    }
    if (prevTitle !== conv.title) {
      deleteTokens(tokenStore, tokenize(prevTitle), conv.id, "title");
      writeTokens(tokenStore, conv.title, conv.id, "title", "title");
    }
    if (conv.updatedAtSource !== "sidebar-rank" || !isValidPageMs(conv.olderThanAt)) {
      delete conv.olderThanAt;
    }
    const pageIds = Array.isArray(meta.pageMessageIds) && meta.pageMessageIds.length
      ? meta.pageMessageIds
      : messages.map((msg) => msg?.id).filter(Boolean);
    conv.messageOrder = mergeMessageOrder(conv.messageOrder, pageIds);
    convStore.put(conv);
  }

  await txDone(tx);
  return { observed: observedNow };
}

function cursorEach(indexOrStore, { range, direction } = {}, visit) {
  return new Promise((resolve, reject) => {
    const req = indexOrStore.openCursor(range || null, direction || "next");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      const stop = visit(cursor.value, cursor);
      if (stop) return resolve();
      cursor.continue();
    };
  });
}

async function collectConvIdsForToken(tokenStore, token) {
  const ids = new Set();
  const postings = [];
  // Compound key [token, conversationId, source]. Stay inside this token so
  // a shorter word does not match a longer one. Role and positions ride on
  // the same row; this cursor does not open the messages store.
  const range = IDBKeyRange.bound([token], [token, "\uffff", "\uffff"]);
  await cursorEach(tokenStore, { range }, (row) => {
    if (row.token === token) {
      ids.add(row.conversationId);
      postings.push(row);
    }
  });
  return { ids, postings };
}

function intersectSets(sets) {
  if (!sets.length) return new Set();
  sets.sort((a, b) => a.size - b.size);
  const out = new Set();
  for (const id of sets[0]) {
    let ok = true;
    for (let i = 1; i < sets.length; i++) {
      if (!sets[i].has(id)) {
        ok = false;
        break;
      }
    }
    if (ok) out.add(id);
  }
  return out;
}

/**
 * Full-text search over titles + message bodies.
 * Uses the token inverted index and conversation cursors.
 * Does not load the messages object store into an array.
 */
export async function searchConversations(options = {}) {
  const q = (options.query || "").trim();
  if (!q) {
    if (options.sort) return withDb((db) => listSortedOn(db, options));
    return listRecent(options);
  }
  return withDb((db) => searchOn(db, options));
}

async function searchOn(db, {
  query = "",
  platform = "",
  scope = "all",
  limit = 80,
  sort,
} = {}) {
  const q = query.trim();
  const tokens = queryTokens(q);

  const tx = db.transaction(["conversations", "tokenMap"], "readonly");
  const convStore = tx.objectStore("conversations");
  const tokenStore = tx.objectStore("tokenMap");

  const tokenSets = [];
  const postingsByConv = new Map();
  for (const token of tokens) {
    const found = await collectConvIdsForToken(tokenStore, token);
    tokenSets.push(found.ids);
    for (const row of found.postings) {
      let list = postingsByConv.get(row.conversationId);
      if (!list) {
        list = [];
        postingsByConv.set(row.conversationId, list);
      }
      list.push(row);
    }
  }
  const fromIndex = tokens.length ? intersectSets(tokenSets) : new Set();

  const needle = q.toLowerCase().normalize("NFKC");
  const fromTitle = new Set();
  await cursorEach(convStore, {}, (conv) => {
    if (!passesScope(conv, { platform, scope })) return;
    if (titleContainsQuery(conv.title, needle)) {
      fromTitle.add(conv.id);
    }
  });

  const ids = new Set([...fromIndex, ...fromTitle]);
  const matches = [];
  for (const id of ids) {
    const conv = await requestDone(convStore.get(id));
    if (!conv) continue;
    if (!passesScope(conv, { platform, scope })) continue;
    matches.push(conv);
  }
  if (sort?.field === "relevance") {
    for (const conv of matches) {
      conv.relevance = relevanceScore(conv, q, postingsByConv.get(conv.id) || []);
    }
  }
  if (sort?.field) {
    matches.sort((a, b) => compareConversations(a, b, sort));
  } else {
    matches.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  return matches.slice(0, limit);
}

/** Every in-scope conversation record, sorted, then limited. Does not open messages. */
async function listSortedOn(db, { platform = "", scope = "all", limit = 80, sort } = {}) {
  const tx = db.transaction("conversations", "readonly");
  const items = [];
  await cursorEach(tx.objectStore("conversations"), {}, (conv) => {
    if (!passesScope(conv, { platform, scope })) return;
    items.push(conv);
  });
  items.sort((a, b) => compareConversations(a, b, sort));
  return items.slice(0, limit);
}

export async function listRecent(options = {}) {
  return withDb((db) => listRecentOn(db, options));
}

async function listRecentOn(db, { platform = "", scope = "all", limit = 80 } = {}) {
  const tx = db.transaction("conversations", "readonly");
  const index = tx.objectStore("conversations").index("updatedAt");
  const items = [];
  await cursorEach(index, { direction: "prev" }, (conv) => {
    if (!passesScope(conv, { platform, scope })) return;
    items.push(conv);
    return items.length >= limit;
  });
  return items;
}

function needsPreviewBackfill(conv) {
  if (!conv || !(Number(conv.messageCount) > 0)) return false;
  return !conv.firstUserPreview && !conv.lastPreview;
}

/**
 * Legacy rows (saved before preview fields existed) get one bounded pass.
 * Index order is not page order; opening the thread again stores the real
 * first prompt. The cap keeps a large library off the messages table.
 */
async function backfillPreviews(convs) {
  if (!convs.length) return;
  await withDb(async (db) => {
    const tx = db.transaction(["conversations", "messages"], "readwrite");
    const convStore = tx.objectStore("conversations");
    const msgStore = tx.objectStore("messages");
    const index = msgStore.index("conversationId");
    for (const conv of convs) {
      if (!conv?.id) continue;
      const stored = await requestDone(convStore.get(conv.id));
      if (!stored || stored.firstUserPreview || stored.lastPreview) {
        if (stored?.firstUserPreview) conv.firstUserPreview = stored.firstUserPreview;
        if (stored?.lastPreview) conv.lastPreview = stored.lastPreview;
        continue;
      }
      let firstUser = "";
      let any = "";
      let seen = 0;
      await cursorEach(index, { range: IDBKeyRange.only(conv.id) }, (msg) => {
        seen += 1;
        if (!any && msg?.body) any = msg.body;
        if (msg?.role === "user" && msg.body) {
          firstUser = msg.body;
          return true;
        }
        return seen >= 40;
      });
      let last = "";
      if (stored.tailMessageId) {
        const tail = await requestDone(msgStore.get(stored.tailMessageId));
        if (tail?.body) last = tail.body;
      }
      if (!last) last = any;
      if (firstUser) {
        stored.firstUserPreview = clipPreviewText(firstUser);
        conv.firstUserPreview = stored.firstUserPreview;
      }
      if (last) {
        stored.lastPreview = clipPreviewText(last);
        conv.lastPreview = stored.lastPreview;
      }
      if (firstUser || last) convStore.put(stored);
    }
    await txDone(tx);
  });
}

async function loadSnippetBodies(list, query) {
  const tokens = snippetTokens(query);
  const bodies = new Map();
  if (!tokens.length || !list.length) return bodies;
  const capped = list.slice(0, 80);
  await withDb(async (db) => {
    const tx = db.transaction(["tokenMap", "messages"], "readonly");
    const tokenStore = tx.objectStore("tokenMap");
    const msgStore = tx.objectStore("messages");
    for (const conv of capped) {
      if (!conv?.id) continue;
      const ids = new Set();
      for (const token of tokens) {
        const range = IDBKeyRange.bound(
          [token, conv.id, ""],
          [token, conv.id, "\uffff"],
        );
        await cursorEach(tokenStore, { range }, (row) => {
          if (row?.token !== token || !row.source || row.source === "title") return;
          ids.add(row.source);
          return ids.size >= 3;
        });
        if (ids.size >= 3) break;
      }
      const found = [];
      for (const id of ids) {
        if (found.length >= 2) break;
        const msg = await requestDone(msgStore.get(id));
        if (msg?.body) found.push(msg.body);
      }
      if (found.length) bodies.set(conv.id, found);
    }
  });
  return bodies;
}

/**
 * Idle path uses preview fields already on the conversation.
 * Search fetches at most two matching message bodies per result via tokenMap,
 * never a messages getAll().
 */
export async function attachPreviews(conversations, query = "") {
  const list = Array.isArray(conversations) ? conversations : [];
  const q = String(query || "").trim();
  // Search can surface an old row that never reached the idle top 80.
  await backfillPreviews(list.filter(needsPreviewBackfill));
  const bodies = q ? await loadSnippetBodies(list, q) : new Map();
  return list.map((conv) => ({
    ...conv,
    preview: buildPreview(conv, q, bodies.get(conv?.id) || []),
  }));
}

/**
 * Read one conversation and its messages. Readonly: does not create rows,
 * does not clear a removed:<id> tombstone, and does not bump the schema.
 */
export async function readConversation(id) {
  if (typeof id !== "string" || !id) return null;
  return withDb(async (db) => {
    const tx = db.transaction(["conversations", "messages"], "readonly");
    const conv = await requestDone(tx.objectStore("conversations").get(id));
    if (!conv) return null;
    const messages = [];
    const index = tx.objectStore("messages").index("conversationId");
    await cursorEach(index, { range: IDBKeyRange.only(id) }, (msg) => {
      if (msg) messages.push(msg);
    });
    return {
      conversation: conv,
      messages: orderMessages(messages, conv.messageOrder),
    };
  });
}

export async function stats() {
  return withDb(async (db) => {
    const tx = db.transaction(["conversations", "messages"], "readonly");
    const conversations = await requestDone(tx.objectStore("conversations").count());
    const messages = await requestDone(tx.objectStore("messages").count());
    return { conversations, messages };
  });
}

export async function saveCaptureHealth(platform, health) {
  if (!platform || !health || typeof health !== "object") return;
  return withDb(async (db) => {
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put({
      key: `health:${platform}`,
      platform,
      at: typeof health.at === "number" ? health.at : Date.now(),
      pathKind: String(health.pathKind || "other").slice(0, 32),
      sidebarCount: Number(health.sidebarCount) || 0,
      messageCount: Number(health.messageCount) || 0,
      selector: String(health.selector || "none").slice(0, 120),
      warn: !!health.warn,
    });
    await txDone(tx);
  });
}

export async function readCaptureHealth() {
  return withDb(async (db) => {
    if (!db.objectStoreNames.contains("meta")) return {};
    const tx = db.transaction("meta", "readonly");
    const out = {};
    await cursorEach(tx.objectStore("meta"), {}, (row) => {
      if (row?.key?.startsWith?.("health:") && row.platform) out[row.platform] = row;
    });
    return out;
  });
}

/**
 * Deletes one conversation, its messages, and its inverted-index rows.
 * Does not message the page. A tombstone in meta keeps sidebar rescans from
 * adding it back; opening the chat with messages on screen captures it again.
 */
export async function removeConversation(id) {
  if (typeof id !== "string" || !id) return;
  return withDb(async (db) => {
    const tx = db.transaction(["conversations", "messages", "tokenMap", "meta"], "readwrite");
    tx.objectStore("conversations").delete(id);
    tx.objectStore("meta").put({ key: REMOVED_PREFIX + id, removedAt: Date.now() });
    const messages = tx.objectStore("messages").index("conversationId");
    await cursorEach(messages, { range: IDBKeyRange.only(id) }, (_row, cursor) => {
      cursor.delete();
    });
    const tokenStore = tx.objectStore("tokenMap");
    const tokenIndex = tokenStore.indexNames.contains("conversationId")
      ? tokenStore.index("conversationId")
      : null;
    if (tokenIndex) {
      await cursorEach(tokenIndex, { range: IDBKeyRange.only(id) }, (_row, cursor) => {
        cursor.delete();
      });
    } else {
      await cursorEach(tokenStore, {}, (row, cursor) => {
        if (row?.conversationId === id) cursor.delete();
      });
    }
    await txDone(tx);
  });
}

export async function clearAll() {
  return withDb(async (db) => {
    const tx = db.transaction(
      ["conversations", "messages", "tokenMap", "meta"],
      "readwrite",
    );
    tx.objectStore("conversations").clear();
    tx.objectStore("messages").clear();
    tx.objectStore("tokenMap").clear();
    tx.objectStore("meta").clear();
    await txDone(tx);
  });
}
