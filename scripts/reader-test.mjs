import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import {
  openDb,
  readCaptureHealth,
  readConversation,
  removeConversation,
  saveCaptureHealth,
  upsertMessages,
} from "../src/db.js";
import { CATALOG, LOCALE_ORDER } from "../src/i18n.js";
import { mergeMessageOrder, orderMessages } from "../src/message-order.js";
import { ORIGINAL_HOSTS, parseReaderSearch, readerPageUrl, safeOriginalUrl } from "../src/reader-url.js";
import { collectHits, MAX_NODES, mountReader, splitPlainBlocks } from "../src/reader-view.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function requestDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const dom = new JSDOM("<!DOCTYPE html><html><body><div id=\"app\"></div></body></html>");
const { document } = dom.window;
const app = () => document.getElementById("app");

function mount(state) {
  app().replaceChildren();
  const host = document.createElement("div");
  app().append(host);
  const opened = [];
  const view = mountReader(host, {
    viewportHeight: 640,
    locale: "zh-CN",
    onOpenOriginal: (url) => opened.push(url),
    ...state,
  });
  return { host, view, opened };
}

const fence = splitPlainBlocks("line one\n```js\nconst x = 1;\n```\nline two");
assert(fence.some((block) => block.type === "code" && block.text.includes("const x = 1")), "code fence is a block");
assert(fence.some((block) => block.type === "text" && block.text.includes("line one")), "text before the fence stays");
assert(fence.some((block) => block.type === "text" && block.text.includes("line two")), "text after the fence stays");
assert(!fence.some((block) => block.text.includes("```")), "fence markers are not shown as text");

assert(mergeMessageOrder([], ["a", "b"]).join() === "a,b", "empty order takes the page");
assert(mergeMessageOrder(["m3", "m4", "m5"], ["m1", "m2", "m3"]).join() === "m1,m2,m3,m4,m5", "older window merges in front");
assert(mergeMessageOrder(["m1", "m2", "m3"], ["m2", "m3", "m4"]).join() === "m1,m2,m3,m4", "newer tail appends");
assert(mergeMessageOrder(["m1", "m2"], ["m9"]).join() === "m1,m2,m9", "disjoint page ids append");

const sameMs = 1710000000000;
const legacyBatch = ["f3c1", "07aa", "c9d2", "1b0e"].map((id, captureIndex) => ({
  id,
  capturedAt: sameMs,
  captureIndex,
}));
assert(
  orderMessages(legacyBatch.slice().reverse(), undefined).map((msg) => msg.id).join() === "f3c1,07aa,c9d2,1b0e",
  "one capture in the same millisecond keeps page position, not random id order",
);
const reopened = [
  { id: "old-1", capturedAt: sameMs, captureIndex: 0 },
  { id: "old-2", capturedAt: sameMs, captureIndex: 1 },
  { id: "zz-new", capturedAt: sameMs + 5000, captureIndex: 0 },
  { id: "aa-new", capturedAt: sameMs + 5000 },
];
assert(
  orderMessages(reopened, ["zz-new", "aa-new"]).map((msg) => msg.id).join() === "old-1,old-2,zz-new,aa-new",
  "a pre-1.5.0 thread reopened at its tail keeps older turns in front",
);
assert(
  orderMessages([{ id: "b", capturedAt: 2 }, { id: "a", capturedAt: 1 }], ["b", "a"]).map((msg) => msg.id).join() === "b,a",
  "stored page order wins over capture time",
);

