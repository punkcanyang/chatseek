import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findReaderContext,
  findSiteTab,
  focusTab,
  readerIdFromDocumentUrl,
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

const older = { tabId: 3, windowId: 1, key: `chatgpt:${gpt}`, at: 10 };
const newer = { tabId: 8, windowId: 2, key: `chatgpt:${gpt}`, at: 20 };
const other = { tabId: 9, windowId: 2, key: "chatgpt:other", at: 30 };
assert(findSiteTab([older, other, newer], `${gptUrl}?q=1`)?.tabId === 8, "the latest report of that chat is focused");
assert(findSiteTab([older], "https://chatgpt.com/") === null, "a non-conversation URL does not focus a tab");
assert(findSiteTab([other], gptUrl) === null, "a different chat is not reused");

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
const listeners = [];
const removed = [];
let contextsLive = [];
globalThis.chrome = {
  sidePanel: { setPanelBehavior() { return Promise.resolve(); } },
  action: { setBadgeText() { return Promise.resolve(); } },
  runtime: {
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    sendMessage() { return Promise.resolve(); },
    onMessage: { addListener(fn) { listeners.push(fn); } },
    getContexts: async () => contextsLive,
  },
  tabs: {
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

await import("../background.js");
assert(listeners.length === 1, "background listens once");
const listener = listeners[0];

function ask(msg, sender = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`hung on ${msg.type}`)), 1000);
    const asyncReply = listener(msg, sender, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
    if (msg.type === "FOCUS_ORIGINAL" || msg.type === "FOCUS_READER") {
      assert(asyncReply === true, `${msg.type} keeps the message channel open`);
    }
  });
}

listener(
  { type: "ACTIVE_LOCATION", url: `https://gemini.google.com/u/1/app/${geminiId}?hl=en#chat` },
  { tab: { id: 4, windowId: 7 } },
);
const geminiHit = await ask({
  type: "FOCUS_ORIGINAL",
  url: `https://gemini.google.com/app/${geminiId}`,
});
assert(geminiHit.focused === true, "Gemini /u/N/ focuses the reported tab");
assert(updates.at(-1).id === 4 && updates.at(-1).info.active === true, "that tab becomes active");
assert(windows.at(-1).id === 7 && windows.at(-1).info.focused === true, "that window is focused");

listener(
  { type: "ACTIVE_LOCATION", url: `${gptUrl}?model=a` },
  { tab: { id: 11, windowId: 1 } },
);
listener(
  { type: "ACTIVE_LOCATION", url: `${gptUrl}#later` },
  { tab: { id: 12, windowId: 3 } },
);
const latest = await ask({ type: "FOCUS_ORIGINAL", url: gptUrl });
assert(latest.focused === true && updates.at(-1).id === 12, "the newer tab of the same chat wins");

failUpdate = true;
const closed = await ask({ type: "FOCUS_ORIGINAL", url: gptUrl });
assert(closed.focused === false, "a closed tab does not throw and is not reused");
failUpdate = false;
const afterClose = await ask({ type: "FOCUS_ORIGINAL", url: gptUrl });
assert(afterClose.focused === false, "the closed tab is forgotten");

listener(
  { type: "ACTIVE_LOCATION", url: gptUrl },
  { tab: { id: 15, windowId: 1 } },
);
removed[0](15);
const gone = await ask({ type: "FOCUS_ORIGINAL", url: gptUrl });
assert(gone.focused === false, "onRemoved drops the tab before the next click");

listener(
  { type: "ACTIVE_LOCATION", url: "https://chatgpt.com/" },
  { tab: { id: 4, windowId: 7 } },
);
const left = await ask({
  type: "FOCUS_ORIGINAL",
  url: `https://gemini.google.com/u/9/app/${geminiId}`,
});
assert(left.focused === false, "leaving the conversation releases that tab");

const quiet = await ask({ type: "FOCUS_ORIGINAL", url: "https://claude.ai/chat/" + gpt });
assert(quiet.focused === false, "an unreported chat opens nothing here");

contextsLive = [
  { documentUrl: `chrome-extension://abc/reader/index.html?id=chatgpt:${gpt}&q=one`, tabId: 21, windowId: 5 },
];
const readerHit = await ask({ type: "FOCUS_READER", id: `chatgpt:${gpt}` });
assert(readerHit.focused === true && updates.at(-1).id === 21, "an open reader tab is focused by conversation id");
contextsLive = [];
const readerMiss = await ask({ type: "FOCUS_READER", id: `chatgpt:${gpt}` });
assert(readerMiss.focused === false, "a closed reader falls through");

console.log("focus-tab tests passed");
