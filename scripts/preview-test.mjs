import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { formatHealthEntries } from "../src/activity-time.js";
import {
  attachPreviews,
  openDb,
  upsertConversations,
  upsertMessages,
} from "../src/db.js";
import {
  conversationKeyFromUrl,
  rowMatchesUrl,
  shouldAutoScroll,
} from "../src/conversation-url.js";
import {
  PREVIEW_STORE_CHARS,
  bestSnippet,
  buildPreview,
  fillHighlight,
  findMatchRanges,
  nextPreviewFields,
  selectIdlePreview,
  snippetAround,
} from "../src/preview.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

function requestDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const idle = selectIdlePreview({
  firstUserPreview: "帮我排京都行程",
  lastPreview: "好的，下面是一份很长的行程。",
  messageCount: 2,
});
assert(idle.kind === "first-user" && idle.text === "帮我排京都行程", "idle preview should be the first user prompt");
assert(
  selectIdlePreview({ lastPreview: "只有助手回复", messageCount: 1 }).kind === "last",
  "idle preview should fall back to the last message",
);
assert(
  selectIdlePreview({ title: "只有标题", messageCount: 0 }).kind === "title-only",
  "a row with no message body is title-only",
);
assert(buildPreview({ title: "草稿", messageCount: 0 }, "").kind === "title-only", "buildPreview title-only");
assert(
  buildPreview({ title: "草稿", messageCount: 0 }, "草稿").titleRanges.length === 1,
  "a title-only search hit still highlights the title",
);

const early = nextPreviewFields({}, [
  { id: "u1", role: "user", body: "EARLY prompt" },
  { id: "a1", role: "assistant", body: "assistant ending" },
], ["u1", "a1"]);
assert(early.firstUserPreview === "EARLY prompt", "page order picks the first user prompt");
assert(early.lastPreview === "assistant ending", "tail message is stored separately");
assert(early.firstUserMessageId === "u1", "first user id is stored");

const kept = nextPreviewFields(early, [
  { id: "a2", role: "assistant", body: "middle" },
  { id: "u2", role: "user", body: "LATE prompt" },
], ["a2", "u2"]);
assert(kept.firstUserPreview === "EARLY prompt", "a later window must not replace the stored first prompt");
assert(kept.lastPreview === "LATE prompt", "the tail preview still moves");

const replaced = nextPreviewFields(kept, [
  { id: "u0", role: "user", body: "TOP prompt" },
], ["u0"]);
assert(replaced.firstUserPreview === "TOP prompt", "a page that starts with a user prompt replaces the stored one");

const edited = nextPreviewFields(replaced, [
  { id: "u0", role: "user", body: "TOP prompt edited" },
], ["u0"]);
assert(edited.firstUserPreview === "TOP prompt edited", "editing the first prompt refreshes the stored preview");

const systemSkipped = nextPreviewFields({}, [
  { id: "s1", role: "system", body: "system banner" },
  { id: "u3", role: "user", body: "real question" },
], ["s1", "u3"]);
assert(systemSkipped.firstUserPreview === "real question", "system text is not the first prompt");

const long = "问".repeat(PREVIEW_STORE_CHARS + 40);
assert(
  nextPreviewFields({}, [{ id: "u", role: "user", body: long }], ["u"]).firstUserPreview.endsWith("…"),
  "stored preview is clipped",
);
assert(
  nextPreviewFields({}, [{ id: "u", role: "user", body: long }], ["u"]).firstUserPreview.length === PREVIEW_STORE_CHARS + 1,
  "clip keeps the store cap plus ellipsis",
);

const music = findMatchRanges("musicmap is not music", ["music"]);
assert(music.length === 1 && "musicmap is not music".slice(music[0][0], music[0][1]) === "music", "music must not highlight inside musicmap");
const cased = findMatchRanges("See NEEDLE here", ["needle"]);
assert("See NEEDLE here".slice(cased[0][0], cased[0][1]) === "NEEDLE", "highlight keeps the original case");
const both = findMatchRanges("京都的红叶", ["京都", "红叶"]);
assert(both.length === 2, "both CJK terms are highlighted");
assert(snippetAround("no match here", ["缺词"]) === null, "snippet is empty when the term is absent");
assert(snippetAround("cost is $5.00 today", ["$5.00"]).text.includes("$5.00"), "regex characters in the query stay literal");
assert(snippetAround("aaa", ["(.*)"]) === null, "a regex payload must not match the whole string");

