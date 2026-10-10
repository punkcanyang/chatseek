import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { clearImageCache, openDb, saveImageRecords, searchConversations, upsertConversations, upsertMessages } from "../src/db.js";
import { CATALOG, LOCALE_ORDER } from "../src/i18n.js";
import {
  activeTabUrl,
  eventInWindow,
  injectionUnloaded,
  locationFromMessage,
  readableTabUrl,
} from "../src/current-tab.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, label, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error(`timed out: ${label}`);
}

// Pure helpers first.
assert(readableTabUrl({ url: "https://chatgpt.com/c/x" }) === "https://chatgpt.com/c/x", "readable https URL");
assert(readableTabUrl({}) === "", "a tab without host permission has no URL");
assert(readableTabUrl({ url: "chrome://newtab/" }) === "", "chrome:// is not a chat");
const remote = { type: "ACTIVE_LOCATION", url: "https://chatgpt.com/c/x" };
assert(locationFromMessage(remote, { tab: { active: true, windowId: 2, url: remote.url } }, 1) === null, "another window's tab is ignored");
assert(locationFromMessage(remote, { tab: { active: false, windowId: 1, url: remote.url } }, 1) === null, "a background tab is ignored");
assert(locationFromMessage(remote, { tab: { active: true, windowId: 1, url: remote.url } }, 1) === remote.url, "this window's active tab is used");
assert(locationFromMessage(remote, { tab: { active: true, windowId: 1 } }, 1) === remote.url, "message URL is the fallback");
assert(locationFromMessage(remote, { tab: { active: true, windowId: 1 } }, null) === null, "unknown panel window does not trust messages");
assert(eventInWindow(2, 1) === false && eventInWindow(1, 1) === true && eventInWindow(undefined, 1) === true, "eventInWindow");
{
  const calls = [];
  const api = {
    async query(q) {
      calls.push(q);
      if (q.lastFocusedWindow) return [{ windowId: 2, url: "https://chatgpt.com/c/other" }];
      return [{ windowId: 1 }];
    },
  };
  assert(await activeTabUrl(api, 1) === "", "an unreadable tab in this window clears the frame");
  assert(calls.length === 1 && calls[0].windowId === 1, `only this window is queried: ${JSON.stringify(calls)}`);
  assert(await activeTabUrl(api, null) === "" && calls[1].currentWindow === true, "no window id asks for currentWindow");
  assert(await activeTabUrl({ query: () => Promise.reject(new Error("gone")) }, 1) === "", "query errors clear");
}
assert(injectionUnloaded({ url: "https://chatgpt.com/c/x", loaded: false }) === true, "a chat tab with no content script warns");
assert(injectionUnloaded({ url: "https://claude.ai/chat/x", loaded: false }) === true, "claude is one of the four hosts");
assert(injectionUnloaded({ url: "https://chatgpt.com/c/x", loaded: true }) === false, "a loaded chat tab stays quiet");
assert(injectionUnloaded({ url: "https://example.com/", loaded: false }) === false, "other sites do not warn");
assert(injectionUnloaded({ url: "", loaded: false }) === false, "an unreadable tab does not warn");

const uuid = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const chatgpt = (n) => ({
  id: `chatgpt:${uuid(n)}`,
  platform: "chatgpt",
  platformId: uuid(n),
  url: `https://chatgpt.com/c/${uuid(n)}`,
});
const now = Date.now();
const A = { ...chatgpt(1), title: "Alpha trip", updatedAt: now - 60000, updatedAtSource: "page-exact" };
const B = { ...chatgpt(2), title: "Bravo notes", updatedAt: now - 120000, updatedAtSource: "page-exact" };
const geminiId = "a1b2c3d4e5f67890";
const G = {
  id: `gemini:${geminiId}`,
  platform: "gemini",
  platformId: geminiId,
  url: `https://gemini.google.com/u/1/app/${geminiId}`,
  title: "Gemini orchid",
  updatedAt: now - 180000,
  updatedAtSource: "page-exact",
};
const X = {
  ...chatgpt(3),
  title: '<img src=x onerror="globalThis.pwned=1"> markup',
  updatedAt: now - 240000,
  updatedAtSource: "page-exact",
};

for (const conv of [A, B, G, X]) {
  const msgs = [
    { id: `${conv.id}:u`, role: "user", body: `first prompt of ${conv.title} <script>globalThis.pwned=2</script>` },
    { id: `${conv.id}:a`, role: "assistant", body: "assistant reply" },
  ];
  await upsertMessages(conv, msgs, { pageMessageIds: msgs.map((m) => m.id), captureId: conv.id });
}

