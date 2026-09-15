import { queryTokens, tokenize } from "./tokenize.js";

const DB_NAME = "chatseek";
const DB_VERSION = 1;

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

export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
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
      };
      req.onsuccess = () => resolve(req.result);
    });
  }
  return dbPromise;
}

function isGenericTitle(title) {
  const t = (title || "").trim();
  if (!t) return true;
  return /^(new chat|chatgpt|claude|grok|untitled|无标题)$/i.test(t);
}

/** Plausible millisecond epoch from a page (rejects unix seconds). */
function isValidPageMs(ts) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return false;
  return ts >= 1e11 && ts <= Date.now() + 86400000 * 366;
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
  const db = await openDb();
  const tx = db.transaction(["conversations", "tokenMap"], "readwrite");
  const convStore = tx.objectStore("conversations");
  const tokenStore = tx.objectStore("tokenMap");

  for (const incoming of list) {
    const old = await requestDone(convStore.get(incoming.id));
    const incomingUpdated = pageMs(incoming.updatedAt);
    const incomingCreated = pageMs(incoming.createdAt);
    const now = Date.now();

    const next = old ? { ...old } : {
      id: incoming.id,
      platform: incoming.platform,
      platformId: incoming.platformId,
      // Prefer page dates when creating; else capture time.
      createdAt: incomingCreated || incomingUpdated || now,
      updatedAt: incomingUpdated || now,
      messageCount: 0,
    };
    next.platform = incoming.platform;
    next.platformId = incoming.platformId;
    next.url = incoming.url || next.url;
    if (!isGenericTitle(incoming.title) || isGenericTitle(next.title)) {
      next.title = (incoming.title || next.title || "").trim() || next.title;
    }
    if (!next.title) next.title = next.platformId;

    // Title-only refresh must NOT stomp a good page updatedAt with Date.now().
    if (incomingUpdated) {
      next.updatedAt = incomingUpdated;
    }
    // createdAt from page only when creating (handled above) or still missing.
    if (!old && incomingCreated) {
      next.createdAt = incomingCreated;
    } else if (old && !isValidPageMs(next.createdAt) && incomingCreated) {
      next.createdAt = incomingCreated;
    }

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

export async function upsertMessages(conversation, messages) {
  if (!conversation?.id || !messages?.length) return;
  await upsertConversations([conversation]);

  const db = await openDb();
  const tx = db.transaction(
    ["conversations", "messages", "tokenMap"],
    "readwrite",
  );
  const convStore = tx.objectStore("conversations");
  const msgStore = tx.objectStore("messages");
  const tokenStore = tx.objectStore("tokenMap");

  let changed = 0;
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

  if (changed) {
    const conv = await requestDone(convStore.get(conversation.id));
    if (conv) {
      const prevTitle = conv.title;
      if (!isGenericTitle(conversation.title)) conv.title = conversation.title;
      if (conversation.url) conv.url = conversation.url;
      const incomingUpdated = pageMs(conversation.updatedAt);
      if (incomingUpdated) {
        // Trust the page date when the content script found one.
        conv.updatedAt = incomingUpdated;
      } else if (!isValidPageMs(conv.updatedAt)) {
        // Keep an existing page date; only fall back when none exists yet.
        conv.updatedAt = Date.now();
      }
      const incomingCreated = pageMs(conversation.createdAt);
      if (incomingCreated && !isValidPageMs(conv.createdAt)) {
        conv.createdAt = incomingCreated;
      }
      conv.messageCount = await requestDone(
        msgStore.index("conversationId").count(conversation.id),
      );
      if (prevTitle !== conv.title) {
        deleteTokens(tokenStore, tokenize(prevTitle), conv.id, "title");
        writeTokens(tokenStore, tokenize(conv.title), conv.id, "title");
      }
      convStore.put(conv);
    }
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

async function collectConvIdsForToken(tokenStore, token) {
  const ids = new Set();
  const range = IDBKeyRange.bound([token], [token + "\uffff"]);
  await cursorEach(tokenStore, { range }, (row) => {
    ids.add(row.conversationId);
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
export async function searchConversations({
  query = "",
  platform = "",
  limit = 80,
} = {}) {
  const db = await openDb();
  const q = query.trim();
  const tokens = queryTokens(q);

  if (!q) {
    return listRecent({ platform, limit });
  }

  const tx = db.transaction(["conversations", "tokenMap"], "readonly");
  const convStore = tx.objectStore("conversations");
  const tokenStore = tx.objectStore("tokenMap");

  const tokenSets = [];
  for (const token of tokens) {
    tokenSets.push(await collectConvIdsForToken(tokenStore, token));
  }
  const fromIndex = tokens.length ? intersectSets(tokenSets) : new Set();

  const needle = q.toLowerCase();
  const fromTitle = new Set();
  await cursorEach(convStore, {}, (conv) => {
    if (platform && conv.platform !== platform) return;
    if ((conv.title || "").toLowerCase().includes(needle)) {
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

export async function listRecent({ platform = "", limit = 80 } = {}) {
  const db = await openDb();
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
  const db = await openDb();
  const tx = db.transaction(["conversations", "messages"], "readonly");
  const conversations = await requestDone(tx.objectStore("conversations").count());
  const messages = await requestDone(tx.objectStore("messages").count());
  return { conversations, messages };
}

export async function clearAll() {
  const db = await openDb();
  const tx = db.transaction(
    ["conversations", "messages", "tokenMap"],
    "readwrite",
  );
  tx.objectStore("conversations").clear();
  tx.objectStore("messages").clear();
  tx.objectStore("tokenMap").clear();
  await txDone(tx);
}
