/**
 * Extension-page URL for the local reader.
 * chrome.runtime.getURL + a query string needs no extra permission.
 * The original site URL is opened unchanged, including Gemini /u/N/.
 */

export function readerPageUrl(id, query, runtime) {
  const params = new URLSearchParams();
  params.set("id", String(id || ""));
  const q = String(query || "").trim();
  if (q) params.set("q", q);
  const getURL = runtime?.getURL;
  if (typeof getURL === "function") {
    const base = getURL("reader/index.html");
    const url = new URL(base);
    url.search = params.toString();
    return url.href;
  }
  return `reader/index.html?${params.toString()}`;
}

export function parseReaderSearch(search) {
  const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  return {
    id: params.get("id") || "",
    query: params.get("q") || "",
  };
}

// Same hosts as host_permissions in manifest.json and HOSTS in background.js.
export const ORIGINAL_HOSTS = new Set([
  "chatgpt.com",
  "chat.openai.com",
  "claude.ai",
  "grok.com",
  "www.grok.com",
  "grok.x.com",
  "x.ai",
  "gemini.google.com",
]);

/**
 * https on one of the four sites only. javascript:, data:, other hosts,
 * credentials, and explicit ports are not opened. Path and query are kept.
 */
export function safeOriginalUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return "";
  }
  if (url.protocol !== "https:") return "";
  if (url.username || url.password || url.port) return "";
  if (!ORIGINAL_HOSTS.has(url.hostname.toLowerCase())) return "";
  return url.href;
}
