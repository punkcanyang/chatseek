import "fake-indexeddb/auto";
import {
  upsertMessages,
  upsertConversations,
  searchConversations,
  stats,
  openDb,
  saveCaptureHealth,
  readCaptureHealth,
} from "../src/db.js";
import { formatActivityLabel, formatHealthEntries } from "../src/activity-time.js";

const longBody =
  "UNIQUE_NEEDLE_" + "padding".repeat(800) + "_END_MARKER_payload";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function requestDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const origTx = IDBDatabase.prototype.transaction;
const openedDuringSearch = [];
let recording = false;
IDBDatabase.prototype.transaction = function (storeNames, mode) {
  if (recording) {
    const list = Array.isArray(storeNames) ? storeNames : [storeNames];
    openedDuringSearch.push(...list);
  }
  return origTx.call(this, storeNames, mode);
};

const origGetAll = IDBObjectStore.prototype.getAll;
IDBObjectStore.prototype.getAll = function (...args) {
  if (recording && this.name === "messages") {
    throw new Error("search called getAll() on the messages store");
  }
  return origGetAll.apply(this, args);
};

const pageUpdatedAt = Date.UTC(2025, 5, 10, 12, 0, 0); // 2025-06-10

await upsertMessages(
  {
    id: "chatgpt:11111111-1111-1111-1111-111111111111",
    platform: "chatgpt",
    platformId: "11111111-1111-1111-1111-111111111111",
    title: "Alpha planning notes",
    url: "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111",
    updatedAt: pageUpdatedAt,
    createdAt: pageUpdatedAt,
  },
  [
    { id: "chatgpt:m1", role: "user", body: longBody },
    { id: "chatgpt:m2", role: "assistant", body: "Short reply about bananas." },
  ],
);

await upsertMessages(
  {
    id: "claude:22222222-2222-2222-2222-222222222222",
    platform: "claude",
    platformId: "22222222-2222-2222-2222-222222222222",
    title: "Claude travel list",
    url: "https://claude.ai/chat/22222222-2222-2222-2222-222222222222",
    updatedAt: Date.UTC(2024, 11, 1, 8, 0, 0),
  },
  [
    {
      id: "claude:m1",
      role: "user",
      body: "请帮我写一段关于京都红叶的介绍，包含哲学。",
    },
  ],
);


await upsertMessages(
  {
    id: "grok:33333333-3333-3333-3333-333333333333",
    platform: "grok",
    platformId: "33333333-3333-3333-3333-333333333333",
    title: "Grok rocket notes",
    url: "https://grok.com/c/33333333-3333-3333-3333-333333333333",
    updatedAt: Date.UTC(2025, 0, 15, 9, 30, 0),
  },
  [
    {
      id: "grok:m1",
      role: "user",
      body: "Explain STARSHIP_NEEDLE boosters without truncating this long body.",
    },
    {
      id: "grok:m2",
      role: "assistant",
      body: "STARSHIP_NEEDLE stages stack for orbital insertion.",
    },
  ],
);

const s = await stats();
assert(s.messages === 5, `expected 5 messages, got ${s.messages}`);
assert(longBody.length > 4000, "fixture must be a long message");

// Page updatedAt must survive message upsert and title-only conversation refresh.
const db = await openDb();
let row = await requestDone(
  db.transaction("conversations").objectStore("conversations")
    .get("chatgpt:11111111-1111-1111-1111-111111111111"),
);
assert(row?.updatedAt === pageUpdatedAt, `page updatedAt lost after upsertMessages: ${row?.updatedAt}`);
assert(row?.createdAt === pageUpdatedAt, `page createdAt lost: ${row?.createdAt}`);

await upsertConversations([
  {
    id: "chatgpt:11111111-1111-1111-1111-111111111111",
    platform: "chatgpt",
    platformId: "11111111-1111-1111-1111-111111111111",
    title: "Alpha planning notes (renamed)",
    url: "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111",
    // no updatedAt — title refresh must not stomp page date with Date.now()
  },
]);
row = await requestDone(
  db.transaction("conversations").objectStore("conversations")
    .get("chatgpt:11111111-1111-1111-1111-111111111111"),
);
assert(
  row?.updatedAt === pageUpdatedAt,
  `title refresh overwrote page updatedAt with ${row?.updatedAt}`,
);
assert(row?.title.includes("renamed"), "title should update on refresh");

