/**
 * Image-cache records and display helpers. No network.
 * Bitmaps stay under IMAGE_MAX_BYTES. URLs are never copied onto a record:
 * signed links expire, and the reader opens the conversation instead.
 */

export const IMAGE_MAX_EDGE = 512;
export const IMAGE_MAX_BYTES = 150 * 1024;
export const IMAGE_MAX_PER_MESSAGE = 24;

const PROMPT_LIMIT = 1000;
const ALT_LIMIT = 500;

export function clipText(value, limit) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return text.slice(0, limit);
}

function clampDim(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(IMAGE_MAX_EDGE, n);
}

function asBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  // chrome.runtime.sendMessage delivers an ArrayBuffer to the service worker
  // as a plain object, so the content script sends a number array instead.
  if (Array.isArray(value)) {
    if (value.length < 1 || value.length > IMAGE_MAX_BYTES) return null;
    const copy = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      const n = value[i];
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
      copy[i] = n;
    }
    return copy;
  }
  return null;
}

/**
 * A stored row. `cached` keeps the encoded bytes. Placeholders keep prompt and
 * alt only: `uncached` (the site tainted the canvas), `oversized` (still over
 * the byte cap after recompressing), `timeout` (encoding did not finish),
 * `not-loaded` (the picture had not finished painting; a later scan can
 * replace it). url / src / href on the input are ignored.
 */
export function normalizeImageRecord(conversationId, raw) {
  if (!conversationId || !raw || typeof raw !== "object") return null;
  const messageId = typeof raw.messageId === "string" ? raw.messageId : "";
  if (!messageId.startsWith(`${conversationId}:`)) return null;
  if (!Number.isInteger(raw.index) || raw.index < 0 || raw.index >= IMAGE_MAX_PER_MESSAGE) {
    return null;
  }
  const alt = clipText(raw.alt, ALT_LIMIT);
  const prompt = clipText(raw.prompt, PROMPT_LIMIT);
  const offset = Number.isFinite(Number(raw.offset))
    ? Math.max(0, Math.min(1_000_000, Math.floor(Number(raw.offset))))
    : 0;
  const base = {
    messageId,
    index: raw.index,
    conversationId,
    alt,
    prompt,
    offset,
  };
  if (raw.status === "uncached" || raw.status === "oversized" || raw.status === "timeout" || raw.status === "not-loaded") {
    return { ...base, status: raw.status, bytes: 0, mime: "", width: 0, height: 0 };
  }
  if (raw.status !== "cached") return null;
  const view = asBytes(raw.bytes ?? raw.blob);
  if (!view || view.byteLength < 1 || view.byteLength > IMAGE_MAX_BYTES) return null;
  const mime = raw.mime === "image/jpeg" || raw.mime === "image/webp" ? raw.mime : "";
  if (!mime) return null;
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return {
    ...base,
    status: "cached",
    bytes: copy.byteLength,
    mime,
    width: clampDim(raw.width),
    height: clampDim(raw.height),
    blob: copy.buffer,
  };
}

/** Snap a character offset to a paragraph edge so a thumbnail does not cut a line. */
export function snapOffset(body, offset) {
  const text = String(body ?? "");
  const n = Number(offset);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= text.length) return text.length;
  const next = text.indexOf("\n", Math.floor(n));
  if (next === -1) return text.length;
  return next + 1;
}

export function dataUrlFromBytes(bytes, mime) {
  const view = asBytes(bytes);
  if (!view || !view.byteLength || view.byteLength > IMAGE_MAX_BYTES) return "";
  const type = mime === "image/jpeg" ? "image/jpeg" : "image/webp";
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < view.length; i += step) {
    const slice = view.subarray(i, i + step);
    binary += String.fromCharCode.apply(null, slice);
  }
  return `data:${type};base64,${btoa(binary)}`;
}

/** Sidebar label. Zero is always "0 KB"; a failed read uses an em dash instead. */
export function formatCacheSize(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n === 0) return "0 KB";
  return formatByteSize(n);
}

export function formatByteSize(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) {
    const kb = n / 1024;
    return `${kb >= 10 ? kb.toFixed(0) : kb.toFixed(1)} KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
