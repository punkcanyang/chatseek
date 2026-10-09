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
