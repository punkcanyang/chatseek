import {
  upsertConversations,
  upsertMessages,
  saveCaptureHealth,
  readCaptureHealth,
  saveImageRecords,
  ensureProgressRepair,
} from "./src/db.js";
import { healthHasWarning } from "./src/activity-time.js";
import { findReaderContext, focusTab, readerRefreshUrl, siteCandidates, siteKey } from "./src/focus-tab.js";
import { handleSyncMessage, noteSyncTabClosed, pauseSyncForStartup } from "./src/sync-runner.js";

const HOSTS = {
  chatgpt: [/^https:\/\/chatgpt\.com\//, /^https:\/\/chat\.openai\.com\//],
  claude: [/^https:\/\/claude\.ai\//],
  grok: [
    /^https:\/\/grok\.com\//,
    /^https:\/\/www\.grok\.com\//,
    /^https:\/\/grok\.x\.com\//,
    /^https:\/\/x\.ai\//,
  ],
  gemini: [/^https:\/\/gemini\.google\.com\//],
};

function openSidePanelOnClick() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(
    () => {},
  );
}

chrome.runtime.onInstalled.addListener(() => {
  openSidePanelOnClick();
  // Fold image-generation progress duplicates left by <= 1.7.1. Idempotent
  // and never bumps the DB version; fire-and-forget on install/update.
  ensureProgressRepair();
});
chrome.runtime.onStartup.addListener(() => {
  openSidePanelOnClick();
  pauseSyncForStartup();
  ensureProgressRepair();
});
openSidePanelOnClick();

function senderPageUrl(sender) {
  const tabUrl = sender?.tab?.url || "";
  if (tabUrl) return tabUrl;
  return typeof sender?.url === "string" ? sender.url : "";
}

function senderAllowed(sender, platform) {
  const url = senderPageUrl(sender);
  return (HOSTS[platform] || []).some((re) => re.test(url));
}

function knownPlatform(platform) {
  return Object.prototype.hasOwnProperty.call(HOSTS, platform);
}

function validConversation(conv) {
  // New adapters register a host list above. Health and capture then accept them.
  if (!conv || !knownPlatform(conv.platform)) return false;
  if (typeof conv.id !== "string" || !conv.id.startsWith(`${conv.platform}:`)) {
    return false;
  }
  if (typeof conv.url === "string" && conv.url) {
    const hosts = HOSTS[conv.platform] || [];
    if (!hosts.some((re) => re.test(conv.url))) return false;
  }
  return true;
}

function notifyIndexUpdated() {
  chrome.runtime.sendMessage({ type: "INDEX_UPDATED" }).catch(() => {});
}

let imageNotice = 0;
function notifyImagesLater() {
  clearTimeout(imageNotice);
  imageNotice = setTimeout(() => {
    chrome.runtime.sendMessage({ type: "IMAGE_CACHE_UPDATED" }).catch(() => {});
  }, 400);
}

function platformFromSender(sender) {
  const url = senderPageUrl(sender);
  for (const [name, list] of Object.entries(HOSTS)) {
    if (list.some((re) => re.test(url))) return name;
  }
  return "";
}

// Content scripts report the page they are on. This map only orders ties; it
// is lost whenever the worker sleeps, so the live tab list below is what
// decides. Host permissions expose `url` for the chat sites (and only those),
// which is enough without the tabs permission.
const siteTabs = new Map();
let siteSeq = 0;

function rememberSite(sender, url) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) return;
  const key = siteKey(url);
  if (!key) {
    siteTabs.delete(tabId);
    return;
  }
  siteTabs.set(tabId, {
    tabId,
    windowId: sender.tab.windowId,
    key,
    at: ++siteSeq,
  });
}

if (chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    siteTabs.delete(tabId);
    noteSyncTabClosed(tabId);
  });
}

async function liveTabs() {
  if (typeof chrome.tabs?.query !== "function") return null;
  try {
    const tabs = await chrome.tabs.query({});
    return Array.isArray(tabs) ? tabs : null;
  } catch {
    return null;
  }
}

function fromExtensionPage(sender) {
  if (!sender?.tab) return true;
  const base = typeof chrome.runtime.getURL === "function" ? chrome.runtime.getURL("") : "";
  return !!base && String(sender.url || "").startsWith(base);
}

async function focusRequest(msg) {
  try {
    if (msg.type === "FOCUS_ORIGINAL") {
      const key = siteKey(msg.url);
      if (!key) return { focused: false };
      const candidates = siteCandidates(await liveTabs(), [...siteTabs.values()], key);
      for (const target of candidates) {
        if (await focusTab(chrome.tabs, chrome.windows, target)) return { focused: true };
        siteTabs.delete(target.tabId);
      }
      return { focused: false };
    }
    const contexts = typeof chrome.runtime.getContexts === "function"
      ? await chrome.runtime.getContexts({ contextTypes: ["TAB"] })
      : [];
    const target = findReaderContext(contexts, msg.id);
    if (!target) return { focused: false };
    const base = typeof chrome.runtime.getURL === "function" ? chrome.runtime.getURL("") : "";
    const refresh = readerRefreshUrl(target.documentUrl, msg.url, msg.id, base);
    return { focused: await focusTab(chrome.tabs, chrome.windows, target, refresh) };
  } catch {
    return { focused: false };
  }
}

function paintBadge(health) {
  const badge = chrome.action;
  if (!badge?.setBadgeText) return;
  const warn = healthHasWarning(health);
  badge.setBadgeText({ text: warn ? "!" : "" }).catch(() => {});
  if (warn && badge.setBadgeBackgroundColor) {
    badge.setBadgeBackgroundColor({ color: "#9a3b2f" }).catch(() => {});
  }
}

