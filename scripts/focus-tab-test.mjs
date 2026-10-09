import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findReaderContext,
  focusTab,
  readerIdFromDocumentUrl,
  readerRefreshUrl,
  siteCandidates,
  siteKey,
} from "../src/focus-tab.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const gpt = "11111111-1111-4111-8111-111111111111";
const gptUrl = `https://chatgpt.com/c/${gpt}`;
const geminiId = "a1b2c3d4e5f67890";

assert(siteKey(`${gptUrl}?model=gpt-4#reply`) === `chatgpt:${gpt}`, "query and hash are not part of the chat");
assert(siteKey(`${gptUrl}#top`) === siteKey(gptUrl), "hash-only URL matches the bare chat");
assert(siteKey(`https://gemini.google.com/u/0/app/${geminiId}`) === `gemini:${geminiId}`, "Gemini /u/0/ is the same chat");
assert(siteKey(`https://gemini.google.com/app/${geminiId}?hl=zh-CN#x`) === `gemini:${geminiId}`, "Gemini without /u/N/ matches");
assert(siteKey(`https://gemini.google.com/u/4/app/${geminiId}`) === `gemini:${geminiId}`, "another Gemini account prefix still matches");
assert(siteKey("https://chatgpt.com/") === "", "the home page is not a conversation");
assert(siteKey("https://example.com/c/" + gpt) === "", "other hosts are not reused");

assert(
  readerIdFromDocumentUrl(`chrome-extension://abc/reader/index.html?id=chatgpt:${gpt}&q=leaf#top`) === `chatgpt:${gpt}`,
  "reader id ignores the search box and the hash",
);
assert(
  readerIdFromDocumentUrl("https://chatgpt.com/c/" + gpt) === "",
  "a website tab is not a reader tab",
);