// 85 newer sidebar-only rows push a 1.2.1 row out of the idle top 80.
await upsertConversations(Array.from({ length: 85 }, (_, i) => ({
  ...chatgpt(100 + i),
  title: `Filler ${i}`,
  updatedAt: now - 3600000 - 1000 * i,
  updatedAtSource: "page-exact",
})));
const legacyId = `chatgpt:${uuid(900)}`;
{
  const db = await openDb();
  const tx = db.transaction(["conversations", "messages", "tokenMap"], "readwrite");
  tx.objectStore("conversations").put({
    ...chatgpt(900),
    title: "Legacyzeta saved in 1.2.1",
    updatedAt: now - 86400000 * 30,
    updatedAtSource: "page-exact",
    messageCount: 1,
    tailMessageId: `${legacyId}:u`,
  });
  tx.objectStore("messages").put({
    id: `${legacyId}:u`,
    conversationId: legacyId,
    role: "user",
    body: "legacy question about ferns",
    capturedAt: now,
  });
  for (const token of ["legacyzeta", "saved", "in"]) {
    tx.objectStore("tokenMap").put({ token, conversationId: legacyId, source: "title" });
  }
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

const html = readFileSync(join(root, "sidepanel/index.html"), "utf8")
  .replace(/<script[^>]*panel\.js[^>]*><\/script>/, "");
const dom = new JSDOM(html, { url: "chrome-extension://test/sidepanel/index.html" });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, "navigator", {
  value: { language: "zh-CN", languages: ["zh-CN"] },
  configurable: true,
});
globalThis.confirm = () => false;

const scrolled = [];
window.Element.prototype.scrollIntoView = function () {
  scrolled.push(this.dataset?.id || "");
};
const inView = new Set();
window.Element.prototype.getBoundingClientRect = function () {
  const on = inView.has(this.dataset?.id);
  return { top: on ? 100 : 5000, bottom: on ? 160 : 5060, left: 0, right: 300, width: 300, height: 60 };
};
Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });

// Window 1 holds the panel. Window 2 is another browser window.
const active = {
  1: { id: 11, windowId: 1, active: true, url: A.url },
  2: { id: 21, windowId: 2, active: true, url: B.url },
};
let lastFocused = 1;
const listeners = { message: [], activated: [], updated: [] };
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
globalThis.chrome = {
  i18n: { getUILanguage: () => "zh-CN" },
  windows: { async getCurrent() { return { id: 1 }; } },
  tabs: {
    async query(q) {
      if (q.url) return [];
      const win = q.windowId ?? (q.currentWindow ? 1 : q.lastFocusedWindow ? lastFocused : null);
      return active[win] ? [{ ...active[win] }] : [];
    },
    async update() {},
    async create() {},
    onActivated: { addListener(fn) { listeners.activated.push(fn); } },
    onUpdated: { addListener(fn) { listeners.updated.push(fn); } },
  },
  runtime: {
    onMessage: { addListener(fn) { listeners.message.push(fn); } },
    sendMessage() {},
    getURL(path) {
      return `chrome-extension://chatseek-test/${String(path).replace(/^\//, "")}`;
    },
  },
  action: { setBadgeText() { return Promise.resolve(); } },
};

const openedTabs = [];
chrome.tabs.create = async (opts) => { openedTabs.push(opts); };
const message = (msg, sender = {}) => listeners.message.forEach((fn) => fn(msg, sender));
const activate = (windowId) => listeners.activated.forEach((fn) => fn({ tabId: active[windowId]?.id, windowId }));
const updated = (windowId, info) => listeners.updated.forEach((fn) => fn(active[windowId]?.id, info, active[windowId]));
const currentIds = () => [...document.querySelectorAll(".item.is-current")].map((el) => el.dataset.id);
const rowFor = (id) => document.querySelector(`.item[data-id="${id}"]`);

await import("../sidepanel/panel.js");

const authorLinks = document.querySelectorAll("footer.foot a");
const authorLink = authorLinks[0];
assert(authorLinks.length === 1 && authorLink.textContent === "@punkcan", "footer has one author link");
assert(authorLink.getAttribute("href") === "https://x.com/punkcan", "author link uses the exact fixed URL");
assert(authorLink.getAttribute("target") === "_blank" && authorLink.relList.contains("noopener"), "author link opens a safe new tab");

