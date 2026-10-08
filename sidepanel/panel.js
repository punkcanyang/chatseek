import {
  searchConversations,
  stats,
  clearAll,
  removeConversation,
  readCaptureHealth,
  attachPreviews,
} from "../src/db.js";
import { formatActivityLabel, formatHealthEntries } from "../src/activity-time.js";
import { fillHighlight } from "../src/preview.js";
import { conversationKeyFromUrl, shouldAutoScroll } from "../src/conversation-url.js";
import { activeTabUrl, eventInWindow, locationFromMessage } from "../src/current-tab.js";
import { CATALOG, LOCALE_ORDER, fill, resolveLocale, text } from "../src/i18n.js";
import { readerPageUrl } from "../src/reader-url.js";
import {
  BROWSE_FIELDS,
  SEARCH_FIELDS,
  SORT_KEY,
  activeSort,
  directionLabelKey,
  parseSortPref,
  readSortPref,
  sortLabelKey,
  writeSortPref,
} from "../src/sort-list.js";

// The panel is an extension page, so its own localStorage keeps the language
// and the list sort without the "storage" permission. Only the panel reads them.
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

function localeFor(pref) {
  return resolveLocale(pref === "auto" ? browserLocale() : pref);
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

function writeLocalePref(pref) {
  try {
    if (pref === "auto") globalThis.localStorage?.removeItem(STORAGE_KEY);
    else globalThis.localStorage?.setItem(STORAGE_KEY, pref);
  } catch {
    // The panel still switches for this view if storage is unavailable.
  }
}

let localePref = readLocalePref();
let localeCode = localeFor(localePref);

function bundle(code) {
  const say = (key, ...args) => fill(text(code, key), ...args);
  return {
    tag: say("tag"),
    search: say("searchLabel"),
    placeholder: say("searchPlaceholder"),
    active: say("tabActive"),
    archived: say("tabArchived"),
    all: say("tabAll"),
    empty: say("empty"),
    none: say("none"),
    loading: say("loading"),
    booting: say("booting"),
    hint: say("hint"),
    counts: (c, m) => say("counts", c, m),
    titleOnly: say("titleOnly"),
    clear: say("clear"),
    confirm: say("confirmClear"),
    error: say("error"),
    archivedBadge: say("archivedBadge"),
    remove: say("remove"),
    confirmRemoveTitle: say("confirmRemoveTitle"),
    confirmRemoveBody: (title) => say("confirmRemoveBody", title),
    cancel: say("cancel"),
    confirmRemove: say("confirmRemove"),
    read: say("read"),
    langLabel: say("langLabel"),
    langFollow: say("langFollow"),
    sortBy: say("sortBy"),
    sortCurrent: (name) => say("sortCurrent", name),
    sortDirHint: (name) => say("sortDirHint", name),
    sortActivity: say("sortActivity"),
    sortTitle: say("sortTitle"),
    sortCaptured: say("sortCaptured"),
    sortCount: say("sortCount"),
    sortRelevance: say("sortRelevance"),
    sortDirNewest: say("sortDirNewest"),
    sortDirOldest: say("sortDirOldest"),
    sortDirAz: say("sortDirAz"),
    sortDirZa: say("sortDirZa"),
    sortDirMore: say("sortDirMore"),
    sortDirFewer: say("sortDirFewer"),
    chatgpt: "ChatGPT",
    claude: "Claude",
    grok: "Grok",
    gemini: "Gemini",
  };
}

let t = bundle(localeCode);

const qEl = document.getElementById("q");
const listEl = document.getElementById("list");
const statusEl = document.getElementById("status");
const countsEl = document.getElementById("counts");
const hintEl = document.getElementById("hint");
const tagEl = document.getElementById("tag");
const clearBtn = document.getElementById("clearBtn");
const healthEl = document.getElementById("health");
const searchLabel = document.getElementById("searchLabel");
const filterActive = document.getElementById("filterActive");
const filterArchived = document.getElementById("filterArchived");
const filterAll = document.getElementById("filterAll");
const langLabel = document.getElementById("langLabel");
const langEl = document.getElementById("lang");
const removeDialog = document.getElementById("removeDialog");
const removeTitle = document.getElementById("removeTitle");
const removeBody = document.getElementById("removeBody");
const removeCancel = document.getElementById("removeCancel");
const removeConfirm = document.getElementById("removeConfirm");
const sortFieldBtn = document.getElementById("sortField");
const sortDirBtn = document.getElementById("sortDir");
const sortMenu = document.getElementById("sortMenu");

let sortPref = readSortPref();

let scope = "active";
let platform = "";
let searchTimer = 0;
let requestSeq = 0;
let loadedOnce = false;
let composing = false;
let currentKey = "";
let settledKey = "";
let tabSeq = 0;
let tabTimer = 0;
let panelWindowId = null;
let pendingRemove = null;

const MIN_DATE_MS = 1577836800000;

function hasDate(ts) {
  return typeof ts === "number" && Number.isFinite(ts) && ts >= MIN_DATE_MS;
}

function platformLabel(id) {
  if (id === "claude") return t.claude;
  if (id === "grok") return t.grok;
  if (id === "gemini") return t.gemini;
  return t.chatgpt;
}

function applyStatic() {
  t = bundle(localeCode);
  document.documentElement.lang = localeCode;
  tagEl.textContent = t.tag;
  qEl.placeholder = t.placeholder;
  searchLabel.textContent = t.search;
  hintEl.textContent = t.hint;
  clearBtn.textContent = t.clear;
  if (filterActive) filterActive.textContent = t.active;
  if (filterArchived) filterArchived.textContent = t.archived;
  if (filterAll) filterAll.textContent = t.all;
  if (langLabel) langLabel.textContent = t.langLabel;
  if (removeTitle) removeTitle.textContent = t.confirmRemoveTitle;
  if (removeCancel) removeCancel.textContent = t.cancel;
  if (removeConfirm) removeConfirm.textContent = t.confirmRemove;
  fillLanguageSelect();
  renderSortControls();
}

function fillLanguageSelect() {
  if (!langEl) return;
  const current = localePref;
  langEl.replaceChildren();
  const auto = document.createElement("option");
  auto.value = "auto";
  auto.textContent = t.langFollow;
  langEl.append(auto);
  for (const code of LOCALE_ORDER) {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = CATALOG[code].langNative;
    langEl.append(option);
  }
  langEl.value = current;
}

function render(items, { emptyKind, error }) {
  listEl.replaceChildren();
  if (error) {
    const p = document.createElement("p");
    p.className = "error";
    p.textContent = t.error;
    listEl.append(p);
    return;
  }
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = emptyKind === "search" ? t.none : t.empty;
    listEl.append(p);
    return;
  }
  for (const conv of items) {
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "row";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "item";
    btn.addEventListener("click", (event) => {
      if (event.target.closest(".item-preview")) return;
      openChat(conv.url);
    });

    const title = document.createElement("div");
    title.className = "item-title";
    const preview = conv.preview || { kind: "title-only", text: "", ranges: [], titleRanges: [] };
    fillHighlight(title, conv.title || conv.platformId, preview.titleRanges);

    let previewEl = null;
    if (preview.kind !== "none") {
      previewEl = document.createElement("p");
      previewEl.className = "item-preview";
      previewEl.dataset.preview = preview.kind;
      if (preview.kind === "title-only") {
        previewEl.classList.add("is-title-only");
        previewEl.textContent = t.titleOnly;
      } else {
        fillHighlight(previewEl, preview.text, preview.ranges);
      }
      previewEl.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openReader(conv);
      });
    }

    const meta = document.createElement("div");
    meta.className = "item-meta";
    const plat = document.createElement("span");
    plat.className = `plat ${conv.platform}`;
    plat.textContent = platformLabel(conv.platform);
    const time = document.createElement("time");
    const label = formatActivityLabel(conv, Date.now(), localeCode);
    time.textContent = label.text;
    time.title = label.title;
    if (label.source) time.dataset.source = label.source;
    if (label.approx) time.classList.add("is-approx");
    if (label.unknown) time.classList.add("is-unknown");
    if (!label.unknown && !label.before && hasDate(conv.updatedAt)) {
      time.dateTime = new Date(conv.updatedAt).toISOString();
    }
    meta.append(plat, time);
    if (conv.archived === true) {
      const badge = document.createElement("span");
      badge.className = "badge-archived";
      badge.textContent = t.archivedBadge;
      meta.append(badge);
    }
    btn.dataset.id = conv.id || "";
    if (currentKey && String(conv.id || "").toLowerCase() === currentKey) {
      btn.classList.add("is-current");
      btn.setAttribute("aria-current", "true");
    }
    btn.append(...(previewEl ? [title, previewEl, meta] : [title, meta]));

    const readBtn = document.createElement("button");
    readBtn.type = "button";
    readBtn.className = "read";
    readBtn.dataset.id = conv.id || "";
    readBtn.textContent = t.read;
    readBtn.addEventListener("click", () => openReader(conv));

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove";
    removeBtn.dataset.id = conv.id || "";
    removeBtn.setAttribute("aria-label", t.remove);
    removeBtn.title = t.remove;
    removeBtn.append(removeIcon());
    removeBtn.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
      event.preventDefault();
      if (event.repeat) return;
      askRemove(conv);
    });
    removeBtn.addEventListener("click", () => askRemove(conv));

    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(readBtn);
    row.append(btn, removeBtn, actions);
    li.append(row);
    listEl.append(li);
  }
}

function removeIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M3 3l6 6M9 3L3 9");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.6");
  path.setAttribute("stroke-linecap", "round");
  svg.append(path);
  return svg;
}

function closeRemove(answer) {
  if (removeDialog) removeDialog.hidden = true;
  const pending = pendingRemove;
  pendingRemove = null;
  if (pending) pending(answer);
}

function askRemove(conv) {
  if (!removeDialog) return;
  removeBody.textContent = t.confirmRemoveBody(conv.title || conv.platformId || "");
  removeDialog.hidden = false;
  pendingRemove = async (yes) => {
    if (!yes) return;
    try {
      await removeConversation(conv.id);
    } catch {
      render([], { error: true });
      return;
    }
    refresh();
  };
  removeCancel?.focus();
}

async function openReader(conv) {
  if (!conv?.id) return;
  // Extension page in a new tab. chrome.tabs.create does not need the tabs permission.
  const url = readerPageUrl(conv.id, qEl.value, chrome.runtime);
  try {
    if (chrome.tabs?.create) {
      await chrome.tabs.create({ url });
      return;
    }
  } catch {
    // Fall through to window.open, which also needs no tabs permission.
  }
  window.open(url, "_blank", "noopener");
}

async function openChat(url) {
  if (!url || !chrome.tabs?.create) return;
  try {
    const existing = await chrome.tabs.query({ url });
    if (existing[0]) {
      await chrome.tabs.update(existing[0].id, { active: true });
      return;
    }
  } catch {
    // host permissions cover ChatGPT/Claude/Grok/Gemini URLs; fall through to create
  }
  await chrome.tabs.create({ url });
}