const padded = `${"前".repeat(80)}红叶${"后".repeat(200)}`;
const windowed = snippetAround(padded, ["红叶"]);
assert(windowed.text.startsWith("…") && windowed.text.endsWith("…"), "a mid-body hit is windowed");
assert(windowed.text.length < padded.length, "the snippet is shorter than the message");
assert(windowed.ranges.length === 1, "the window has one highlight");
assert(windowed.text.slice(windowed.ranges[0][0], windowed.ranges[0][1]) === "红叶", "the highlight is the matched term");
assert(windowed.ranges[0][0] < 40, "the match stays near the start of the collapsed preview");

const nasty = 'before <img src=x onerror="alert(1)"> NEEDLE <script>alert(1)</script> after';
const nastySnip = snippetAround(nasty, ["NEEDLE"]);
const dom = new JSDOM("<!DOCTYPE html><div id='p'></div>");
const parent = dom.window.document.getElementById("p");
const nastyRanges = findMatchRanges(nasty, ["NEEDLE"]);
fillHighlight(parent, nasty, nastyRanges);
assert(parent.querySelector("img") === null, "chat text must not create an img");
assert(parent.querySelector("script") === null, "chat text must not create a script");
assert(parent.querySelector("mark")?.textContent === "NEEDLE", "only the match is marked");
assert(parent.textContent.includes("<img") && parent.textContent.includes("<script>"), "tags stay visible as text");
assert(parent.innerHTML.includes("&lt;img") && parent.innerHTML.includes("&lt;script&gt;"), "tags are escaped");
assert(!parent.innerHTML.includes("<img") && !parent.innerHTML.includes("<script"), "raw markup must not be in the DOM");
assert(nastySnip.ranges.length === 1 && nastySnip.text.slice(nastySnip.ranges[0][0], nastySnip.ranges[0][1]) === "NEEDLE", "snippet still marks NEEDLE");
const titleHost = dom.window.document.createElement("div");
fillHighlight(titleHost, "<script>alert(1)</script> 红叶", findMatchRanges("<script>alert(1)</script> 红叶", ["红叶"]));
assert(titleHost.querySelector("script") === null, "a title must not parse script");
assert(titleHost.querySelector("mark")?.textContent === "红叶", "title highlight is text");

const multi = bestSnippet(
  ["no hit in this one", `${"垫".repeat(50)}红叶在中间`],
  ["红叶"],
);
assert(multi.text.includes("红叶") && multi.ranges.length === 1, "bestSnippet picks the body that matches");

