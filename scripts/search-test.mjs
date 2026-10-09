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
import {
  applySidebarEstimates,
  calendarDay,
  formatAbsoluteStamp,
  formatActivityLabel,
  formatDayStamp,
  formatHealthEntries,
} from "../src/activity-time.js";

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
    { id: "chatgpt:m2", role: "assistant", body: "Short reply about bananas. FOURSTACK" },
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
      body: "请帮我写一段关于京都红叶的介绍，包含哲学。 FOURSTACK",
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
      body: "STARSHIP_NEEDLE stages stack for orbital insertion. FOURSTACK",
    },
  ],
);

const geminiUpdated = Date.UTC(2025, 8, 2, 15, 0, 0);
await upsertMessages(
  {
    id: "gemini:a1b2c3d4e5f67890",
    platform: "gemini",
    platformId: "a1b2c3d4e5f67890",
    title: "Gemini orchid notes",
    url: "https://gemini.google.com/u/1/app/a1b2c3d4e5f67890",
    updatedAt: geminiUpdated,
    createdAt: geminiUpdated,
    updatedAtSource: "page-exact",
  },
  [
    {
      id: "gemini:m1",
      role: "user",
      body: "Where is GEMINI_ORCHID_NEEDLE planted?",
    },
    {
      id: "gemini:m2",
      role: "assistant",
      body: "GEMINI_ORCHID_NEEDLE grows beside FOURSTACK in the greenhouse.",
    },
  ],
);

const s = await stats();
assert(s.messages === 7, `expected 7 messages, got ${s.messages}`);
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
const byFour = await searchConversations({ query: "FOURSTACK" });
const fourPlatforms = new Set(byFour.map((row) => row.platform));
assert(
  byFour.length === 4 &&
    fourPlatforms.has("chatgpt") &&
    fourPlatforms.has("claude") &&
    fourPlatforms.has("grok") &&
    fourPlatforms.has("gemini"),
  `four platforms should match FOURSTACK, got ${byFour.map((row) => row.platform).join(",")}`,
);
const onlyGemini = await searchConversations({ query: "FOURSTACK", platform: "gemini" });
assert(
  onlyGemini.length === 1 &&
    onlyGemini[0].platform === "gemini" &&
    onlyGemini[0].url.includes("/u/1/app/"),
  "Gemini filter should return only the Gemini chat",
);
const byOrchid = await searchConversations({ query: "GEMINI_ORCHID_NEEDLE" });
assert(
  byOrchid.length === 1 && byOrchid[0].platform === "gemini",
  "Gemini-only needle should not hit the other platforms",
);
const orchidOnChatgpt = await searchConversations({
  query: "GEMINI_ORCHID_NEEDLE",
  platform: "chatgpt",
});
assert(orchidOnChatgpt.length === 0, "ChatGPT filter must not return the Gemini chat");
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

