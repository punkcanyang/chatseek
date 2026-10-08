import { upsertConversations, upsertMessages, saveCaptureHealth, readCaptureHealth } from "./src/db.js";
import { healthHasWarning } from "./src/activity-time.js";
import { findReaderContext, findSiteTab, focusTab, siteKey } from "./src/focus-tab.js";

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

chrome.runtime.onInstalled.addListener(openSidePanelOnClick);
chrome.runtime.onStartup.addListener(openSidePanelOnClick);
openSidePanelOnClick();

function senderAllowed(sender, platform) {
  const url = sender.tab?.url || "";
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

// Content scripts report the page they are on. The id is enough to focus that
// tab later; the URL itself is not stored. A closed tab is dropped on the
// next failed focus, and also here when the browser tells us it went away.
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
  });
}

async function focusRequest(msg) {
  try {
    if (msg.type === "FOCUS_ORIGINAL") {
      const key = siteKey(msg.url);
      const candidates = [...siteTabs.values()]
        .filter((entry) => entry.key === key)
        .sort((a, b) => (b.at || 0) - (a.at || 0));
      for (const target of candidates) {
        const focused = await focusTab(chrome.tabs, chrome.windows, target);
        if (focused) return { focused: true };
        siteTabs.delete(target.tabId);
      }
      return { focused: false };
    }
    const contexts = typeof chrome.runtime.getContexts === "function"
      ? await chrome.runtime.getContexts({ contextTypes: ["TAB"] })
      : [];
    const target = findReaderContext(contexts, msg.id);
    return { focused: await focusTab(chrome.tabs, chrome.windows, target) };
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
  // Counts and selector names only. Reject anything large enough to be a transcript.
  try {
    if (JSON.stringify(health).length > 2000) return false;
  } catch {
    return false;
  }
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "ACTIVE_LOCATION") {
    rememberSite(sender, msg.url);
    return;
  }
  if (msg.type === "INDEX_UPDATED") return;
  if (msg.type === "FOCUS_ORIGINAL" || msg.type === "FOCUS_READER") {
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
    saveCaptureHealth(platform, msg.health)
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

  if (msg.type === "CAPTURE_MESSAGES") {
    if (!validConversation(msg.conversation)) {
      sendResponse({ ok: false, error: "invalid conversation" });
      return;
    }
    upsertMessages(msg.conversation, msg.messages || [], captureMeta(msg))
      .then((result) => {
        notifyIndexUpdated();
        sendResponse({ ok: true, observed: !!result?.observed });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});
