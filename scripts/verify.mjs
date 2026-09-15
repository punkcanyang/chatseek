#!/usr/bin/env node
import { readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

if (errors.length) {
  console.error(errors.map((e) => "x " + e).join("\n"));
  process.exit(1);
}
console.log("verify ok");
