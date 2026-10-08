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

/** https only. javascript: and other schemes are not opened. Path is kept. */
export function safeOriginalUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return "";
  }
  if (url.protocol !== "https:") return "";
  return url.href;
}