await until(() => currentIds().length === 1, "initial current row");
assert(currentIds()[0] === A.id, `initial frame on A, got ${currentIds()}`);
assert(rowFor(A.id).getAttribute("aria-current") === "true", "aria-current on the framed row");
assert(scrolled.length === 1 && scrolled[0] === A.id, `off-screen current row scrolls once: ${scrolled}`);
await until(() => document.getElementById("counts").textContent.includes("条消息"), "zh-CN counts say 条消息");
assert(!document.getElementById("counts").textContent.includes("则"), "zh-CN counts never say 则");

const preview = rowFor(A.id).querySelector(".item-preview");
assert(preview.dataset.preview === "first-user" && preview.textContent.startsWith("first prompt of Alpha"), "idle preview is the first prompt");
const draft = rowFor(`chatgpt:${uuid(100)}`).querySelector(".item-preview");
assert(draft.classList.contains("is-title-only") && draft.textContent === "仅有标题，未收录消息", "sidebar-only rows are marked");

const list = document.getElementById("list");
assert(!list.querySelector("img, script"), "chat text and titles never become elements");
assert(rowFor(X.id).querySelector(".item-title").textContent.startsWith("<img"), "markup title shows as text");
assert(globalThis.pwned === undefined, "no chat text ran");
assert(
  document.querySelectorAll(".item").length === document.querySelectorAll(".read").length &&
    document.querySelectorAll(".read").length === document.querySelectorAll(".open-site").length &&
    document.querySelectorAll(".read").length > 0,
  "every row has a read button and an original-site button",
);
assert(
  [...document.querySelectorAll(".read")].every((btn) =>
    btn.getAttribute("aria-label") === "阅读"
    && btn.title === "阅读"
    && btn.textContent.trim() === ""
    && btn.querySelector("svg")
    && btn.type === "button"),
  "zh-CN read label",
);
assert(
  [...document.querySelectorAll(".open-site")].every((btn) =>
    btn.getAttribute("aria-label") === "去原网站打开"
    && btn.title === "去原网站打开"
    && btn.querySelector("svg")
    && btn.type === "button"),
  "zh-CN original-site label",
);
{
  const css = readFileSync(join(root, "sidepanel/panel.css"), "utf8");
  assert(css.includes(".remove:focus-visible"), "remove button has a focus ring");
  assert(css.includes(".row:focus-within > .remove"), "keyboard focus inside the row reveals the X");
  assert(css.includes(".row:hover > .remove"), "hover reveals the X");
  assert(css.includes("#3DDC97"), "current-conversation frame stays green");
  const sample = rowFor(A.id).parentElement.querySelector(":scope > .remove");
  assert(sample && !rowFor(A.id).contains(sample), "the X is a sibling of the card, not nested in it");
  assert(sample.type === "button" && sample.tabIndex >= 0, "the X stays in tab order");
  assert(sample.textContent.trim() === "" && sample.querySelector("svg[aria-hidden='true']"), "the X is an icon");
  assert(sample.getAttribute("aria-label") === "从索引移除" && sample.title === "从索引移除", "zh-CN name and tooltip");
  assert(
    [...document.querySelectorAll(".remove")].every(
      (btn) => btn.getAttribute("aria-label") === CATALOG["zh-CN"].remove && btn.title === CATALOG["zh-CN"].remove,
    ),
    "every zh-CN row reuses the remove message",
  );
}
openedTabs.length = 0;
rowFor(A.id).parentElement.querySelector(".read").click();
await until(() => openedTabs.length === 1, "read opens a tab");
assert(openedTabs[0].url.includes("reader/index.html"), `read url ${openedTabs[0].url}`);
assert(openedTabs[0].url.includes(encodeURIComponent(A.id)), "read url carries the conversation id");
assert(!openedTabs[0].url.includes("chatgpt.com"), "read does not open the website");
openedTabs.length = 0;
rowFor(A.id).querySelector(".item-preview").click();
await until(() => openedTabs.length === 1, "preview opens the reader");
assert(openedTabs[0].url.includes("reader/index.html"), `preview url ${openedTabs[0].url}`);
openedTabs.length = 0;
rowFor(A.id).querySelector(".item-title").click();
await until(() => openedTabs.length === 1, "title still opens the original chat");
assert(openedTabs[0].url.startsWith("https://chatgpt.com/"), `title url ${openedTabs[0].url}`);

