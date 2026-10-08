import { queryTokens, tokenize } from "./tokenize.js";
import { applySidebarEstimates, mergeActivityTime } from "./activity-time.js";

const DB_NAME = "chatseek";
const DB_VERSION = 2;

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
      req.onupgradeneeded = () => {
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

function writeTokens(tokenStore, tokens, conversationId, source) {
  for (const token of tokens) {
    tokenStore.put({ token, conversationId, source });
  }
}

function deleteTokens(tokenStore, tokens, conversationId, source) {
  for (const token of tokens) {
    tokenStore.delete([token, conversationId, source]);
  }
}

export async function upsertConversations(list) {
  if (!list?.length) return;
  return withDb((db) => writeConversations(db, list));
}

async function writeConversations(db, list) {
  const tx = db.transaction(["conversations", "tokenMap"], "readwrite");
  const convStore = tx.objectStore("conversations");
  const tokenStore = tx.objectStore("tokenMap");
  const drafts = [];

  for (const incoming of list) {
    const old = await requestDone(convStore.get(incoming.id));
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
    drafts.push({ old, next });
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
    });
  }

  for (const { old, next } of drafts) {
    delete next.sidebarIndex;
    const oldTitleTokens = tokenize(old?.title || "");
    const newTitleTokens = tokenize(next.title || "");
    if (old && old.title !== next.title) {
      deleteTokens(tokenStore, oldTitleTokens, next.id, "title");
    }
    if (!old || old.title !== next.title) {
      writeTokens(tokenStore, newTitleTokens, next.id, "title");
    }
    convStore.put(next);
  }

  await txDone(tx);
}

export async function upsertMessages(conversation, messages, meta = {}) {
  if (!conversation?.id || !messages?.length) return;
  // A one-row batch has no neighbours. Interpolating it alone would rewrite an
  // undated row's sidebar sort key as if it were the last row in the sidebar.
  const { sidebarIndex: _ignored, ...row } = conversation;
  await upsertConversations([row]);
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
  for (const msg of messages) {
    if (!msg?.id || typeof msg.body !== "string" || !msg.body) continue;
    const existing = await requestDone(msgStore.get(msg.id));
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
    writeTokens(tokenStore, tokenize(msg.body), conversation.id, msg.id);
    changed += 1;
  }

  if (conv && (changed || (meta.captureId && conv.captureToken === meta.captureId))) {
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
      }
      if (pageIds.length) conv.tailMessageId = pageIds[pageIds.length - 1];
      conv.messageCount = await requestDone(
        msgStore.index("conversationId").count(conversation.id),
      );
    }
    if (prevTitle !== conv.title) {
      deleteTokens(tokenStore, tokenize(prevTitle), conv.id, "title");
      writeTokens(tokenStore, tokenize(conv.title), conv.id, "title");
    }
    convStore.put(conv);
  }

  await txDone(tx);
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

function titleContainsQuery(title, needle) {
  const hay = (title || "").toLowerCase().normalize("NFKC");
  if (!needle || !hay.includes(needle)) return false;
  // CJK phrases have no word boundaries; latin must match a whole token
  // so "star" does not hit "starship" and "not" does not hit "notes".
  if (/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/.test(needle)) {
    return true;
  }
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i").test(hay);
}

async function collectConvIdsForToken(tokenStore, token) {
  const ids = new Set();
  // Compound key [token, conversationId, source]. Stay inside this token so
  // a shorter word does not match a longer one.
  const range = IDBKeyRange.bound([token], [token, "\uffff", "\uffff"]);
  await cursorEach(tokenStore, { range }, (row) => {
    if (row.token === token) ids.add(row.conversationId);
  });
  return ids;
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
  if (!q) return listRecent(options);
  return withDb((db) => searchOn(db, options));
}

async function searchOn(db, {
  query = "",
  platform = "",
  limit = 80,
} = {}) {
  const q = query.trim();
  const tokens = queryTokens(q);

  const tx = db.transaction(["conversations", "tokenMap"], "readonly");
  const convStore = tx.objectStore("conversations");
  const tokenStore = tx.objectStore("tokenMap");

  const tokenSets = [];
  for (const token of tokens) {
    tokenSets.push(await collectConvIdsForToken(tokenStore, token));
  }
  const fromIndex = tokens.length ? intersectSets(tokenSets) : new Set();

  const needle = q.toLowerCase().normalize("NFKC");
  const fromTitle = new Set();
  await cursorEach(convStore, {}, (conv) => {
    if (platform && conv.platform !== platform) return;
    if (titleContainsQuery(conv.title, needle)) {
      fromTitle.add(conv.id);
    }
  });

  const ids = new Set([...fromIndex, ...fromTitle]);
  const matches = [];
  for (const id of ids) {
    const conv = await requestDone(convStore.get(id));
    if (!conv) continue;
    if (platform && conv.platform !== platform) continue;
    matches.push(conv);
  }
  matches.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return matches.slice(0, limit);
}

export async function listRecent(options = {}) {
  return withDb((db) => listRecentOn(db, options));
}

async function listRecentOn(db, { platform = "", limit = 80 } = {}) {
  const tx = db.transaction("conversations", "readonly");
  const index = tx.objectStore("conversations").index("updatedAt");
  const items = [];
  await cursorEach(index, { direction: "prev" }, (conv) => {
    if (platform && conv.platform !== platform) return;
    items.push(conv);
    return items.length >= limit;
  });
  return items;
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
