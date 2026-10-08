import { upsertConversations, upsertMessages, saveCaptureHealth, readCaptureHealth } from "./src/db.js";
import { healthHasWarning } from "./src/activity-time.js";

const HOSTS = {
  chatgpt: [/^https:\/\/chatgpt\.com\//, /^https:\/\/chat\.openai\.com\//],
  claude: [/^https:\/\/claude\.ai\//],
  grok: [
    /^https:\/\/grok\.com\//,
    /^https:\/\/www\.grok\.com\//,
    /^https:\/\/grok\.x\.com\//,
    /^https:\/\/x\.ai\//,
  ],
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

function paintBadge(health) {
  const badge = chrome.action;
  if (!badge?.setBadgeText) return;
  const warn = healthHasWarning(health);
  badge.setBadgeText({ text: warn ? "!" : "" }).catch(() => {});
  if (warn && badge.setBadgeBackgroundColor) {
    badge.setBadgeBackgroundColor({ color: "#9a3b2f" }).catch(() => {});
  }
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
  if (msg.type === "INDEX_UPDATED") return;

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
    upsertMessages(msg.conversation, msg.messages || [])
      .then(() => {
        notifyIndexUpdated();
        sendResponse({ ok: true });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});
