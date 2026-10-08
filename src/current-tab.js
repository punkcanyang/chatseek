/**
 * Which tab the side panel is framing. A side panel belongs to one window,
 * so only that window's active tab counts. Tab URLs are readable only for the
 * chat hosts in host_permissions; any other page reads as "" and clears the frame.
 */

export function readableTabUrl(tab) {
  const url = tab?.url;
  return typeof url === "string" && /^https:\/\//i.test(url) ? url : "";
}

/**
 * The active tab of this panel's window. Never falls back to another window:
 * an unreadable URL there means "not a chat", not "look elsewhere".
 */
export async function activeTabUrl(tabsApi, windowId) {
  if (!tabsApi?.query) return "";
  const query = Number.isInteger(windowId)
    ? { active: true, windowId }
    : { active: true, currentWindow: true };
  try {
    const tabs = await tabsApi.query(query);
    return readableTabUrl((tabs || [])[0]);
  } catch {
    return "";
  }
}

/**
 * A content script's ACTIVE_LOCATION is trusted only from the active tab of
 * this panel's window. Returns the URL to frame, or null to ignore the message.
 */
export function locationFromMessage(msg, sender, windowId) {
  if (msg?.type !== "ACTIVE_LOCATION") return null;
  const tab = sender?.tab;
  if (!tab?.active) return null;
  if (!Number.isInteger(windowId) || tab.windowId !== windowId) return null;
  const fromTab = readableTabUrl(tab);
  if (fromTab) return fromTab;
  return typeof msg.url === "string" && /^https:\/\//i.test(msg.url) ? msg.url : "";
}

/** Tab events from other windows do not change this panel's frame. */
export function eventInWindow(eventWindowId, windowId) {
  if (!Number.isInteger(windowId) || !Number.isInteger(eventWindowId)) return true;
  return eventWindowId === windowId;
}
