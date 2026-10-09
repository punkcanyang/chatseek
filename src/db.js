import { indexPlain } from "./markdown.js";
import { queryTokens, titleContainsQuery, tokenSpans, tokenize } from "./tokenize.js";
import { applySidebarEstimates, mergeActivityTime, pageShowsNewActivity, tailTextSeen } from "./activity-time.js";
import { activityBodyChanged, alignRekeyedTurns, planCloneDrops } from "./message-identity.js";
import {
  buildPreview,
  clipPreviewSource,
  nextPreviewFields,
  snippetTokens,
} from "./preview.js";
import { mergeMessageOrder, orderMessages } from "./message-order.js";
import { compareConversations, RELEVANCE_WEIGHT, relevanceScore } from "./sort-list.js";
import { normalizeImageRecord } from "./image-cache.js";
import { isProgressText, planProgressMerges } from "./image-progress.js";

const DB_NAME = "chatseek";
const DB_VERSION = 4;
const IMAGE_BYTES_KEY = "imageBytes";
// Bitmap bytes live here, not on the images row the grid lists.
const IMAGE_BLOB_PREFIX = "imgb:";
const IMAGE_SPLIT_KEY = "imgb:split";

function imageBlobKey(messageId, index) {
  return `${IMAGE_BLOB_PREFIX}${messageId}\u0001${index}`;
}

function withoutBlob(row) {
  if (!row || row.blob == null) return row;
  const next = { ...row };
  delete next.blob;
  return next;
}