// Explicit newer page date should replace the old one.
const newer = Date.UTC(2025, 7, 1, 10, 0, 0);
await upsertConversations([
  {
    id: "chatgpt:11111111-1111-1111-1111-111111111111",
    platform: "chatgpt",
    platformId: "11111111-1111-1111-1111-111111111111",
    title: "Alpha planning notes (renamed)",
    url: "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111",
    updatedAt: newer,
  },
]);
row = await requestDone(
  db.transaction("conversations").objectStore("conversations")
    .get("chatgpt:11111111-1111-1111-1111-111111111111"),
);
assert(row?.updatedAt === newer, `incoming page updatedAt not applied: ${row?.updatedAt}`);

// Older builds could store a 2001 date parsed from a title like "Top 10".
const bogusId = "chatgpt:44444444-4444-4444-4444-444444444444";
const bogus = Date.UTC(2001, 9, 1);
{
  const tx = db.transaction("conversations", "readwrite");
  tx.objectStore("conversations").put({
    id: bogusId,
    platform: "chatgpt",
    platformId: "44444444-4444-4444-4444-444444444444",
    title: "Top 10 ideas",
    url: "https://chatgpt.com/c/44444444-4444-4444-4444-444444444444",
    createdAt: bogus,
    updatedAt: bogus,
    messageCount: 0,
  });
  await new Promise((resolve) => { tx.oncomplete = resolve; });
}
const beforeRepair = Date.now();
await upsertConversations([
  {
    id: bogusId,
    platform: "chatgpt",
    platformId: "44444444-4444-4444-4444-444444444444",
    title: "Top 10 ideas",
    url: "https://chatgpt.com/c/44444444-4444-4444-4444-444444444444",
    updatedAt: bogus,
  },
]);
row = await requestDone(
  db.transaction("conversations").objectStore("conversations").get(bogusId),
);
assert(
  row.updatedAt >= beforeRepair && row.createdAt >= beforeRepair,
  `pre-2020 dates should fall back to capture time, got ${row.updatedAt}/${row.createdAt}`,
);

const closed = await openDb();
closed.close();
const afterClose = await searchConversations({ query: "bananas" });
assert(
  afterClose.length === 1 && afterClose[0].platform === "chatgpt",
  "search should work after the IndexedDB connection closes",
);

const byStar = await searchConversations({ query: "star" });
assert(
  byStar.length === 0,
  `prefix token star should not match starship, got ${byStar.length}`,
);
const byPlan = await searchConversations({ query: "plan" });
assert(
  byPlan.length === 0,
  `prefix plan should not match planning, got ${byPlan.map((c) => c.title).join("|")}`,
);
const byStarship = await searchConversations({ query: "StArShIp" });
assert(
  byStarship.length === 1 && byStarship[0].platform === "grok",
  "case-insensitive whole word should hit Grok",
);
const byNotes = await searchConversations({ query: "notes" });
assert(
  byNotes.some((c) => c.id.startsWith("chatgpt:")),
  "whole word notes should match the ChatGPT title",
);
const byMulti = await searchConversations({ query: "planning bananas" });
assert(
  byMulti.length === 1 && byMulti[0].id.startsWith("chatgpt:"),
  "multi-word query should match across title and body in one conversation",
);
const byCross = await searchConversations({ query: "京都 STARSHIP_NEEDLE" });
assert(
  byCross.length === 0,
  "tokens that live in different conversations must not combine into a hit",
);

recording = true;
const byNeedle = await searchConversations({ query: "UNIQUE_NEEDLE" });
const byEnd = await searchConversations({ query: "END_MARKER" });
const byCjk = await searchConversations({ query: "京都" });
const byGrok = await searchConversations({ query: "STARSHIP_NEEDLE", platform: "grok" });
recording = false;

assert(
  byNeedle.length === 1 && byNeedle[0].id.startsWith("chatgpt:"),
  "long-message needle should hit ChatGPT conversation",
);
assert(byEnd.length === 1, "token near the end of a long body should hit");
assert(
  byCjk.some((row) => row.platform === "claude"),
  "CJK tokens in message body should hit",
);
assert(
  byGrok.length === 1 && byGrok[0].platform === "grok",
  "platform filter should hit Grok conversation",
);
assert(
  !openedDuringSearch.includes("messages"),
  `search opened messages store: ${openedDuringSearch.join(",")}`,
);

function convOf(id, extra = {}) {
  const platformId = id.slice(id.indexOf(":") + 1);
  return {
    id,
    platform: "chatgpt",
    platformId,
    title: extra.title || `Time ${platformId.slice(0, 4)}`,
    url: `https://chatgpt.com/c/${platformId}`,
    ...extra,
  };
}

