import { conversationFromUrl } from "./conversation-url.js";

export const DELETED_GRACE_MS = 8000;
const visits = new Map();
const evidence = new Map();
export function deletedHomeUrl(raw, platform) {
  try {
    const url = new URL(raw);
    const hosts = { chatgpt: ["chatgpt.com", "chat.openai.com"], claude: ["claude.ai"],
      grok: ["grok.com", "www.grok.com", "grok.x.com", "x.ai"], gemini: ["gemini.google.com"] };
    if (url.protocol !== "https:" || !hosts[platform]?.includes(url.hostname)) return false;
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return platform === "gemini" ? /^(?:\/u\/\d+)?\/app$/.test(path)
      : platform === "claude" ? ["/", "/new"].includes(path)
      : ["/", "/new", "/chat"].includes(path);
  } catch { return false; }
}
export function rememberDeletedVisit(tabId, url, now = Date.now()) {
  const conv = conversationFromUrl(url);
  if (!Number.isInteger(tabId) || !conv) return;
  visits.set(tabId, { ...conv, url, at: now });
  evidence.delete(tabId);
}
export function forgetDeletedVisit(tabId) { visits.delete(tabId); evidence.delete(tabId); }
export function noteDeletedNavigation(tabId, change, now = Date.now()) {
  if (!change?.url) return; // Never infer an attempted URL from an old tab URL.
  const conv = conversationFromUrl(change.url);
  if (conv) return rememberDeletedVisit(tabId, change.url, now);
  const visit = visits.get(tabId);
  try {
    if (visit && new URL(visit.url).origin === new URL(change.url).origin
        && deletedHomeUrl(change.url, visit.platform) && now - visit.at <= 60000) return;
  } catch { /* discard uncertain navigation */ }
  forgetDeletedVisit(tabId);
}
export function deletedVisitContext(tabId, currentUrl, now = Date.now()) {
  const visit = visits.get(tabId);
  if (!visit || now - visit.at > 60000 || !deletedHomeUrl(currentUrl, visit.platform)) return null;
  try { if (new URL(currentUrl).origin !== new URL(visit.url).origin) return null; } catch { return null; }
  return { id: visit.id, platform: visit.platform };
}
/** Background clock and top-frame URL bind each observation to one visit.
 * Client-provided duration/count cannot authorize a write. */
export function observeDeletedEvidence(tabId, currentUrl, report, now = Date.now()) {
  const direct = conversationFromUrl(currentUrl);
  const redirect = report?.redirected === true ? deletedVisitContext(tabId, currentUrl, now) : null;
  const target = direct || redirect;
  if (!target || target.id !== report?.id || target.platform !== report?.platform
      || !(Number(report.hits) > 0) || report.blocked === true) {
    evidence.delete(tabId); return false;
  }
  const key = `${target.id}|${currentUrl}|${direct ? "explicit" : "redirect"}`;
  let row = evidence.get(tabId);
  if (!row || row.key !== key || now - row.last > 6000) row = { key, first: now, last: now, count: 1 };
  else if (now - row.last >= 1000) { row.count++; row.last = now; }
  evidence.set(tabId, row);
  return row.count >= 3 && now - row.first >= DELETED_GRACE_MS;
}
