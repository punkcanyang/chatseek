#!/usr/bin/env node
import { readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { tokenize, queryTokens } from "../src/tokenize.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

function fail(msg) {
  errors.push(msg);
}

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
if (!manifest.side_panel?.default_path) fail("side_panel.default_path missing");

const hosts = JSON.stringify(manifest.host_permissions || []);
for (const banned of ["gemini", "perplexity", "deepseek", "google.com"]) {
  if (hosts.toLowerCase().includes(banned)) fail(`banned host: ${banned}`);
}
const allowed = [
  "https://chatgpt.com/*",
  "https://chat.openai.com/*",
  "https://claude.ai/*",
  "https://grok.com/*",
  "https://www.grok.com/*",
  "https://grok.x.com/*",
  "https://x.ai/*",
];
const extra = (manifest.host_permissions || []).filter((h) => !allowed.includes(h));
if (extra.length) fail(`unexpected host_permissions: ${extra.join(", ")}`);

for (const script of manifest.content_scripts || []) {
  const joined = (script.matches || []).join(" ");
  if (/gemini|perplexity|deepseek/i.test(joined)) {
    fail(`content_scripts matches extra site: ${joined}`);
  }
}

const referenced = new Set([
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  "sidepanel/panel.js",
  "sidepanel/panel.css",
  "src/db.js",
  "src/tokenize.js",
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
  "content/shared.js",
]) {
  const src = read(rel);
  if (/XMLHttpRequest|prototype\.fetch|window\.fetch\s*=/.test(src)) {
    fail(`${rel} must not hook fetch/XHR`);
  }
  if (/MAIN/.test(src)) fail(`${rel} must not use MAIN world hooks`);
}

const dbSrc = read("src/db.js");
if (/messages["']?\)\.getAll|objectStore\(\s*["']messages["']\s*\)\.getAll/.test(dbSrc)) {
  fail("db.js must not getAll() the messages store");
}
if (!/openCursor/.test(dbSrc)) fail("db.js should cursor IndexedDB for search/list");
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
if (!/ChatGPT/i.test(readme) || !/Claude/i.test(readme) || !/Grok/i.test(readme)) {
  fail("README should mention ChatGPT, Claude, and Grok");
}


const sharedSrc = read("content/shared.js");
if (!/parsePageTime/.test(sharedSrc) || !/findTimeNear/.test(sharedSrc)) {
  fail("shared.js should expose parsePageTime and findTimeNear");
}
if (!/pageTimesFromDocument/.test(sharedSrc)) {
  fail("shared.js should scan static page JSON for conversation times");
}
for (const rel of ["content/chatgpt.js", "content/claude.js", "content/grok.js"]) {
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

if (errors.length) {
  console.error(errors.map((e) => "x " + e).join("\n"));
  process.exit(1);
}
console.log("verify ok");