async function readConv(id) {
  const handle = await openDb();
  return requestDone(handle.transaction("conversations").objectStore("conversations").get(id));
}

const exactId = "chatgpt:55555555-5555-4555-8555-555555555555";
const exactAt = Date.UTC(2026, 8, 7, 18, 0, 0);
await upsertConversations([
  convOf(exactId, {
    title: "Exact September chat",
    updatedAt: exactAt,
    updatedAtSource: "page-exact",
  }),
]);
const bucketAt = Date.UTC(2026, 7, 23, 12, 0, 0);
await upsertConversations([
  convOf(exactId, {
    title: "Exact September chat",
    updatedAt: bucketAt,
    updatedAtSource: "page-bucket",
  }),
]);
let timed = await readConv(exactId);
assert(timed.updatedAt === exactAt, `bucket overwrote exact time: ${timed.updatedAt}`);
assert(timed.updatedAtSource === "page-exact", "exact source was downgraded");

const olderExact = Date.UTC(2026, 0, 2, 8, 0, 0);
await upsertConversations([
  convOf(exactId, {
    title: "Exact September chat",
    updatedAt: olderExact,
    updatedAtSource: "page-exact",
  }),
]);
timed = await readConv(exactId);
assert(timed.updatedAt === exactAt, "older page-exact must not replace a newer one");

const futureId = "chatgpt:56565656-5656-4565-8565-565656565656";
await upsertConversations([
  convOf(futureId, {
    title: "Today bucket",
    updatedAt: Date.now() + 3 * 3600000,
    updatedAtSource: "page-bucket",
  }),
]);
timed = await readConv(futureId);
assert(timed.updatedAt <= Date.now(), "Today-style bucket must not land in the future");
assert(timed.updatedAtSource === "page-bucket", "future clamp should keep the bucket source");

const chunkId = "chatgpt:66666666-6666-4666-8666-666666666666";
const c1 = `${chunkId}:a`;
const c2 = `${chunkId}:b`;
const c3 = `${chunkId}:c`;
await upsertMessages(
  convOf(chunkId, { title: "Chunked old thread" }),
  [{ id: c1, role: "user", body: "chunk one already on the page" }],
  { pageMessageIds: [c1, c2], captureId: "capture-initial" },
);
await upsertMessages(
  convOf(chunkId, { title: "Chunked old thread" }),
  [{ id: c2, role: "assistant", body: "chunk two already on the page" }],
  { pageMessageIds: [c1, c2], captureId: "capture-initial" },
);
timed = await readConv(chunkId);
assert(timed.updatedAtSource !== "observed", "first ingest of an old thread must not be observed");
const beforeAppend = timed.updatedAt;
await new Promise((resolve) => setTimeout(resolve, 20));
await upsertMessages(
  convOf(chunkId, { title: "Chunked old thread" }),
  [{ id: c3, role: "user", body: "brand new tail after the stored messages" }],
  { pageMessageIds: [c1, c2, c3], captureId: "capture-append" },
);
timed = await readConv(chunkId);
assert(timed.updatedAtSource === "observed", "a new tail message should be observed");
assert(timed.updatedAt >= beforeAppend, "observed activity should move last-activity time forward");

const scrollId = "chatgpt:67676767-6767-4676-8676-676767676767";
const s1 = `${scrollId}:a`;
const s2 = `${scrollId}:b`;
const s0 = `${scrollId}:old`;
await upsertMessages(
  convOf(scrollId, { title: "Scrollback thread" }),
  [
    { id: s1, role: "user", body: "visible start" },
    { id: s2, role: "assistant", body: "visible end" },
  ],
  { pageMessageIds: [s1, s2], captureId: "scroll-init" },
);
const scrollFrozen = await readConv(scrollId);
await upsertMessages(
  convOf(scrollId, { title: "Scrollback thread" }),
  [{ id: s0, role: "user", body: "older message loaded by scrolling up" }],
  { pageMessageIds: [s0, s1, s2], captureId: "scroll-up" },
);
timed = await readConv(scrollId);
assert(timed.updatedAtSource === scrollFrozen.updatedAtSource, "scrollback must not change the time source");
assert(timed.updatedAt === scrollFrozen.updatedAt, "scrollback must not move last-activity time");

