import "fake-indexeddb/auto";
import { CATALOG, LOCALE_ORDER } from "../src/i18n.js";
import { openDb, searchConversations, stats } from "../src/db.js";
import {
  SORT_KEY,
  activeSort,
  activityTier,
  defaultSortPref,
  messageCountOf,
  parseSortPref,
  readSortPref,
  relevanceScore,
  sortConversations,
  writeSortPref,
} from "../src/sort-list.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const exactNew = { id: "e1", updatedAt: 9000, updatedAtSource: "page-exact" };
const exactOld = { id: "e2", updatedAt: 8000, updatedAtSource: "observed" };
const approxNew = { id: "a1", updatedAt: 99000, updatedAtSource: "page-bucket" };
const approxOld = { id: "a2", updatedAt: 1000, updatedAtSource: "page-bucket" };
const beforeNew = { id: "b1", updatedAt: 100000, updatedAtSource: "sidebar-rank", olderThanAt: 1710000000000 };
const beforeOld = { id: "b2", updatedAt: 5000, updatedAtSource: "sidebar-rank", olderThanAt: 1700000000000 };
const unknownHigh = { id: "u1", updatedAt: 200000, updatedAtSource: "sidebar-rank" };
const unknownLow = { id: "u2", updatedAt: 10, updatedAtSource: "first-seen" };
const legacy = { id: "u3", updatedAt: 50, updatedAtSource: "legacy" };
const bare = { id: "u4", updatedAt: 180000 };
const tiers = [unknownHigh, beforeNew, approxNew, exactOld, unknownLow, beforeOld, exactNew, approxOld, legacy, bare];

assert(activityTier(exactNew) === 0 && activityTier(exactOld) === 0, "exact and observed share the confident tier");
assert(activityTier(approxNew) === 1, "page-bucket is 約");
assert(activityTier(beforeNew) === 2 && activityTier(beforeOld) === 2, "sidebar-rank with an anchor is 早於");
assert(activityTier(unknownHigh) === 3, "sidebar-rank without an anchor is 日期未知");
assert(activityTier(unknownLow) === 3 && activityTier(legacy) === 3 && activityTier(bare) === 3, "first-seen, legacy, and a missing source stay unknown");

const ids = (dir) => sortConversations(tiers, { field: "activity", dir }).map((row) => row.id);
assert(
  ids("desc").join() === ["e1", "e2", "a1", "a2", "b1", "b2", "u1", "u4", "u3", "u2"].join(),
  `activity newest ${ids("desc")}`,
);
assert(
  ids("asc").join() === ["e2", "e1", "a2", "a1", "b2", "b1", "u2", "u3", "u4", "u1"].join(),
  `activity oldest ${ids("asc")}`,
);
for (const dir of ["asc", "desc"]) {
  const order = ids(dir);
  const tierOf = Object.fromEntries(tiers.map((row) => [row.id, activityTier(row)]));
  for (let i = 1; i < order.length; i++) {
    assert(tierOf[order[i]] >= tierOf[order[i - 1]], `${dir} moved a lower tier ahead`);
  }
}

const captured = [
  { id: "c1", firstSeenAt: 1700000000000, updatedAt: 1710000000000, updatedAtSource: "page-exact" },
  { id: "c2", firstSeenAt: 1710000000000, updatedAt: 1600000000000, updatedAtSource: "page-exact" },
  { id: "c3", createdAt: 1690000000000, updatedAt: 1720000000000, updatedAtSource: "page-exact" },
];
assert(
  sortConversations(captured, { field: "captured", dir: "desc" }).map((row) => row.id).join() === "c2,c1,c3",
  "capture time uses firstSeenAt, not last activity",
);
assert(
  sortConversations(captured, { field: "captured", dir: "asc" }).map((row) => row.id).join() === "c3,c1,c2",
  "oldest capture first",
);

const counts = [
  { id: "m1", messageCount: 3, title: "three" },
  { id: "m0", messageCount: 0, title: "only a title" },
  { id: "m2", title: "also only a title" },
  { id: "m4", messageCount: 4, title: "four" },
];
assert(messageCountOf(counts[1]) === 0 && messageCountOf(counts[2]) === 0, "title-only counts as 0");
assert(
  sortConversations(counts, { field: "count", dir: "desc" }).map((row) => row.id).join() === "m4,m1,m0,m2",
  "more messages first, zeros tie by id",
);
assert(
  sortConversations(counts, { field: "count", dir: "asc" }).map((row) => row.id).join() === "m0,m2,m1,m4",
  "fewer messages first",
);