// Index updates for the same chat must not pull the list back.
message({ type: "INDEX_UPDATED" });
await sleep(400);
assert(currentIds()[0] === A.id && scrolled.length === 1, `refresh re-scrolled: ${scrolled}`);
updated(1, { status: "complete" });
await sleep(200);
assert(scrolled.length === 1, "a reload of the same chat does not scroll again");

// Another window's active tab must not move this panel's frame.
message({ type: "ACTIVE_LOCATION", url: B.url }, { tab: { ...active[2] } });
await sleep(50);
assert(currentIds()[0] === A.id, `another window's ACTIVE_LOCATION moved the frame: ${currentIds()}`);
lastFocused = 2;
activate(2);
updated(2, { url: B.url });
await sleep(200);
assert(currentIds()[0] === A.id, `another window's tab events moved the frame: ${currentIds()}`);

// Tab switch in this window to a site without host permission clears it,
// even while the last focused window shows a chat.
active[1] = { id: 12, windowId: 1, active: true };
activate(1);
await until(() => currentIds().length === 0, "non-chat tab clears the frame");
lastFocused = 1;

// Tab switch back to B in this window.
active[1] = { id: 13, windowId: 1, active: true, url: B.url };
activate(1);
await until(() => currentIds()[0] === B.id, "tab switch frames B");
assert(scrolled.at(-1) === B.id, "a new off-screen chat scrolls once");

// In-page navigation in this window; Gemini /u/4/ matches the /u/1/ row.
const geminiUrl = `https://gemini.google.com/u/4/app/${geminiId}`;
active[1] = { id: 13, windowId: 1, active: true, url: geminiUrl };
message({ type: "ACTIVE_LOCATION", url: geminiUrl }, { tab: { ...active[1] } });
await until(() => currentIds()[0] === G.id, "SPA navigation frames the Gemini row");
assert(currentIds().length === 1, "exactly one frame");

// A visible row is not scrolled.
inView.add(A.id);
const before = scrolled.length;
active[1] = { id: 13, windowId: 1, active: true, url: A.url };
updated(1, { url: A.url });
await until(() => currentIds()[0] === A.id, "back to A");
assert(scrolled.length === before, "an on-screen row does not scroll");

// Share pages and Gemini non-thread pages do not light anything.
for (const url of [
  `https://gemini.google.com/share/${geminiId}`,
  "https://gemini.google.com/u/1/app/download",
  `https://chatgpt.com/share/${uuid(1)}`,
  "https://chatgpt.com/",
]) {
  active[1] = { id: 13, windowId: 1, active: true, url };
  updated(1, { url });
  await until(() => currentIds().length === 0, `no frame on ${url}`);
}

// New chat that is not indexed yet: no frame until the row arrives.
const fresh = { ...chatgpt(4), title: "Brand new chat", updatedAtSource: "page-exact", updatedAt: Date.now() };
active[1] = { id: 13, windowId: 1, active: true, url: fresh.url };
message({ type: "ACTIVE_LOCATION", url: fresh.url }, { tab: { ...active[1] } });
await sleep(100);
assert(currentIds().length === 0, "an unindexed chat frames nothing");
const freshMsgs = [{ id: `${fresh.id}:u`, role: "user", body: "brand new question" }];
await upsertMessages(fresh, freshMsgs, { pageMessageIds: [freshMsgs[0].id], captureId: "fresh" });
message({ type: "INDEX_UPDATED" });
await until(() => currentIds()[0] === fresh.id, "new chat framed after it is indexed");
assert(scrolled.at(-1) === fresh.id, "the new chat row is scrolled into view once");
assert(rowFor(fresh.id).querySelector(".item-preview").textContent === "brand new question", "new chat preview");

// Search: a 1.2.1 row outside the idle top 80 shows its message, not "title only".
const q = document.getElementById("q");
const scrolledBeforeSearch = scrolled.length;
q.value = "legacyzeta";
q.dispatchEvent(new window.Event("input"));
await until(() => rowFor(legacyId), "search finds the legacy row");
const legacyPreview = rowFor(legacyId).querySelector(".item-preview");
assert(legacyPreview && !legacyPreview.classList.contains("is-title-only"), "legacy row with messages is not title-only");
assert(legacyPreview.textContent.includes("ferns"), `legacy preview backfilled in search: ${legacyPreview.textContent}`);
assert(rowFor(legacyId).querySelector(".item-title mark")?.textContent.toLowerCase() === "legacyzeta", "title hit highlighted");