function absoluteStamp(ts, locale = "en") {
  return formatAbsoluteStamp(ts, locale);
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
const observedLabel = formatActivityLabel(timed, Date.now(), "zh-TW");
assert(
  !observedLabel.before && !observedLabel.approx && !observedLabel.text.includes("約") && !observedLabel.text.includes("早於"),
  `observed time should stay a normal label, got ${observedLabel.text}`,
);

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
assert(top.olderThanAt == null, "a row with no clock above does not store a before-bound");
assert(bot.olderThanAt === anchorAt, "the row below stores the anchor time, not the hour offset");
const aboveLabel = formatActivityLabel(top, Date.now(), "zh-TW");
const belowLabel = formatActivityLabel(bot, Date.now(), "zh-TW");
const exactLabel = formatActivityLabel(mid, Date.now(), "zh-TW");
const anchorStamp = absoluteStamp(anchorAt, "zh-TW");
assert(
  aboveLabel.unknown && aboveLabel.text.startsWith("收錄於 "),
  `no clock above should stay unknown, got ${aboveLabel.text}`,
);
assert(!aboveLabel.text.includes("約") && !aboveLabel.before, "a row above the anchor must not say 約 or 早於");
assert(belowLabel.before && belowLabel.text === `早於 ${anchorStamp}`, `below label ${belowLabel.text}`);
assert(!belowLabel.approx && !belowLabel.text.includes("約") && !belowLabel.text.includes("小時前"), belowLabel.text);
assert(belowLabel.title.includes(anchorStamp) && belowLabel.title.includes("確切"), belowLabel.title);
assert(!exactLabel.text.includes("約") && !exactLabel.before, "exact time should not be marked 約 or 早於");

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
const unknownLabel = formatActivityLabel(unknownA, Date.now(), "zh-TW");
assert(
  unknownLabel.text.startsWith("收錄於 "),
  `unknown date label drifted: ${unknownLabel.text}`,
);
assert(!unknownLabel.text.includes("約"), "unknown date must not look estimated");

const belowHans = formatActivityLabel(bot, Date.now(), "zh-CN");
const belowEn = formatActivityLabel(bot, Date.now(), "en");
const unknownHans = formatActivityLabel(unknownA, Date.now(), "zh-CN");
assert(belowHans.text === `早于 ${absoluteStamp(anchorAt, "zh-CN")}`, `Simplified before-label drifted: ${belowHans.text}`);
assert(belowEn.text === `before ${absoluteStamp(anchorAt, "en")}`, `English before-label drifted: ${belowEn.text}`);
assert(!belowHans.text.includes("约") && !belowEn.text.includes("~"), belowHans.text);
assert(unknownHans.text.startsWith("收录于 "), `Simplified unknown label drifted: ${unknownHans.text}`);
for (const [label, foreign] of [
  [belowLabel.text + belowLabel.title, /[约钟时侧栏顺录]/],
  [belowHans.text + belowHans.title, /[約鐘時側欄順錄]/],
]) {
  assert(!foreign.test(label), `label mixes Simplified and Traditional: ${label}`);
}
for (const [locale, prefix] of [
  ["zh-TW", "早於 "],
  ["zh-HK", "早於 "],
  ["zh-MO", "早於 "],
  ["zh-Hant", "早於 "],
  ["zh-CN", "早于 "],
  ["zh-SG", "早于 "],
  ["zh", "早于 "],
  ["en", "before "],
  ["en-GB", "before "],
]) {
  const label = formatActivityLabel(bot, Date.now(), locale);
  assert(label.text === `${prefix}${absoluteStamp(anchorAt, locale)}`, `${locale} → ${label.text}`);
}
assert(
  formatActivityLabel(bot, Date.now(), "fr").text === `avant ${absoluteStamp(anchorAt, "fr")}`,
  "French before-label should follow the fr catalog",
);
const later = formatActivityLabel(bot, Date.now() + 40 * 86400000, "zh-TW");
assert(later.text === belowLabel.text, "an absolute before-bound must not drift as time passes");
const bucketLabel = formatActivityLabel(
  { updatedAtSource: "page-bucket", updatedAt: Date.now() - 3 * 3600000, firstSeenAt: Date.now() },
  Date.now(),
  "zh-TW",
);
assert(bucketLabel.approx && bucketLabel.text.startsWith("約 ") && !bucketLabel.before, bucketLabel.text);

// A group instant is invented (Today = midpoint of the day so far, Yesterday =
// noon), so the label carries the group's day only, never hours or a clock.
{
  const viewAt = new Date(2026, 9, 8, 15, 0).getTime();
  const todayPoint = new Date(2026, 9, 8, 7, 30).getTime();
  const yesterdayPoint = new Date(2026, 9, 7, 12, 0).getTime();
  const weekPoint = new Date(2026, 9, 5, 12, 0).getTime();
  const oldPoint = new Date(2026, 6, 15, 12, 0).getTime();
  for (const [point, day] of [
    [todayPoint, "2026-10-08"],
    [yesterdayPoint, "2026-10-07"],
    [weekPoint, "2026-10-05"],
    [oldPoint, "2026-07-15"],
  ]) {
    const conv = { updatedAtSource: "page-bucket", updatedAt: point, firstSeenAt: viewAt };
    const hant = formatActivityLabel(conv, viewAt, "zh-TW");
    const hans = formatActivityLabel(conv, viewAt, "zh-CN");
    const en = formatActivityLabel(conv, viewAt, "en");
    assert(calendarDay(point) === day, `${calendarDay(point)} !== ${day}`);
    assert(hant.text === `約 ${formatDayStamp(point, "zh-TW")}` && hant.approx && !hant.before && !hant.unknown, hant.text);
    assert(hans.text === `约 ${formatDayStamp(point, "zh-CN")}`, hans.text);
    assert(en.text === `~ ${formatDayStamp(point, "en")}`, en.text);
    assert(hant.title === `推估：依側欄分組 · ${formatDayStamp(point, "zh-TW")}`, hant.title);
    assert(hans.title === `推估：按侧栏分组 · ${formatDayStamp(point, "zh-CN")}`, hans.title);
    assert(en.title === `Estimated from the sidebar group · ${formatDayStamp(point, "en")}`, en.title);
    for (const label of [hant, hans, en]) {
      assert(!/\d{2}:\d{2}|小時|小时|分鐘|分钟|剛剛|刚刚|ago|just now/.test(label.text + label.title), label.text + label.title);
    }
    assert(formatActivityLabel(conv, viewAt + 3 * 86400000, "zh-TW").text === hant.text, "a group label must not drift");
  }
}

const boundNow = Date.now();
const tNew = boundNow - 2 * 86400000;
const tOld = boundNow - 10 * 86400000;
const bucketAtBound = boundNow - 12 * 86400000;
const bounded = applySidebarEstimates([
  { id: "above" },
  { id: "clockNew", updatedAt: tNew, updatedAtSource: "page-exact" },
  { id: "between" },
  { id: "clockOld", updatedAt: tOld, updatedAtSource: "observed" },
  { id: "underOld" },
  { id: "bucket", updatedAt: bucketAtBound, updatedAtSource: "page-bucket" },
  { id: "underBucket" },
], boundNow);
const byBound = Object.fromEntries(bounded.map((row) => [row.id, row]));
assert(byBound.above.updatedAtSource === "sidebar-rank" && byBound.above.olderThanAt == null, "above the first clock stays estimated for sort only");
assert(byBound.above.updatedAt > byBound.clockNew.updatedAt, "row above still sorts newer");
assert(formatActivityLabel(byBound.above, boundNow, "en").text.startsWith("Saved "), formatActivityLabel(byBound.above, boundNow, "en").text);
assert(byBound.between.olderThanAt === tNew, "nearest clock above wins over the older clock");
assert(byBound.between.updatedAt < tNew && byBound.between.updatedAt > tOld, "between-anchor sort key stays interpolated");
assert(formatActivityLabel(byBound.between, boundNow, "zh-TW").text === `早於 ${absoluteStamp(tNew, "zh-TW")}`);
assert(
  formatActivityLabel(byBound.between, boundNow + 40 * 86400000, "en").text === `before ${absoluteStamp(tNew, "en")}`,
  "before-label ignores the passage of time",
);
assert(byBound.underOld.olderThanAt === tOld && byBound.underOld.updatedAt < tOld, "the lower clock is the bound once it is the nearest above");
assert(formatActivityLabel(byBound.underOld, boundNow, "zh-CN").text === `早于 ${absoluteStamp(tOld, "zh-CN")}`);
assert(byBound.bucket.updatedAtSource === "page-bucket" && byBound.bucket.olderThanAt == null, "a bucket is not given a before-bound");
assert(byBound.underBucket.olderThanAt === tOld, "a page-bucket above is not the before-anchor");
assert(
  formatActivityLabel(byBound.underOld, boundNow, "zh-TW").text ===
    formatActivityLabel(byBound.underBucket, boundNow, "zh-TW").text,
  "rows under the same clock share one before-label",
);
assert(byBound.underOld.updatedAt !== byBound.underBucket.updatedAt, "shared label must not collapse the sort keys");
for (let i = 1; i < bounded.length; i++) {
  assert(bounded[i].updatedAt < bounded[i - 1].updatedAt, `multi-anchor order broke at ${bounded[i].id}`);
}
assert(!formatActivityLabel(byBound.clockNew, boundNow, "zh-TW").text.includes("早於"), "page-exact must not render as 早於");
assert(!formatActivityLabel(byBound.clockOld, boundNow, "en").text.startsWith("before"), "observed must not render as before");

// A stored clock is a lower bound on that chat's activity. When a row below it
// carries a later time, the clock above is stale and is not an upper bound.
const staleAt = boundNow - 3 * 86400000;
const freshBelowAt = boundNow - 3600000;
const stale = Object.fromEntries(applySidebarEstimates([
  { id: "top", updatedAt: boundNow - 1800000, updatedAtSource: "page-exact" },
  { id: "underTop" },
  { id: "staleClock", updatedAt: staleAt, updatedAtSource: "observed" },
  { id: "underStale" },
  { id: "freshBelow", updatedAt: freshBelowAt, updatedAtSource: "observed" },
  { id: "underFresh" },
], boundNow).map((row) => [row.id, row]));
assert(stale.underStale.olderThanAt === boundNow - 1800000, "a contradicted clock falls back to the next trustworthy clock above");
assert(stale.underFresh.olderThanAt === freshBelowAt, "the newest clock is still the bound for rows under it");
assert(stale.underTop.olderThanAt === boundNow - 1800000, stale.underTop.olderThanAt);
const onlyStale = Object.fromEntries(applySidebarEstimates([
  { id: "staleClock", updatedAt: staleAt, updatedAtSource: "observed" },
  { id: "x" },
  { id: "freshBelow", updatedAt: freshBelowAt, updatedAtSource: "observed" },
  { id: "y" },
  { id: "laterBucket", updatedAt: freshBelowAt - 3600000, updatedAtSource: "page-bucket" },
], boundNow).map((row) => [row.id, row]));
assert(onlyStale.x.olderThanAt == null, `a row above a later clock must not say before the stale clock: ${onlyStale.x.olderThanAt}`);
const xLabel = formatActivityLabel(onlyStale.x, boundNow, "zh-TW");
assert(xLabel.unknown && xLabel.text.startsWith("收錄於 ") && !xLabel.text.includes("早於"), xLabel.text);
assert(onlyStale.y.olderThanAt === freshBelowAt, "rows under the fresh clock still get it");
const bucketVeto = Object.fromEntries(applySidebarEstimates([
  { id: "clock", updatedAt: boundNow - 2 * 86400000, updatedAtSource: "page-exact" },
  { id: "x" },
  { id: "today", updatedAt: boundNow - 3600000, updatedAtSource: "page-bucket" },
], boundNow).map((row) => [row.id, row]));
assert(bucketVeto.x.olderThanAt == null, "a later group time below vetoes an older clock above");
for (const rows of [bounded, Object.values(stale), Object.values(onlyStale), Object.values(bucketVeto)]) {
  for (const row of rows) {
    if (row.olderThanAt == null) continue;
    assert(row.updatedAt < row.olderThanAt, `${row.id} sorts at ${row.updatedAt}, after its before-bound ${row.olderThanAt}`);
  }
}

const staleDbId = "chatgpt:19191919-1919-4191-8191-191919191919";
const midDbId = "chatgpt:1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a";
const freshDbId = "chatgpt:1b1b1b1b-1b1b-41b1-81b1-1b1b1b1b1b1b";
await upsertConversations([
  convOf(staleDbId, { title: "Stale observed clock", updatedAt: staleAt, updatedAtSource: "observed" }),
  convOf(freshDbId, { title: "Fresh observed clock", updatedAt: freshBelowAt, updatedAtSource: "observed" }),
]);
await upsertConversations([
  convOf(staleDbId, { title: "Stale observed clock", sidebarIndex: 0 }),
  convOf(midDbId, { title: "Between stale and fresh", sidebarIndex: 1 }),
  convOf(freshDbId, { title: "Fresh observed clock", sidebarIndex: 2 }),
]);
const storedMid = await readConv(midDbId);
assert(storedMid.olderThanAt == null, `IndexedDB stored a before-bound from a stale clock: ${storedMid.olderThanAt}`);
assert(formatActivityLabel(storedMid, Date.now(), "zh-CN").text.startsWith("收录于 "), formatActivityLabel(storedMid, Date.now(), "zh-CN").text);
assert((await readConv(staleDbId)).updatedAt === staleAt, "the stale clock itself is not rewritten");

const farId = "chatgpt:15151515-1515-4151-8151-151515151515";
const betweenId = "chatgpt:18181818-1818-4181-8181-181818181818";
const nearId = "chatgpt:16161616-1616-4161-8161-161616161616";
const lowId = "chatgpt:17171717-1717-4171-8171-171717171717";
const farAt = boundNow - 4 * 86400000;
const nearAt = boundNow - 9 * 86400000;
await upsertConversations([
  convOf(farId, { title: "Far clock anchor", sidebarIndex: 0, updatedAt: farAt, updatedAtSource: "page-exact" }),
  convOf(betweenId, { title: "Between two clocks", sidebarIndex: 1 }),
  convOf(nearId, { title: "Near clock anchor", sidebarIndex: 2, updatedAt: nearAt, updatedAtSource: "observed" }),
  convOf(lowId, { title: "Below both clocks", sidebarIndex: 3 }),
]);
const storedBetween = await readConv(betweenId);
const storedLow = await readConv(lowId);
assert(storedBetween.olderThanAt === farAt, `IndexedDB kept the farther clock: ${storedBetween.olderThanAt}`);
assert(storedLow.olderThanAt === nearAt, `IndexedDB kept the farther clock for the bottom row: ${storedLow.olderThanAt}`);
assert(formatActivityLabel(storedBetween, Date.now(), "en").text === `before ${absoluteStamp(farAt, "en")}`);
assert(formatActivityLabel(storedLow, Date.now(), "zh-TW").text === `早於 ${absoluteStamp(nearAt, "zh-TW")}`);
assert(storedBetween.updatedAt < farAt && storedBetween.updatedAt > nearAt, "stored sort key stays between the two clocks");
await upsertConversations([
  convOf(lowId, {
    title: "Below both clocks",
    updatedAt: nearAt - 1000,
    updatedAtSource: "page-exact",
  }),
]);
const promoted = await readConv(lowId);
assert(promoted.updatedAtSource === "page-exact" && promoted.olderThanAt == null, "a higher-confidence time clears the before-bound");
assert(!formatActivityLabel(promoted, Date.now(), "zh-CN").text.includes("早于"), "promoted exact time must not stay 早于");

const legacyRankId = "chatgpt:12121212-1212-4121-8121-121212121212";
const legacyExactId = "chatgpt:13131313-1313-4131-8131-131313131313";
const legacySaved = new Date(2026, 9, 1, 8, 30).getTime();
const legacyEstimate = boundNow - 5 * 3600000;
const legacyExactAt = boundNow - 2 * 3600000;
{
  const handle = await openDb();
  const tx = handle.transaction("conversations", "readwrite");
  const store = tx.objectStore("conversations");
  store.put({
    id: legacyRankId,
    platform: "chatgpt",
    platformId: "12121212-1212-4121-8121-121212121212",
    title: "StoredLikeOneTwoZero",
    url: "https://chatgpt.com/c/12121212-1212-4121-8121-121212121212",
    updatedAt: legacyEstimate,
    updatedAtSource: "sidebar-rank",
    firstSeenAt: legacySaved,
    createdAt: legacySaved,
    messageCount: 0,
  });
  store.put({
    id: legacyExactId,
    platform: "chatgpt",
    platformId: "13131313-1313-4131-8131-131313131313",
    title: "ExactLikeOneTwoZero",
    url: "https://chatgpt.com/c/13131313-1313-4131-8131-131313131313",
    updatedAt: legacyExactAt,
    updatedAtSource: "page-exact",
    firstSeenAt: legacySaved,
    createdAt: legacyExactAt,
    messageCount: 0,
  });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
const storedRank = await readConv(legacyRankId);
assert(storedRank.olderThanAt == null && storedRank.updatedAt === legacyEstimate, "a 1.2.0 sidebar-rank row is readable and not rewritten on open");
const hits120 = await searchConversations({ query: "StoredLikeOneTwoZero" });
assert(hits120.length === 1 && hits120[0].id === legacyRankId, "1.2.0 row still matches search");
const rankLabel = formatActivityLabel(hits120[0], Date.now(), "zh-TW");
const rankHans = formatActivityLabel(hits120[0], Date.now(), "zh-CN");
const rankEn = formatActivityLabel(hits120[0], Date.now(), "en");
assert(rankLabel.unknown && rankLabel.text.startsWith("收錄於 "), rankLabel.text);
assert(rankHans.unknown && rankHans.text.startsWith("收录于 "), rankHans.text);
assert(rankEn.unknown && rankEn.text.startsWith("Saved "), rankEn.text);
assert(!rankLabel.text.includes("約") && !rankLabel.text.includes("早於"), rankLabel.text);
const exact120 = formatActivityLabel(await readConv(legacyExactId), Date.now(), "zh-TW");
assert(!exact120.before && !exact120.approx && !exact120.unknown, `1.2.0 exact row drifted: ${exact120.text}`);
assert(exact120.text.includes("小時前") || exact120.text.includes("分鐘前"), exact120.text);
const freshAnchorId = "chatgpt:14141414-1414-4141-8141-141414141414";
const freshAt = boundNow - 26 * 3600000;
await upsertConversations([
  convOf(freshAnchorId, {
    title: "Fresh clock above legacy",
    sidebarIndex: 0,
    updatedAt: freshAt,
    updatedAtSource: "observed",
  }),
  convOf(legacyRankId, { title: "StoredLikeOneTwoZero", sidebarIndex: 1 }),
]);
const rescanned = await readConv(legacyRankId);
assert(rescanned.updatedAtSource === "sidebar-rank" && rescanned.olderThanAt === freshAt, "rescan stores the new clock above");
assert(rescanned.updatedAt < freshAt, "rescan keeps the row sorted older than the clock");
assert(formatActivityLabel(rescanned, Date.now(), "zh-TW").text === `早於 ${absoluteStamp(freshAt, "zh-TW")}`);
assert(formatActivityLabel(await readConv(legacyExactId), Date.now(), "en").text !== `before ${absoluteStamp(freshAt, "en")}`);

const lastYear = new Date(new Date().getFullYear() - 1, 5, 10, 9, 30).getTime();
const oldUnknown = formatActivityLabel(
  { updatedAtSource: "first-seen", updatedAt: lastYear, firstSeenAt: lastYear },
  Date.now(),
  "zh-TW",
);
assert(
  oldUnknown.text.includes(`${new Date(lastYear).getFullYear()}/06/10`),
  `a saved stamp from another year needs the year: ${oldUnknown.text}`,
);

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
const healthLines = formatHealthEntries(health, Date.now(), "zh-TW");
assert(
  healthLines.some((line) => line.platform === "chatgpt" && line.warn && line.text.includes("頁面可能改版")),
  "side panel should show the redesign hint",
);
assert(
  healthLines.some((line) => line.platform === "claude" && line.text.includes("最後收錄") && line.text.includes("3 則訊息")),
  "side panel should show the last capture line",
);
const healthHans = formatHealthEntries(health, Date.now(), "zh-CN");
assert(
  healthHans.some((line) => line.platform === "chatgpt" && line.text.includes("页面可能改版，请回报")) &&
    healthHans.some((line) => line.platform === "claude" && line.text.includes("最后收录") && line.text.includes("3 条消息")),
  `Simplified health lines drifted: ${healthHans.map((line) => line.text).join(" | ")}`,
);

const geminiStored = await readConv("gemini:a1b2c3d4e5f67890");
assert(geminiStored.updatedAt === geminiUpdated, "gemini page time should be stored");
assert(
  geminiStored.updatedAtSource === "page-exact",
  `gemini time should stay page-exact, got ${geminiStored.updatedAtSource}`,
);
assert(geminiStored.timeSource == null && geminiStored.emptyCapture == null, "old gemini date fields should not be stored");

console.log("search-test ok", {
  longBody: longBody.length,
  stores: [...new Set(openedDuringSearch)],
  stats: s,
  pageUpdatedAtPreserved: true,
});
