/**
 * Match a tab URL to a stored conversation.
 * Same rules as the content scripts: ChatGPT /c/<uuid>, Claude /chat/<uuid>,
 * Grok /c|chat/<id>, Gemini /app/<id> and /gem/<gemId>/<id>, including /u/N/.
 * The Gemini account prefix is not part of the stored id, so /u/1/ and /u/4/
 * for the same conversation id are one row. Keep in sync with content/gemini.js.
 */

const UUID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function uuidFrom(pathname) {
  const match = String(pathname || "").match(UUID);
  return match ? match[0].toLowerCase() : "";
}

/** ChatGPT id is the UUID after /c/, never an earlier id in /g/<gpt>/c/. */
function chatgptConversationId(pathname) {
  const path = String(pathname || "").split(/[?#]/)[0];
  const match = path.match(/\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match ? match[1].toLowerCase() : "";
}

function cleanGeminiId(raw) {
  const id = String(raw || "").trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) return "";
  if (!/\d/.test(id) && !/^[0-9a-f]{12,}$/i.test(id)) return "";
  return id;
}

function geminiFromPath(pathname) {
  const path = String(pathname || "").split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  if (/\/share(?:\/|$)/i.test(path)) return null;
  let match = path.match(/^(?:\/u\/(\d+))?\/app\/([A-Za-z0-9_-]{8,128})$/i);
  if (match) {
    const id = cleanGeminiId(match[2]);
    if (!id) return null;
    return { platform: "gemini", platformId: id, id: `gemini:${id}` };
  }
  match = path.match(
    /^(?:\/u\/(\d+))?\/gem\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]{8,128})$/i,
  );
  if (!match) return null;
  if (/^(edit|create|view|new)$/i.test(match[2])) return null;
  if (/^(edit|create|view|new)$/i.test(match[3])) return null;
  const id = cleanGeminiId(match[3]);
  if (!id) return null;
  return { platform: "gemini", platformId: id, id: `gemini:${id}` };
}

function grokId(pathname) {
  if (!/\/(?:c|chat)\//i.test(pathname || "")) return "";
  const uuid = uuidFrom(pathname);
  if (uuid) return uuid;
  const match = String(pathname || "").match(
    /\/(?:c|chat)\/([A-Za-z0-9_-]{16,128})(?=[/?#]|$)/i,
  );
  return match ? match[1].toLowerCase() : "";
}

export function conversationFromUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname || "/";

  if (host === "chatgpt.com" || host === "chat.openai.com") {
    const id = chatgptConversationId(path);
    if (!id) return null;
    return { platform: "chatgpt", platformId: id, id: `chatgpt:${id}` };
  }
  if (host === "claude.ai") {
    if (!/\/chat\//i.test(path)) return null;
    const id = uuidFrom(path);
    if (!id) return null;
    return { platform: "claude", platformId: id, id: `claude:${id}` };
  }
  if (
    host === "grok.com" ||
    host === "www.grok.com" ||
    host === "grok.x.com" ||
    host === "x.ai"
  ) {
    const id = grokId(path);
    if (!id) return null;
    return { platform: "grok", platformId: id, id: `grok:${id}` };
  }
  if (host === "gemini.google.com") return geminiFromPath(path);
  return null;
}

export function conversationKeyFromUrl(raw) {
  return (conversationFromUrl(raw)?.id || "").toLowerCase();
}

export function rowMatchesUrl(conv, raw) {
  const parsed = conversationFromUrl(raw);
  if (!parsed || !conv) return false;
  const key = parsed.id.toLowerCase();
  if (conv.id && String(conv.id).toLowerCase() === key) return true;
  if (
    conv.platform === parsed.platform &&
    conv.platformId &&
    String(conv.platformId).toLowerCase() === parsed.platformId.toLowerCase()
  ) {
    return true;
  }
  const stored = conversationKeyFromUrl(conv.url || "");
  return !!stored && stored === key;
}

/**
 * Scroll the matching row once per conversation change, and only when it is
 * actually outside the viewport. A later list refresh for the same chat
 * (index update, typing) must not pull the list back under the user's scroll.
 */
export function shouldAutoScroll({ currentKey, settledKey, rowFound, inView }) {
  if (!currentKey || !rowFound) return false;
  if (currentKey === settledKey) return false;
  if (inView) return false;
  return true;
}
