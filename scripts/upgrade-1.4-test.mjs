import "fake-indexeddb/auto";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function requestDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Schema and a row as 1.3.0 (DB version 2) wrote them: preview fields, meta,
// no archived property and no token conversation index.
const legacyId = "chatgpt:12121212-1212-4121-8121-121212121212";
const v2 = await new Promise((resolve, reject) => {
  const req = indexedDB.open("chatseek", 2);
  req.onupgradeneeded = () => {
    const db = req.result;
    const conv = db.createObjectStore("conversations", { keyPath: "id" });
    conv.createIndex("updatedAt", "updatedAt");
    conv.createIndex("platform", "platform");
    const msg = db.createObjectStore("messages", { keyPath: "id" });
    msg.createIndex("conversationId", "conversationId");
    db.createObjectStore("tokenMap", { keyPath: ["token", "conversationId", "source"] });
    db.createObjectStore("meta", { keyPath: "key" });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

{
  const tx = v2.transaction(["conversations", "messages", "tokenMap", "meta"], "readwrite");
  tx.objectStore("conversations").put({
    id: legacyId,
    platform: "chatgpt",
    platformId: "12121212-1212-4121-8121-121212121212",
    title: "Preview survived",
    url: "https://chatgpt.com/c/12121212-1212-4121-8121-121212121212",
    createdAt: Date.UTC(2026, 3, 2),
    updatedAt: Date.UTC(2026, 3, 4),
    updatedAtSource: "page-exact",
    firstSeenAt: Date.UTC(2026, 3, 1),
    messageCount: 1,
    tailMessageId: `${legacyId}:u`,
    firstUserPreview: "first prompt about cedar",
    firstUserMessageId: `${legacyId}:u`,
    lastPreview: "assistant cedar reply",
    lastPreviewRole: "assistant",
  });
  tx.objectStore("messages").put({
    id: `${legacyId}:u`,
    conversationId: legacyId,
    role: "user",
    body: "cedarneedle from one three",
    capturedAt: Date.UTC(2026, 3, 4),
  });
  tx.objectStore("tokenMap").put({
    token: "cedarneedle",
    conversationId: legacyId,
    source: `${legacyId}:u`,
  });
  tx.objectStore("meta").put({
    key: "health:chatgpt",
    platform: "chatgpt",
    at: Date.UTC(2026, 3, 4),
    pathKind: "conversation",
    sidebarCount: 2,
    messageCount: 1,
    selector: "[data-turn]",
    warn: false,
  });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
assert(v2.version === 2, "fixture should be a 1.3.0 database");
v2.close();

const db = await import("../src/db.js");
const handle = await db.openDb();
assert(handle.version === 4, `1.3.0 database should upgrade to 4, got ${handle.version}`);
assert(handle.objectStoreNames.contains("images"), "upgrade should add the images store");
const convStore = handle.transaction("conversations").objectStore("conversations");
assert(convStore.indexNames.contains("updatedAt") && convStore.indexNames.contains("platform"), "old indexes stay");
assert(
  handle.transaction("tokenMap").objectStore("tokenMap").indexNames.contains("conversationId"),
  "token index added for local removal",
);

const row = await requestDone(handle.transaction("conversations").objectStore("conversations").get(legacyId));
assert(row.title === "Preview survived", "title survived");
assert(row.firstUserPreview === "first prompt about cedar", "preview survived");
assert(row.lastPreview === "assistant cedar reply", "last preview survived");
assert(row.updatedAtSource === "page-exact" && row.updatedAt === Date.UTC(2026, 3, 4), "page time survived");
assert(row.archived !== true && row.archiveSource == null, "a 1.3.0 row is not archived");
assert((await db.stats()).messages === 1, "messages survived");
const hits = await db.searchConversations({ query: "cedarneedle" });
assert(hits.length === 1 && hits[0].id === legacyId, "1.3.0 inverted index survived");
assert((await db.readCaptureHealth()).chatgpt?.messageCount === 1, "health meta survived");
const shown = await db.listRecent({ scope: "active" });
assert(shown.some((item) => item.id === legacyId), "upgraded rows show on the active tab");
assert((await db.listRecent({ scope: "archived" })).length === 0, "nothing is archived just because of the upgrade");

await db.removeConversation(legacyId);
assert((await db.searchConversations({ query: "cedarneedle" })).length === 0, "a 1.3.0 row can be removed");
const legacyTokens = await requestDone(
  handle.transaction("tokenMap").objectStore("tokenMap").index("conversationId").count(legacyId),
);
assert(legacyTokens === 0, "1.3.0 token rows are reachable through the new index and removed");
assert((await db.readCaptureHealth()).chatgpt?.messageCount === 1, "removing a chat keeps health meta");

console.log("upgrade-1.4-test ok", { from: 2, to: handle.version });
