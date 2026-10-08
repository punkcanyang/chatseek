import { readConversation } from "../src/db.js";
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

function openOriginal(url) {
  const safe = safeOriginalUrl(url);
  if (!safe) return;
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
  mountReader(app, {
    conversation: row.conversation,
    messages: row.messages,
    locale,
    query: parsed.query,
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

window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  const pref = readLocalePref();
  if (pref === localePref) return;
  localePref = pref;
  show();
});