const gemini = {
  id: "gemini:a1b2c3d4e5f67890",
  platform: "gemini",
  platformId: "a1b2c3d4e5f67890",
  url: "https://gemini.google.com/u/1/app/a1b2c3d4e5f67890",
};
for (const url of [
  "https://gemini.google.com/u/4/app/a1b2c3d4e5f67890",
  "https://gemini.google.com/u/4/app/a1b2c3d4e5f67890/",
  "https://gemini.google.com/app/a1b2c3d4e5f67890",
  "https://gemini.google.com/u/2/gem/coding-helper/a1b2c3d4e5f67890",
]) {
  assert(rowMatchesUrl(gemini, url), `Gemini URL should match the stored row: ${url}`);
}
for (const url of [
  "https://gemini.google.com/u/4/app/bbbbbbbbbbbbbbbb",
  "https://gemini.google.com/share/a1b2c3d4e5f67890",
  "https://gemini.google.com/u/1/app/download",
  "https://gemini.google.com/u/1/gem/edit/a1b2c3d4e5f67890",
  "https://mail.google.com/u/1/app/a1b2c3d4e5f67890",
  "https://gemini.google.com/app",
]) {
  assert(!rowMatchesUrl(gemini, url), `Gemini URL should not match: ${url}`);
}
assert(
  conversationKeyFromUrl("https://gemini.google.com/u/4/app/AbCdEf12345678") === "gemini:abcdef12345678",
  "Gemini keys compare case-insensitively",
);
const chatgptId = "11111111-1111-4111-8111-111111111111";
assert(
  rowMatchesUrl(
    { id: `chatgpt:${chatgptId}`, url: `https://chatgpt.com/c/${chatgptId}` },
    `https://chat.openai.com/g/g-p-abc/c/${chatgptId.toUpperCase()}?model=gpt`,
  ),
  "ChatGPT project URLs and chat.openai.com share the stored id",
);
assert(!rowMatchesUrl({ id: `chatgpt:${chatgptId}` }, "https://chatgpt.com/"), "home is not a conversation");
assert(
  !rowMatchesUrl(
    { id: "claude:22222222-2222-4222-8222-222222222222" },
    "https://claude.ai/chat/new",
  ),
  "Claude new chat is not a row",
);
assert(
  rowMatchesUrl(
    { id: "claude:22222222-2222-4222-8222-222222222222" },
    "https://claude.ai/chat/22222222-2222-4222-8222-222222222222",
  ),
  "Claude chat URL matches",
);
const grokSlug = "abcdefghijklmnopqrst";
assert(
  rowMatchesUrl(
    { id: `grok:${grokSlug}`, platform: "grok", platformId: grokSlug },
    "https://x.ai/chat/abcdefghijklmnopqrst",
  ),
  "x.ai slug matches the Grok row",
);
assert(
  rowMatchesUrl(
    { id: `grok:${chatgptId}` },
    `https://www.grok.com/c/${chatgptId}`,
  ),
  "www.grok.com UUID matches",
);
assert(!conversationKeyFromUrl("https://grok.com/c/short"), "short Grok paths are not conversations");
assert(
  rowMatchesUrl(
    { url: "https://gemini.google.com/u/1/app/a1b2c3d4e5f67890" },
    "https://gemini.google.com/u/9/app/a1b2c3d4e5f67890",
  ),
  "matching can use the stored URL when the id field is absent",
);

assert(!shouldAutoScroll({ currentKey: "", settledKey: "", rowFound: true, inView: false }), "no current chat, no scroll");
assert(!shouldAutoScroll({ currentKey: "chatgpt:a", settledKey: "", rowFound: false, inView: false }), "missing row does not scroll");
assert(!shouldAutoScroll({ currentKey: "chatgpt:a", settledKey: "chatgpt:a", rowFound: true, inView: false }), "same chat must not fight scrolling");
assert(!shouldAutoScroll({ currentKey: "chatgpt:a", settledKey: "", rowFound: true, inView: true }), "an on-screen row does not scroll");
assert(shouldAutoScroll({ currentKey: "chatgpt:b", settledKey: "chatgpt:a", rowFound: true, inView: false }), "a new off-screen chat scrolls once");

const hansWarn = formatHealthEntries({
  chatgpt: { warn: true, pathKind: "conversation", messageCount: 0, sidebarCount: 1, at: Date.now() },
}, Date.now(), "zh-CN");
const hansThread = formatHealthEntries({
  claude: { warn: false, pathKind: "conversation", messageCount: 3, sidebarCount: 2, at: Date.now() },
}, Date.now(), "zh-CN");
assert(hansWarn[0].text.includes("0 条消息"), `warn copy: ${hansWarn[0].text}`);
assert(hansThread[0].text.includes("3 条消息"), `thread copy: ${hansThread[0].text}`);
assert(!hansWarn[0].text.includes("则") && !hansThread[0].text.includes("则"), "Simplified copy must not use 则 for messages");
const hantThread = formatHealthEntries({
  claude: { warn: false, pathKind: "conversation", messageCount: 3, sidebarCount: 2, at: Date.now() },
}, Date.now(), "zh-TW");
const hantWarn = formatHealthEntries({
  chatgpt: { warn: true, pathKind: "conversation", messageCount: 0, sidebarCount: 1, at: Date.now() },
}, Date.now(), "zh-TW");
assert(hantThread[0].text.includes("3 則訊息"), `zh-TW thread: ${hantThread[0].text}`);
assert(hantWarn[0].text.includes("0 則訊息"), `zh-TW warn: ${hantWarn[0].text}`);
assert(!hantThread[0].text.includes("条") && !hantWarn[0].text.includes("消息"), "Traditional copy keeps 則訊息");