q.value = "Alpha";
q.dispatchEvent(new window.Event("input"));
await until(() => rowFor(A.id) && !rowFor(B.id), "search for Alpha");
openedTabs.length = 0;
rowFor(A.id).parentElement.querySelector(".read").click();
await until(() => openedTabs.length === 1, "search read passes the query");
assert(decodeURIComponent(openedTabs[0].url).includes("q=Alpha"), `search reader url ${openedTabs[0].url}`);
q.value = "";
q.dispatchEvent(new window.Event("input"));
await until(() => rowFor(B.id), "cleared search");
assert(currentIds()[0] === fresh.id, "frame survives search and clear");
assert(scrolled.length === scrolledBeforeSearch, "searching for the same chat does not scroll");

const chips = [...document.querySelectorAll(".chip")].map((el) =>
  el.dataset.scope === "platform" ? el.dataset.platform : el.dataset.scope,
);
assert(
  chips.join(",") === "active,chatgpt,claude,grok,gemini,archived,all,images",
  `tab order ${chips.join(",")}`,
);
assert(document.querySelector(".chip.is-on")?.dataset.scope === "active", "active tab is the default");

const archivedId = `chatgpt:${uuid(77)}`;
await upsertConversations([{
  ...chatgpt(77),
  title: "Archived fern notes",
  updatedAt: Date.now(),
  updatedAtSource: "page-exact",
  archived: true,
  archiveSource: "chatgpt:banner",
  archivedAt: Date.now(),
}]);
await upsertMessages(
  {
    ...chatgpt(77),
    title: "Archived fern notes",
    archived: true,
    archiveSource: "chatgpt:banner",
  },
  [{ id: `${archivedId}:u`, role: "user", body: "fern archive needle" }],
  { pageMessageIds: [`${archivedId}:u`], captureId: "arch" },
);
message({ type: "INDEX_UPDATED" });
await sleep(400);
assert(!rowFor(archivedId), "active tab hides archived chats");
q.value = "fern";
q.dispatchEvent(new window.Event("input"));
await sleep(400);
assert(!rowFor(archivedId), "search on the active tab stays inside that tab");
q.value = "";
q.dispatchEvent(new window.Event("input"));
await sleep(300);

document.querySelector('[data-scope="archived"]').click();
await until(() => rowFor(archivedId), "archived tab lists the archived chat");
assert(rowFor(archivedId).querySelector(".badge-archived")?.textContent === "已归档", "zh-CN grey label says 已归档");
assert(!rowFor(A.id), "archived tab hides active chats");
q.value = "fern";
q.dispatchEvent(new window.Event("input"));
await until(() => rowFor(archivedId) && !document.querySelector(".empty"), "archived tab search finds the row");
q.value = "Alpha";
q.dispatchEvent(new window.Event("input"));
await until(() => !rowFor(A.id) && document.querySelector(".empty"), "archived search does not return active chats");
q.value = "";
q.dispatchEvent(new window.Event("input"));
await until(() => rowFor(archivedId), "cleared archived search");
const restore = rowFor(archivedId).parentElement.querySelector(".restore");
assert(restore?.textContent === "恢复活跃", `zh-CN restore label ${restore?.textContent}`);
restore.click();
await until(() => !rowFor(archivedId), "manual restore leaves the archived tab");
document.querySelector('[data-scope="active"]').click();
await until(() => rowFor(archivedId) && !rowFor(archivedId).querySelector(".badge-archived"), "restored chat is active");
await upsertConversations([{
  ...chatgpt(77),
  title: "Archived fern notes",
  updatedAt: Date.now(),
  updatedAtSource: "page-exact",
  archived: true,
  archiveSource: "chatgpt:banner",
  archivedAt: Date.now(),
}]);
message({ type: "INDEX_UPDATED" });
document.querySelector('[data-scope="archived"]').click();
await until(() => rowFor(archivedId)?.parentElement?.querySelector(".restore"), "archived tab lists the chat again");

document.querySelector('[data-platform="chatgpt"]').click();
await until(() => rowFor(A.id) && !rowFor(archivedId), "ChatGPT tab is unarchived ChatGPT only");
assert(!rowFor(G.id), "ChatGPT tab hides Gemini");

document.querySelector("#filterAll").click();
await until(() => rowFor(archivedId) && rowFor(A.id), "all tab includes archived and active");

