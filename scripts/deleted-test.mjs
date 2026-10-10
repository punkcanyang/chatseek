import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import * as db from "../src/db.js";
import { conversationFromUrl } from "../src/conversation-url.js";
import { rememberDeletedVisit, observeDeletedEvidence, forgetDeletedVisit } from "../src/deleted-visits.js";
import { CATALOG, LOCALE_ORDER } from "../src/i18n.js";
import { mountReader } from "../src/reader-view.js";

let checks = 0;
function assert(value, label) { checks++; if (!value) throw Error(label); }
let now = 1700000000000;
const originalNow = Date.now;
Date.now = () => now;
let listener;
const tabs = new Map();
globalThis.chrome = {
  runtime: { id: "deleted-fixture", onInstalled: { addListener() {} }, onStartup: { addListener() {} },
    onMessage: { addListener(fn) { listener = fn; } }, sendMessage: () => Promise.resolve() },
  tabs: { get: async (id) => ({ url: tabs.get(id)?.window.location.href || "" }),
    onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
  sidePanel: { setPanelBehavior: () => Promise.resolve() },
  action: { setBadgeText: () => Promise.resolve(), setBadgeBackgroundColor: () => Promise.resolve() },
};
await import("../background.js");
const source = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const shared = source("content/shared.js"), deleted = source("content/deleted.js");
let tabId = 0;
const doms = [];
const uuid = "71717171-7171-4171-8171-717171717171";
const urls = { chatgpt: `https://chatgpt.com/c/${uuid}`, claude: `https://claude.ai/chat/${uuid}`,
  grok: `https://grok.com/c/${uuid}`, gemini: "https://gemini.google.com/u/1/app/7171717171717171" };
function harness(platform, html, href = urls[platform], adapter = false) {
  const dom = new JSDOM(`<!doctype html><title>Sample page</title><body>${html}</body>`, { url: href });
  const doc = dom.window.document;
  Object.defineProperty(doc, "readyState", { configurable: true, value: "complete" });
  const id = ++tabId;
  tabs.set(id, dom); doms.push(dom);
  const sent = [];
  const contentChrome = { runtime: { id: "deleted-fixture", getManifest: () => ({ version: "1.7.5" }),
    sendMessage(payload, cb) {
      sent.push(payload);
      const sender = { frameId: 0, url: dom.window.location.href, tab: { id, url: dom.window.location.href } };
      const pending = listener(payload, sender, (res) => cb?.(res));
      if (pending !== true) cb?.();
    } }, dom: {} };
  const api = new Function("document", "location", "Node", "NodeFilter", "window", "console", "chrome", "setTimeout", "clearTimeout",
    `${shared}\nChatseek.autoStart = false; Chatseek.observe = (handler) => { Chatseek._testCapture = handler; };\n${deleted}\n${adapter ? source(`content/${platform}.js`) : ""}\nreturn Chatseek;`)(
    doc, dom.window.location, dom.window.Node, dom.window.NodeFilter, dom.window,
    { log() {}, warn() {} }, contentChrome,
    (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout,
  );
  return { api, dom, doc, sent, id };
}
const normal = (platform) => {
  const tag = platform === "gemini" ? "user-query" : "div";
  const attrs = platform === "claude" ? 'data-testid="user-message"' : 'data-turn="user" data-message-author-role="user" data-message-id="sample-turn"';
  return `<main><${tag} ${attrs}><p>Sample garden notes: a quiet pathway winds beside a blue orchid and a little tea house.</p></${tag}><textarea></textarea></main>`;
};
const positive = ["Conversation not found", "This conversation has been deleted", "You do not have access to this conversation"];
const negative = [
  ['<h1>Sign in</h1><input type="password"><h2>Conversation not found</h2>', "login"],
  ['<h1>Conversation not found</h1><form id="challenge-form"></form>', "captcha"],
  ['<h1>Network error</h1><p>Conversation not found</p>', "network"],
  ['<h1>Too many requests</h1><p>Conversation not found</p>', "rate"],
  ['<h1>Conversation not found</h1><div aria-busy="true">Loading</div>', "loading"],
  ["", "transient blank"], ['<h1>Something went wrong</h1>', "generic error"],
  ['<h1>Unable to load conversation</h1>', "ambiguous load failure"],
  ['<h1>Conversation not found</h1><button>Sign in</button>', "login button"],
  ['<div hidden><h1>Conversation not found</h1></div>', "hidden"],
  ['<div style="display:none"><h1>Conversation not found</h1></div>', "CSS hidden"],
  ['<nav><h1>Conversation not found</h1></nav>', "sidebar text"],
  ['<blockquote><p>Conversation not found</p></blockquote>', "quote"],
];
await db.clearAll();
for (const platform of Object.keys(urls)) {
  const conv = { ...conversationFromUrl(urls[platform]), url: urls[platform], title: "Sample garden", updatedAt: now, updatedAtSource: "page-exact" };
  await db.upsertMessages(conv, [{ id: `${conv.id}:sample`, role: "user", body: "Sample garden notes." }]);
  const before = await db.readConversation(conv.id);
  for (const text of positive) {
    const h = harness(platform, `<main><h1>${text}</h1></main>`);
    assert(h.api.readDeletedPage().hits > 0, `${platform}: ${text}`);
    now += 10000;
    await h.api.checkDeletedPage(platform);
    assert((await db.readConversation(conv.id)).conversation.archived !== true, `${platform}: first observation does not archive`);
    now += 3000; await h.api.checkDeletedPage(platform);
    assert((await db.readConversation(conv.id)).conversation.archived !== true, `${platform}: second observation does not archive`);
    now += 5000; await h.api.checkDeletedPage(platform);
    const stored = await db.readConversation(conv.id);
    assert(stored.conversation.archived && stored.conversation.archiveSource === "site-deleted", `${platform}: stable evidence archives`);
    assert(stored.conversation.updatedAt === before.conversation.updatedAt && stored.messages[0].body === before.messages[0].body,
      `${platform}: preserve activity and transcript`);
    const line = h.api.publishDiag(h.api.diagFields({ platform, deleted: h.api._deletedHits }));
    assert(/\bdeleted=\d+\b/.test(line) && !line.includes(uuid) && !line.includes("https:") && !line.includes("Sample garden") && !line.includes(text), `${platform}: counts-only diagnostics`);
    const live = harness(platform, normal(platform));
    assert(live.api.readDeletedPage().body, `${platform}: recognizes genuine message structure`);
    await live.api.restoreDeletedPage(conv, [{ id: "sample", body: "sample" }], { check: () => true });
    const restored = (await db.readConversation(conv.id)).conversation;
    assert(!restored.archived && !restored.archiveSource, `${platform}: normal body restores only deletion source`);
  }
  for (const [html, label] of negative) {
    const h = harness(platform, `<main>${html}</main>`);
    now += 10000;
    for (let i = 0; i < 3; i++) { await h.api.checkDeletedPage(platform); now += 4000; }
    assert(!h.api._deletedHits && !(await db.readConversation(conv.id)).conversation.archived, `${platform}: ignores ${label}`);
  }
  const offline = harness(platform, "<main><h1>Conversation not found</h1></main>");
  Object.defineProperty(offline.dom.window.navigator, "onLine", { value: false });
  assert(offline.api.readDeletedPage().blocked && !offline.api.readDeletedPage().hits, `${platform}: offline veto`);
  const unfinished = harness(platform, "<main><h1>Conversation not found</h1></main>");
  Object.defineProperty(unfinished.doc, "readyState", { value: "loading" });
  assert(!unfinished.api.readDeletedPage().hits, `${platform}: readyState veto`);
  const quoted = harness(platform, normal(platform).replace("Sample garden notes:", "Conversation not found."));
  assert(!quoted.api.readDeletedPage().hits, `${platform}: message content is not a deletion signal`);
  const home = platform === "gemini" ? "https://gemini.google.com/u/1/app" : new URL(urls[platform]).origin + "/";
  const redirected = harness(platform, "<main><textarea></textarea></main>", home);
  rememberDeletedVisit(redirected.id, urls[platform], now);
  Object.defineProperty(redirected.dom.window.performance, "getEntriesByType", { value: () => [{ redirectCount: 1, name: home }] });
  for (const delta of [0, 3000, 5000]) { now += delta; await redirected.api.checkDeletedPage(platform); }
  assert((await db.readConversation(conv.id)).conversation.archiveSource === "site-deleted", `${platform}: proven redirect plus healthy empty home`);
  await db.setSiteDeletedState(conv.id, false);
  const manualHome = harness(platform, "<main><textarea></textarea></main>", home);
  rememberDeletedVisit(manualHome.id, urls[platform], now);
  for (let i = 0; i < 3; i++) { await manualHome.api.checkDeletedPage(platform); now += 4000; }
  assert(!(await db.readConversation(conv.id)).conversation.archived, `${platform}: manual home without redirect proof is not deletion`);
  const blankRedirect = harness(platform, "<main></main>", home);
  rememberDeletedVisit(blankRedirect.id, urls[platform], now);
  Object.defineProperty(blankRedirect.dom.window.performance, "getEntriesByType", { value: () => [{ redirectCount: 1, name: home }] });
  assert(!blankRedirect.api.readDeletedPage().homeReady, `${platform}: blank redirect is insufficient`);
  const unknownUrl = urls[platform].replaceAll("71", "92");
  const unknown = harness(platform, "<main><h1>Conversation not found</h1></main>", unknownUrl, true);
  const capture = unknown.api.platforms?.[platform]?.capture || unknown.api._testCapture;
  assert(typeof capture === "function", `${platform}: real adapter capture is exercised`);
  for (let i = 0; i < 3; i++) { await capture(); now += 4000; }
  assert(!(await db.readConversation(conversationFromUrl(unknownUrl).id))?.conversation, `${platform}: adapter never creates a deleted unknown row`);
  assert(!unknown.sent.some((msg) => ["CAPTURE_MESSAGES", "CAPTURE_CONVERSATIONS"].includes(msg.type)), `${platform}: error page does not enter capture writes`);
}
const localized = ["找不到這段對話", "此对话已删除", "Conversation not found", "このチャットは削除されました", "이 대화에 접근할 권한이 없습니다", "conversación no encontrada", "cette conversation a été supprimée", "diese unterhaltung wurde gelöscht", "esta conversa foi excluída"];
for (const platform of Object.keys(urls)) for (const text of localized) {
  const h = harness(platform, `<main><p role="alert">${text}</p></main>`);
  assert(h.api.readDeletedPage().hits > 0, `${platform}: localized ${text}`);
}
const id = conversationFromUrl(urls.chatgpt).id;
await db.upsertConversations([{ id, platform: "chatgpt", archived: true, archiveSource: "chatgpt:banner" }]);
await db.setSiteDeletedState(id, false);
assert((await db.readConversation(id)).conversation.archiveSource === "chatgpt:banner", "normal opening cannot restore a banner archive");
await db.setSiteDeletedState(id, true);
await db.setSiteDeletedState(id, false);
assert((await db.readConversation(id)).conversation.archiveSource === "chatgpt:banner", "deletion recovery retains previous ChatGPT archive evidence");
await db.setSiteDeletedState(id, true);
await db.upsertConversations([{ id, platform: "chatgpt", archived: true, archiveSource: "chatgpt:archive-list" }]);
await db.setSiteDeletedState(id, false);
assert((await db.readConversation(id)).conversation.archiveSource === "chatgpt:archive-list", "late archive-list evidence overrides deletion recovery");
const sample = { platform: "chatgpt", id, hits: 1 };
const tid = 9999;
assert(!observeDeletedEvidence(tid, urls.chatgpt, sample, 0), "backend first observation is not enough");
assert(!observeDeletedEvidence(tid, urls.chatgpt, sample, 8000), "long unobserved gap resets debounce");
assert(!observeDeletedEvidence(tid, urls.chatgpt, { ...sample, hits: 0 }, 9000), "transient recovery resets debounce");
assert(!observeDeletedEvidence(tid, urls.chatgpt, sample, 10000), "debounce restarts after recovery");
assert(!observeDeletedEvidence(tid, urls.chatgpt.replaceAll("71", "92"), sample, 14000), "backend rejects a stale target after navigation");
forgetDeletedVisit(tid);
for (const locale of LOCALE_ORDER) {
  const dom = new JSDOM("<!doctype html><div id='reader'></div>");
  const root = dom.window.document.getElementById("reader");
  mountReader(root, { conversation: { id, title: "Sample garden", platform: "chatgpt", archived: true, archiveSource: "site-deleted" }, locale });
  assert(root.querySelector("#siteDeletedNote").textContent === CATALOG[locale].siteDeleted && !root.querySelector("#siteDeletedNote").hidden, `${locale}: reader deleted note`);
  mountReader(root, { conversation: { id, title: "Sample garden", platform: "chatgpt", archived: true, archiveSource: "chatgpt:banner" }, locale });
  assert(root.querySelector("#siteDeletedNote").hidden, `${locale}: banner archive has no deleted note`);
  dom.window.close();
}
assert((await db.openDb()).version === 4, "DB remains version 4");
for (const dom of doms) dom.window.close();
Date.now = originalNow;
console.log("deleted-test ok", { checks, platforms: 4, locales: 9, graceMs: 8000 });
process.exit(0);
