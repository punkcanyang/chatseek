import { readConversation, readConversationRow, readImagesForMessages } from "../src/db.js";
import { CATALOG, resolveLocale, text } from "../src/i18n.js";
import { parseReaderSearch, safeOriginalUrl } from "../src/reader-url.js";
import { mountReader } from "../src/reader-view.js";

// Same key as the side panel. Extension pages share localStorage, so the
// panel's manual choice applies here without the "storage" permission.
const STORAGE_KEY = "chatseek.uiLocale";

function browserLocale() {
  try {
    const ui = chrome.i18n?.getUILanguage?.();
    if (ui) return ui;
  } catch {
    // Fall back to the page language below.
  }
  return navigator.language;
}

function readLocalePref() {
  try {
    const pref = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (pref && CATALOG[pref]) return pref;
  } catch {
    // Storage blocked: follow the browser.
  }
  return "auto";
}

function localeFor(pref) {
  return resolveLocale(pref === "auto" ? browserLocale() : pref);
}

const app = document.getElementById("app");
const parsed = parseReaderSearch(location.search);
let localePref = readLocalePref();
let row = null;
let failed = false;
let view = null;
const imageMap = new Map();
const fetchedImages = new Set();
let shownIds = [];

const REUSE_WAIT_MS = 1500;

async function openOriginal(url) {
  const safe = safeOriginalUrl(url);
  if (!safe) return;
  const runtime = globalThis.chrome?.runtime;
  if (typeof runtime?.sendMessage === "function") {
    let timer = 0;
    try {
      const res = await Promise.race([
        runtime.sendMessage({ type: "FOCUS_ORIGINAL", url: safe }),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), REUSE_WAIT_MS); }),
      ]);
      if (res?.focused) return;
    } catch {
      // The worker did not answer. Open a tab instead of leaving the click dead.
    } finally {
      clearTimeout(timer);
    }
  }
  const tabs = globalThis.chrome?.tabs;
  if (typeof tabs?.create === "function") {
    tabs.create({ url: safe });
    return;
  }
  window.open(safe, "_blank", "noopener");
}

async function load() {
  failed = false;
  row = null;
  if (!parsed.id) return;
  try {
    row = await readConversation(parsed.id);
  } catch {
    failed = true;
  }
}

async function loadImages(ids, replace = false) {
  const need = (ids || []).filter((id) => id && (replace || !fetchedImages.has(id)));
  if (!need.length || !parsed.id) return;
  need.forEach((id) => fetchedImages.add(id));
  let found = [];
  try {
    found = await readImagesForMessages(need);
  } catch {
    need.forEach((id) => fetchedImages.delete(id));
    return;
  }
  if (replace) {
    for (const id of need) imageMap.delete(id);
  } else if (!found.length) {
    return;
  }
  for (const shot of found) {
    if (shot?.conversationId && shot.conversationId !== parsed.id) continue;
    const list = imageMap.get(shot.messageId) || [];
    const at = list.findIndex((item) => item.index === shot.index);
    if (at >= 0) list[at] = shot;
    else list.push(shot);
    imageMap.set(shot.messageId, list);
  }
  view?.setImages(imageMap);
}

function show() {
  const locale = localeFor(localePref);
  if (!app) return;
  if (failed) {
    mountReader(app, { error: true, locale, query: parsed.query, onOpenOriginal: openOriginal });
    document.title = "Chatseek";
    return;
  }
  if (!row?.conversation) {
    mountReader(app, { missing: true, locale, query: parsed.query, onOpenOriginal: openOriginal });
    document.title = "Chatseek";
    return;
  }
  view = mountReader(app, {
    conversation: row.conversation,
    messages: row.messages,
    locale,
    query: parsed.query,
    images: imageMap,
    onWindow: (ids) => {
      shownIds = ids || [];
      loadImages(shownIds);
    },
    onOpenOriginal: openOriginal,
  });
}

function bootPlaceholder() {
  if (!app) return;
  app.textContent = text(localeFor(localePref), "readerLoading");
}

bootPlaceholder();
await load();
show();

function applyClock(conv) {
  if (!conv || !row?.conversation || !view?.setActivity) return;
  row.conversation.updatedAt = conv.updatedAt;
  row.conversation.updatedAtSource = conv.updatedAtSource;
  if (conv.olderThanAt) row.conversation.olderThanAt = conv.olderThanAt;
  else delete row.conversation.olderThanAt;
  if (conv.firstSeenAt) row.conversation.firstSeenAt = conv.firstSeenAt;
  view.setActivity(row.conversation);
}

async function refreshClock() {
  if (!parsed.id || !view) return;
  let conv = null;
  try {
    conv = await readConversationRow(parsed.id);
  } catch {
    return;
  }
  applyClock(conv);
}

if (chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "INDEX_UPDATED") refreshClock();
    if (msg?.type !== "IMAGE_CACHE_UPDATED") return;
    for (const id of shownIds) fetchedImages.delete(id);
    loadImages(shownIds, true);
  });
}

let readerClock = 0;
function stopReaderClock() {
  if (!readerClock) return;
  clearInterval(readerClock);
  readerClock = 0;
}
function startReaderClock() {
  stopReaderClock();
  if (document.hidden) return;
  view?.setActivity?.(row?.conversation);
  readerClock = setInterval(() => {
    if (document.hidden) {
      stopReaderClock();
      return;
    }
    view?.setActivity?.(row?.conversation);
  }, 15000);
  readerClock.unref?.();
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopReaderClock();
  else startReaderClock();
});
startReaderClock();

window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  const pref = readLocalePref();
  if (pref === localePref) return;
  localePref = pref;
  show();
});
