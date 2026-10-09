#!/usr/bin/env node
import { readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { mergeActivityTime, pageShowsNewActivity } from "../src/activity-time.js";
import { tokenize, queryTokens } from "../src/tokenize.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

function fail(msg) {
  errors.push(msg);
}

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
if (!manifest.side_panel?.default_path) fail("side_panel.default_path missing");

function hostOf(pattern) {
  const match = String(pattern).match(/^https:\/\/([^/*]+)/i);
  return match ? match[1].toLowerCase() : "";
}

function isBannedHost(pattern) {
  const host = hostOf(pattern);
  if (!host) return true;
  if (/perplexity|deepseek/i.test(host) || /perplexity|deepseek/i.test(pattern)) return true;
  if (host === "google.com" || host.endsWith(".google.com") || host.includes("google.com")) {
    return host !== "gemini.google.com";
  }
  return false;
}

const allowed = [
  "https://chatgpt.com/*",
  "https://chat.openai.com/*",
  "https://claude.ai/*",
  "https://grok.com/*",
  "https://www.grok.com/*",
  "https://grok.x.com/*",
  "https://x.ai/*",
  "https://gemini.google.com/*",
];
const forbiddenHosts = [
  "https://www.google.com/*",
  "https://google.com/*",
  "https://*.google.com/*",
  "*://*/*",
  "<all_urls>",
  "https://aistudio.google.com/*",
  "https://bard.google.com/*",
  "https://mail.google.com/*",
  "https://accounts.google.com/*",
  "https://notgemini.google.com/*",
  "https://gemini.google.com.evil.example/*",
  "https://www.perplexity.ai/*",
  "https://perplexity.ai/*",
  "https://chat.deepseek.com/*",
  "https://deepseek.com/*",
];
if (!(manifest.host_permissions || []).includes("https://gemini.google.com/*")) {
  fail("missing host permission https://gemini.google.com/*");
}
for (const pattern of manifest.host_permissions || []) {
  if (!allowed.includes(pattern)) fail(`unexpected host_permissions: ${pattern}`);
  if (isBannedHost(pattern)) fail(`banned host: ${pattern}`);
}
for (const pattern of forbiddenHosts) {
  if (!isBannedHost(pattern)) fail(`should reject ${pattern}`);
  if ((manifest.host_permissions || []).includes(pattern)) fail(`manifest has banned host ${pattern}`);
}

let geminiScript = false;
for (const script of manifest.content_scripts || []) {
  for (const match of script.matches || []) {
    if (!allowed.includes(match)) fail(`content_scripts match not allowed: ${match}`);
    if (isBannedHost(match)) fail(`banned content match: ${match}`);
  }
  if ((script.js || []).includes("content/gemini.js")) {
    geminiScript = true;
    const matches = script.matches || [];
    if (matches.length !== 1 || matches[0] !== "https://gemini.google.com/*") {
      fail(`gemini content script matches must be only https://gemini.google.com/*`);
    }
  }
}
if (!geminiScript) fail("content/gemini.js is not a content script");
if (manifest.version !== "1.6.5") fail(`version should be 1.6.5, got ${manifest.version}`);
let chatgptFrames = false;
for (const script of manifest.content_scripts || []) {
  const isChatgpt = (script.js || []).includes("content/chatgpt.js");
  if (isChatgpt) {
    if (script.all_frames !== true || script.match_about_blank !== true || script.match_origin_as_fallback !== true) {
      fail("chatgpt content script must set all_frames, match_about_blank, and match_origin_as_fallback");
    }
    for (const match of script.matches || []) {
      if (!String(match).endsWith("/*")) {
        fail(`match_origin_as_fallback requires a /* path: ${match}`);
      }
    }
    chatgptFrames = true;
  } else if (script.all_frames || script.match_about_blank || script.match_origin_as_fallback) {
    fail("only the chatgpt content script may match child frames");
  }
}
if (!chatgptFrames) fail("chatgpt content script missing frame matching");
if ((manifest.permissions || []).includes("unlimitedStorage")) {
  fail("unlimitedStorage is not allowed");
}
const csp = manifest.content_security_policy?.extension_pages || "";
if (!/script-src[^;]*'self'/.test(csp)) fail("extension CSP must keep script-src 'self'");
if (!/object-src[^;]*'self'/.test(csp)) fail("extension CSP must keep object-src 'self'");
if (!/img-src/.test(csp) || /img-src[^;]*(https:|\*)/.test(csp)) {
  fail("extension CSP must block external images");
}
if (/unsafe-inline|unsafe-eval/.test(csp)) fail("extension CSP must not allow inline or eval scripts");
if (manifest.web_accessible_resources) {
  fail("no web_accessible_resources: websites must not frame or open extension pages");
}
const { ORIGINAL_HOSTS, safeOriginalUrl } = await import("../src/reader-url.js");
const permittedHosts = (manifest.host_permissions || []).map(hostOf).filter(Boolean).sort();
if ([...ORIGINAL_HOSTS].sort().join() !== permittedHosts.join()) {
  fail(`reader ORIGINAL_HOSTS should equal host_permissions hosts ${permittedHosts}`);
}
for (const bad of ["javascript:alert(1)", "http://chatgpt.com/c/x", "https://evil.example/c/x", "data:text/html,x"]) {
  if (safeOriginalUrl(bad)) fail(`reader would open ${bad}`);
}
if (manifest.default_locale !== "en") fail("default_locale should be en");
if (manifest.name !== "__MSG_extName__" || manifest.description !== "__MSG_extDescription__") {
  fail("manifest name and description should use chrome.i18n messages");
}
const perms = manifest.permissions || [];
if (perms.length !== 1 || perms[0] !== "sidePanel") {
  fail(`permissions should stay ["sidePanel"], got ${JSON.stringify(perms)}`);
}
const localeFolders = ["zh_TW", "zh_CN", "en", "ja", "ko", "es", "fr", "de", "pt_BR"];
for (const folder of localeFolders) {
  const rel = `_locales/${folder}/messages.json`;
  if (!existsSync(join(root, rel))) fail(`missing ${rel}`);
}

const referenced = new Set([
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  "sidepanel/panel.js",
  "sidepanel/panel.css",
  "src/db.js",
  "src/tokenize.js",
  "src/activity-time.js",
  "src/preview.js",
  "src/conversation-url.js",
  "src/current-tab.js",
  "src/i18n.js",
  "src/message-order.js",
  "src/reader-url.js",
  "src/reader-view.js",
  "reader/index.html",
  "reader/reader.js",
  "reader/reader.css",
  "LICENSE",
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
]);
for (const cs of manifest.content_scripts || []) {
  for (const js of cs.js || []) referenced.add(js);
}
for (const rel of referenced) {
  if (!rel) continue;
  const abs = join(root, rel);
  if (!existsSync(abs)) fail(`missing file: ${rel}`);
}

for (const name of ["icon16.png", "icon32.png", "icon48.png", "icon128.png"]) {
  const st = statSync(join(root, "icons", name));
  if (st.size < 200) fail(`${name} looks like a placeholder (${st.size} bytes)`);
}

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

for (const rel of [
  "content/chatgpt.js",
  "content/claude.js",
  "content/grok.js",
  "content/gemini.js",
  "content/shared.js",
  "content/images.js",
]) {
  const src = read(rel);
  if (/XMLHttpRequest|prototype\.fetch|window\.fetch\s*=/.test(src)) {
    fail(`${rel} must not hook fetch/XHR`);
  }
  if (/MAIN/.test(src)) fail(`${rel} must not use MAIN world hooks`);
  // 1.6.0: thumbnails are taken from images the page already painted.
  if (/\bfetch\s*\(/.test(src)) fail(`${rel} must not fetch`);
  if (/\bnew\s+Image\b|createElement\(\s*["']img["']\s*\)/.test(src)) {
    fail(`${rel} must not construct an Image to load`);
  }
  if (/crossOrigin/.test(src)) fail(`${rel} must not set crossOrigin`);
}
if (/status:\s*["']omit["']|status === ["']omit["']/.test(read("content/images.js"))) {
  fail("an oversized image must be kept as a placeholder, not dropped");
}
if (!/oversized/.test(read("content/images.js")) || !/oversized/.test(read("src/image-cache.js"))) {
  fail("oversized images need their own stored status");
}
if (!/openOrClosedShadowRoot/.test(read("content/images.js"))) {
  fail("image scan must open closed shadow roots without a new permission");
}
if (!/not-loaded/.test(read("content/images.js")) || !/"timeout"/.test(read("content/images.js"))) {
  fail("image results must include timeout and not-loaded placeholders");
}
if (!/const MIN_EDGE = 48/.test(read("content/images.js"))) {
  fail("decorative images are those under 48px");
}
if (!/function byteList/.test(read("content/images.js")) || !/Array.isArray\(value\)/.test(read("src/image-cache.js"))) {
  fail("cached thumbnails must cross the extension message as a byte list");
}
if (!/view\.byteLength > MAX_BYTES/.test(read("content/images.js"))) {
  fail("a thumbnail list must stay within 150KB before it is sent");
}
if (!/function inChildFrame/.test(read("content/images.js")) || !/window\.top !== window/.test(read("content/images.js"))) {
  fail("a child frame must not capture images the top frame already walks");
}
if (!/paceDom/.test(read("content/images.js")) || !/MAX_TRIES/.test(read("content/images.js"))) {
  fail("image walks must yield and image retries must be capped");
}
if (!/function scrubImageUrls/.test(read("src/image-cache.js"))) {
  fail("image rows must scrub image urls before they are stored");
}
const { normalizeImageRecord: normalizeShot } = await import("../src/image-cache.js");
const hiddenUrl = normalizeShot("chatgpt:c", {
  messageId: "chatgpt:c:m",
  index: 0,
  status: "uncached",
  alt: "https://cdn.example/secret.png",
  prompt: "see https://files.oaiusercontent.com/gen.png",
  url: "https://cdn.example/secret.png",
  src: "blob:https://chatgpt.com/abc",
  currentSrc: "https://cdn.example/secret.png",
});
if (/https?:|cdn\.example|oaiusercontent|blob:/i.test(JSON.stringify(hiddenUrl))) {
  fail(`image record kept an address: ${JSON.stringify(hiddenUrl)}`);
}
if (!/status: "cleared"/.test(read("src/db.js")) || !/imageCleared/.test(read("src/reader-view.js"))) {
  fail("clearing the image cache must leave a placeholder the reader can draw");
}
if (!/imgs=\$\{detected\}\/\$\{saved\}\/\$\{hold\} fail=tainted:/.test(read("content/shared.js"))) {
  fail("diag must include imgs= detected/saved/placeholder and fail counts");
}
if (!/return "0 KB"/.test(read("src/image-cache.js"))) {
  fail("a zero image cache must read 0 KB");
}
if (!/clearImagesBtn.disabled/.test(read("sidepanel/panel.js"))) {
  fail("clear image cache must be disabled when the cache is empty or unreadable");
}
if (/innerHTML|insertAdjacentHTML|outerHTML/.test(read("content/images.js") + read("src/image-cache.js"))) {
  fail("image cache must not assign HTML");
}
for (const rel of [
  "background.js",
  "content/chatgpt.js",
  "content/claude.js",
  "content/grok.js",
  "content/gemini.js",
  "content/shared.js",
  "content/images.js",
  "src/activity-time.js",
  "src/db.js",
  "src/tokenize.js",
  "src/preview.js",
  "src/conversation-url.js",
  "src/current-tab.js",
  "src/i18n.js",
  "src/message-order.js",
  "src/reader-url.js",
  "src/reader-view.js",
  "src/markdown.js",
  "src/markdown-dom.js",
  "src/sort-list.js",
  "src/image-cache.js",
  "reader/reader.js",
  "sidepanel/panel.js",
]) {
  const src = read(rel);
  if (/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts/.test(src)) {
    fail(`${rel} must not make network requests`);
  }
  if (/batchexecute|_\/BardChatUi/i.test(src)) fail(`${rel} must not touch Gemini internal endpoints`);
}

const dbSrc = read("src/db.js");
if (/messages["']?\)\.getAll|objectStore\(\s*["']messages["']\s*\)\.getAll/.test(dbSrc)) {
  fail("db.js must not getAll() the messages store");
}
if (!/openCursor/.test(dbSrc)) fail("db.js should cursor IndexedDB for search/list");
if (!/const DB_VERSION = 4/.test(dbSrc)) fail("schema should be version 4");
if (!/objectStoreNames\.contains\("images"\)|createObjectStore\("images"/.test(dbSrc)) {
  fail("schema should add an images store");
}
const readFn = dbSrc.split("export async function readConversation")[1]?.split("export async function")[0] || "";
if (!readFn) fail("readConversation not found");
if (!/readonly/.test(readFn)) fail("readConversation must use a readonly transaction");
if (/readwrite|\.put\(|\.delete\(|\.add\(|\.clear\(/.test(readFn)) {
  fail("readConversation must not write");
}
const searchFn = dbSrc.split("export async function searchConversations")[1]?.split(
  "export async function listRecent",
)[0] || "";
if (!searchFn) fail("searchConversations not found");
if (/objectStore\(\s*["']messages["']\s*\)/.test(searchFn) ||
    /transaction\([^)]*["']messages["']/.test(searchFn)) {
  fail("searchConversations must not open or read the messages store");
}
if (!/tokenMap/.test(searchFn) || !/openCursor|collectConvIdsForToken/.test(searchFn)) {
  fail("searchConversations should look up tokenMap with a cursor");
}

const tok = tokenize("Hello ChatGPT 对话搜索 12345 the");
if (!tok.includes("hello") || !tok.includes("chatgpt")) fail("latin tokenize failed");
if (!tok.includes("对话") || !tok.includes("搜索")) fail("cjk bigram tokenize failed");
if (!tok.includes("12345")) fail("number tokenize failed");
const q = queryTokens("the hello");
if (q.includes("the") && q.length > 1) fail("stopword not filtered");

if (!existsSync(join(root, "LICENSE"))) fail("LICENSE missing");
if (!existsSync(join(root, "README.md"))) fail("README missing");
const readme = read("README.md");
if (!/Load unpacked|加载/.test(readme)) fail("README should explain load unpacked");
if (!/IndexedDB|倒排/.test(readme)) fail("README should explain search");
if (!/标签页|tab is open/i.test(readme)) fail("README should state open-tab limitation");
if (!/ChatGPT/i.test(readme) || !/Claude/i.test(readme) || !/Grok/i.test(readme) || !/Gemini/i.test(readme)) {
  fail("README should mention ChatGPT, Claude, Grok, and Gemini");
}


const sharedSrc = read("content/shared.js");
if (!/parsePageTime/.test(sharedSrc) || !/findTimeNear/.test(sharedSrc)) {
  fail("shared.js should expose parsePageTime and findTimeNear");
}
if (!/pageTimesFromDocument/.test(sharedSrc)) {
  fail("shared.js should scan static page JSON for conversation times");
}
for (const rel of ["content/chatgpt.js", "content/claude.js", "content/grok.js", "content/gemini.js"]) {
  const src = read(rel);
  if (!/attachPageTime|updatedAt/.test(src)) {
    fail(`${rel} should attach page updatedAt in extractSidebar`);
  }
}
const dbForDates = read("src/db.js");
if (!/isValidPageMs|pageMs/.test(dbForDates)) {
  fail("db.js should validate page timestamps");
}
if (!/incomingUpdated/.test(dbForDates)) {
  fail("db.js should prefer incoming page updatedAt over Date.now()");
}
const readmeDates = read("README.md");
if (!/真实会话时间/.test(readmeDates) || !/采集时间/.test(readmeDates)) {
  fail("README should mention page dates vs capture time");
}

const healthWarns = [];
const sandbox = {
  Date,
  Math,
  Number,
  String,
  RegExp,
  Map,
  Set,
  console: {
    warn: (line) => healthWarns.push(String(line)),
    log() {},
  },
  document: { scripts: [], querySelectorAll() { return []; } },
  location: { href: "https://chatgpt.com/" },
  chrome: { runtime: {} },
  NodeFilter: { SHOW_ELEMENT: 1 },
  clearTimeout,
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  setInterval,
};
createContext(sandbox);
const pageTime = runInContext(`${sharedSrc}\nChatseek;\n`, sandbox);
const afterSlashC = "66666666-6666-4666-8666-666666666666";
const gizmoDecoy = "77777777-7777-4777-8777-777777777777";
if (pageTime.conversationIdFromPath(`/g/${gizmoDecoy}/c/${afterSlashC}?model=gpt`) !== afterSlashC) {
  fail("conversation id must be the uuid after /c/");
}
if (pageTime.conversationIdFromPath(`/g/g-p-abc/c/${afterSlashC}#x`) !== afterSlashC) {
  fail("project urls must keep the uuid after /c/");
}
if (pageTime.conversationIdFromPath("/c/not-a-uuid") !== null) fail("a non-uuid after /c/ is not an id");
const iso = pageTime.parsePageTime("2025-06-10T12:00:00.000Z");
if (iso !== Date.parse("2025-06-10T12:00:00.000Z")) fail("ISO parsePageTime failed");
const sec = pageTime.parsePageTime(1718000000);
if (sec !== 1718000000 * 1000) fail("unix seconds parsePageTime failed");
const noon = Date.UTC(2026, 0, 15, 12, 0, 0);
const yest = pageTime.parsePageTime("Yesterday", noon);
if (!(yest < noon && noon - yest < 3 * 86400000)) fail("Yesterday parsePageTime failed");
if (!pageTime.parsePageTime("Previous 7 Days", noon)) {
  fail("Previous 7 Days parsePageTime failed");
}
if (pageTime.parsePageTime("not a date") !== null) {
  fail("parsePageTime should reject junk");
}
if (pageTime.parsePageTime("2h", noon) !== noon - 2 * 3600000) {
  fail("compact 2h parsePageTime failed");
}
for (const junk of ["Chapter 3", "Top 10", "Step 1", "Idea 7", "Roadmap 2025", "2024"]) {
  if (pageTime.parsePageTime(junk, noon) !== null) {
    fail(`parsePageTime turned title text "${junk}" into a date`);
  }
}
if (pageTime.parsePageTime(Date.UTC(2001, 2, 1)) !== null) {
  fail("parsePageTime should reject pre-2020 epochs");
}
if (pageTime.parsePageTime("Sep 12, 2025", noon) !== Date.parse("Sep 12, 2025")) {
  fail("month-day-year parsePageTime failed");
}
const yearless = pageTime.parsePageTime("Mar 3", noon);
if (!yearless || new Date(yearless).getFullYear() !== 2025) {
  fail(`yearless "Mar 3" should resolve to the latest past Mar 3, got ${yearless}`);
}
for (const [raw, names, want] of [
  ["Sales - Xbox plan - Grok", ["Grok", "x\\.ai", "xAI", "X"], "Sales - Xbox plan"],
  ["Ideas - Claude Shannon bio - Claude", ["Claude"], "Ideas - Claude Shannon bio"],
  ["Tips | ChatGPT vs Claude", ["ChatGPT", "OpenAI"], "Tips | ChatGPT vs Claude"],
  ["Trip plan - ChatGPT", ["ChatGPT", "OpenAI"], "Trip plan"],
  ["ChatGPT", ["ChatGPT", "OpenAI"], "ChatGPT"],
]) {
  const got = pageTime.stripTitleSuffix(raw, names);
  if (got !== want) fail(`stripTitleSuffix(${raw}) = ${got}, want ${want}`);
}

const sent = [];
let reply = { ok: true };
sandbox.chrome.runtime.sendMessage = (payload, cb) => {
  sent.push(payload);
  cb(reply);
};
const capState = { lastListFp: "", lastMsgFp: "" };
const conv = (id) => ({
  id: `chatgpt:${id}`,
  platform: "chatgpt",
  platformId: id,
  title: `Thread ${id}`,
});
const msg = (convId, mid, body) => ({ id: `chatgpt:${convId}:${mid}`, role: "user", body });
const sentMessages = () => sent.filter((p) => p.type === "CAPTURE_MESSAGES");

let capOk = await pageTime.runCapture(capState, {
  platform: "chatgpt",
  sidebar: [],
  conversation: conv("aaa"),
  messages: [msg("aaa", "m1", "alpha question"), msg("aaa", "m2", "alpha answer")],
});
if (capOk !== true || sentMessages().length !== 1) fail("runCapture should store the first thread");

sent.length = 0;
await pageTime.runCapture(capState, {
  platform: "chatgpt",
  sidebar: [],
  conversation: conv("bbb"),
  messages: [msg("bbb", "m1", "alpha question"), msg("bbb", "m2", "alpha answer")],
});
if (sentMessages().length) {
  fail("runCapture must not file the previous thread's messages under a new URL");
}

sent.length = 0;
await pageTime.runCapture(capState, {
  platform: "chatgpt",
  sidebar: [],
  conversation: conv("bbb"),
  messages: [msg("bbb", "m9", "beta question")],
});
if (sentMessages().length !== 1) fail("runCapture should store the new thread once it renders");

reply = { ok: false };
capOk = await pageTime.runCapture(capState, {
  platform: "chatgpt",
  sidebar: [],
  conversation: conv("bbb"),
  messages: [msg("bbb", "m9", "beta question"), msg("bbb", "m10", "beta answer")],
});
if (capOk !== false) fail("runCapture should report a failed write");
reply = { ok: true };
sent.length = 0;
capOk = await pageTime.runCapture(capState, {
  platform: "chatgpt",
  sidebar: [],
  conversation: conv("bbb"),
  messages: [msg("bbb", "m9", "beta question"), msg("bbb", "m10", "beta answer")],
});
if (capOk !== true || sentMessages().length !== 1) {
  fail("runCapture should resend after a failed write");
}

sent.length = 0;
const bigSidebar = Array.from({ length: 120 }, (_, i) => ({
  ...conv(`side${i}`),
  sidebarIndex: i,
}));
await pageTime.runCapture({ lastListFp: "", lastMsgFp: "" }, {
  platform: "chatgpt",
  sidebar: bigSidebar,
  conversation: null,
  messages: [],
});
const sidebarWrites = sent.filter((p) => p.type === "CAPTURE_CONVERSATIONS");
if (sidebarWrites.length !== 1 || sidebarWrites[0].conversations.length !== 120) {
  fail("a whole sidebar must reach the database in one write so order estimates see every anchor");
}

const healthSent = () => sent.filter((p) => p.type === "CAPTURE_HEALTH");
const threadHealth = {
  pathKind: "conversation",
  selector: null,
  selectorsTried: ["[data-message-author-role]", "[data-turn]"],
};
const loading = { lastListFp: "", lastMsgFp: "" };
pageTime._healthWarned = "";
healthWarns.length = 0;
sent.length = 0;
capOk = await pageTime.runCapture(loading, {
  platform: "chatgpt",
  sidebar: [],
  conversation: conv("loading"),
  messages: [],
  health: threadHealth,
});
if (capOk !== false) fail("an empty thread inside the grace period should ask observe() to look again");
if (healthSent().some((p) => p.health.warn) || healthWarns.length) {
  fail("a thread that is still loading must not raise the 0-message warning");
}
capOk = await pageTime.runCapture(loading, {
  platform: "chatgpt",
  sidebar: [],
  conversation: conv("loading"),
  messages: [msg("loading", "m1", "loaded in time")],
  health: threadHealth,
});
if (capOk !== true || healthSent().some((p) => p.health.warn)) {
  fail("a thread that renders within the grace period should never warn");
}
sent.length = 0;
await pageTime.runCapture(loading, {
  platform: "chatgpt",
  sidebar: [],
  conversation: conv("broken"),
  messages: [],
  health: threadHealth,
});
loading.zeroSince -= pageTime.HEALTH_GRACE_MS;
capOk = await pageTime.runCapture(loading, {
  platform: "chatgpt",
  sidebar: [],
  conversation: conv("broken"),
  messages: [],
  health: threadHealth,
});
if (capOk !== true || !healthSent().some((p) => p.health.warn && p.health.messageCount === 0)) {
  fail("a thread that stays empty past the grace period should report the warning");
}
healthWarns.length = 0;
if (!/runCapture/.test(sharedSrc) || !/sectionTimesFor/.test(sharedSrc)) {
  fail("shared.js should serialize capture and assign section dates");
}
if (!/withDb/.test(dbForDates)) fail("db.js should reopen a closed IndexedDB connection");
if (!/row\.token === token/.test(dbSrc)) {
  fail("token lookup must ignore longer tokens that share a prefix");
}

const morning = new Date(2026, 9, 8, 9, 0, 0, 0).getTime();
const todayMs = pageTime.parsePageTime("Today", morning);
const morningStart = new Date(2026, 9, 8, 0, 0, 0, 0).getTime();
if (!(todayMs <= morning && todayMs >= morningStart)) {
  fail(`Today must stay inside the morning, got ${todayMs}`);
}
const hourPhrase = pageTime.parsePageTime("Last message 3 hours ago", morning);
if (hourPhrase !== pageTime.minuteFloor(morning) - 3 * 3600000) {
  fail("Last message 3 hours ago should parse as an exact offset");
}
const zhHour = pageTime.parsePageTime("3 小時前", morning);
if (zhHour !== pageTime.minuteFloor(morning) - 3 * 3600000) {
  fail("Traditional 3 小時前 should parse");
}
if (pageTime.parsePageTime("上次訊息 5 分鐘前", morning) == null) {
  fail("Traditional prefixed minute phrase should parse");
}
const jitter = Date.UTC(2026, 0, 15, 12, 0, 30);
if (pageTime.parsePageTime("2h", jitter) !== pageTime.parsePageTime("2h", jitter + 20000)) {
  fail("relative times should stay stable within one minute");
}
if (pageTime.parsePageTime("Today", jitter) !== pageTime.parsePageTime("Today", jitter + 20000)) {
  fail("Today should stay stable within one minute so the sidebar is not rewritten every scan");
}
const exactKind = pageTime.classifyPageTime("2025-06-10T12:00:00.000Z");
const bucketKind = pageTime.classifyPageTime("Previous 30 Days", morning);
if (exactKind?.source !== "page-exact") fail("ISO time should be page-exact");
if (bucketKind?.source !== "page-bucket") fail("Previous 30 Days should be page-bucket");
if (pageTime.timeSourceRank("page-exact") <= pageTime.timeSourceRank("page-bucket")) {
  fail("page-exact must outrank page-bucket");
}
const activitySrc = read("src/activity-time.js");
for (const line of [
  '"page-exact": 50',
  "observed: 40",
  '"page-bucket": 30',
  '"sidebar-rank": 20',
  '"first-seen": 10',
]) {
  if (!sharedSrc.includes(line) || !activitySrc.includes(line)) {
    fail(`time source rank drifted: ${line}`);
  }
}
const olderExact = Date.UTC(2024, 3, 2, 9, 0, 0);
const observedNow = olderExact + 86400000 * 400;
const stamped = mergeActivityTime(
  { updatedAt: olderExact, updatedAtSource: "page-exact", firstSeenAt: olderExact },
  { updatedAt: observedNow, updatedAtSource: "observed" },
  observedNow,
);
if (stamped.updatedAt !== observedNow || stamped.updatedAtSource !== "observed") {
  fail("a newer observed stamp must replace an older page-exact time");
}
const kept = mergeActivityTime(stamped, { updatedAt: olderExact, updatedAtSource: "page-exact" }, observedNow);
if (kept.updatedAt !== observedNow || kept.updatedAtSource !== "observed") {
  fail("an older page-exact time must not roll an observed clock backward");
}
const rekeyed = pageShowsNewActivity({
  baselineCount: 2,
  baselineTail: "old-tail",
  baselineTailBody: "A pangolin rolls into a ball when the ridge feels unsafe.",
  pageIds: ["h-user", "h-asst", "h-new"],
  pageBodies: [
    { id: "h-user", body: "The ridge path stays dry until the afternoon rain starts." },
    { id: "h-asst", body: "A pangolin rolls into a ball when the ridge feels unsafe." },
    { id: "h-new", body: "NEW_TAIL_TOKEN The pangolin asked what the ridge looks like after rain." },
  ],
});
if (!rekeyed) fail("a re-keyed capture with a new ending must count as activity");
const sameEnding = pageShowsNewActivity({
  baselineCount: 2,
  baselineTail: "old-tail",
  baselineTailBody: "A pangolin rolls into a ball when the ridge feels unsafe.",
  pageIds: ["h-user", "h-asst"],
  pageBodies: [
    { id: "h-user", body: "The ridge path stays dry until the afternoon rain starts." },
    { id: "h-asst", body: "**A** pangolin rolls into a ball when the ridge feels unsafe." },
  ],
});
if (sameEnding) fail("re-keying the same ending must not count as activity");
const scrollback = pageShowsNewActivity({
  baselineCount: 2,
  baselineTail: "tail",
  baselineTailBody: "visible end of the stored thread",
  pageIds: ["older", "start", "tail"],
  pageBodies: [
    { id: "older", body: "older message loaded by scrolling up the transcript" },
    { id: "tail", body: "visible end of the stored thread" },
  ],
});
if (scrollback) fail("scrollback must not count as activity");
if (!dbSrc.includes("pageShowsNewActivity")) fail("db.js must decide activity from the page ending");
if (!dbSrc.includes("alignRekeyedTurns") || !dbSrc.includes("planCloneDrops")) {
  fail("db.js must collapse a re-keyed copy of the same turn");
}
if (!read("src/message-identity.js").includes("turnStamp")) {
  fail("re-keyed turns need a role and normalized-text identity");
}
if (!read("content/shared.js").includes("Chatseek.debounce(invoke, 800)")) {
  fail("capture must stay debounced so a stream does not write every token");
}
const readerSrc = read("reader/reader.js");
if (!readerSrc.includes("INDEX_UPDATED") || !readerSrc.includes("readConversationRow")) {
  fail("the reader must refresh its clock from the conversation row");
}
if (!readerSrc.includes("clearInterval(readerClock)")) {
  fail("the reader clock must stop while the reader is hidden");
}
const beforeCopy = {
  zh_TW: "早於",
  zh_CN: "早于",
  en: "before ",
};
for (const [folder, piece] of Object.entries(beforeCopy)) {
  const messages = JSON.parse(read(`_locales/${folder}/messages.json`));
  const before = messages.before?.message || "";
  const approx = messages.approx?.message || "";
  const unknown = messages.unknown?.message || "";
  if (!before.includes(piece)) fail(`missing before-anchor label in ${folder}: ${before}`);
  if (!approx || !unknown) fail(`${folder} is missing approx/unknown date labels`);
}
if (!/formatAbsoluteStamp|Intl\.DateTimeFormat/.test(activitySrc)) {
  fail("activity labels should format dates with Intl");
}
if (!/readArchiveSignals/.test(sharedSrc)) fail("shared.js should expose archive signal reading");
if (!/supported: false/.test(sharedSrc)) fail("platforms without an archive surface must be able to decline");

pageTime._healthWarned = "";
const zero = pageTime.buildHealthReport({
  platform: "chatgpt",
  pathKind: "conversation",
  sidebarCount: 4,
  messageCount: 0,
  selector: null,
  selectorsTried: ["[data-message-author-role]", "[data-turn]"],
});
if (!zero.warn) fail("conversation page with 0 messages should warn");
if (!healthWarns.some((line) => line.includes("[Chatseek] chatgpt: 0 messages on /c/ page, selectors tried:"))) {
  fail(`missing capture health console hint: ${healthWarns.join(" | ")}`);
}
pageTime.buildHealthReport({
  platform: "chatgpt",
  pathKind: "conversation",
  sidebarCount: 4,
  messageCount: 0,
  selector: null,
  selectorsTried: ["[data-message-author-role]", "[data-turn]"],
});
if (healthWarns.length !== 1) fail("health warning should be logged once per selector set");
const home = pageTime.buildHealthReport({
  platform: "chatgpt",
  pathKind: "home",
  sidebarCount: 2,
  messageCount: 0,
  selectorsTried: [],
});
if (home.warn) fail("home page with 0 messages should not warn");
const claudeZero = pageTime.buildHealthReport({
  platform: "claude",
  pathKind: "conversation",
  sidebarCount: 1,
  messageCount: 0,
  selectorsTried: [".font-claude-message"],
});
if (!claudeZero.warn || !healthWarns.some((line) => line.includes("claude: 0 messages on conversation page"))) {
  fail("health check should cover Claude too");
}
const geminiSrc = read("content/gemini.js");
if (/batchexecute|MaZiqc|hNvQHb/.test(geminiSrc)) {
  fail("gemini.js must not call Gemini internal endpoints");
}
if (/timeSource|emptyCapture|extractedMessageCount/.test(geminiSrc)) {
  fail("gemini.js should use shared activity time and health, not a local date copy");
}
for (const needle of ["attachPageTime", "sidebarSlots", "queryLayers", "pageKind", "runCapture"]) {
  if (!geminiSrc.includes(needle)) fail(`gemini.js should call Chatseek.${needle}`);
}
if (!/gemini:\s*"Gemini"/.test(activitySrc)) fail("health labels should name Gemini");
const panelHtml = read("sidepanel/index.html");
const panelSrc = read("sidepanel/panel.js");
if (!/data-platform="gemini"/.test(panelHtml)) fail("side panel needs a Gemini filter");
if (!/data-scope="active"/.test(panelHtml) || !/data-scope="archived"/.test(panelHtml) || !/id="filterAll"/.test(panelHtml)) {
  fail("side panel tabs should be active, platforms, archived, then all");
}
const tabOrder = panelHtml.indexOf('data-scope="active"');
const gptOrder = panelHtml.indexOf('data-platform="chatgpt"');
const archivedOrder = panelHtml.indexOf('data-scope="archived"');
const allOrder = panelHtml.indexOf('id="filterAll"');
if (!(tabOrder < gptOrder && gptOrder < archivedOrder && archivedOrder < allOrder)) {
  fail("tab order should be active, platforms, archived, all");
}
const imagesOrder = panelHtml.indexOf('data-scope="images"');
if (!(allOrder < imagesOrder)) fail("the images tab must follow All");
if (!/id="showUncached"/.test(panelHtml) || !/id="imageGrid"/.test(panelHtml)) {
  fail("the images tab needs an uncached switch and a grid");
}
if (!panelSrc.includes("listImageCards") || !panelSrc.includes("filterImageCards")) {
  fail("the images tab must list cached rows without a new fetch");
}
const gridSrc = read("src/image-grid.js");
if (/innerHTML|insertAdjacentHTML|outerHTML/.test(gridSrc)) fail("image grid must not assign HTML");
if (/\bfetch\s*\(/.test(gridSrc) || /\bnew\s+Image\b/.test(gridSrc)) fail("image grid must not fetch or construct an Image");
if (!gridSrc.includes("dataUrlFromBytes") || !gridSrc.includes("function releaseUrl") || !gridSrc.includes("revokeObjectURL")) {
  fail("thumbnails stay on data URLs, and an object URL must be revoked");
}
if (!gridSrc.includes("visibleRange")) fail("the image grid must virtualize");
if (!gridSrc.includes('removeAttribute("src")')) fail("leaving a thumbnail must drop its data URL");
if (!gridSrc.includes("ResizeObserver")) fail("the image grid must refit when the panel width changes");
if (!/startsWith\("data:image\/"\)/.test(gridSrc)) fail("a thumbnail src must be a data URL");
if (!read("src/reader-view.js").includes("is-target") || !read("src/reader-url.js").includes('params.set("m"')) {
  fail("the reader must be able to scroll to a chosen cached image");
}
if (!read("src/db.js").includes("listImageCards")) fail("image cards must be listed from IndexedDB");
if (!read("src/db.js").includes('const IMAGE_BLOB_PREFIX = "imgb:"') || !read("src/db.js").includes("delete next.blob")) {
  fail("thumbnail bytes must be stored apart from the image list row");
}
for (const folder of localeFolders) {
  const messages = JSON.parse(read(`_locales/${folder}/messages.json`));
  if (!messages.tabImages?.message || !messages.imageEmpty?.message || !messages.showUncached?.message) {
    fail(`${folder} is missing the image tab copy`);
  }
}
if (!panelSrc.includes("paintActivityTimes")) {
  fail("the side panel must repaint relative activity labels");
}
if (!panelSrc.includes("clearInterval(activityClock)")) {
  fail("the side panel clock must stop while the panel is hidden");
}
if (!/gemini:\s*"Gemini"/.test(panelSrc)) fail("side panel should name Gemini");
if (!/removeConversation/.test(panelSrc)) fail("side panel should remove a row from the local index");
if (/innerHTML|insertAdjacentHTML|outerHTML/.test(panelSrc)) {
  fail("side panel must not assign HTML from chat text");
}
if (/innerHTML|insertAdjacentHTML|outerHTML/.test(read("src/preview.js"))) {
  fail("preview renderer must not use innerHTML");
}
for (const rel of ["src/reader-view.js", "src/markdown.js", "src/markdown-dom.js", "reader/reader.js", "reader/index.html"]) {
  if (/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(read(rel))) {
    fail(`${rel} must not assign HTML`);
  }
}
const markdownSrc = read("src/markdown.js") + read("src/markdown-dom.js");
if (!existsSync(join(root, "src/markdown.js")) || !existsSync(join(root, "src/markdown-dom.js"))) {
  fail("in-repo markdown parser is missing");
}
if (/createElement\(\s*["'](img|script|iframe|object|embed)["']\s*\)/.test(markdownSrc)) {
  fail("markdown renderer must not create img, script, or iframe elements");
}
if (/cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|skypack\.dev/.test(markdownSrc)) {
  fail("markdown renderer must not load a CDN");
}
const cdnRe = /cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|skypack\.dev/;
for (const rel of [
  "background.js",
  "reader/index.html",
  "reader/reader.js",
  "reader/reader.css",
  "sidepanel/index.html",
  "sidepanel/panel.js",
  "sidepanel/panel.css",
  "src/markdown.js",
  "src/markdown-dom.js",
  "src/reader-view.js",
  "src/preview.js",
  "src/icons.js",
  "src/focus-tab.js",
]) {
  if (cdnRe.test(read(rel))) fail(`${rel} must not reference a CDN`);
  if (/<script[^>]+src\s*=\s*["']https?:/i.test(read(rel))) fail(`${rel} must not load a remote script`);
}
const readerPage = read("reader/reader.js");
if (/upsert|removeConversation|clearAll|readwrite/.test(readerPage)) {
  fail("reader page must not write the index");
}
if (!readerPage.includes("localStorage") || !readerPage.includes("getUILanguage")) {
  fail("reader should follow the panel language stored in localStorage");
}
if (!readerPage.includes("chatseek.uiLocale")) fail("reader should use the panel locale key");
const readerHtml = read("reader/index.html");
if (!/img-src 'self'/.test(readerHtml)) fail("reader page CSP should block external images");
if (/<script(?![^>]*src=)/i.test(readerHtml)) fail("reader page must not use inline scripts");
if (!read("sidepanel/panel.js").includes("reader/index.html") && !read("sidepanel/panel.js").includes("readerPageUrl")) {
  fail("side panel should open the reader page");
}
if (!read("sidepanel/panel.js").includes('className = "read"')) fail("side panel needs a read control");
if (!read("sidepanel/panel.js").includes('className = "open-site"')) fail("side panel needs an original-site control");
if (/chrome\.tabs\.query\(\s*\{\s*url/.test(read("sidepanel/panel.js"))) {
  fail("opening a chat must not depend on tabs.query url matching");
}
if (!/\.plat\.gemini/.test(read("sidepanel/panel.css"))) fail("missing .plat.gemini color");
const backgroundSrc = read("background.js");
if (!/gemini:\s*\[/.test(backgroundSrc) || !/knownPlatform/.test(backgroundSrc)) {
  fail("background.js should accept gemini through HOSTS");
}
if (!/FOCUS_ORIGINAL/.test(backgroundSrc) || !/FOCUS_READER/.test(backgroundSrc) || !/getContexts/.test(backgroundSrc)) {
  fail("background should reuse an open conversation tab before creating one");
}
if (!/fitHealth/.test(backgroundSrc)) fail("health payload should be trimmed without dropping the warning");
if (/stringify\(health\)\.length > 2000/.test(backgroundSrc)) {
  fail("a long diag must not reject the whole health warning");
}
if (!/senderPageUrl/.test(backgroundSrc)) fail("health should accept sender.url when tab.url is empty");
if (!/\[Chatseek\] loaded v=/.test(sharedSrc)) fail("content script must log once when it loads");
if (!/CHATSEEK_PING/.test(sharedSrc)) fail("content script must answer the side panel ping");
if (!/emptyRescanDelay/.test(sharedSrc)) fail("empty conversations need a capped rescan");
if (!/document\.hidden/.test(sharedSrc)) fail("a hidden tab must pause the empty rescan");
const chatgptSrc = read("content/chatgpt.js");
if (!/watchEmbedded = true/.test(chatgptSrc)) fail("chatgpt should opt in to embedded watching");
for (const rel of ["content/claude.js", "content/gemini.js", "content/grok.js"]) {
  if (/watchEmbedded/.test(read(rel))) fail(`${rel} must not opt in to embedded frame watching`);
}
const childBranch = chatgptSrc.slice(chatgptSrc.lastIndexOf("if (child)"));
if (!/watchChildFrame\(\)/.test(childBranch) || /runCapture|observe\(/.test(childBranch.split("else")[0] || "")) {
  fail("a child frame must not capture or write");
}
const openShadowFn = sharedSrc.slice(sharedSrc.indexOf("openShadowRoots(doc)"), sharedSrc.indexOf("openShadowRoots(doc)") + 320);
if (/closed:\s*true/.test(openShadowFn)) fail("the shared open-shadow walk must not probe closed roots");
const pingSrc = read("sidepanel/panel.js");
const pingAt = pingSrc.indexOf("async function pingInjection");
const guardAt = pingSrc.indexOf("isChatTabUrl", pingAt);
const sendAt = pingSrc.indexOf("chrome.tabs.sendMessage", pingAt);
if (pingAt < 0 || guardAt < 0 || sendAt < 0 || guardAt > sendAt) {
  fail("the injection ping must check the chat host before sendMessage");
}
if (!/openOrClosedShadowRoot/.test(sharedSrc)) fail("closed shadow roots must be readable without a new permission");
if (!/readScopes/.test(read("content/chatgpt.js"))) fail("chatgpt capture must walk shadow and iframe scopes");
if (!/conversationIdFromPath/.test(read("content/chatgpt.js"))) fail("chatgpt ids must come from the /c/ uuid");

for (const rel of [
  "content/chatgpt.js",
  "content/claude.js",
  "content/grok.js",
  "content/gemini.js",
  "content/shared.js",
  "content/images.js",
]) {
  if (/innerHTML|insertAdjacentHTML|outerHTML|\beval\s*\(/.test(read(rel))) {
    fail(`${rel} must not use innerHTML or eval`);
  }
}
for (const rel of ["content/chatgpt.js", "content/claude.js", "content/grok.js", "content/gemini.js"]) {
  const src = read(rel);
  const captureAt = src.search(/Chatseek\.runCapture/);
  const imageAt = src.lastIndexOf("safeScheduleImages");
  if (captureAt < 0 || imageAt < 0 || imageAt < captureAt) {
    fail(`${rel} must store text before scheduling images`);
  }
}
if (!/safeScheduleImages = \(job\) => \{\s*try \{/.test(read("content/shared.js"))) {
  fail("image scheduling must catch errors so text capture still finishes");
}
const { indexPlain } = await import("../src/markdown.js");
const indexed = indexPlain("**bold** word\n\n# Title\n\n[lab](https://example.com/zz-secret)");
if (/[*#]|zz-secret|example\.com/.test(indexed) || !indexed.includes("bold") || !indexed.includes("Title") || !indexed.includes("lab")) {
  fail(`search text kept markup or a link url: ${indexed}`);
}
const indexedImage = indexPlain("see ![maple tea](https://cdn.example/maple.png) today");
if (/cdn\.example|maple\.png/.test(indexedImage) || !indexedImage.includes("maple tea")) {
  fail(`search text kept an image url: ${indexedImage}`);
}
const leaked = pageTime.formatDiag({
  version: "1.6.1",
  platform: "chatgpt",
  pathKind: "conversation",
  selector: "[data-turn]",
  selectorHits: { "[data-turn]": 2, "[data-message-author-role]": 0 },
  userCount: 1,
  assistantCount: 1,
  charCount: 40,
  imagesCached: 0,
  imagesPlaceholder: 1,
  healthState: "warn",
  errorName: "TypeError",
  errorStack: "at capture (chatgpt.js:1:1)",
  at: Date.UTC(2026, 9, 8, 12, 0, 0),
  title: "SECRET TITLE",
  body: "SECRET BODY zebrafox",
  prompt: "SECRET PROMPT",
  alt: "SECRET ALT",
  url: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111",
});
if (!leaked.startsWith("[Chatseek] diag ")) fail(`diag prefix missing: ${leaked}`);
if (/SECRET|zebrafox|11111111|chatgpt\.com\/c/.test(leaked)) fail(`diag leaked content: ${leaked}`);
const structureLine = pageTime.formatStructure({
  main: "shadow+iframe",
  top: 4,
  body: "41-160",
  frames: ["chatgpt.com:script", "https://evil.example/runner.html?q=1:script"],
  shadows: [{ tag: "div", mode: "closed" }, { tag: "!!!", mode: "open" }],
  skeleton: "iframe>main>div{turn}~41-160 SECRET BODY zebrafox",
});
if (!/main=shadow\+iframe/.test(structureLine) || !/top=4/.test(structureLine) || !/body=41-160/.test(structureLine)) {
  fail(`structure line missing counts: ${structureLine}`);
}
if (!/frames=1:chatgpt\.com:script/.test(structureLine)) fail(`frame host leaked a path: ${structureLine}`);
if (!/shadows=1:div:closed/.test(structureLine)) fail(`shadow list drifted: ${structureLine}`);
if (!/skeleton=-/.test(structureLine) || /SECRET|zebrafox|evil\.example|runner/.test(structureLine)) {
  fail(`structure diag leaked text: ${structureLine}`);
}
const uuidSkeleton = pageTime.formatStructure({
  main: "top",
  top: 1,
  body: "0",
  frames: [],
  shadows: [],
  skeleton: "main>div~1-40 11111111-1111-4111-8111-111111111111",
});
if (/11111111/.test(uuidSkeleton) || !/skeleton=-/.test(uuidSkeleton)) {
  fail(`uuid must not survive in the skeleton: ${uuidSkeleton}`);
}
if (!/user=1/.test(leaked) || !/assistant=1/.test(leaked) || !/imgHold=1/.test(leaked) || !/path=conversation/.test(leaked)) {
  fail(`diag missing counts: ${leaked}`);
}
if (!/imgs=1\/0\/1 fail=tainted:0,too-big:0,timeout:0,not-loaded:0/.test(leaked)) {
  fail(`diag missing image counts: ${leaked}`);
}
pageTime.scheduleMessageImages = () => {
  throw new Error("boom SECRET BODY");
};
let imageThrew = false;
try {
  pageTime.safeScheduleImages({ conversationId: "chatgpt:x", items: [{ messageId: "m" }] });
} catch {
  imageThrew = true;
}
if (imageThrew) fail("image scheduling must not throw into text capture");
const afterImage = pageTime.formatDiag(pageTime.diagFields({
  platform: "chatgpt",
  pathKind: "conversation",
  healthState: "ok",
}));
if (/SECRET/.test(afterImage)) fail(`diag included the image error text: ${afterImage}`);
if (!/err=Error/.test(afterImage)) fail(`diag should keep the error name: ${afterImage}`);
const dirtyStack = pageTime.formatDiag({
  version: "1.6.1",
  platform: "chatgpt",
  pathKind: "conversation",
  errorName: "SECRET BODY zebrafox",
  errorStack: "at capture (chatgpt.js:1:1) SECRET BODY zebrafox https://chatgpt.com/c/11111111-1111-4111-8111-111111111111",
  at: Date.UTC(2026, 9, 8, 12, 0, 0),
});
if (/SECRET|zebrafox|11111111|chatgpt\.com/.test(dirtyStack)) fail(`diag stack leaked: ${dirtyStack}`);
const shellHealth = {
  pathKind: "conversation",
  selector: "[data-message-author-role]",
  selectorsTried: ["[data-message-author-role]", "[data-turn]"],
  selectorHits: { "[data-message-author-role]": 2, "[data-turn]": 2 },
  userCount: 0,
  assistantCount: 0,
  charCount: 0,
};
const shellState = { lastListFp: "", lastMsgFp: "" };
sent.length = 0;
healthWarns.length = 0;
await pageTime.runCapture(shellState, {
  platform: "chatgpt",
  sidebar: [],
  conversation: conv("shell"),
  messages: [],
  health: shellHealth,
});
if (healthSent().some((p) => p.health.warn) || healthWarns.length) {
  fail("selector shells during the grace period are still loading and must not warn");
}
shellState.zeroSince -= pageTime.HEALTH_GRACE_MS;
await pageTime.runCapture(shellState, {
  platform: "chatgpt",
  sidebar: [],
  conversation: conv("shell"),
  messages: [],
  health: shellHealth,
});
if (!healthSent().some((p) => p.health.warn && p.health.messageCount === 0 && String(p.health.diag || "").startsWith("[Chatseek] diag "))) {
  fail("a title-only thread whose selectors matched shells must warn and store a diag line");
}
if (healthSent().some((p) => /SECRET|zebrafox/.test(JSON.stringify(p.health)))) {
  fail("stored health diag must not carry message text");
}
const fresh = { lastListFp: "", lastMsgFp: "" };
sent.length = 0;
healthWarns.length = 0;
await pageTime.runCapture(fresh, {
  platform: "chatgpt",
  sidebar: [],
  conversation: conv("new"),
  messages: [],
  health: {
    pathKind: "conversation",
    selector: "none",
    selectorsTried: ["[data-message-author-role]"],
    selectorHits: { "[data-message-author-role]": 0 },
    untitled: true,
    userCount: 0,
    assistantCount: 0,
    charCount: 0,
  },
});
fresh.zeroSince -= pageTime.HEALTH_GRACE_MS;
await pageTime.runCapture(fresh, {
  platform: "chatgpt",
  sidebar: [],
  conversation: conv("new"),
  messages: [],
  health: {
    pathKind: "conversation",
    selector: "none",
    selectorsTried: ["[data-message-author-role]"],
    selectorHits: { "[data-message-author-role]": 0 },
    untitled: true,
    userCount: 0,
    assistantCount: 0,
    charCount: 0,
  },
});
if (healthSent().some((p) => p.health.warn) || healthWarns.length) {
  fail("a new chat with a generic title and no message nodes must not warn");
}

if (errors.length) {
  console.error(errors.map((e) => "x " + e).join("\n"));
  process.exit(1);
}
console.log("verify ok");