function titleOrder(locale, dir, names) {
  const items = names.map((title, index) => ({ id: String(index), title }));
  return sortConversations(items, { field: "title", dir, locale }).map((row) => row.title);
}
const collatorOpts = { usage: "sort", sensitivity: "variant", numeric: true };
for (const [locale, names] of [
  ["zh-CN", ["查", "阿", "八", "对话 10", "对话 2"]],
  ["ja", ["か", "あ", "い"]],
  ["de", ["Zucker", "Ärger", "Apfel", "10", "2"]],
]) {
  const collator = new Intl.Collator(locale, collatorOpts);
  const expected = names.slice().sort((a, b) => collator.compare(a, b));
  assert(titleOrder(locale, "asc", names).join("|") === expected.join("|"), `${locale} A→Z ${titleOrder(locale, "asc", names)}`);
  assert(
    titleOrder(locale, "desc", names).join("|") === expected.slice().reverse().join("|"),
    `${locale} Z→A`,
  );
}
const de = new Intl.Collator("de", collatorOpts);
const sv = new Intl.Collator("sv", collatorOpts);
assert(de.compare("Ärger", "Zucker") !== sv.compare("Ärger", "Zucker"), "de and sv disagree on ä");
assert(titleOrder("de", "asc", ["Zucker", "Ärger"])[0] === "Ärger", "German sort keeps ä with a");

const titleHit = { id: "title", title: "orchid notes" };
const bodyHit = { id: "body", title: "plain notes" };
const tokenSets = [new Set(["body"])];
titleHit.relevance = relevanceScore(titleHit, { tokenSets, titleHit: true, tokens: ["orchid"] });
bodyHit.relevance = relevanceScore(bodyHit, { tokenSets, titleHit: false, tokens: ["orchid"] });
assert(titleHit.relevance > bodyHit.relevance, "a title hit outranks a body hit");
assert(
  sortConversations([bodyHit, titleHit], { field: "relevance", dir: "desc" }).map((row) => row.id).join() === "title,body",
  "higher relevance first",
);
assert(
  sortConversations([bodyHit, titleHit], { field: "relevance", dir: "asc" }).map((row) => row.id).join() === "body,title",
  "lower relevance first",
);

const pref = defaultSortPref();
assert(activeSort(pref, { searching: false }).field === "activity", "browse default is last activity");
assert(activeSort(pref, { searching: false }).dir === "desc", "browse default is newest first");
assert(activeSort(pref, { searching: true }).field === "relevance", "search default is relevance");
pref.field = "title";
pref.dirs.title = "desc";
assert(activeSort(pref, { searching: true }).field === "relevance", "search does not take the browse field");
assert(activeSort(pref, { searching: false }).field === "title" && activeSort(pref, { searching: false }).dir === "desc", "clearing search restores the browse sort");
const memory = {
  value: null,
  getItem() { return this.value; },
  setItem(_key, value) { this.value = value; },
};
writeSortPref(pref, memory);
assert(memory.value.includes(SORT_KEY) === false && memory.value.includes('"field":"title"'), "sort is one JSON value");
const restored = readSortPref(memory);
assert(restored.field === "title" && restored.dirs.title === "desc", "reload keeps field and direction");
assert(restored.searchField === "relevance", "reload keeps the search default");
assert(parseSortPref("{").field === "activity", "bad JSON falls back");

const many = Array.from({ length: 4000 }, (_, index) => ({
  id: `n-${index}`,
  title: `对话 ${4000 - index}`,
  updatedAt: index,
  updatedAtSource: index % 4 === 0 ? "page-bucket" : "page-exact",
  messageCount: index % 9,
  firstSeenAt: 1700000000000 + index * 1000,
}));
const started = performance.now();
sortConversations(many, { field: "activity", dir: "asc" });
sortConversations(many, { field: "title", dir: "asc", locale: "zh-CN" });
sortConversations(many, { field: "count", dir: "desc" });
assert(performance.now() - started < 250, "sorting conversation records stays cheap");