async function renderHealth() {
  if (!healthEl) return;
  const health = await readCaptureHealth();
  const lines = formatHealthEntries(health, Date.now(), localeCode);
  healthEl.replaceChildren();
  healthEl.hidden = !lines.length;
  for (const line of lines) {
    const p = document.createElement("p");
    p.className = line.warn ? "health-warn" : "health-line";
    p.textContent = line.text;
    healthEl.append(p);
  }
}

function searchingNow() {
  return !!qEl.value.trim();
}

function labelFor(key) {
  const value = t[key];
  return typeof value === "string" ? value : "";
}

function renderSortControls() {
  if (!sortFieldBtn || !sortDirBtn || !sortMenu) return;
  const searching = searchingNow();
  const choice = activeSort(sortPref, { searching, locale: localeCode });
  const fields = searching ? SEARCH_FIELDS : BROWSE_FIELDS;
  const fieldName = labelFor(sortLabelKey(choice.field));
  const dirName = labelFor(directionLabelKey(choice.field, choice.dir));
  sortFieldBtn.textContent = fieldName;
  sortFieldBtn.setAttribute("aria-label", t.sortCurrent(fieldName));
  sortDirBtn.textContent = dirName;
  sortDirBtn.setAttribute("aria-label", t.sortDirHint(dirName));
  const wasOpen = !sortMenu.hidden;
  sortMenu.replaceChildren();
  sortMenu.setAttribute("aria-label", t.sortBy);
  for (const field of fields) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "sort-option";
    item.setAttribute("role", "menuitemradio");
    item.dataset.field = field;
    const on = field === choice.field;
    item.setAttribute("aria-checked", on ? "true" : "false");
    item.tabIndex = on ? 0 : -1;
    item.textContent = labelFor(sortLabelKey(field));
    item.addEventListener("click", () => chooseSortField(field));
    sortMenu.append(item);
  }
  sortMenu.hidden = !wasOpen;
  sortFieldBtn.setAttribute("aria-expanded", wasOpen ? "true" : "false");
}

function focusSortOption(el) {
  if (!el || !sortMenu) return;
  for (const item of sortMenu.querySelectorAll(".sort-option")) {
    item.tabIndex = item === el ? 0 : -1;
  }
  el.focus();
}

