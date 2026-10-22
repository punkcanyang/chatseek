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
let imageEpoch = 0;
let refreshPending = false;
let refreshRun = null;

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
  const epoch = imageEpoch;
  const need = (ids || []).filter((id) => id && (replace || !fetchedImages.has(id)));
  if (!need.length || !parsed.id) return;
  need.forEach((id) => fetchedImages.add(id));
  let found = [];
  try {
    found = await readImagesForMessages(need);
  } catch {
    if (epoch === imageEpoch) need.forEach((id) => fetchedImages.delete(id));
    return;
  }
  if (epoch !== imageEpoch) return;
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

function show(position = view?.position?.()) {
  const locale = localeFor(localePref);
  if (!app) return;
  view?.destroy?.();
  view = null;
  shownIds = [];
  if (failed) {
    view = mountReader(app, { error: true, locale, query: parsed.query, onOpenOriginal: openOriginal });
    document.title = "Chatseek";
    return;
  }
  if (!row?.conversation) {
    view = mountReader(app, { missing: true, locale, query: parsed.query, onOpenOriginal: openOriginal });
    document.title = "Chatseek";
    return;
  }
  view = mountReader(app, {
    conversation: row.conversation,
    messages: row.messages,
    locale,
    query: parsed.query,
    images: imageMap,
    position,
    focus: parsed.imageIndex >= 0 && parsed.messageId
      ? { messageId: parsed.messageId, index: parsed.imageIndex }
      : null,
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
if (parsed.imageIndex >= 0 && parsed.messageId) loadImages([parsed.messageId]);

function applyClock(conv) {
  if (!conv || !row?.conversation || !view?.setActivity) return;
  row.conversation.updatedAt = conv.updatedAt;
  row.conversation.updatedAtSource = conv.updatedAtSource;
  row.conversation.archived = conv.archived;
  row.conversation.archiveSource = conv.archiveSource;
  if (conv.olderThanAt) row.conversation.olderThanAt = conv.olderThanAt;
  else delete row.conversation.olderThanAt;
  if (conv.firstSeenAt) row.conversation.firstSeenAt = conv.firstSeenAt;
  view.setActivity(row.conversation);
}

function invalidateImages() {
  imageEpoch += 1;
  imageMap.clear();
  fetchedImages.clear();
}

async function refreshContent() {
  if (!parsed.id) return;
  const conv = await readConversationRow(parsed.id);
  if (!conv) {
    if (row || failed) {
      row = null;
      failed = false;
      invalidateImages();
      show(null);
    }
    return;
  }
  const old = row?.conversation;
  const changed = !old || ["contentRevision", "messageCount", "title", "url", "platform", "firstSeenAt"]
    .some((key) => conv[key] !== old[key]);
  if (!changed) {
    applyClock(conv);
    return;
  }
  // Read body and revision in one snapshot. A following notification queues
  // another check, so writes during this read cannot leave the reader stale.
  const next = await readConversation(parsed.id);
  const position = row ? view?.position?.() : null;
  row = next;
  failed = false;
  invalidateImages();
  show(position);
}

function refreshReader() {
  refreshPending = true;
  if (refreshRun) return refreshRun;
  refreshRun = (async () => {
    while (refreshPending) {
      refreshPending = false;
      try { await refreshContent(); }
      catch { /* Keep the current view; another notification/focus retries. */ }
    }
  })().finally(() => {
    refreshRun = null;
    if (refreshPending) return refreshReader();
  });
  return refreshRun;
}

if (chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "INDEX_UPDATED") return refreshReader();
    if (msg?.type !== "IMAGE_CACHE_UPDATED") return;
    invalidateImages();
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
  else {
    startReaderClock();
    refreshReader();
  }
});
window.addEventListener("focus", refreshReader);
startReaderClock();

window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  const pref = readLocalePref();
  if (pref === localePref) return;
  localePref = pref;
  show();
});

// Catch a write between the initial snapshot and listener registration.
await refreshReader();