const db = await openDb();
const tx = db.transaction(["conversations", "tokenMap"], "readwrite");
const convStore = tx.objectStore("conversations");
const tokenStore = tx.objectStore("tokenMap");
const stored = [
  { id: "chatgpt:exact", platform: "chatgpt", platformId: "exact", title: "Exact clock", url: "https://chatgpt.com/c/exact", updatedAt: 1710000000000, updatedAtSource: "page-exact", firstSeenAt: 1700000001000, messageCount: 2 },
  { id: "chatgpt:bucket", platform: "chatgpt", platformId: "bucket", title: "Bucket day", url: "https://chatgpt.com/c/bucket", updatedAt: 1720000000000, updatedAtSource: "page-bucket", firstSeenAt: 1700000005000, messageCount: 0 },
  { id: "chatgpt:before", platform: "chatgpt", platformId: "before", title: "Before anchor", url: "https://chatgpt.com/c/before", updatedAt: 1730000000000, updatedAtSource: "sidebar-rank", olderThanAt: 1710000000000, firstSeenAt: 1700000002000, messageCount: 5 },
  { id: "chatgpt:title", platform: "chatgpt", platformId: "title", title: "orchid notes", url: "https://chatgpt.com/c/title", updatedAt: 1700000000000, updatedAtSource: "page-exact", firstSeenAt: 1700000003000, messageCount: 0 },
  { id: "chatgpt:body", platform: "chatgpt", platformId: "body", title: "plain notes", url: "https://chatgpt.com/c/body", updatedAt: 1705000000000, updatedAtSource: "page-exact", firstSeenAt: 1700000004000, messageCount: 1 },
];
for (const row of stored) convStore.put(row);
tokenStore.put({ token: "orchid", conversationId: "chatgpt:body", source: "body" });
await new Promise((resolve, reject) => {
  tx.oncomplete = resolve;
  tx.onerror = () => reject(tx.error);
});

const byActivity = await searchConversations({
  sort: { field: "activity", dir: "desc", locale: "en" },
  limit: 10,
});
assert(
  byActivity.map((row) => row.id).join() === "chatgpt:exact,chatgpt:body,chatgpt:title,chatgpt:bucket,chatgpt:before",
  `indexed activity order ${byActivity.map((row) => row.id)}`,
);
const byCount = await searchConversations({
  sort: { field: "count", dir: "asc", locale: "en" },
  scope: "all",
  limit: 10,
});
assert(byCount[0].messageCount === 0 && byCount.at(-1).id === "chatgpt:before", "count sort reads the stored count");
const found = await searchConversations({
  query: "orchid",
  sort: { field: "relevance", dir: "desc", locale: "zh-TW" },
  limit: 10,
});
assert(found.map((row) => row.id).join() === "chatgpt:title,chatgpt:body", `relevance ${found.map((row) => row.id)}`);
const reversed = await searchConversations({
  query: "orchid",
  sort: { field: "relevance", dir: "asc", locale: "en" },
  limit: 10,
});
assert(reversed.map((row) => row.id).join() === "chatgpt:body,chatgpt:title", "relevance direction flips");
const counted = await stats();
assert(counted.messages === 0, "sort did not read message bodies");

assert(CATALOG["zh-TW"].sortActivity === "最後對話時間", "zh-TW activity label");
assert(CATALOG["zh-TW"].sortTitle === "標題" && CATALOG["zh-TW"].sortCaptured === "收錄時間", "zh-TW title and capture");
assert(CATALOG["zh-TW"].sortCount === "訊息數" && CATALOG["zh-CN"].sortCount === "消息数", "message-count wording");
assert(CATALOG["zh-TW"].sortRelevance === "相關度" && CATALOG["zh-CN"].sortRelevance === "相关度", "relevance wording");
for (const code of LOCALE_ORDER) {
  for (const key of ["sortBy", "sortCurrent", "sortDirHint", "sortActivity", "sortTitle", "sortCaptured", "sortCount", "sortRelevance", "sortDirNewest", "sortDirOldest", "sortDirAz", "sortDirZa", "sortDirMore", "sortDirFewer"]) {
    assert(CATALOG[code][key]?.trim(), `${code}.${key} missing`);
  }
}

console.log("sort-test ok");