const key = `chatgpt:${gpt}`;
const older = { tabId: 3, windowId: 1, key, at: 10 };
const newer = { tabId: 8, windowId: 2, key, at: 20 };
const other = { tabId: 9, windowId: 2, key: "chatgpt:other", at: 30 };
assert(siteCandidates(null, [older, other, newer], key)[0]?.tabId === 8, "without a tab list the latest report wins");
assert(siteCandidates(null, [other], key).length === 0, "a different chat is not reused");
assert(siteCandidates([{ id: 3, windowId: 1, url: gptUrl }], [], "").length === 0, "no key, no tab");
{
  const tabs = [
    { id: 3, windowId: 1, url: `${gptUrl}?model=x`, lastAccessed: 100 },
    { id: 8, windowId: 2, url: `${gptUrl}#later`, lastAccessed: 500 },
    { id: 9, windowId: 2, url: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222", lastAccessed: 900 },
    { id: 10, windowId: 3, lastAccessed: 999 },
  ];
  const picked = siteCandidates(tabs, [older], key);
  assert(picked.map((t) => t.tabId).join() === "8,3", `live tabs of that chat, last seen first: ${JSON.stringify(picked)}`);
  assert(picked[0].windowId === 2, "the window comes with the tab");
  const stale = siteCandidates([{ id: 3, windowId: 1, lastAccessed: 1 }], [older], key);
  assert(stale.length === 0, "a reported tab that moved to another site is not reused");
}
assert(
  readerRefreshUrl(
    "chrome-extension://abc/reader/index.html?id=chatgpt%3Ax&q=old",
    "chrome-extension://abc/reader/index.html?id=chatgpt%3Ax&q=new",
    "chatgpt:x",
    "chrome-extension://abc/",
  ).includes("q=new"),
  "a new search reloads the open reader",
);
assert(
  readerRefreshUrl(
    "chrome-extension://abc/reader/index.html?id=chatgpt%3Ax&q=same#hit",
    "chrome-extension://abc/reader/index.html?id=chatgpt%3Ax&q=same",
    "chatgpt:x",
    "chrome-extension://abc/",
  ) === "",
  "the same search only switches tabs",
);
assert(
  readerRefreshUrl(
    "chrome-extension://abc/reader/index.html?id=chatgpt%3Ax",
    "chrome-extension://abc/reader/index.html?id=chatgpt%3Ax&m=chatgpt%3Ax%3Au&i=1",
    "chatgpt:x",
    "chrome-extension://abc/",
  ).includes("i=1"),
  "a different image reloads the open reader",
);
assert(
  readerRefreshUrl(
    "chrome-extension://abc/reader/index.html?id=chatgpt%3Ax&m=chatgpt%3Ax%3Au&i=1",
    "chrome-extension://abc/reader/index.html?id=chatgpt%3Ax&m=chatgpt%3Ax%3Au&i=1",
    "chatgpt:x",
    "chrome-extension://abc/",
  ) === "",
  "the same image only switches tabs",
);
assert(
  readerRefreshUrl("chrome-extension://abc/reader/index.html?id=a", "https://evil.example/reader/index.html?id=a&q=x", "a", "chrome-extension://abc/") === "",
  "only this extension's reader URL is loaded",
);
assert(
  readerRefreshUrl("chrome-extension://abc/reader/index.html?id=a", "chrome-extension://abc/reader/index.html?id=b&q=x", "a", "chrome-extension://abc/") === "",
  "a reader URL for another chat is refused",
);

const contexts = [
  { documentUrl: "https://chatgpt.com/c/" + gpt, tabId: 3, windowId: 1 },
  { documentUrl: `chrome-extension://abc/reader/index.html?id=chatgpt:${gpt}&q=old`, tabId: 5, windowId: 4 },
  { documentUrl: `chrome-extension://abc/reader/index.html?id=chatgpt:${gpt}&q=new#hit`, tabId: 6, windowId: 9 },
];
assert(findReaderContext(contexts, `chatgpt:${gpt}`)?.tabId === 6, "reader tabs match on the conversation id");
assert(findReaderContext(contexts, "chatgpt:missing") === null, "an unopened reader is not invented");

{
  const updates = [];
  const windows = [];
  const ok = await focusTab(
    { async update(id, info) { updates.push({ id, info }); } },
    { async update(id, info) { windows.push({ id, info }); } },
    { tabId: 8, windowId: 2 },
  );
  assert(ok === true, "an open tab is focused");
  assert(updates[0]?.id === 8 && updates[0].info.active === true, "the tab is activated");
  assert(windows[0]?.id === 2 && windows[0].info.focused === true, "its window is focused");
}
{
  const ok = await focusTab(
    { async update() { throw new Error("No tab with id"); } },
    { async update() { throw new Error("should not focus a window"); } },
    { tabId: 8, windowId: 2 },
  );
  assert(ok === false, "a closed tab falls through");
}
{
  let windowCalls = 0;
  const ok = await focusTab(
    { async update() {} },
    { async update() { windowCalls += 1; throw new Error("window gone"); } },
    { tabId: 8, windowId: 2 },
  );
  assert(ok === true && windowCalls === 1, "a window-focus failure still counts as reuse");
}
assert(await focusTab({ async update() {} }, {}, null) === false, "nothing to focus");

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
assert(
  JSON.stringify(manifest.permissions) === JSON.stringify(["sidePanel"]),
  `permissions stay sidePanel, got ${JSON.stringify(manifest.permissions)}`,
);

const updates = [];
const windows = [];
let failUpdate = false;
let queryFails = false;
let liveTabs = [];
let contextsLive = [];
const listeners = [];
const removed = [];
const EXT = "chrome-extension://chatseek-test/";
globalThis.chrome = {
  sidePanel: { setPanelBehavior() { return Promise.resolve(); } },
  action: { setBadgeText() { return Promise.resolve(); } },
  runtime: {
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    sendMessage() { return Promise.resolve(); },
    onMessage: { addListener(fn) { listeners.push(fn); } },
    getContexts: async () => contextsLive,
    getURL: (path) => EXT + path,
  },
  tabs: {
    async query(info) {
      assert(info && Object.keys(info).length === 0, "the tab list is read without a URL filter");
      if (queryFails) throw new Error("tabs unavailable");
      return liveTabs.map((tab) => ({ ...tab }));
    },
    async update(id, info) {
      updates.push({ id, info });
      if (failUpdate) throw new Error("No tab with id");
    },
    onRemoved: { addListener(fn) { removed.push(fn); } },
  },
  windows: {
    async update(id, info) { windows.push({ id, info }); },
  },
};

let generation = 0;
async function bootWorker() {
  generation += 1;
  const before = listeners.length;
  await import(`../background.js?boot=${generation}`);
  assert(listeners.length === before + 1, "background listens once per boot");
  return listeners.at(-1);
}

let listener = await bootWorker();
const panelSender = {};
const readerSender = { tab: { id: 77, windowId: 1 }, url: `${EXT}reader/index.html?id=x` };

function ask(msg, sender = panelSender) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`hung on ${msg.type}`)), 1000);
    const asyncReply = listener(msg, sender, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
    if (asyncReply !== true) {
      clearTimeout(timer);
      resolve(undefined);
    }
  });
}

liveTabs = [{ id: 4, windowId: 7, url: `https://gemini.google.com/u/1/app/${geminiId}?hl=en#chat`, lastAccessed: 5 }];
const geminiHit = await ask({ type: "FOCUS_ORIGINAL", url: `https://gemini.google.com/app/${geminiId}` });
assert(geminiHit.focused === true, "Gemini /u/N/ focuses the open tab");
assert(updates.at(-1).id === 4 && updates.at(-1).info.active === true, "that tab becomes active");
assert(!("url" in updates.at(-1).info), "the chat tab is not reloaded");
assert(windows.at(-1).id === 7 && windows.at(-1).info.focused === true, "that window is focused");