const removeBtn = rowFor(archivedId).parentElement.querySelector(".remove");
const dialog = document.getElementById("removeDialog");
const pressRemove = (key) => {
  const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  removeBtn.dispatchEvent(event);
  assert(event.defaultPrevented, `${JSON.stringify(key)} is handled on the button`);
};
pressRemove("Enter");
await until(() => !dialog.hidden, "Enter opens confirm");
assert(rowFor(archivedId), "Enter does not delete before confirm");
document.getElementById("removeCancel").click();
await until(() => dialog.hidden, "cancel after Enter");
assert(rowFor(archivedId), "cancel after Enter keeps the row");
pressRemove(" ");
await until(() => !dialog.hidden, "Space opens confirm");
assert(rowFor(archivedId), "Space does not delete before confirm");
document.getElementById("removeCancel").click();
await until(() => dialog.hidden, "cancel after Space");
assert(rowFor(archivedId), "cancel after Space keeps the row");
removeBtn.click();
await until(() => !dialog.hidden, "remove dialog opens");
assert(document.getElementById("removeBody").textContent.includes("Archived fern notes"), "confirm names the chat");
document.getElementById("removeCancel").click();
await until(() => dialog.hidden, "cancel closes the dialog");
assert(rowFor(archivedId), "cancel keeps the row");
removeBtn.click();
await until(() => !dialog.hidden, "remove dialog opens again");
document.getElementById("removeConfirm").click();
await until(() => !rowFor(archivedId), "confirm drops the row");
const gone = await searchConversations({ query: "fern", scope: "all" });
assert(gone.length === 0, "removed chat is gone from search");

assert(currentIds()[0] === fresh.id, "the open chat is framed before it is removed");
rowFor(fresh.id).parentElement.querySelector(".remove").click();
await until(() => !dialog.hidden, "remove dialog for the open chat");
document.getElementById("removeConfirm").click();
await until(() => !rowFor(fresh.id), "the framed row is removed");
assert(currentIds().length === 0, "no frame is left on another row");
await upsertConversations([{ ...fresh, archived: false, archiveSource: "chatgpt:sidebar" }]);
message({ type: "INDEX_UPDATED" });
await sleep(400);
assert(!rowFor(fresh.id), "a sidebar rescan does not bring the removed chat back");
await upsertMessages(fresh, freshMsgs, { pageMessageIds: [freshMsgs[0].id], captureId: "fresh-again" });
message({ type: "INDEX_UPDATED" });
await until(() => currentIds()[0] === fresh.id, "reopening the chat brings the row and its frame back");
assert(rowFor(fresh.id).querySelector(".item-preview").textContent === "brand new question", "preview is rebuilt");

document.getElementById("lang").value = "en";
document.getElementById("lang").dispatchEvent(new window.Event("change"));
await until(() => document.getElementById("counts").textContent.includes("messages"), "manual English");
assert(document.getElementById("filterActive").textContent === "Active", "English active tab");
assert(store.get("chatseek.uiLocale") === "en", "language preference is stored");
assert(!("storage" in globalThis.chrome), "the panel needs no chrome.storage");

store.set("chatseek.uiLocale", "ja");
window.dispatchEvent(new window.StorageEvent("storage", { key: "chatseek.uiLocale" }));
await until(() => document.getElementById("filterActive").textContent === "アクティブ", "another window switched to Japanese");
assert(document.getElementById("lang").value === "ja", "the select follows the other window");

document.getElementById("lang").value = "auto";
document.getElementById("lang").dispatchEvent(new window.Event("change"));
await until(() => document.getElementById("filterActive").textContent === "活跃中", "follow browser returns to zh-CN");
assert(!store.has("chatseek.uiLocale"), "follow browser clears the stored choice");
assert(CATALOG["zh-TW"].remove === "從索引移除", "zh-TW remove copy");
for (const code of LOCALE_ORDER) {
  document.getElementById("lang").value = code;
  document.getElementById("lang").dispatchEvent(new window.Event("change"));
  assert(document.querySelectorAll("footer.foot a").length === 1
    && authorLink.isConnected && authorLink.textContent === "@punkcan", `${code} keeps the same author link`);
  const expected = CATALOG[code].remove;
  await until(() => {
    const btn = document.querySelector(".remove");
    return btn && btn.getAttribute("aria-label") === expected && btn.title === expected;
  }, `${code} remove label`);
  const buttons = [...document.querySelectorAll(".remove")];
  assert(buttons.length > 0, `${code} still renders a remove control`);
  assert(
    buttons.every(
      (btn) => btn.getAttribute("aria-label") === expected
        && btn.title === expected
        && btn.textContent.trim() === ""
        && btn.querySelector("svg"),
    ),
    `${code} aria-label and title reuse the remove message`,
  );
}
document.getElementById("lang").value = "auto";
document.getElementById("lang").dispatchEvent(new window.Event("change"));
await until(() => document.getElementById("filterActive").textContent === "活跃中", "follow browser restored");
assert(
  document.querySelector(".chip.is-on")?.getAttribute("aria-selected") === "true" &&
    document.querySelectorAll('.chip[aria-selected="true"]').length === 1,
  "exactly one tab is selected",
);