function openSortMenu() {
  if (!sortMenu || !sortFieldBtn) return;
  renderSortControls();
  sortMenu.hidden = false;
  sortFieldBtn.setAttribute("aria-expanded", "true");
  const selected = sortMenu.querySelector('[aria-checked="true"]') || sortMenu.querySelector(".sort-option");
  focusSortOption(selected);
}

function closeSortMenu() {
  if (!sortMenu || !sortFieldBtn) return;
  sortMenu.hidden = true;
  sortFieldBtn.setAttribute("aria-expanded", "false");
}

function chooseSortField(field) {
  const allowed = searchingNow() ? SEARCH_FIELDS : BROWSE_FIELDS;
  if (!allowed.includes(field)) return;
  if (searchingNow()) sortPref.searchField = field;
  else sortPref.field = field;
  sortPref = parseSortPref(sortPref);
  writeSortPref(sortPref);
  closeSortMenu();
  renderSortControls();
  refresh();
}

function toggleSortDir() {
  const searching = searchingNow();
  const choice = activeSort(sortPref, { searching, locale: localeCode });
  const next = choice.dir === "asc" ? "desc" : "asc";
  if (searching) sortPref.searchDirs[choice.field] = next;
  else sortPref.dirs[choice.field] = next;
  sortPref = parseSortPref(sortPref);
  writeSortPref(sortPref);
  renderSortControls();
  refresh();
}

async function refresh() {
  renderSortControls();
  const seq = ++requestSeq;
  const query = qEl.value;
  const showStatus = !loadedOnce || !!query.trim();
  statusEl.hidden = !showStatus;
  statusEl.textContent = !loadedOnce && !query.trim() ? t.booting : t.loading;
  try {
    const items = await searchConversations({
      query,
      platform: scope === "platform" ? platform : "",
      scope: scope === "platform" ? "active" : scope,
      limit: 80,
      sort: activeSort(sortPref, { searching: !!query.trim(), locale: localeCode }),
    });
    if (seq !== requestSeq) return;
    const shown = await attachPreviews(items, query);
    if (seq !== requestSeq) return;
    loadedOnce = true;
    statusEl.hidden = true;
    render(shown, { emptyKind: query.trim() ? "search" : "idle" });
    markCurrentRow();
    const s = await stats();
    if (seq !== requestSeq) return;
    countsEl.textContent = t.counts(s.conversations, s.messages);
    await renderHealth();
  } catch {
    if (seq !== requestSeq) return;
    statusEl.hidden = true;
    render([], { error: true });
    if (!loadedOnce) countsEl.textContent = t.error;
  }
}

function scheduleRefresh() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refresh, 180);
}

qEl.addEventListener("compositionstart", () => {
  composing = true;
});
qEl.addEventListener("compositionend", () => {
  composing = false;
  scheduleRefresh();
});
qEl.addEventListener("input", () => {
  if (!composing) scheduleRefresh();
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach((c) => {
      c.classList.toggle("is-on", c === chip);
      c.setAttribute("aria-selected", c === chip ? "true" : "false");
    });
    scope = chip.dataset.scope || "all";
    platform = scope === "platform" ? (chip.dataset.platform || "") : "";
    refresh();
  });
});

clearBtn.addEventListener("click", async () => {
  if (!confirm(t.confirm)) return;
  try {
    await clearAll();
  } catch {
    render([], { error: true });
    return;
  }
  chrome.action?.setBadgeText?.({ text: "" })?.catch?.(() => {});
  listEl.replaceChildren();
  countsEl.textContent = t.counts(0, 0);
  refresh();
});

removeCancel?.addEventListener("click", () => closeRemove(false));
removeConfirm?.addEventListener("click", () => closeRemove(true));
removeDialog?.addEventListener("click", (event) => {
  if (event.target === removeDialog) closeRemove(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (removeDialog && !removeDialog.hidden) {
    closeRemove(false);
    return;
  }
  if (sortMenu && !sortMenu.hidden) {
    closeSortMenu();
    sortFieldBtn?.focus();
  }
});

sortFieldBtn?.addEventListener("click", () => {
  if (sortMenu?.hidden) openSortMenu();
  else closeSortMenu();
});
sortFieldBtn?.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown" && event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
  event.preventDefault();
  if (event.repeat) return;
  if (sortMenu?.hidden) openSortMenu();
  else if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") closeSortMenu();
});
sortDirBtn?.addEventListener("click", () => toggleSortDir());
sortDirBtn?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
  event.preventDefault();
  if (event.repeat) return;
  toggleSortDir();
});
sortMenu?.addEventListener("keydown", (event) => {
  const items = [...sortMenu.querySelectorAll(".sort-option")];
  const index = items.indexOf(document.activeElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = items[(index + step + items.length) % items.length];
    focusSortOption(next);
    return;
  }
  if (event.key === "Home") {
    event.preventDefault();
    focusSortOption(items[0]);
    return;
  }
  if (event.key === "End") {
    event.preventDefault();
    focusSortOption(items[items.length - 1]);
    return;
  }
  if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
    event.preventDefault();
    const host = event.target?.dataset ? event.target : document.activeElement;
    const field = host?.dataset?.field;
    if (field) chooseSortField(field);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeSortMenu();
    sortFieldBtn?.focus();
  }
});
document.addEventListener("click", (event) => {
  if (!sortMenu || sortMenu.hidden) return;
  if (sortFieldBtn?.contains(event.target)) return;
  if (sortMenu.contains(event.target)) return;
  closeSortMenu();
});

