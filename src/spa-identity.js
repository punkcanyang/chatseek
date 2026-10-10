// Same FNV-1a as Chatseek.hash; transcript boundaries and body-only signature
// are mirrored in content/shared.js and checked by verify.
export function transcriptHash(messages) {
  const text = JSON.stringify(messages.map(m => String(m.body || "")));
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function nativeTurnKeys(conversationId, messages) {
  const prefix = conversationId + ":";
  return messages.map(m => m.id?.startsWith(prefix) ? m.id.slice(prefix.length) : "")
    .filter(id => id && !/^[0-9a-f]{1,8}:dom\d+$/.test(id));
}

export function bodyTurnKeys(messages, fallbackOnly = false) {
  return messages.filter(m => !fallbackOnly || /^(?:chatgpt|claude|grok|gemini):[^:]+:[0-9a-f]{1,8}:dom\d+$/.test(m.id || ""))
    .flatMap(m => [40, 80, 160].filter(length => (m.body || "").length >= length)
      .map(length => `${m.role}:${length}:${transcriptHash([{ body: m.body.slice(0, length) }])}`));
}