const activity = read("src/activity-time.js");
const hansBlock = activity.split('"zh-Hans"')[1].split(/\n  \},/)[0];
const hantBlock = activity.split('"zh-Hant"')[1].split('"zh-Hans"')[0];
assert(!/则消息|則消息|則訊息/.test(hansBlock) && /条消息/.test(hansBlock), "zh-Hans strings must say 条消息");
assert(!/条消息|则消息|條消息/.test(hantBlock) && /則訊息/.test(hantBlock), "zh-Hant strings must say 則訊息");
const panel = read("sidepanel/panel.js");
assert(panel.includes("条消息") && panel.includes("則訊息"), "panel counts diverged");
assert(panel.includes("仅有标题，未收录消息") && panel.includes("僅有標題，未收錄訊息"), "title-only labels missing");
assert(!panel.includes("则消息"), "panel still has 则消息");
const readme = read("README.md");
assert(!readme.includes("则消息") && readme.includes("一条消息"), "README measure word drifted");
assert(readme.includes("真实会话时间") && readme.includes("采集时间"), "README date wording drifted");

const origGetAll = IDBObjectStore.prototype.getAll;
let messageGetAll = 0;
IDBObjectStore.prototype.getAll = function (...args) {
  if (this.name === "messages") messageGetAll += 1;
  return origGetAll.apply(this, args);
};

const convId = "chatgpt:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
await upsertMessages(
  {
    id: convId,
    platform: "chatgpt",
    platformId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "京都行程",
    url: "https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    updatedAt: Date.UTC(2026, 9, 1, 12, 0, 0),
    updatedAtSource: "page-exact",
  },
  [
    { id: `${convId}:u`, role: "user", body: `${"垫".repeat(40)}想看红叶和寺庙${"垫".repeat(40)}` },
    { id: `${convId}:a`, role: "assistant", body: "好的，下面是行程。" },
  ],
  { pageMessageIds: [`${convId}:u`, `${convId}:a`], captureId: "cap-1" },
);
const db = await openDb();
let stored = await requestDone(db.transaction("conversations").objectStore("conversations").get(convId));
assert(stored.firstUserPreview.includes("想看红叶"), "upsert stores the first user prompt");
assert(stored.lastPreview.includes("好的"), "upsert stores the tail");