const sortField = document.getElementById("sortField");
const sortDir = document.getElementById("sortDir");
const sortMenu = document.getElementById("sortMenu");
assert(sortField.textContent === "最后对话时间" && sortDir.textContent === "新→旧", "default sort is newest activity");
assert(sortMenu.hidden && sortField.getAttribute("aria-expanded") === "false", "sort menu starts closed");
sortField.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
await until(() => !sortMenu.hidden, "ArrowDown opens the sort menu");
assert(sortField.getAttribute("aria-expanded") === "true", "sort button exposes the open menu");
assert(!sortMenu.querySelector('[data-field="relevance"]'), "relevance is absent until there is a query");
assert(sortMenu.querySelector('[data-field="title"]')?.getAttribute("role") === "menuitemradio", "sort choices are radio menu items");
sortMenu.querySelector('[data-field="title"]').dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
await until(() => sortMenu.hidden && sortField.textContent === "标题", "Enter selects title sort");
assert(sortDir.textContent === "A→Z", "title starts at A to Z");
const titleIds = () => [...document.querySelectorAll(".item")].map((el) => el.dataset.id);
assert(titleIds().indexOf(A.id) < titleIds().indexOf(B.id), "A to Z puts Alpha before Bravo");
const saved = JSON.parse(store.get("chatseek.listSort"));
assert(saved.field === "title" && saved.dirs.title === "asc" && saved.searchField === "relevance", "browse sort is stored apart from the search default");
sortDir.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
await until(() => sortDir.textContent === "Z→A", "Space reverses the direction");
await until(() => document.querySelector(".item-title")?.textContent.startsWith("Legacyzeta"), "Z to A brings the last title to the top");
document.getElementById("filterArchived").click();
await until(() => document.getElementById("sortField").textContent === "标题", "archived tab keeps the sort");
document.getElementById("filterAll").click();
await until(() => document.getElementById("sortField").textContent === "标题" && sortDir.textContent === "Z→A", "all tab keeps the same sort");
store.set("chatseek.listSort", JSON.stringify({
  field: "count",
  dirs: { activity: "desc", title: "asc", captured: "desc", count: "asc" },
  searchField: "relevance",
  searchDirs: { relevance: "desc", activity: "desc", title: "asc", captured: "desc", count: "desc" },
}));
window.dispatchEvent(new window.StorageEvent("storage", { key: "chatseek.listSort" }));
await until(() => sortField.textContent === "消息数" && sortDir.textContent === "少→多", "another panel's sort arrives");
q.value = "Alpha";
q.dispatchEvent(new window.Event("input"));
await until(() => sortField.textContent === "相关度" && sortDir.textContent === "高→低", "search switches to relevance");
sortField.click();
await until(() => !sortMenu.hidden && sortMenu.querySelector('[data-field="relevance"][aria-checked="true"]'), "relevance is checked in the menu");
sortField.click();
sortDir.click();
await until(() => sortDir.textContent === "低→高", "search direction is its own toggle");
q.value = "";
q.dispatchEvent(new window.Event("input"));
await until(() => sortField.textContent === "消息数" && sortDir.textContent === "少→多", "clearing search restores the saved non-search sort");
q.value = "Alpha";
q.dispatchEvent(new window.Event("input"));
await until(() => sortField.textContent === "相关度" && sortDir.textContent === "低→高", "the search direction is remembered");
q.value = "";
q.dispatchEvent(new window.Event("input"));
await until(() => sortField.textContent === "消息数", "search cleared again");