function copyBytes(blob) {
  if (blob instanceof ArrayBuffer) return blob.slice(0);
  if (ArrayBuffer.isView(blob)) {
    const view = new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    return copy.buffer;
  }
  return null;
}

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
        // 1.6.0: thumbnails and uncached placeholders. Not part of search.
        if (!db.objectStoreNames.contains("images")) {
          const images = db.createObjectStore("images", { keyPath: ["messageId", "index"] });
          images.createIndex("conversationId", "conversationId");
          images.createIndex("messageId", "messageId");
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

function isQuotaError(err) {
  const name = err?.name || "";
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
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

function tokensForDelete(body) {
  const raw = tokenize(body);
  const plain = indexPlain(body);
  if (plain === body) return raw;
  return [...new Set([...raw, ...tokenize(plain)])];
}

// A half-painted turn is a prefix of the text we already stored. A shorter
// edit that is not that prefix still replaces the row.
function poorerBody(existingBody, nextBody) {
  const prev = String(existingBody || "").trim();
  const next = String(nextBody || "").trim();
  if (!prev || !next || next.length >= prev.length) return false;
  return prev.startsWith(next);
}

function poorerPreview(prev, next) {
  const stored = String(prev || "").trim();
  const incoming = String(next || "").trim().replace(/…$/, "");
  if (!stored || !incoming || incoming.length >= stored.length) return false;
  return stored.startsWith(incoming);
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
 * archived false restores active. Callers may send it only for a conversation
 * page with no archive banner and a new message, or for a manual restore.
 * Omitted leaves the stored flag alone — a sidebar row, a sync visit, or a
 * new last-activity time is not a signal.
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
// Page order of a conversation's message ids. Kept in meta, not on the
// conversation row, so list and search cursors over conversations stay small.
const ORDER_PREFIX = "order:";

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

async function writeMessages(db, conversation, messages, meta = {}) {
  const storeNames = ["conversations", "messages", "tokenMap", "meta"];
  if (db.objectStoreNames.contains("images")) storeNames.push("images");
  const tx = db.transaction(storeNames, "readwrite");
  const convStore = tx.objectStore("conversations");
  const msgStore = tx.objectStore("messages");
  const tokenStore = tx.objectStore("tokenMap");
  const metaStore = tx.objectStore("meta");

  const conv = await requestDone(convStore.get(conversation.id));
  let baselineCount = conv?.messageCount || 0;
  let baselineTail = conv?.tailMessageId || "";
  // A title-only row (0 stored messages) must accept the next real capture.
  // Prefix protection stays for rows that already have a body.
  const titleOnly = !(Number(conv?.messageCount) > 0);
  let replacedTitleOnly = false;
  if (titleOnly) {
    const oldRows = await requestDone(msgStore.index("conversationId").getAll(conversation.id));
    for (const row of oldRows || []) {
      if (!row?.id) continue;
      deleteTokens(tokenStore, tokensForDelete(row.body), conversation.id, row.id);
      msgStore.delete(row.id);
      replacedTitleOnly = true;
    }
    baselineCount = 0;
    baselineTail = "";
  }
  if (conv && meta.captureId && conv.captureToken !== meta.captureId) {
    conv.captureToken = meta.captureId;
    conv.captureBaselineCount = baselineCount;
    conv.captureBaselineTail = baselineTail;
    conv.captureSawTail = false;
  } else if (conv && meta.captureId && conv.captureToken === meta.captureId) {
    baselineCount = conv.captureBaselineCount ?? baselineCount;
    baselineTail = conv.captureBaselineTail || baselineTail;
  }

  let changed = 0;
  let identityChanged = false;
  let tailBodyChanged = false;
  let observedNow = false;
  const freshIds = new Set();
  const skippedIds = new Set();
  let storedRows = null;
  const pageIds = Array.isArray(meta.pageMessageIds) ? meta.pageMessageIds : [];
  const pageCount = pageIds.length;
  const imageStore = db.objectStoreNames.contains("images") ? tx.objectStore("images") : null;

  async function imageRows(messageId) {
    if (!imageStore || !messageId) return [];
    const rows = [];
    await cursorEach(imageStore.index("messageId"), { range: IDBKeyRange.only(messageId) }, (row) => {
      if (row) rows.push(row);
    });
    return rows;
  }

  async function takeImageBytes(messageId, index, inline) {
    const key = imageBlobKey(messageId, index);
    const packed = await requestDone(metaStore.get(key));
    metaStore.delete(key);
    return copyBytes(packed?.blob) || copyBytes(inline);
  }

  async function moveImages(fromId, toId) {
    if (!imageStore || !fromId || !toId || fromId === toId) return;
    for (const row of await imageRows(fromId)) {
      const dest = await requestDone(imageStore.get([toId, row.index]));
      const bytes = await takeImageBytes(fromId, row.index, row.blob);
      imageStore.delete([fromId, row.index]);
      if (!dest) {
        imageStore.put(withoutBlob({ ...row, messageId: toId }));
        if (bytes) metaStore.put({ key: imageBlobKey(toId, row.index), blob: bytes });
      } else if (row.bytes) await adjustImageBytes(metaStore, -(Number(row.bytes) || 0));
    }
  }

  async function deleteStoredMessage(messageId) {
    const existing = await requestDone(msgStore.get(messageId));
    if (!existing) return;
    deleteTokens(tokenStore, tokensForDelete(existing.body), conversation.id, messageId);
    msgStore.delete(messageId);
    for (const row of await imageRows(messageId)) {
      imageStore.delete([messageId, row.index]);
      metaStore.delete(imageBlobKey(messageId, row.index));
      if (row.bytes) await adjustImageBytes(metaStore, -(Number(row.bytes) || 0));
    }
  }

  const orderKeyEarly = ORDER_PREFIX + conversation.id;
  let orderIdsLive = null;
  async function loadOrderIds() {
    if (orderIdsLive) return orderIdsLive;
    const row = titleOnly ? null : await requestDone(metaStore.get(orderKeyEarly));
    orderIdsLive = Array.isArray(row?.ids) ? row.ids.slice() : [];
    return orderIdsLive;
  }
  function rememberOrder(ids) {
    const next = [];
    const seen = new Set();
    for (const id of ids || []) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      next.push(id);
    }
    orderIdsLive = next;
    if (!titleOnly && conv) {
      metaStore.put({ key: orderKeyEarly, conversationId: conv.id, ids: next });
    }
  }
  function pointTail(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return;
    if (baselineTail === fromId) {
      baselineTail = toId;
      if (conv?.captureBaselineTail === fromId) conv.captureBaselineTail = toId;
    }
    if (conv?.tailMessageId === fromId) conv.tailMessageId = toId;
  }

  let missingId = false;
  if (conv && baselineCount > 0 && !titleOnly) {
    for (const msg of messages) {
      if (!msg?.id || typeof msg.body !== "string" || !msg.body) continue;
      const existing = await requestDone(msgStore.get(msg.id));
      if (!existing) {
        missingId = true;
        break;
      }
    }
  }
  const maybeClones = !!(
    conv && baselineCount > 0 && !titleOnly &&
    pageIds.length >= 2 && baselineCount >= pageIds.length * 2 &&
    baselineCount % pageIds.length === 0
  );
  if (missingId || maybeClones) {
    const storedList = await requestDone(msgStore.index("conversationId").getAll(conversation.id));
    const orderIds = await loadOrderIds();
    const byId = new Map((storedList || []).filter((row) => row?.id).map((row) => [row.id, row]));
    const ordered = [];
    for (const id of orderIds) {
      const row = byId.get(id);
      if (!row) continue;
      ordered.push(row);
      byId.delete(id);
    }
    const rest = [...byId.values()].sort((a, b) => (a.capturedAt || 0) - (b.capturedAt || 0));
    let storedOrdered = ordered.concat(rest);

    if (maybeClones) {
      const moves = planCloneDrops(storedOrdered, pageIds, messages);
      if (moves.length) {
        identityChanged = true;
        const dropIds = new Set(moves.map((move) => move.from));
        for (const move of moves) {
          await moveImages(move.from, move.to);
          await deleteStoredMessage(move.from);
          pointTail(move.from, move.to);
        }
        rememberOrder(orderIds.filter((id) => !dropIds.has(id)));
        storedOrdered = storedOrdered.filter((row) => !dropIds.has(row.id));
      }
    }

    if (missingId) {
      const indexOf = new Map(pageIds.map((id, index) => [id, index]));
      const pageItems = [];
      for (const msg of messages) {
        if (!msg?.id || typeof msg.body !== "string" || !msg.body) continue;
        pageItems.push({
          id: msg.id,
          role: msg.role,
          body: msg.body,
          index: indexOf.has(msg.id) ? indexOf.get(msg.id) : pageItems.length,
        });
      }
      const alias = alignRekeyedTurns(storedOrdered, pageItems);
      for (const [pageId, storedId] of alias) {
        if (!pageId || !storedId || pageId === storedId) continue;
        const existing = await requestDone(msgStore.get(storedId));
        if (!existing) continue;
        if (await requestDone(msgStore.get(pageId))) continue;
        deleteTokens(tokenStore, tokensForDelete(existing.body), conversation.id, storedId);
        msgStore.delete(storedId);
        const record = { ...existing, id: pageId };
        msgStore.put(record);
        writeTokens(
          tokenStore,
          indexPlain(existing.body),
          conversation.id,
          pageId,
          record.role,
        );
        await moveImages(storedId, pageId);
        const currentOrder = await loadOrderIds();
        rememberOrder(currentOrder.map((id) => (id === storedId ? pageId : id)));
        pointTail(storedId, pageId);
        const slot = storedOrdered.find((row) => row.id === storedId);
        if (slot) slot.id = pageId;
        identityChanged = true;
      }
    }
  }

  for (const [captureIndex, msg] of messages.entries()) {
    if (!msg?.id || typeof msg.body !== "string" || !msg.body) continue;
    const existing = await requestDone(msgStore.get(msg.id));
    if (existing && (existing.body === msg.body || poorerBody(existing.body, msg.body))) continue;
    if (!titleOnly && !existing && baselineCount > pageCount && pageCount > 0) {
      const needle = msg.body.trim();
      if (needle.length >= 12) {
        if (!storedRows) {
          storedRows = await requestDone(msgStore.index("conversationId").getAll(conversation.id));
        }
        const fragment = (storedRows || []).some((row) => {
          const body = String(row?.body || "");
          return body.length > needle.length && body.startsWith(needle);
        });
        if (fragment) {
          skippedIds.add(msg.id);
          continue;
        }
      }
    }
    if (!existing) freshIds.add(msg.id);

    if (existing) {
      deleteTokens(
        tokenStore,
        tokensForDelete(existing.body),
        conversation.id,
        msg.id,
      );
    }
    if (msg.id === baselineTail && activityBodyChanged(existing?.body, msg.body)) {
      tailBodyChanged = true;
    }
    const record = {
      id: msg.id,
      conversationId: conversation.id,
      role: msg.role === "assistant" || msg.role === "unknown" ? "assistant" : "user",
      body: msg.body,
      // First capture time and page position order turns that share a
      // millisecond. A streamed body rewrite keeps both so the turn stays put.
      capturedAt: typeof existing?.capturedAt === "number" ? existing.capturedAt : Date.now(),
      captureIndex: Number.isInteger(existing?.captureIndex) ? existing.captureIndex : captureIndex,
    };
    msgStore.put(record);
    writeTokens(
      tokenStore,
      indexPlain(msg.body),
      conversation.id,
      msg.id,
      record.role,
    );
    changed += 1;
  }

  if (replacedTitleOnly) changed += 1;
  let activity = false;
  if (conv && baselineCount > 0 && baselineTail && pageIds.length) {
    let storedBody = "";
    const tailMoved = !pageIds.includes(baselineTail) || pageIds[pageIds.length - 1] !== baselineTail;
    if (tailMoved || tailBodyChanged) {
      const storedTail = await requestDone(msgStore.get(baselineTail));
      storedBody = storedTail?.body || "";
    }
    if (!pageIds.includes(baselineTail) && storedBody) {
      for (const msg of messages) {
        if (msg?.body && tailTextSeen(storedBody, msg.body)) {
          conv.captureSawTail = true;
          break;
        }
      }
    }
    activity = pageShowsNewActivity({
      baselineCount,
      baselineTail,
      baselineTailBody: storedBody,
      pageIds,
      pageBodies: messages,
      tailBodyChanged,
      sawStoredTail: !!conv.captureSawTail,
    });
  }
  if (conv && (changed || activity || identityChanged || (meta.captureId && conv.captureToken === meta.captureId))) {
    const fields = nextPreviewFields(conv, messages, meta.pageMessageIds, { freshIds });
    if (fields.firstUserPreview && !poorerPreview(conv.firstUserPreview, fields.firstUserPreview)) {
      conv.firstUserPreview = fields.firstUserPreview;
      conv.firstUserMessageId = fields.firstUserMessageId;
    }
    if (fields.lastPreview && !poorerPreview(conv.lastPreview, fields.lastPreview)) {
      conv.lastPreview = fields.lastPreview;
      conv.lastPreviewRole = fields.lastPreviewRole;
    }
    const prevTitle = conv.title;
    if (!isGenericTitle(conversation.title)) conv.title = conversation.title;
    if (conversation.url) conv.url = conversation.url;
    const now = Date.now();
    const incomingUpdated = pageMs(conversation.updatedAt);
    if (changed || activity) {
      if (changed || identityChanged) {
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
        conv.messageCount = await requestDone(
          msgStore.index("conversationId").count(conversation.id),
        );
      }
      // A new ending is its own high-confidence time. It still cannot move
      // the clock backward: mergeActivityTime keeps the newer stamp.
      if (activity) {
        const observed = mergeActivityTime(conv, {
          updatedAt: now,
          updatedAtSource: "observed",
        }, now);
        conv.updatedAt = observed.updatedAt;
        conv.updatedAtSource = observed.updatedAtSource;
        observedNow = observed.updatedAtSource === "observed";
      }
      // A shorter window must not move the stored tail backward.
      const pageTail = pageIds[pageIds.length - 1];
      if (pageIds.length && (activity || !baselineTail || pageTail === baselineTail)) {
        conv.tailMessageId = pageTail;
      }
    }
    if (prevTitle !== conv.title) {
      deleteTokens(tokenStore, tokenize(prevTitle), conv.id, "title");
      writeTokens(tokenStore, conv.title, conv.id, "title", "title");
    }
    if (conv.updatedAtSource !== "sidebar-rank" || !isValidPageMs(conv.olderThanAt)) {
      delete conv.olderThanAt;
    }
    if (identityChanged) {
      conv.messageCount = await requestDone(
        msgStore.index("conversationId").count(conversation.id),
      );
    }
    const orderIds = (pageIds.length
      ? pageIds
      : messages.map((msg) => msg?.id).filter(Boolean)
    ).filter((id) => !skippedIds.has(id));
    const orderKey = ORDER_PREFIX + conv.id;
    const storedOrder = titleOnly ? null : await requestDone(metaStore.get(orderKey));
    metaStore.put({
      key: orderKey,
      conversationId: conv.id,
      ids: mergeMessageOrder(titleOnly ? [] : (storedOrder?.ids || conv.messageOrder), orderIds),
    });
    delete conv.messageOrder;
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

async function collectConvIdsForToken(tokenStore, token, keepPostings = false) {
  const ids = new Set();
  const postings = [];
  // Compound key [token, conversationId, source]. Stay inside this token so
  // a shorter word does not match a longer one. Role and positions ride on
  // the same row; this cursor does not open the messages store.
  const range = IDBKeyRange.bound([token], [token, "\uffff", "\uffff"]);
  await cursorEach(tokenStore, { range }, (row) => {
    if (row.token === token) {
      ids.add(row.conversationId);
      if (keepPostings) postings.push(row);
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
    const found = await collectConvIdsForToken(tokenStore, token, sort?.field === "relevance");
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
        stored.firstUserPreview = clipPreviewSource(firstUser);
        conv.firstUserPreview = stored.firstUserPreview;
      }
      if (last) {
        stored.lastPreview = clipPreviewSource(last);
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

/** Conversation row only. The reader clock uses this so a 3000-message thread is not reread. */
export async function readConversationRow(id) {
  if (typeof id !== "string" || !id) return null;
  return withDb(async (db) => {
    const tx = db.transaction("conversations", "readonly");
    return requestDone(tx.objectStore("conversations").get(id));
  });
}

/**
 * Read one conversation and its messages. Readonly: does not create rows,
 * does not clear a removed:<id> tombstone, and does not bump the schema.
 */
export async function readConversation(id) {
  if (typeof id !== "string" || !id) return null;
  return withDb(async (db) => {
    const tx = db.transaction(["conversations", "messages", "meta"], "readonly");
    const conv = await requestDone(tx.objectStore("conversations").get(id));
    if (!conv) return null;
    const order = await requestDone(tx.objectStore("meta").get(ORDER_PREFIX + id));
    const messages = [];
    const index = tx.objectStore("messages").index("conversationId");
    await cursorEach(index, { range: IDBKeyRange.only(id) }, (msg) => {
      if (msg) messages.push(msg);
    });
    return {
      conversation: conv,
      messages: orderMessages(messages, order?.ids || conv.messageOrder),
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

function cleanStoredDiag(line) {
  let text = String(line || "");
  if (!text.startsWith("[Chatseek] diag ")) return "";
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)) return "";
  if (text.length > 1600) text = text.slice(0, 1600);
  return text;
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
      diag: cleanStoredDiag(health.diag),
    });
    await txDone(tx);
  });
}

export async function readCaptureHealth() {
  return withDb(async (db) => {
    if (!db.objectStoreNames.contains("meta")) return {};
    const tx = db.transaction("meta", "readonly");
    const out = {};
    const range = IDBKeyRange.bound("health:", "health:\uffff");
    await cursorEach(tx.objectStore("meta"), { range }, (row) => {
      if (row?.key?.startsWith?.("health:") && row.platform) out[row.platform] = row;
    });
    return out;
  });
}

const SYNC_SESSION_KEY = "sync:session";

/** Conversation rows only. Does not open the messages store. */
export async function listSyncCandidates(platform) {
  if (typeof platform !== "string" || !platform) return [];
  return withDb(async (db) => {
    const tx = db.transaction("conversations", "readonly");
    const items = [];
    await cursorEach(tx.objectStore("conversations"), {}, (conv) => {
      if (!conv || conv.platform !== platform) return;
      items.push({
        id: conv.id,
        url: typeof conv.url === "string" ? conv.url : "",
        updatedAt: typeof conv.updatedAt === "number" ? conv.updatedAt : 0,
        messageCount: Number(conv.messageCount) || 0,
      });
    });
    return items;
  });
}

export async function readSyncSession() {
  return withDb(async (db) => {
    if (!db.objectStoreNames.contains("meta")) return null;
    const tx = db.transaction("meta", "readonly");
    const row = await requestDone(tx.objectStore("meta").get(SYNC_SESSION_KEY));
    return row?.session && typeof row.session === "object" ? row.session : null;
  });
}

export async function writeSyncSession(session) {
  if (!session || typeof session !== "object") return;
  return withDb(async (db) => {
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put({ key: SYNC_SESSION_KEY, session });
    await txDone(tx);
  });
}

async function adjustImageBytes(metaStore, delta) {
  const row = await requestDone(metaStore.get(IMAGE_BYTES_KEY));
  const next = Math.max(0, (Number(row?.bytes) || 0) + delta);
  metaStore.put({ key: IMAGE_BYTES_KEY, bytes: next });
  return next;
}

export async function saveImageRecords(conversationId, images) {
  if (typeof conversationId !== "string" || !conversationId || !images?.length) {
    return { saved: 0 };
  }
  try {
    return await withDb(async (db) => {
      const tx = db.transaction(["images", "meta"], "readwrite");
      const store = tx.objectStore("images");
      const meta = tx.objectStore("meta");
      let saved = 0;
      for (const raw of images) {
        const rec = normalizeImageRecord(conversationId, raw);
        if (!rec) continue;
        const prev = await requestDone(store.get([rec.messageId, rec.index]));
        let delta = rec.status === "cached" ? rec.bytes : 0;
        if (prev?.bytes) delta -= Number(prev.bytes) || 0;
        const blobKey = imageBlobKey(rec.messageId, rec.index);
        const bitmap = rec.status === "cached" ? copyBytes(rec.blob) : null;
        try {
          store.put(withoutBlob(rec));
          if (bitmap) meta.put({ key: blobKey, blob: bitmap });
          else meta.delete(blobKey);
        } catch (err) {
          if (!isQuotaError(err)) throw err;
          try { tx.abort(); } catch { /* already aborting */ }
          return { saved: 0, quota: true };
        }
        if (delta) await adjustImageBytes(meta, delta);
        saved += 1;
      }
      await txDone(tx);
      return { saved };
    });
  } catch (err) {
    // A failed put aborts the transaction, so the byte counter is unchanged
    // and conversation rows (a different transaction) stay put.
    if (isQuotaError(err)) return { saved: 0, quota: true };
    throw err;
  }
}

async function bytesForRow(meta, row) {
  if (!row || row.status !== "cached") return row;
  if (row.blob) return row;
  const packed = await requestDone(meta.get(imageBlobKey(row.messageId, row.index)));
  if (!packed?.blob) return row;
  return { ...row, blob: packed.blob };
}

export async function readImagesForMessages(ids) {
  const wanted = (Array.isArray(ids) ? ids : [])
    .filter((id) => typeof id === "string" && id)
    .slice(0, 80);
  if (!wanted.length) return [];
  return withDb(async (db) => {
    if (!db.objectStoreNames.contains("images")) return [];
    const tx = db.transaction(["images", "meta"], "readonly");
    const index = tx.objectStore("images").index("messageId");
    const meta = tx.objectStore("meta");
    const out = [];
    for (const id of wanted) {
      const rows = [];
      await cursorEach(index, { range: IDBKeyRange.only(id) }, (row) => {
        if (row) rows.push(row);
      });
      for (const row of rows) out.push(await bytesForRow(meta, row));
    }
    out.sort((a, b) => (a.index || 0) - (b.index || 0));
    return out;
  });
}

async function imageBlobsSplit() {
  return withDb(async (db) => {
    if (!db.objectStoreNames.contains("meta")) return true;
    const tx = db.transaction("meta", "readonly");
    const flag = await requestDone(tx.objectStore("meta").get(IMAGE_SPLIT_KEY));
    return flag?.done === true;
  });
}

/** Move at most `limit` legacy inline bitmaps off the list rows. */
async function detachImageBlobBatch(limit) {
  return withDb(async (db) => {
    if (!db.objectStoreNames.contains("images") || !db.objectStoreNames.contains("meta")) return false;
    const tx = db.transaction(["images", "meta"], "readwrite");
    const store = tx.objectStore("images");
    const meta = tx.objectStore("meta");
    let moved = 0;
    await cursorEach(store, {}, (row, cursor) => {
      if (!row?.blob) return;
      const bitmap = copyBytes(row.blob);
      const next = { ...row };
      delete next.blob;
      if (bitmap) meta.put({ key: imageBlobKey(row.messageId, row.index), blob: bitmap });
      cursor.update(next);
      moved += 1;
      return moved >= limit;
    });
    await txDone(tx);
    return moved >= limit;
  });
}

async function markImageBlobsSplit() {
  return withDb(async (db) => {
    if (!db.objectStoreNames.contains("meta")) return;
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put({ key: IMAGE_SPLIT_KEY, done: true });
    await txDone(tx);
  });
}

/**
 * Older 1.6.x rows kept the bitmap on the same record the list has to scan.
 * One pass parks those bytes beside the row. The database stays version 4.
 */
async function ensureImageBytesDetached() {
  try {
    if (await imageBlobsSplit()) return;
    let more = false;
    for (let i = 0; i < 10000; i += 1) {
      more = await detachImageBlobBatch(32);
      if (!more) break;
    }
    if (!more) await markImageBlobsSplit();
  } catch {
    // The list still accepts an inline bitmap. A later open tries again.
  }
}

/**
 * Metadata for the image tab. Bitmap bytes stay out of this cursor.
 * Archived conversations are included: this grid is the cache, and it sits
 * after All, which already shows archived chats. Image addresses are not
 * copied onto the card.
 */
export async function listImageCards() {
  await ensureImageBytesDetached();
  return withDb(async (db) => {
    if (!db.objectStoreNames.contains("images")) return [];
    const tx = db.transaction(["images", "conversations", "meta"], "readonly");
    const raw = [];
    await cursorEach(tx.objectStore("images"), {}, (row) => {
      if (!row?.conversationId || !row.messageId) return;
      raw.push({
        messageId: row.messageId,
        index: row.index,
        conversationId: row.conversationId,
        status: row.status || "",
        alt: row.alt || "",
        offset: Number(row.offset) || 0,
        width: Number(row.width) || 0,
        height: Number(row.height) || 0,
        mime: row.mime || "",
        bytes: Number(row.bytes) || 0,
      });
    });
    const convStore = tx.objectStore("conversations");
    const meta = tx.objectStore("meta");
    const convs = new Map();
    const ranks = new Map();
    for (const id of new Set(raw.map((row) => row.conversationId))) {
      const conv = await requestDone(convStore.get(id));
      if (conv) convs.set(id, conv);
      const order = await requestDone(meta.get(ORDER_PREFIX + id));
      const ids = order?.ids || conv?.messageOrder || [];
      ids.forEach((mid, index) => {
        if (mid && !ranks.has(mid)) ranks.set(mid, index);
      });
    }
    return raw.map((row) => {
      const conv = convs.get(row.conversationId);
      return {
        ...row,
        platform: conv?.platform || "",
        title: conv?.title || "",
        chatUrl: typeof conv?.url === "string" ? conv.url : "",
        updatedAt: Number(conv?.updatedAt) || 0,
        messageRank: ranks.has(row.messageId) ? ranks.get(row.messageId) : null,
      };
    });
  });
}

export async function readImageBytes(messageId, index) {
  if (typeof messageId !== "string" || !messageId || !Number.isInteger(index)) return null;
  return withDb(async (db) => {
    if (!db.objectStoreNames.contains("images")) return null;
    const tx = db.transaction(["images", "meta"], "readonly");
    const row = await requestDone(tx.objectStore("images").get([messageId, index]));
    if (!row || row.status !== "cached") return null;
    const packed = await bytesForRow(tx.objectStore("meta"), row);
    const blob = packed?.blob;
    const size = blob?.byteLength || blob?.length || 0;
    if (!size) return null;
    return { mime: row.mime || "", blob };
  });
}

export async function imageCacheUsage() {
  return withDb(async (db) => {
    if (!db.objectStoreNames.contains("meta")) return 0;
    const tx = db.transaction("meta", "readonly");
    const row = await requestDone(tx.objectStore("meta").get(IMAGE_BYTES_KEY));
    return Math.max(0, Number(row?.bytes) || 0);
  });
}

export async function clearImageCache() {
  return withDb(async (db) => {
    const tx = db.transaction(["images", "meta"], "readwrite");
    const store = tx.objectStore("images");
    // Keep the slot. Dropping the row would leave a blank gap in the reader,
    // because the message text does not store an image address.
    const meta = tx.objectStore("meta");
    await cursorEach(store, {}, (row, cursor) => {
      if (!row || row.status === "cleared") return;
      if (row.status !== "cached" && !row.blob && !(Number(row.bytes) > 0)) return;
      meta.delete(imageBlobKey(row.messageId, row.index));
      const next = {
        messageId: row.messageId,
        index: row.index,
        conversationId: row.conversationId,
        alt: row.alt || "",
        prompt: row.prompt || "",
        offset: row.offset || 0,
        status: "cleared",
        bytes: 0,
        mime: "",
        width: 0,
        height: 0,
      };
      cursor.update(next);
    });
    tx.objectStore("meta").put({ key: IMAGE_BYTES_KEY, bytes: 0 });
    await txDone(tx);
  });
}

/**
 * Manual restore from the side panel. Does not change last-activity time,
 * messages, or the page. A later banner or archive-list capture can mark
 * the chat archived again.
 */
export async function restoreConversation(id) {
  if (typeof id !== "string" || !id) return false;
  return withDb(async (db) => {
    const tx = db.transaction("conversations", "readwrite");
    const store = tx.objectStore("conversations");
    const row = await requestDone(store.get(id));
    if (!row || row.archived !== true) {
      await txDone(tx);
      return false;
    }
    const next = { ...row, archived: false };
    delete next.archiveSource;
    delete next.archivedAt;
    store.put(next);
    await txDone(tx);
    return true;
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
    const stores = ["conversations", "messages", "tokenMap", "meta"];
    if (db.objectStoreNames.contains("images")) stores.push("images");
    const tx = db.transaction(stores, "readwrite");
    tx.objectStore("conversations").delete(id);
    tx.objectStore("meta").put({ key: REMOVED_PREFIX + id, removedAt: Date.now() });
    tx.objectStore("meta").delete(ORDER_PREFIX + id);
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
    if (db.objectStoreNames.contains("images")) {
      const imageIndex = tx.objectStore("images").index("conversationId");
      let freed = 0;
      const meta = tx.objectStore("meta");
      await cursorEach(imageIndex, { range: IDBKeyRange.only(id) }, (row, cursor) => {
        freed += Number(row?.bytes) || 0;
        if (row?.messageId) meta.delete(imageBlobKey(row.messageId, row.index));
        cursor.delete();
      });
      if (freed) await adjustImageBytes(tx.objectStore("meta"), -freed);
    }
    await txDone(tx);
  });
}

export async function clearAll() {
  return withDb(async (db) => {
    const names = ["conversations", "messages", "tokenMap", "meta"];
    if (db.objectStoreNames.contains("images")) names.push("images");
    const tx = db.transaction(names, "readwrite");
    tx.objectStore("conversations").clear();
    tx.objectStore("messages").clear();
    tx.objectStore("tokenMap").clear();
    tx.objectStore("meta").clear();
    if (names.includes("images")) tx.objectStore("images").clear();
    await txDone(tx);
  });
}

/**
 * One-time tidy of image-generation progress duplicates left by <= 1.7.1.
 *
 * Those versions stored each "Creating image 25%" rewrite as a fresh assistant
 * message. This folds a consecutive run of progress-only rows into the final
 * settled turn, keeping that turn's body and image records and never touching
 * updatedAt. Idempotent: a `progressRepair` meta flag short-circuits a second
 * run, and re-running without the flag finds no runs to merge.
 * IndexedDB stays at version 4.
 */
const PROGRESS_REPAIR_KEY = "progressRepair";

async function repairConversationProgress(db, convId) {
  const storeNames = ["conversations", "messages", "tokenMap", "meta"];
  const hasImages = db.objectStoreNames.contains("images");
  if (hasImages) storeNames.push("images");
  const tx = db.transaction(storeNames, "readwrite");
  const convStore = tx.objectStore("conversations");
  const msgStore = tx.objectStore("messages");
  const tokenStore = tx.objectStore("tokenMap");
  const metaStore = tx.objectStore("meta");
  const imageStore = hasImages ? tx.objectStore("images") : null;

  const completed = txDone(tx);
  completed.catch(() => {}); // request failures are handled below
  try {
    const conv = await requestDone(convStore.get(convId));
    if (!conv) {
      await completed;
      return { dropped: 0, groups: 0 };
    }
    const all = await requestDone(msgStore.index("conversationId").getAll(convId));
    // Time order, never the stored order meta: a 1.7.1 capture anchored the meta
    // order on the first user id, which can leave the progress rewrites reversed.
    // First capture time recovers rewrite order; captureIndex separately
    // supplies position evidence. Missing positions are never guessed.
    const rows = orderMessages(all || [], null);

    const plans = planProgressMerges(rows);
    if (!plans.length) {
      await completed;
      return { dropped: 0, groups: 0 };
    }

    const dropToKeep = new Map();
    for (const plan of plans) {
      for (const id of plan.drop) dropToKeep.set(id, plan.keep);
    }

    // A progress row has no image of its own; move any anyway so a thumbnail
    // never points at a row that is about to disappear.
    if (imageStore) {
      // One indexed read for this conversation rather than thousands of empty
      // message-id cursor scans. Current image rows carry metadata only.
      const imageRows = await requestDone(imageStore.index("conversationId").getAll(convId));
      const imagesByMessage = new Map();
      for (const image of imageRows) {
        if (!imagesByMessage.has(image.messageId)) imagesByMessage.set(image.messageId, []);
        imagesByMessage.get(image.messageId).push(image);
      }
      const occupiedByKeep = new Map();
      for (const [from, keep] of dropToKeep) {
        for (const row of imagesByMessage.get(from) || []) {
          let index = row.index;
          // Keep distinct images even when every old progress row used slot 0.
          // The stable turn's original slots retain their indices for reader
          // links; moved records take a free slot and retain their bitmap bytes.
          let slots = occupiedByKeep.get(keep);
          if (!slots) {
            const keptImages = imagesByMessage.get(keep) || [];
            slots = { occupied: new Set(keptImages.map(image => image.index)), next: 0 };
            occupiedByKeep.set(keep, slots);
          }
          if (slots.occupied.has(index)) {
            while (slots.occupied.has(slots.next)) slots.next += 1;
            index = slots.next++;
          }
          slots.occupied.add(index);
          const key = imageBlobKey(from, row.index);
          const packed = await requestDone(metaStore.get(key));
          metaStore.delete(key);
          const bytes = copyBytes(packed?.blob) || copyBytes(row.blob);
          imageStore.delete([from, row.index]);
          imageStore.put(withoutBlob({ ...row, messageId: keep, index, offset: 0 }));
          if (bytes) metaStore.put({ key: imageBlobKey(keep, index), blob: bytes });
        }
      }
    }

    const byId = new Map(rows.map(row => [row.id, row]));
    for (const id of dropToKeep.keys()) {
      const existing = byId.get(id);
      if (!existing) continue;
      deleteTokens(tokenStore, tokensForDelete(existing.body), convId, id);
      msgStore.delete(id);
      // All image rows were moved above in this same transaction. No second
      // cursor sweep per deleted message, and no bitmap bytes were discarded.
    }

    const orderRow = await requestDone(metaStore.get(ORDER_PREFIX + convId));
    const nextOrder = (orderRow?.ids || []).filter((id) => id && !dropToKeep.has(id));
    if (orderRow) metaStore.put({ ...orderRow, ids: nextOrder });

    // Counts and pointers only. updatedAt / updatedAtSource stay exactly as they
    // were: the last progress write already stamped the conversation "just now".
    conv.messageCount = await requestDone(msgStore.index("conversationId").count(convId));
    const droppedTail = !!(conv.tailMessageId && dropToKeep.has(conv.tailMessageId));
    if (droppedTail) conv.tailMessageId = dropToKeep.get(conv.tailMessageId);
    if (conv.captureBaselineTail && dropToKeep.has(conv.captureBaselineTail)) {
      conv.captureBaselineTail = dropToKeep.get(conv.captureBaselineTail);
    }
    // The sidebar preview may have been the last progress rewrite. Show the kept
    // settled turn instead. A kept progress row (no settled tail) is left alone.
    if (droppedTail && conv.tailMessageId) {
      const keptTail = await requestDone(msgStore.get(conv.tailMessageId));
      if (keptTail && typeof keptTail.body === "string" && keptTail.body.trim() &&
          !isProgressText(keptTail.body)) {
        conv.lastPreview = clipPreviewSource(keptTail.body);
        conv.lastPreviewRole = keptTail.role;
      }
    }
    convStore.put(conv);
    await completed;
    return { dropped: dropToKeep.size, groups: plans.length };
  } catch (error) {
    try { tx.abort(); } catch { /* already completed or aborted */ }
    await completed.catch(() => {});
    throw error;
  }
}

/**
 * Fold stored image-generation progress duplicates on every chatgpt
 * conversation. Best-effort per conversation: one unreadable row must not
 * strand the rest. Returns { merged, dropped, done }.
 */
export async function repairProgressDuplicates() {
  return withDb(async (db) => {
    const flagTx = db.transaction("meta", "readonly");
    const flag = await requestDone(flagTx.objectStore("meta").get(PROGRESS_REPAIR_KEY));
    if (flag?.done) return { merged: 0, dropped: 0, done: true };

    const ids = [];
    const convTx = db.transaction("conversations", "readonly");
    await cursorEach(
      convTx.objectStore("conversations").index("platform"),
      { range: IDBKeyRange.only("chatgpt") },
      (row) => { if (row?.id) ids.push(row.id); },
    );

    let merged = 0;
    let dropped = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const res = await repairConversationProgress(db, id);
        merged += res.groups;
        dropped += res.dropped;
      } catch {
        // One unreadable conversation must not strand the rest.
        failed += 1;
      }
    }

    const doneTx = db.transaction("meta", "readwrite");
    doneTx.objectStore("meta").put({
      key: PROGRESS_REPAIR_KEY,
      done: failed === 0,
      merged,
      dropped,
      at: Date.now(),
    });
    await txDone(doneTx);
    if (dropped) {
      try { console.log(`[Chatseek] progress repair merged=${merged} dropped=${dropped}`); }
      catch { /* missing console must not stop the tidy */ }
    }
    return { merged, dropped, done: failed === 0 };
  });
}

let progressRepairPromise = null;

/** Share a pending/successful repair; a failed attempt remains retryable. */
export function ensureProgressRepair() {
  if (!progressRepairPromise) {
    progressRepairPromise = repairProgressDuplicates().then((result) => {
      if (!result.done) progressRepairPromise = null;
      return result;
    }).catch(() => { progressRepairPromise = null; return null; });
  }
  return progressRepairPromise;
}