await upsertMessages(
  {
    id: convId,
    platform: "chatgpt",
    platformId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "京都行程",
    url: "https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  },
  [
    { id: `${convId}:a2`, role: "assistant", body: "中间回复" },
    { id: `${convId}:u2`, role: "user", body: "后来又问了一句" },
  ],
  { pageMessageIds: [`${convId}:a2`, `${convId}:u2`], captureId: "cap-2" },
);
stored = await requestDone(db.transaction("conversations").objectStore("conversations").get(convId));
assert(stored.firstUserPreview.includes("想看红叶"), "a later page must not wipe the first prompt");
assert(stored.lastPreview.includes("后来又问了一句"), "tail preview follows the new tail");

const origTx = IDBDatabase.prototype.transaction;
const opened = [];
let watchTx = false;
IDBDatabase.prototype.transaction = function (names, mode) {
  if (watchTx) {
    const list = Array.isArray(names) ? names : [names];
    opened.push(...list);
  }
  return origTx.call(this, names, mode);
};
const fast = await attachPreviews([stored], "");
watchTx = true;
opened.length = 0;
const again = await attachPreviews(fast, "");
watchTx = false;
assert(!opened.includes("messages"), `idle preview read the messages store: ${opened.join(",")}`);
assert(again[0].preview.kind === "first-user" && again[0].preview.text.includes("想看红叶"), "idle attach uses the stored prompt");
assert(messageGetAll === 0, "preview path must not getAll() messages");

const found = await attachPreviews([stored], "红叶");
assert(found[0].preview.kind === "snippet", `search preview kind ${found[0].preview.kind}`);
assert(found[0].preview.text.includes("红叶"), "search preview contains the match");
assert(found[0].preview.ranges.length >= 1, "search preview has highlight ranges");
const hit = found[0].preview;
assert(
  hit.text.slice(hit.ranges[0][0], hit.ranges[0][1]) === "红叶",
  "search highlight range covers 红叶",
);

const titleOnlyId = "chatgpt:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
await upsertConversations([{
  id: titleOnlyId,
  platform: "chatgpt",
  platformId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  title: "还没点开",
  url: "https://chatgpt.com/c/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  updatedAt: Date.UTC(2026, 8, 1, 8, 0, 0),
  updatedAtSource: "page-exact",
}]);
const titleRow = await requestDone(db.transaction("conversations").objectStore("conversations").get(titleOnlyId));
const marked = await attachPreviews([titleRow], "");
assert(marked[0].preview.kind === "title-only", "sidebar-only row is title-only");
assert(!(Number(titleRow.messageCount) > 0), "title-only row has no messages");

const legacyId = "chatgpt:cccccccc-cccc-4ccc-8ccc-cccccccccccc";
{
  const tx = db.transaction(["conversations", "messages"], "readwrite");
  tx.objectStore("conversations").put({
    id: legacyId,
    platform: "chatgpt",
    platformId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    title: "旧索引",
    url: "https://chatgpt.com/c/cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    updatedAt: Date.UTC(2026, 7, 1, 8, 0, 0),
    updatedAtSource: "page-exact",
    messageCount: 1,
    tailMessageId: `${legacyId}:u`,
  });
  tx.objectStore("messages").put({
    id: `${legacyId}:u`,
    conversationId: legacyId,
    role: "user",
    body: "legacy first question about 兰花",
    capturedAt: Date.now(),
  });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
const legacy = await requestDone(db.transaction("conversations").objectStore("conversations").get(legacyId));
const filled = await attachPreviews([legacy], "");
assert(filled[0].preview.kind === "first-user", `legacy backfill kind ${filled[0].preview.kind}`);
assert(filled[0].preview.text.includes("兰花"), "legacy backfill reads the stored user message");
const saved = await requestDone(db.transaction("conversations").objectStore("conversations").get(legacyId));
assert(saved.firstUserPreview.includes("兰花"), "legacy backfill is written back");
assert(messageGetAll === 0, "backfill must not getAll() messages");

const htmlId = "chatgpt:dddddddd-dddd-4ddd-8ddd-dddddddddddd";
await upsertMessages(
  {
    id: htmlId,
    platform: "chatgpt",
    platformId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    title: "markup",
    url: "https://chatgpt.com/c/dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    updatedAt: Date.UTC(2026, 9, 2, 12, 0, 0),
    updatedAtSource: "page-exact",
  },
  [{
    id: `${htmlId}:u`,
    role: "user",
    body: '<img src=x onerror="alert(1)"> SIGNALWORD <script>alert(1)</script>',
  }],
  { pageMessageIds: [`${htmlId}:u`] },
);
const htmlRow = await requestDone(db.transaction("conversations").objectStore("conversations").get(htmlId));
const htmlPreview = (await attachPreviews([htmlRow], "SIGNALWORD"))[0].preview;
const host = dom.window.document.createElement("div");
fillHighlight(host, htmlPreview.text, htmlPreview.ranges);
assert(host.querySelector("img") === null && host.querySelector("script") === null, "indexed chat HTML must not become an element");
assert(host.querySelector("mark")?.textContent === "SIGNALWORD", "indexed match is marked as text");
assert(host.textContent.includes("<script>"), "indexed tag survives as text");
assert(host.innerHTML.includes("&lt;script&gt;"), "indexed script tag is escaped");

console.log("preview-test ok");