// Ids only, so the database can tell a new tail message from a first ingest.
function captureMeta(msg) {
  const ids = Array.isArray(msg.pageMessageIds)
    ? msg.pageMessageIds.filter((id) => typeof id === "string" && id.length <= 300).slice(-5000)
    : [];
  const captureId = typeof msg.captureId === "string" ? msg.captureId.slice(0, 400) : "";
  return { pageMessageIds: ids, captureId };
}

function validHealth(health) {
  if (!health || typeof health !== "object") return false;
  if (typeof health.messageCount !== "number") return false;
  if (typeof health.sidebarCount !== "number") return false;
  return true;
}

// Structural diag rides on the health row. A long skeleton must not drop the
// warning itself. Transcripts are still rejected by the diag scrubber.
function fitHealth(health) {
  const core = {
    at: typeof health.at === "number" ? health.at : Date.now(),
    pathKind: String(health.pathKind || "other").slice(0, 32),
    sidebarCount: Number(health.sidebarCount) || 0,
    messageCount: Number(health.messageCount) || 0,
    selector: String(health.selector || "none").slice(0, 80),
    selectorsTried: Array.isArray(health.selectorsTried)
      ? health.selectorsTried.map((name) => String(name).slice(0, 48)).slice(0, 12)
      : [],
    selectorHits: {},
    userCount: Number(health.userCount) || 0,
    assistantCount: Number(health.assistantCount) || 0,
    charCount: Number(health.charCount) || 0,
    warn: !!health.warn,
    diag: typeof health.diag === "string" ? health.diag : "",
  };
  const hits = health.selectorHits && typeof health.selectorHits === "object" ? health.selectorHits : {};
  for (const [key, value] of Object.entries(hits)) {
    if (Object.keys(core.selectorHits).length >= 16) break;
    core.selectorHits[String(key).slice(0, 48)] = Math.max(0, Math.floor(Number(value) || 0));
  }
  try {
    if (JSON.stringify(core).length > 4500) core.diag = core.diag.slice(0, 700);
    if (JSON.stringify(core).length > 4500) {
      core.diag = "";
      core.selectorHits = {};
    }
  } catch {
    core.diag = "";
    core.selectorHits = {};
  }
  return core;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  if (
    msg.type === "SYNC_START" ||
    msg.type === "SYNC_PAUSE" ||
    msg.type === "SYNC_RESUME" ||
    msg.type === "SYNC_STOP" ||
    msg.type === "SYNC_TICK" ||
    msg.type === "SYNC_STATUS"
  ) {
    if (!fromExtensionPage(sender)) return;
    handleSyncMessage(msg).then((view) => sendResponse(view || { status: "idle" })).catch(() => {
      sendResponse({ status: "idle" });
    });
    return true;
  }
  if (msg.type === "ACTIVE_LOCATION") {
    rememberSite(sender, msg.url);
    return;
  }
  if (msg.type === "INDEX_UPDATED" || msg.type === "IMAGE_CACHE_UPDATED") return;
  if (msg.type === "FOCUS_ORIGINAL" || msg.type === "FOCUS_READER") {
    if (!fromExtensionPage(sender)) return;
    focusRequest(msg).then(sendResponse);
    return true;
  }

  const platform = msg.conversation?.platform || msg.platform ||
    msg.conversations?.[0]?.platform;
  if (
    msg.type === "CAPTURE_CONVERSATIONS" ||
    msg.type === "CAPTURE_MESSAGES" ||
    msg.type === "CAPTURE_HEALTH"
  ) {
    if (!senderAllowed(sender, platform)) {
      sendResponse({ ok: false, error: "forbidden" });
      return;
    }
  }

  if (msg.type === "CAPTURE_HEALTH") {
    if (!knownPlatform(platform) || !validHealth(msg.health)) {
      sendResponse({ ok: false, error: "invalid health" });
      return;
    }
    saveCaptureHealth(platform, fitHealth(msg.health))
      .then(async () => {
        paintBadge(await readCaptureHealth());
        notifyIndexUpdated();
        sendResponse({ ok: true });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === "CAPTURE_CONVERSATIONS") {
    const conversations = (msg.conversations || []).filter(validConversation);
    upsertConversations(conversations)
      .then(() => {
        notifyIndexUpdated();
        sendResponse({ ok: true });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === "CAPTURE_IMAGES") {
    const platform = platformFromSender(sender);
    const conversationId = typeof msg.conversationId === "string" ? msg.conversationId : "";
    if (!platform || !conversationId.startsWith(`${platform}:`)) {
      sendResponse({ ok: false, error: "forbidden" });
      return;
    }
    const images = Array.isArray(msg.images) ? msg.images.slice(0, 4) : [];
    saveImageRecords(conversationId, images)
      .then((result) => {
        if (result?.quota) {
          sendResponse({ ok: false, error: "quota" });
          return;
        }
        if (result?.saved) notifyImagesLater();
        sendResponse({ ok: true, saved: result?.saved || 0 });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === "CAPTURE_MESSAGES") {
    if (!validConversation(msg.conversation)) {
      sendResponse({ ok: false, error: "invalid conversation" });
      return;
    }
    // The one-time progress-duplicate tidy runs in the background and is
    // bounded per transaction; a fresh capture never waits behind it. It is
    // fire-and-forget so a slow or stuck repair cannot delay the response.
    ensureProgressRepair().catch(() => null);
    upsertMessages(msg.conversation, msg.messages || [], captureMeta(msg))
      .then((result) => {
        notifyIndexUpdated();
        sendResponse({ ok: true, observed: !!result?.observed });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});