const round = readerPageUrl("chatgpt:abc", "红叶", {
  getURL: (path) => `chrome-extension://chatseek-test/${path}`,
});
const parsed = parseReaderSearch(new URL(round).search);
assert(parsed.id === "chatgpt:abc" && parsed.query === "红叶", `reader url roundtrip ${round}`);
const gemini = "https://gemini.google.com/u/2/app/a1b2c3d4e5f67890";
assert(safeOriginalUrl(gemini) === gemini, "Gemini /u/N/ is preserved");
assert(safeOriginalUrl("javascript:alert(1)") === "", "javascript URLs are not opened");
for (const bad of [
  "https://evil.example/x.png",
  "http://chatgpt.com/c/abc",
  "data:text/html,<script>alert(1)</script>",
  "JaVaScRiPt:alert(1)",
  "https://chatgpt.com.evil.example/c/abc",
  "https://user:pw@claude.ai/chat/abc",
  "https://claude.ai:8443/chat/abc",
  "chrome://settings",
  "",
]) {
  assert(safeOriginalUrl(bad) === "", `not one of the four sites: ${bad}`);
}
for (const good of [
  "https://chatgpt.com/c/abc",
  "https://chat.openai.com/c/abc",
  "https://claude.ai/chat/abc",
  "https://grok.com/c/abc",
  "https://gemini.google.com/app/abc",
]) {
  assert(safeOriginalUrl(good) === good, `known site kept: ${good}`);
}
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const manifestHosts = manifest.host_permissions.map((pattern) => new URL(pattern.replace("/*", "/")).hostname);
assert(
  manifestHosts.slice().sort().join() === [...ORIGINAL_HOSTS].sort().join(),
  `reader host list matches host_permissions ${manifestHosts}`,
);