const anchorAt = Date.now() - 10 * 86400000;
const topId = "chatgpt:77777777-7777-4777-8777-777777777777";
const midId = "chatgpt:88888888-8888-4888-8888-888888888888";
const botId = "chatgpt:99999999-9999-4999-8999-999999999999";
await upsertConversations([
  convOf(topId, { title: "Sidebar newer guess", sidebarIndex: 0 }),
  convOf(midId, {
    title: "Sidebar exact anchor",
    sidebarIndex: 1,
    updatedAt: anchorAt,
    updatedAtSource: "page-exact",
  }),
  convOf(botId, { title: "Sidebar older guess", sidebarIndex: 2 }),
]);
const top = await readConv(topId);
const mid = await readConv(midId);
const bot = await readConv(botId);
assert(top.updatedAtSource === "sidebar-rank", "undated sidebar neighbor should be estimated");
assert(bot.updatedAtSource === "sidebar-rank", "older sidebar neighbor should be estimated");
assert(top.updatedAt > mid.updatedAt && top.updatedAt <= Date.now(), "estimate should sit between now and the anchor");
assert(bot.updatedAt < mid.updatedAt, "lower sidebar rank should sort older");
assert(mid.updatedAt === anchorAt && mid.updatedAtSource === "page-exact", "anchor time must stay exact");
const approx = formatActivityLabel(top, Date.now(), "zh");
const exactLabel = formatActivityLabel(mid, Date.now(), "zh");
assert(approx.text.startsWith("約 "), `estimated time should be marked 約, got ${approx.text}`);
assert(!exactLabel.text.includes("約"), "exact time should not be marked 約");
assert(approx.title.includes("側欄順序"), "approx tooltip should name the sidebar estimate");

const unknownNew = "chatgpt:abababab-abab-4aba-8aba-abababababab";
const unknownOld = "chatgpt:cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";
await upsertConversations([
  convOf(unknownNew, { title: "No clock newer", sidebarIndex: 0 }),
  convOf(unknownOld, { title: "No clock older", sidebarIndex: 1 }),
]);
const unknownA = await readConv(unknownNew);
const unknownB = await readConv(unknownOld);
assert(unknownA.updatedAtSource === "first-seen" && unknownB.updatedAtSource === "first-seen", "no anchors means first-seen");
assert(unknownA.updatedAt > unknownB.updatedAt, "unknown rows should keep sidebar order");
assert(unknownA.updatedAt < Date.UTC(2021, 0, 1), "unknown sort keys must not look like recent activity");
const unknownLabel = formatActivityLabel(unknownA, Date.now(), "zh");
assert(
  unknownLabel.text.startsWith("日期未知（收錄於 "),
  `unknown date label drifted: ${unknownLabel.text}`,
);
assert(!unknownLabel.text.includes("約"), "unknown date must not look estimated");

const longSidebar = [];
for (let i = 0; i < 60; i++) {
  const pid = `5e5e5e5e-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const row = convOf(`chatgpt:${pid}`, { title: `Long sidebar ${i}`, sidebarIndex: i });
  if (i === 10) Object.assign(row, { updatedAt: Date.now() - 2 * 86400000, updatedAtSource: "page-exact" });
  if (i === 50) Object.assign(row, { updatedAt: Date.now() - 20 * 86400000, updatedAtSource: "page-exact" });
  longSidebar.push(row);
}
await upsertConversations(longSidebar);
const longRows = [];
for (const row of longSidebar) longRows.push(await readConv(row.id));
for (let i = 1; i < longRows.length; i++) {
  assert(
    longRows[i].updatedAt < longRows[i - 1].updatedAt,
    `sidebar estimate broke order at row ${i}: ${longRows[i].updatedAtSource}`,
  );
}

await saveCaptureHealth("chatgpt", {
  at: Date.now(),
  pathKind: "conversation",
  sidebarCount: 4,
  messageCount: 0,
  selector: "none",
  warn: true,
});
await saveCaptureHealth("claude", {
  at: Date.now(),
  pathKind: "conversation",
  sidebarCount: 2,
  messageCount: 3,
  selector: "[data-testid=assistant-message]",
  warn: false,
});
const health = await readCaptureHealth();
assert(health.chatgpt?.warn === true, "health warning should persist");
assert(health.claude?.messageCount === 3, "health counts should persist");
const healthLines = formatHealthEntries(health, Date.now(), "zh");
assert(
  healthLines.some((line) => line.platform === "chatgpt" && line.warn && line.text.includes("頁面可能改版")),
  "side panel should show the redesign hint",
);
assert(
  healthLines.some((line) => line.platform === "claude" && line.text.includes("最後收錄") && line.text.includes("3 則訊息")),
  "side panel should show the last capture line",
);

console.log("search-test ok", {
  longBody: longBody.length,
  stores: [...new Set(openedDuringSearch)],
  stats: s,
  pageUpdatedAtPreserved: true,
});