liveTabs = [
  { id: 11, windowId: 1, url: `${gptUrl}?model=a`, lastAccessed: 10 },
  { id: 12, windowId: 3, url: `${gptUrl}#later`, lastAccessed: 20 },
];
const latest = await ask({ type: "FOCUS_ORIGINAL", url: gptUrl }, readerSender);
assert(latest.focused === true && updates.at(-1).id === 12, "the tab seen last wins, from the reader page too");
assert(windows.at(-1).id === 3, "a tab in another window brings that window forward");

listener = await bootWorker();
const afterRestart = await ask({ type: "FOCUS_ORIGINAL", url: gptUrl });
assert(afterRestart.focused === true && updates.at(-1).id === 12, "a restarted worker with no reports still finds the tab");

listener({ type: "ACTIVE_LOCATION", url: gptUrl }, { tab: { id: 30, windowId: 1 } });
liveTabs = [{ id: 30, windowId: 1, lastAccessed: 99 }];
const moved = await ask({ type: "FOCUS_ORIGINAL", url: gptUrl });
assert(moved.focused === false, "a reported tab that now shows another site is not focused");

liveTabs = [{ id: 12, windowId: 3, url: gptUrl }];
failUpdate = true;
const closed = await ask({ type: "FOCUS_ORIGINAL", url: gptUrl });
assert(closed.focused === false, "a tab closed between query and focus does not throw");
failUpdate = false;

liveTabs = [];
const gone = await ask({ type: "FOCUS_ORIGINAL", url: gptUrl });
assert(gone.focused === false, "no open tab means the caller opens one");

removed.at(-1)(30);
queryFails = true;
listener({ type: "ACTIVE_LOCATION", url: `${gptUrl}?x=1` }, { tab: { id: 41, windowId: 2 } });
const fallback = await ask({ type: "FOCUS_ORIGINAL", url: gptUrl });
assert(fallback.focused === true && updates.at(-1).id === 41, "without a tab list the content-script report is used");
removed.at(-1)(41);
const removedTab = await ask({ type: "FOCUS_ORIGINAL", url: gptUrl });
assert(removedTab.focused === false, "onRemoved drops the reported tab");
listener({ type: "ACTIVE_LOCATION", url: gptUrl }, { tab: { id: 42, windowId: 2 } });
listener({ type: "ACTIVE_LOCATION", url: "https://chatgpt.com/" }, { tab: { id: 42, windowId: 2 } });
const left = await ask({ type: "FOCUS_ORIGINAL", url: gptUrl });
assert(left.focused === false, "leaving the conversation releases that tab");
queryFails = false;

const notChat = await ask({ type: "FOCUS_ORIGINAL", url: "https://chatgpt.com/" });
assert(notChat.focused === false, "a URL that is not a conversation focuses nothing");

const fromSite = await ask(
  { type: "FOCUS_ORIGINAL", url: gptUrl },
  { tab: { id: 50, windowId: 1, url: gptUrl }, url: gptUrl },
);
assert(fromSite === undefined, "a web page cannot ask the worker to switch tabs");

contextsLive = [
  { documentUrl: `${EXT}reader/index.html?id=chatgpt%3A${gpt}&q=one`, tabId: 21, windowId: 5 },
];
const readerHit = await ask({
  type: "FOCUS_READER",
  id: `chatgpt:${gpt}`,
  url: `${EXT}reader/index.html?id=chatgpt%3A${gpt}&q=one`,
});
assert(readerHit.focused === true && updates.at(-1).id === 21, "an open reader tab is focused by conversation id");
assert(!("url" in updates.at(-1).info), "the same search does not reload the reader");
assert(windows.at(-1).id === 5, "the reader's window is focused");
const readerNewQuery = await ask({
  type: "FOCUS_READER",
  id: `chatgpt:${gpt}`,
  url: `${EXT}reader/index.html?id=chatgpt%3A${gpt}&q=two`,
});
assert(readerNewQuery.focused === true && updates.at(-1).id === 21, "a new search reuses the reader tab");
assert(String(updates.at(-1).info.url || "").includes("q=two"), "and loads the new search there");
contextsLive = [];
const readerMiss = await ask({ type: "FOCUS_READER", id: `chatgpt:${gpt}` });
assert(readerMiss.focused === false, "a closed reader falls through");

for (const rel of ["sidepanel/panel.js", "reader/reader.js"]) {
  const src = readFileSync(join(root, rel), "utf8");
  assert(!/=\s*(?:globalThis\.)?chrome\??\.runtime\??\.sendMessage\s*;/.test(src), `${rel} calls sendMessage on chrome.runtime, not detached`);
  assert(/REUSE_WAIT_MS/.test(src), `${rel} gives up waiting for the worker`);
}

console.log("focus-tab tests passed");