const plain = mount({
  conversation: {
    id: "chatgpt:plain",
    platform: "chatgpt",
    title: "行程笔记",
    url: "https://chatgpt.com/c/plain",
    updatedAt: Date.now() - 3600000,
    updatedAtSource: "page-exact",
    messageCount: 2,
  },
  messages: [
    { id: "u", role: "user", body: "line one\n```\nconst x = 1;\n```\nline two" },
    {
      id: "a",
      role: "assistant",
      body: 'see <img src="https://evil.example/a.png" onerror="globalThis.pwned=1"> <script>globalThis.pwned=1</script> ![x](https://evil.example/b.png)',
    },
  ],
  query: "",
});
assert(plain.host.querySelector(".msg-user .code")?.textContent.includes("const x = 1"), "code block is monospace text");
assert(plain.host.querySelector(".msg-user .chunk")?.textContent.includes("line one"), "newline text is kept");
assert(plain.host.textContent.includes("line two"), "text after code is kept");
const body = plain.host.querySelector(".msg-assistant .msg-body");
assert(body && !body.querySelector("img, script, iframe, video, audio, source, object, embed"), "payloads are not elements");
assert(!body.innerHTML.includes("<img") && !body.innerHTML.includes("<script"), "tags are escaped");
assert(body.innerHTML.includes("&lt;img") && body.innerHTML.includes("&lt;script&gt;"), "tags show as text");
assert(body.textContent.includes("https://evil.example/a.png"), "external image URL stays text");
assert(body.textContent.includes("https://evil.example/b.png"), "markdown image URL stays text");
assert(body.querySelector("[src]") == null, "no external src");
assert(body.querySelector("img") == null, "markdown image is not an element");
for (const anchor of body.querySelectorAll("[href]")) {
  const href = anchor.getAttribute("href") || "";
  assert(/^https?:\/\//i.test(href), `only http(s) hrefs, got ${href}`);
  assert(!/javascript:|data:/i.test(href), `unsafe href ${href}`);
}
assert(globalThis.pwned === undefined, "payload did not run");
assert(plain.host.querySelector(".msg-user .msg-role")?.textContent === "你", "user role label");
assert(plain.host.querySelector(".msg-assistant .msg-role")?.textContent === "助手", "assistant role label");
assert(plain.host.querySelector("#readerPlatform")?.textContent === "ChatGPT", "platform label");
assert(plain.host.querySelector("#readerDate")?.textContent, "date label");
assert(plain.host.querySelector("#hitCount")?.hidden === true, "no search: no hit counter");
assert(plain.host.querySelector("#prevHit")?.hidden && plain.host.querySelector("#nextHit")?.hidden, "no search: no hit buttons");
assert(!plain.host.querySelector("#openOriginal")?.hidden, "no search: original site stays");

const evilHost = mount({
  conversation: {
    id: "chatgpt:evil",
    platform: "chatgpt",
    title: "evil",
    url: "https://evil.example/c/1",
    updatedAt: Date.now(),
    updatedAtSource: "page-exact",
  },
  messages: [{ id: "e1", role: "user", body: "hello" }],
  query: "nothing-here",
});
assert(evilHost.host.querySelector("#openOriginal")?.hidden === true, "unknown host has no open button");
evilHost.host.querySelector("#openOriginal").click();
assert(evilHost.opened.length === 0, "unknown host is never opened");
assert(evilHost.host.querySelector("#hitCount")?.textContent === CATALOG["zh-CN"].noHits, "search without hits says so");
assert(!evilHost.host.querySelector("#hitCount")?.hidden, "search without hits keeps the counter");

const hits = mount({
  conversation: {
    id: "chatgpt:hits",
    platform: "chatgpt",
    title: "京都红叶",
    url: "https://chatgpt.com/c/hits",
    updatedAt: Date.now() - 7200000,
    updatedAtSource: "page-bucket",
    messageCount: 3,
  },
  messages: [
    { id: "m0", role: "user", body: "no match in this turn" },
    { id: "m1", role: "user", body: "十一月去京都看红叶，住在四条。" },
    { id: "m2", role: "assistant", body: "I like musicmap and music." },
  ],
  query: "红叶 music",
});
assert(hits.view.hitCount() === 3, `title 京都 is not in this query; want 红叶 + music, got ${hits.view.hitCount()} ${hits.host.textContent}`);
const marks = [...hits.host.querySelectorAll("mark")].map((el) => el.textContent);
assert(marks.includes("红叶"), `red leaves marked ${marks}`);
assert(marks.includes("music"), `music marked ${marks}`);
assert(!marks.includes("musicmap") && !marks.some((text) => text.includes("musicmap")), "music does not mark musicmap");
assert(hits.view.hitIndex() === 0, "opens on the first hit");
assert(hits.host.querySelector("#prevHit")?.disabled === true, "previous is disabled on the first hit");
assert(hits.host.querySelector("#nextHit")?.disabled === false, "next is enabled");
assert(hits.host.querySelector("#hitCount")?.textContent === "1 / 3", hits.host.querySelector("#hitCount")?.textContent);
assert(hits.host.querySelector("mark.is-current")?.textContent === "红叶", "first hit is 红叶");
hits.view.next();
assert(hits.view.hitIndex() === 1, "next moves forward");
hits.view.next();
assert(hits.view.hitIndex() === 2, "next reaches the last hit");
assert(hits.host.querySelector("#nextHit")?.disabled === true, "next is disabled at the end");
assert(hits.host.querySelector("mark.is-current")?.textContent === "music", "current hit is music");
hits.view.next();
assert(hits.view.hitIndex() === 2, "next does not wrap");
hits.host.querySelector("#prevHit").click();
assert(hits.view.hitIndex() === 1, "previous moves back");
hits.view.prev();
hits.view.prev();
assert(hits.view.hitIndex() === 0, "previous does not wrap");
assert(/约|~/.test(hits.host.querySelector("#readerDate")?.textContent || "") || hits.host.querySelector("#readerDate")?.dataset.source === "page-bucket", "bucket dates stay approximate");

const cjkOnly = collectHits("标题", [{ body: "musicmap" }], "music");
assert(cjkOnly.length === 0, "panel word boundaries apply in the reader");
const cjkHit = collectHits("", [{ body: "搜索对话" }], "对话");
assert(cjkHit.length === 1 && cjkHit[0].where === "message", "CJK matches inside a phrase");

const titleOnly = mount({
  conversation: {
    id: "chatgpt:title",
    platform: "claude",
    title: "还没点开的草稿",
    url: "https://claude.ai/chat/title-only",
    updatedAt: Date.now(),
    updatedAtSource: "first-seen",
    firstSeenAt: Date.now(),
    messageCount: 0,
  },
  messages: [],
});
assert(titleOnly.host.dataset.state === "title-only", "title-only state");
assert(titleOnly.host.querySelector("#readerNote")?.textContent === "仅有标题，未收录消息", "title-only copy");
assert(titleOnly.host.querySelectorAll(".msg").length === 0, "title-only is not a blank transcript");
assert(titleOnly.host.querySelector("#openOriginal") && !titleOnly.host.querySelector("#openOriginal").hidden, "title-only can open the site");
titleOnly.host.querySelector("#openOriginal").click();
assert(titleOnly.opened[0] === "https://claude.ai/chat/title-only", titleOnly.opened[0]);

const archived = mount({
  locale: "zh-TW",
  conversation: {
    id: "chatgpt:arch",
    platform: "chatgpt",
    title: "舊相機維修",
    url: gemini,
    archived: true,
    archiveSource: "chatgpt:banner",
    updatedAt: Date.now() - 86400000,
    updatedAtSource: "sidebar-rank",
    olderThanAt: Date.now() - 86400000,
    messageCount: 1,
  },
  messages: [{ id: "au", role: "user", body: "快門有時不釋放。" }],
});
const badge = archived.host.querySelector("#archivedBadge");
assert(badge && !badge.hidden && badge.textContent === "已封存", `zh-TW archived label ${badge?.textContent}`);
assert(archived.host.dataset.archived === "true", "archived flag");
assert(archived.host.querySelector(".msg")?.textContent.includes("快門"), "archived chats stay readable");
assert(archived.host.querySelector("#readerDate")?.textContent.includes("早於"), archived.host.querySelector("#readerDate")?.textContent);
archived.host.querySelector("#openOriginal").click();
assert(archived.opened[0] === gemini, `original url ${archived.opened[0]}`);

const archivedCn = mount({
  conversation: {
    id: "chatgpt:archcn",
    platform: "chatgpt",
    title: "已归档示例",
    url: "https://chatgpt.com/c/archcn",
    archived: true,
    updatedAt: Date.now(),
    updatedAtSource: "page-exact",
    messageCount: 1,
  },
  messages: [{ id: "cn", role: "assistant", body: "还在。" }],
});
assert(archivedCn.host.querySelector("#archivedBadge")?.textContent === "已归档", "zh-CN reuses the 1.4.0 badge");

const missing = mount({ missing: true });
assert(missing.host.dataset.state === "missing", "missing state");
assert(missing.host.querySelector("#readerNote")?.textContent === CATALOG["zh-CN"].missingChat, "missing copy");
assert(missing.host.querySelector("#openOriginal")?.hidden === true, "missing chat has no original URL");
assert(missing.host.querySelectorAll(".msg").length === 0, "missing is not a blank transcript");

const createdTags = [];
const origCreate = document.createElement.bind(document);
document.createElement = (tag, opts) => {
  createdTags.push(String(tag).toLowerCase());
  return origCreate(tag, opts);
};
const xss = mount({
  conversation: {
    id: "chatgpt:xss",
    platform: "grok",
    title: "<img src=x onerror=alert(1)>",
    url: "https://grok.com/c/xss",
    updatedAt: Date.now(),
    updatedAtSource: "page-exact",
    messageCount: 1,
  },
  messages: [{
    id: "xss",
    role: "user",
    body: '<img src="https://evil.example/pwn.png" onerror="globalThis.pwned=1">\n<script src="https://evil.example/a.js"></script>',
  }],
});
document.createElement = origCreate;
assert(!createdTags.includes("img") && !createdTags.includes("script") && !createdTags.includes("iframe"), `created ${createdTags}`);
assert(xss.host.querySelector("#readerTitle")?.textContent.startsWith("<img"), "title is text");
assert(globalThis.pwned === undefined, "title and body payloads did not run");

const longMessages = Array.from({ length: 3000 }, (_, i) => ({
  id: `long-${String(i).padStart(4, "0")}`,
  role: i % 2 ? "assistant" : "user",
  body: i === 2500 ? "the far needle sits in this turn" : `ordinary turn ${i} about tea`,
}));
const started = performance.now();
const long = mount({
  conversation: {
    id: "chatgpt:long",
    platform: "gemini",
    title: "很长的对话",
    url: gemini,
    updatedAt: Date.now(),
    updatedAtSource: "page-exact",
    messageCount: longMessages.length,
  },
  messages: longMessages,
  query: "needle",
});
const elapsed = performance.now() - started;
const rendered = long.view.renderedMessages();
assert(elapsed < 1500, `3000 messages took ${elapsed.toFixed(0)}ms`);
assert(rendered > 0 && rendered <= MAX_NODES, `bounded DOM nodes, got ${rendered}`);
assert(rendered < 3000, "does not mount every message");
assert(long.host.querySelector('.msg[data-index="2500"]'), "first hit message is mounted");
assert(!long.host.querySelector('.msg[data-index="0"]'), "messages far above the hit stay unmounted");
assert(long.view.hitCount() === 1 && long.view.hitIndex() === 0, "single far hit");
assert(long.host.querySelector("#prevHit")?.disabled && long.host.querySelector("#nextHit")?.disabled, "ends disable both controls");
assert(long.host.querySelector("mark")?.textContent === "needle", "far hit is marked");

const spread = [40, 1500, 2960];
const jumpy = mount({
  conversation: {
    id: "chatgpt:jumpy",
    platform: "chatgpt",
    title: "跳转",
    url: "https://chatgpt.com/c/jumpy",
    updatedAt: Date.now(),
    updatedAtSource: "page-exact",
  },
  messages: Array.from({ length: 3000 }, (_, i) => ({
    id: `j-${i}`,
    role: i % 2 ? "assistant" : "user",
    capturedAt: 1710000000000,
    captureIndex: i,
    body: spread.includes(i) ? `第 ${i} 条提到了红叶` : `第 ${i} 条只是普通内容`,
  })),
  query: "红叶",
});
assert(jumpy.view.hitCount() === spread.length, `three far CJK hits, got ${jumpy.view.hitCount()}`);
for (let step = 0; step < spread.length; step++) {
  if (step) jumpy.view.next();
  const want = spread[step];
  const current = jumpy.host.querySelector("mark.is-current");
  assert(current?.textContent === "红叶", `hit ${step} is marked`);
  assert(current.closest(".msg")?.dataset.index === String(want), `hit ${step} is in message ${want}, got ${current.closest(".msg")?.dataset.index}`);
  assert(jumpy.view.renderedMessages() <= MAX_NODES, "jumps keep the DOM bounded");
  assert(jumpy.host.querySelectorAll("mark.is-current").length === 1, "one current hit");
}
jumpy.view.prev();
jumpy.view.prev();
assert(jumpy.host.querySelector("mark.is-current")?.closest(".msg")?.dataset.index === "40", "back to the first chunk");

const id = "chatgpt:ordered";
const conv = {
  id,
  platform: "chatgpt",
  platformId: "ordered",
  title: "顺序",
  url: "https://chatgpt.com/c/ordered",
  updatedAt: Date.now(),
  updatedAtSource: "page-exact",
};
await upsertMessages(conv, [
  { id: `${id}:m3`, role: "user", body: "third" },
  { id: `${id}:m4`, role: "assistant", body: "fourth" },
], { pageMessageIds: [`${id}:m3`, `${id}:m4`], captureId: "tail" });
await upsertMessages(conv, [
  { id: `${id}:m1`, role: "user", body: "first" },
  { id: `${id}:m2`, role: "assistant", body: "second" },
  { id: `${id}:m3`, role: "user", body: "third" },
], { pageMessageIds: [`${id}:m1`, `${id}:m2`, `${id}:m3`], captureId: "head" });
const db = await openDb();
const before = JSON.stringify(await requestDone(db.transaction("conversations").objectStore("conversations").get(id)));
const read = await readConversation(id);
const after = JSON.stringify(await requestDone(db.transaction("conversations").objectStore("conversations").get(id)));
assert(before === after, "reading does not modify the conversation");
assert(read.messages.map((msg) => msg.body).join() === "first,second,third,fourth", `order ${read.messages.map((msg) => msg.body)}`);
const m2Before = await requestDone(db.transaction("messages").objectStore("messages").get(`${id}:m2`));
assert(m2Before.captureIndex === 1, `page position stored ${m2Before.captureIndex}`);
await new Promise((resolve) => setTimeout(resolve, 5));
await upsertMessages(conv, [{ id: `${id}:m2`, role: "assistant", body: "second, streamed longer" }], { captureId: "stream" });
const m2After = await requestDone(db.transaction("messages").objectStore("messages").get(`${id}:m2`));
assert(m2After.body === "second, streamed longer", "streamed body is saved");
await upsertMessages(conv, [{ id: `${id}:m2`, role: "assistant", body: "second" }], {
  pageMessageIds: [`${id}:m2`],
  captureId: "partial-paint",
});
const m2Kept = await requestDone(db.transaction("messages").objectStore("messages").get(`${id}:m2`));
assert(m2Kept.body === "second, streamed longer", "a shorter prefix must not replace the stored turn");
await upsertMessages(conv, [{ id: `${id}:frag`, role: "assistant", body: "second, streamed" }], {
  pageMessageIds: [`${id}:frag`],
  captureId: "fragment",
});
const frag = await requestDone(db.transaction("messages").objectStore("messages").get(`${id}:frag`));
assert(!frag, "a partial new id must not sit beside the full turn");
await upsertMessages(conv, [
  { id: `${id}:m1`, role: "user", body: "first" },
  { id: `${id}:m2`, role: "assistant", body: "edited shorter" },
  { id: `${id}:m3`, role: "user", body: "third" },
  { id: `${id}:m4`, role: "assistant", body: "fourth" },
], { pageMessageIds: [`${id}:m1`, `${id}:m2`, `${id}:m3`, `${id}:m4`], captureId: "edit" });
const m2Edited = await requestDone(db.transaction("messages").objectStore("messages").get(`${id}:m2`));
assert(m2Edited.body === "edited shorter", "a real shorter edit still replaces the turn");
assert(m2After.capturedAt === m2Before.capturedAt && m2After.captureIndex === 1, "a body rewrite keeps the turn's place");
const reread = await readConversation(id);
assert(reread.messages.map((msg) => msg.id.split(":").pop()).join() === "m1,m2,m3,m4", "order holds after a rewrite");

const convRow = await requestDone(db.transaction("conversations").objectStore("conversations").get(id));
assert(!("messageOrder" in convRow), "page order is not carried on the conversation row that list and search scan");
const orderRow = await requestDone(db.transaction("meta").objectStore("meta").get(`order:${id}`));
assert(orderRow?.ids?.length === 4, `page order lives in meta ${JSON.stringify(orderRow)}`);

const imageBody = "maple tea\n\n![maple tea](https://cdn.example/maple.png)\n\nstill maple";
const imageMount = mount({
  conversation: {
    id: "chatgpt:img",
    platform: "chatgpt",
    title: "pics",
    url: "https://chatgpt.com/c/pics",
    updatedAt: Date.now(),
    updatedAtSource: "page-exact",
  },
  messages: [{ id: "img1", role: "assistant", body: imageBody }],
  images: new Map([["img1", [{ index: 0, alt: "maple tea", offset: imageBody.indexOf("!["), status: "site" }]]]),
  query: "maple",
});
const paintedHits = new Set([...imageMount.host.querySelectorAll("mark[data-hit]")].map((el) => el.dataset.hit)).size;
assert(imageMount.view.hitCount() === paintedHits, `hit count ${imageMount.view.hitCount()} != painted ${paintedHits}`);
await saveCaptureHealth("chatgpt", { at: Date.now(), pathKind: "conversation", messageCount: 4 });
const health = await readCaptureHealth();
assert(Object.keys(health).join() === "chatgpt" && health.chatgpt.messageCount === 4, `health ignores order rows ${JSON.stringify(health)}`);

const legacyId = "chatgpt:legacy-order";
await requestDone(db.transaction("conversations", "readwrite").objectStore("conversations").put({
  id: legacyId,
  platform: "chatgpt",
  platformId: "legacy-order",
  title: "legacy",
  url: "https://chatgpt.com/c/legacy-order",
  updatedAt: Date.now(),
  updatedAtSource: "page-exact",
  messageOrder: ["l2", "l1"],
}));
const legacyTx = db.transaction("messages", "readwrite");
legacyTx.objectStore("messages").put({ id: "l1", conversationId: legacyId, role: "user", body: "one", capturedAt: 1 });
legacyTx.objectStore("messages").put({ id: "l2", conversationId: legacyId, role: "user", body: "two", capturedAt: 2 });
await new Promise((resolve) => { legacyTx.oncomplete = resolve; });
assert((await readConversation(legacyId)).messages.map((msg) => msg.id).join() === "l2,l1", "an order left on the row still reads");

const asGiven = mount({
  conversation: { id: "chatgpt:given", platform: "chatgpt", title: "given", url: "https://chatgpt.com/c/given", updatedAt: Date.now(), updatedAtSource: "page-exact" },
  messages: [
    { id: "z-first", role: "user", body: "first on the page", capturedAt: 9 },
    { id: "a-second", role: "assistant", body: "second on the page", capturedAt: 1 },
  ],
});
assert(
  [...asGiven.host.querySelectorAll(".msg")].map((el) => el.textContent.includes("first") ? "1" : "2").join() === "1,2",
  "the view shows messages in the order readConversation gave",
);

await removeConversation(id);
const orderGone = await requestDone(db.transaction("meta").objectStore("meta").get(`order:${id}`));
assert(orderGone == null, "removing a chat drops its page order");
const tomb = await requestDone(db.transaction("meta").objectStore("meta").get(`removed:${id}`));
assert(tomb?.removedAt, "tombstone exists");
assert(await readConversation(id) === null, "removed id reads as missing");
const stillGone = await requestDone(db.transaction("conversations").objectStore("conversations").get(id));
const tombAfter = await requestDone(db.transaction("meta").objectStore("meta").get(`removed:${id}`));
assert(stillGone == null, "reader did not resurrect the conversation");
assert(tombAfter?.removedAt === tomb.removedAt, "reader did not touch the tombstone");
const msgLeft = await requestDone(db.transaction("messages").objectStore("messages").get(`${id}:m1`));
assert(msgLeft == null, "removed messages stay gone");

const readerSrc = readFileSync(join(root, "reader/reader.js"), "utf8");
const viewSrc = readFileSync(join(root, "src/reader-view.js"), "utf8");
assert(!/upsert|removeConversation|clearAll|readwrite|\.put\(/.test(readerSrc + viewSrc), "reader modules do not write");
assert(LOCALE_ORDER.length === 9, "nine locales");
for (const code of LOCALE_ORDER) {
  for (const key of ["read", "openOriginal", "prevHit", "nextHit", "hitCount", "noHits", "roleUser", "roleAssistant", "missingChat", "readerLoading", "titleOnly", "archivedBadge", "copyCode", "imageLabel"]) {
    assert(CATALOG[code][key]?.trim(), `${code}.${key} missing`);
  }
}

console.log("reader-test ok", { elapsed: Math.round(elapsed), rendered });