function setLocalePref(pref) {
  localePref = pref === "auto" || CATALOG[pref] ? pref : "auto";
  localeCode = localeFor(localePref);
  applyStatic();
  refresh();
}

langEl?.addEventListener("change", () => {
  const pref = langEl.value || "auto";
  writeLocalePref(pref);
  setLocalePref(pref);
});

// A side panel open in another window follows the change.
window.addEventListener("storage", (event) => {
  if (event.key !== null && event.key !== STORAGE_KEY && event.key !== SORT_KEY) return;
  if (event.key === null || event.key === STORAGE_KEY) {
    const pref = readLocalePref();
    if (pref !== localePref) setLocalePref(pref);
  }
  if (event.key === null || event.key === SORT_KEY) {
    const next = readSortPref();
    if (JSON.stringify(next) !== JSON.stringify(parseSortPref(sortPref))) {
      sortPref = next;
      renderSortControls();
      refresh();
    }
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  refresh();
  scheduleSync();
});

function rowInView(el) {
  const rect = el.getBoundingClientRect();
  const height = window.innerHeight || document.documentElement.clientHeight || 0;
  return rect.bottom > 24 && rect.top < height - 24;
}

function markCurrentRow() {
  let target = null;
  for (const btn of listEl.querySelectorAll(".item")) {
    const on = !!currentKey && String(btn.dataset.id || "").toLowerCase() === currentKey;
    btn.classList.toggle("is-current", on);
    if (on) {
      btn.setAttribute("aria-current", "true");
      target = btn;
    } else {
      btn.removeAttribute("aria-current");
    }
  }
  if (!currentKey || !target || currentKey === settledKey) return;
  const visible = rowInView(target);
  if (shouldAutoScroll({
    currentKey,
    settledKey,
    rowFound: true,
    inView: visible,
  })) {
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  settledKey = currentKey;
}

function setCurrentFromUrl(url) {
  const key = conversationKeyFromUrl(url);
  if (key === currentKey) {
    markCurrentRow();
    return;
  }
  currentKey = key;
  if (!key) settledKey = "";
  markCurrentRow();
}

async function resolvePanelWindow() {
  try {
    const win = await chrome.windows?.getCurrent?.();
    if (Number.isInteger(win?.id)) panelWindowId = win.id;
  } catch {
    // Without a window id the panel asks for currentWindow instead.
  }
}

async function syncActiveTab() {
  const seq = ++tabSeq;
  const url = await activeTabUrl(chrome.tabs, panelWindowId);
  if (seq !== tabSeq) return;
  setCurrentFromUrl(url);
}

function scheduleSync() {
  clearTimeout(tabTimer);
  tabTimer = setTimeout(syncActiveTab, 80);
}

function onActiveLocation(url) {
  tabSeq += 1;
  setCurrentFromUrl(url);
}

if (chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type === "INDEX_UPDATED") scheduleRefresh();
    if (msg?.type !== "ACTIVE_LOCATION") return;
    if (!Number.isInteger(panelWindowId)) {
      if (sender?.tab?.active) scheduleSync();
      return;
    }
    const url = locationFromMessage(msg, sender, panelWindowId);
    if (url !== null) onActiveLocation(url);
  });
}

if (chrome.tabs?.onActivated) {
  chrome.tabs.onActivated.addListener((info) => {
    if (eventInWindow(info?.windowId, panelWindowId)) scheduleSync();
  });
}
if (chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (!eventInWindow(tab?.windowId, panelWindowId)) return;
    if (info?.url || info?.status === "complete") scheduleSync();
  });
}

applyStatic();
resolvePanelWindow().then(syncActiveTab);
refresh();
