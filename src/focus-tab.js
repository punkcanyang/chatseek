/**
 * Decide which already-open tab is the same conversation.
 * Query strings, hashes, and Gemini's /u/N/ account prefix are not part of
 * the identity. Opening the tab stays in the caller: this module only matches
 * and focuses, and a closed tab is reported as "not focused".
 */
import { conversationFromUrl } from "./conversation-url.js";

export function siteKey(raw) {
  const conv = conversationFromUrl(raw);
  return conv?.id || "";
}

export function readerIdFromDocumentUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return "";
  }
  if (!/\/reader\/index\.html$/i.test(url.pathname)) return "";
  const id = url.searchParams.get("id") || "";
  if (!id || id.length > 400) return "";
  return id;
}

/**
 * Tabs to try, best first. `tabs` is chrome.tabs.query({}) or null when the
 * list could not be read. With a list, a tab counts only if its current URL
 * is this conversation: a reported id whose tab has since moved elsewhere is
 * not reused. Without a list (older browser, API error) the content-script
 * reports are all we have. The tab the person looked at last comes first.
 */
export function siteCandidates(tabs, reports, key) {
  if (!key) return [];
  const reported = new Map();
  for (const entry of reports || []) {
    if (entry && entry.key === key && Number.isInteger(entry.tabId)) reported.set(entry.tabId, entry.at || 0);
  }
  if (!Array.isArray(tabs)) {
    return (reports || [])
      .filter((entry) => entry && entry.key === key && Number.isInteger(entry.tabId))
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .map((entry) => ({ tabId: entry.tabId, windowId: entry.windowId }));
  }
  return tabs
    .filter((tab) => tab && Number.isInteger(tab.id) && siteKey(tab.url || tab.pendingUrl || "") === key)
    .map((tab) => ({
      tabId: tab.id,
      windowId: tab.windowId,
      seen: Number(tab.lastAccessed) || 0,
      at: reported.get(tab.id) || 0,
      active: tab.active === true,
    }))
    .sort((a, b) => b.seen - a.seen || b.at - a.at || Number(b.active) - Number(a.active))
    .map(({ tabId, windowId }) => ({ tabId, windowId }));
}

export function findReaderContext(contexts, id) {
  const want = String(id || "");
  if (!want) return null;
  let hit = null;
  for (const ctx of contexts || []) {
    if (!ctx || !Number.isInteger(ctx.tabId)) continue;
    if (readerIdFromDocumentUrl(ctx.documentUrl) !== want) continue;
    hit = ctx;
  }
  return hit ? { tabId: hit.tabId, windowId: hit.windowId, documentUrl: hit.documentUrl } : null;
}

/**
 * The open reader keeps its tab, but a different search should not leave the
 * old highlights up. Returns the new reader URL when the search changed, or
 * "" when the tab can simply be shown. Only this extension's reader page for
 * the same id is accepted.
 */
export function readerRefreshUrl(currentUrl, wantedUrl, id, base) {
  if (!wantedUrl || !base || !String(wantedUrl).startsWith(base)) return "";
  if (readerIdFromDocumentUrl(wantedUrl) !== String(id || "")) return "";
  let now;
  let next;
  try {
    now = new URL(String(currentUrl || ""));
    next = new URL(String(wantedUrl));
  } catch {
    return "";
  }
  const q = (url) => (url.searchParams.get("q") || "").trim();
  return q(now) === q(next) ? "" : next.href;
}

/**
 * Activate the tab and its window. A missing or closed tab rejects `update`
 * and comes back as false so the caller can open a new one. Focusing the
 * window is best-effort: the tab is already the one we meant to reuse.
 */
export async function focusTab(tabs, windows, target, url = "") {
  if (!target || !Number.isInteger(target.tabId) || typeof tabs?.update !== "function") return false;
  try {
    await tabs.update(target.tabId, url ? { active: true, url } : { active: true });
  } catch {
    return false;
  }
  if (Number.isInteger(target.windowId) && typeof windows?.update === "function") {
    try {
      await windows.update(target.windowId, { focused: true });
    } catch {
      // The conversation tab is active. The window focus is extra.
    }
  }
  return true;
}
