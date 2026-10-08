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

// Schema and rows exactly as 1.0.2 (DB_VERSION 1) wrote them: no
// updatedAtSource, no firstSeenAt, no meta store.
const v1 = await new Promise((resolve, reject) => {
  const req = indexedDB.open("chatseek", 1);
  req.onupgradeneeded = () => {
    const db = req.result;
    const conv = db.createObjectStore("conversations", { keyPath: "id" });
    conv.createIndex("updatedAt", "updatedAt");
    conv.createIndex("platform", "platform");
    const msg = db.createObjectStore("messages", { keyPath: "id" });
    msg.createIndex("conversationId", "conversationId");
    db.createObjectStore("tokenMap", { keyPath: ["token", "conversationId", "source"] });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const legacyPage = Date.UTC(2025, 5, 10, 12, 0, 0);
const ids = [0, 1, 2].map((i) => `aaaa000${i}-0000-4000-8000-000000000000`);
const rowOf = (pid, title, at) => ({
  id: `chatgpt:${pid}`,
  platform: "chatgpt",
  platformId: pid,
  title,
  url: `https://chatgpt.com/c/${pid}`,
  createdAt: at,
  updatedAt: at,
  messageCount: 1,
});
{
  const tx = v1.transaction(["conversations", "messages", "tokenMap"], "readwrite");
  tx.objectStore("conversations").put(rowOf(ids[0], "Legacy top", Date.now() - 60000));
  tx.objectStore("conversations").put(rowOf(ids[1], "Legacy page date", legacyPage));
  tx.objectStore("conversations").put(rowOf(ids[2], "Legacy bottom", Date.now() - 30000));
  tx.objectStore("messages").put({
    id: `chatgpt:${ids[1]}:m1`,
    conversationId: `chatgpt:${ids[1]}`,
    role: "user",
    body: "legacyneedle body",
    capturedAt: Date.now(),
  });
  for (const token of ["legacyneedle", "body"]) {
    tx.objectStore("tokenMap").put({
      token,
      conversationId: `chatgpt:${ids[1]}`,
      source: `chatgpt:${ids[1]}:m1`,
    });
  }
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
v1.close();

const db = await import("../src/db.js");
const { formatActivityLabel } = await import("../src/activity-time.js");

const handle = await db.openDb();
assert(handle.version === 3, `expected DB version 3, got ${handle.version}`);
assert(handle.transaction("conversations").objectStore("conversations").indexNames.contains("archived"), "upgrade should add the archived index");
assert(handle.objectStoreNames.contains("meta"), "upgrade should add the meta store");

const hits = await db.searchConversations({ query: "legacyneedle" });
assert(hits.length === 1 && hits[0].title === "Legacy page date", "1.0.2 message index must survive the upgrade");
assert((await db.stats()).messages === 1, "upgrade must not drop messages");
assert(
  formatActivityLabel(hits[0], Date.now(), "zh-TW").unknown,
  "a 1.0.2 row cannot prove its date was a page time, so it shows as unknown until rescanned",
);
assert(Object.keys(await db.readCaptureHealth()).length === 0, "fresh meta store should be empty");

// The next sidebar scan re-estimates legacy rows from their neighbours.
const anchorAt = Date.now() - 3 * 86400000;
await db.upsertConversations([
  { ...rowOf(ids[0], "Legacy top"), sidebarIndex: 0, updatedAt: undefined },
  { ...rowOf(ids[1], "Legacy page date"), sidebarIndex: 1, updatedAt: anchorAt, updatedAtSource: "page-exact" },
  { ...rowOf(ids[2], "Legacy bottom"), sidebarIndex: 2, updatedAt: undefined },
]);
const get = (pid) => requestDone(
  handle.transaction("conversations").objectStore("conversations").get(`chatgpt:${pid}`),
);
const [top, mid, bottom] = [await get(ids[0]), await get(ids[1]), await get(ids[2])];
assert(mid.updatedAtSource === "page-exact" && mid.updatedAt === anchorAt, "page time should replace a legacy value");
assert(top.updatedAtSource === "sidebar-rank" && top.updatedAt > anchorAt, "legacy row above the anchor should be estimated newer");
assert(
  bottom.updatedAtSource === "sidebar-rank" && bottom.updatedAt < anchorAt,
  "a legacy capture-time row below the anchor must not keep its recent capture time",
);
for (const row of [top, mid, bottom]) {
  assert(row.firstSeenAt > 0, "rescanned rows should record firstSeenAt");
}

await db.saveCaptureHealth("chatgpt", { pathKind: "home", sidebarCount: 3, messageCount: 0, warn: false });
assert((await db.readCaptureHealth()).chatgpt?.sidebarCount === 3, "health should save after the upgrade");
await db.clearAll();
assert(Object.keys(await db.readCaptureHealth()).length === 0, "clearAll should drop capture health");

console.log("upgrade-test ok", { from: 1, to: handle.version });
