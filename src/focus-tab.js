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

/** Latest report wins when several tabs show the same conversation. */
export function findSiteTab(entries, url) {
  const key = siteKey(url);
  if (!key) return null;
  let hit = null;
  for (const entry of entries || []) {
    if (!entry || entry.key !== key || !Number.isInteger(entry.tabId)) continue;
    if (!hit || (entry.at || 0) >= (hit.at || 0)) hit = entry;
  }
  return hit;
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
  return hit ? { tabId: hit.tabId, windowId: hit.windowId } : null;
}

/**
 * Activate the tab and its window. A missing or closed tab rejects `update`
 * and comes back as false so the caller can open a new one. Focusing the
 * window is best-effort: the tab is already the one we meant to reuse.
 */
export async function focusTab(tabs, windows, target) {
  if (!target || !Number.isInteger(target.tabId) || typeof tabs?.update !== "function") return false;
  try {
    await tabs.update(target.tabId, { active: true });
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