const shotMessage = `${A.id}:u`;
await saveImageRecords(A.id, [
  {
    messageId: shotMessage,
    index: 0,
    status: "cached",
    mime: "image/webp",
    width: 8,
    height: 8,
    offset: 0,
    alt: "ridge",
    bytes: [1, 2, 3, 4, 5, 6, 7, 8],
  },
  {
    messageId: shotMessage,
    index: 1,
    status: "uncached",
    offset: 20,
    alt: "https://cdn.example/hidden.png",
  },
]);
document.getElementById("filterImages").click();
await until(() => document.querySelector(".shot-img")?.getAttribute("src")?.startsWith("data:image/"), "image tab shows a cached thumb");
assert(document.getElementById("list").hidden, "the conversation list steps aside");
assert(!document.querySelector(".shot-missing"), "placeholders stay hidden");
assert(document.getElementById("imageEmpty").hidden, "empty copy hides when a thumb exists");
assert(!document.getElementById("imageGrid").innerHTML.includes("cdn.example"), "the grid does not keep an image address");
const uncached = document.getElementById("showUncached");
uncached.checked = true;
uncached.dispatchEvent(new window.Event("change"));
await until(() => document.querySelector(".shot-missing")?.dataset.reason === "uncached", "uncached placeholder appears");
openedTabs.length = 0;
document.querySelector(".shot-open").click();
await until(() => openedTabs.length === 1, "thumb opens the reader");
assert(openedTabs[0].url.includes("m=") && openedTabs[0].url.includes("i=0"), openedTabs[0].url);
assert(!openedTabs[0].url.includes("cdn.example"), "reader link is not an image address");
openedTabs.length = 0;
document.querySelector(".shot-site").click();
await until(() => openedTabs.length === 1, "site icon reuses the conversation tab path");
assert(openedTabs[0].url === A.url, openedTabs[0].url);
document.querySelector('[data-image-platform="gemini"]').click();
await until(() => !document.getElementById("imageEmpty").hidden, "a platform with no images is empty");
assert(document.getElementById("imageEmpty").textContent.includes("平台"), document.getElementById("imageEmpty").textContent);
document.getElementById("imagePlatformAll").click();
await until(() => document.querySelector(".shot-img"), "all platforms shows the thumb again");
const oldConfirm = globalThis.confirm;
globalThis.confirm = () => true;
document.getElementById("clearImagesBtn").click();
await until(
  () => document.querySelector(".shot-missing")?.dataset.reason === "cleared" && !document.querySelector(".shot-img"),
  "clearing the cache replaces thumbs while the tab is open",
);
globalThis.confirm = oldConfirm;
await clearImageCache();
document.getElementById("filterActive").click();
await until(() => document.querySelector(".item") && !document.getElementById("list").hidden, "the conversation list returns");

// Structure copy uses the panel's own window and keeps a character count even
// when clipboard access is denied and the manual-copy box is shown.
for (const locale of LOCALE_ORDER) {
  for (const key of ["copyStructure", "copyStructureDone", "copyStructureManual", "copyStructureEmpty", "copyStructureUnavailable"]) {
    assert(CATALOG[locale][key], `structure copy locale ${locale}:${key}`);
  }
}
active[1] = { id: 11, windowId: 1, active: true, url: A.url };
lastFocused = 2;
const structureText = "# chatseek page skeleton v1 nodes=1 depth<=60 truncated=false\nhtml d0 c0";
const structureCalls = [];
chrome.tabs.sendMessage = async (tabId, msg) => {
  structureCalls.push({ tabId, msg });
  return { ok: true, text: structureText, chars: structureText.length };
};
navigator.clipboard = { writeText: async () => { throw new Error("denied"); } };
document.getElementById("copyStructureBtn").click();
await until(() => document.getElementById("diagBox").value === structureText, "manual structure copy");
assert(!document.getElementById("diagBox").hidden, "manual box is visible");
assert(document.getElementById("status").textContent.includes(String(structureText.length)), "manual fallback reports chars");
assert(structureCalls.length === 1 && structureCalls[0].tabId === 11 &&
  structureCalls[0].msg.type === "COPY_PAGE_SKELETON", "only this window's active tab receives the request");
let copiedStructure = "";
navigator.clipboard.writeText = async text => { copiedStructure = text; };
document.getElementById("copyStructureBtn").click();
await until(() => copiedStructure === structureText && document.getElementById("diagBox").hidden, "clipboard structure copy");
assert(document.getElementById("status").textContent.includes(String(structureText.length)), "clipboard success reports chars");

// An index refresh used to replace the copy result with Searching….
q.value = "maple";
q.dispatchEvent(new window.Event("input"));
message({type:"INDEX_UPDATED"});
await sleep(500);
assert(document.getElementById("status").textContent.includes(String(structureText.length)), "refresh must preserve the copy character count");
assert(!document.getElementById("status").hidden, "copy confirmation remains visible during refresh");

console.log("panel-test ok", { scrolls: scrolled.length });
process.exit(0);
