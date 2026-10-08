import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function requestDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const convId = "chatgpt:aaaa1111-1111-4111-8111-111111111111";
const msgId = `${convId}:m1`;
const otherId = "chatgpt:bbbb2222-2222-4222-8222-222222222222";

// A 1.5.1 database: version 3, no images store.
const v3 = await new Promise((resolve, reject) => {
  const req = indexedDB.open("chatseek", 3);
  req.onupgradeneeded = () => {
    const db = req.result;
    const conv = db.createObjectStore("conversations", { keyPath: "id" });
    conv.createIndex("updatedAt", "updatedAt");
    conv.createIndex("platform", "platform");
    const msg = db.createObjectStore("messages", { keyPath: "id" });
    msg.createIndex("conversationId", "conversationId");
    const tokens = db.createObjectStore("tokenMap", { keyPath: ["token", "conversationId", "source"] });
    tokens.createIndex("conversationId", "conversationId");
    db.createObjectStore("meta", { keyPath: "key" });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
{
  const tx = v3.transaction(["conversations", "messages", "tokenMap"], "readwrite");
  tx.objectStore("conversations").put({
    id: convId,
    platform: "chatgpt",
    platformId: "aaaa1111-1111-4111-8111-111111111111",
    title: "Image upgrade",
    url: "https://chatgpt.com/c/aaaa1111-1111-4111-8111-111111111111",
    createdAt: Date.UTC(2026, 9, 1),
    updatedAt: Date.UTC(2026, 9, 2),
    updatedAtSource: "page-exact",
    firstSeenAt: Date.UTC(2026, 9, 1),
    messageCount: 1,
  });
  tx.objectStore("messages").put({
    id: msgId,
    conversationId: convId,
    role: "user",
    body: "maplecache needle",
    capturedAt: Date.UTC(2026, 9, 2),
  });
  tx.objectStore("tokenMap").put({
    token: "maplecache",
    conversationId: convId,
    source: msgId,
  });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
assert(v3.version === 3 && !v3.objectStoreNames.contains("images"), "fixture should be a 1.5.1 database");
v3.close();

const db = await import("../src/db.js");
const { normalizeImageRecord, formatByteSize, dataUrlFromBytes, IMAGE_MAX_BYTES } = await import("../src/image-cache.js");
const { text } = await import("../src/i18n.js");
const { mountReader } = await import("../src/reader-view.js");

const handle = await db.openDb();
assert(handle.version === 4, `1.5.1 database should upgrade to 4, got ${handle.version}`);
assert(handle.objectStoreNames.contains("images"), "upgrade creates the images store");
assert(
  handle.transaction("images").objectStore("images").indexNames.contains("conversationId"),
  "images are indexed by conversation",
);
const survived = await db.searchConversations({ query: "maplecache" });
assert(survived.length === 1 && survived[0].id === convId, "messages survive the image-store upgrade");
assert((await db.imageCacheUsage()) === 0, "a fresh image store uses no space");

const stripped = normalizeImageRecord(convId, {
  messageId: msgId,
  index: 0,
  status: "uncached",
  alt: "清水寺",
  prompt: "畫一座清水寺",
  url: "https://files.example/secret.png",
  src: "https://files.example/secret.png",
  href: "https://files.example/secret.png",
});
assert(stripped && stripped.status === "uncached" && stripped.bytes === 0, "uncached row keeps no bytes");
assert(!("url" in stripped) && !("src" in stripped) && !("href" in stripped), "image URLs are not stored");
assert(
  normalizeImageRecord(convId, {
    messageId: msgId,
    index: 1,
    status: "cached",
    mime: "image/webp",
    width: 512,
    height: 256,
    bytes: new Uint8Array(IMAGE_MAX_BYTES + 1).buffer,
  }) == null,
  "a bitmap over 150KB is rejected",
);

const tiny = new Uint8Array([1, 2, 3, 4, 5]);
const saved = await db.saveImageRecords(convId, [
  stripped,
  {
    messageId: msgId,
    index: 1,
    status: "cached",
    mime: "image/webp",
    width: 512,
    height: 128,
    bytes: tiny.buffer,
    alt: "縮圖",
    prompt: "畫一座清水寺",
    url: "https://cdn.example/gone.png",
  },
  {
    messageId: msgId,
    index: 2,
    status: "cached",
    mime: "image/webp",
    width: 12,
    height: 12,
    bytes: new Uint8Array(IMAGE_MAX_BYTES + 8).buffer,
    alt: "太大",
    prompt: "不要存",
  },
]);
assert(saved.saved === 2, `expected 2 records, saved ${saved.saved}`);
assert((await db.imageCacheUsage()) === tiny.byteLength, "usage counts cached bytes only");
const rows = await db.readImagesForMessages([msgId]);
assert(rows.length === 2, "reader can load the message's images");
assert(rows.every((row) => !row.url && !row.src), "stored rows have no image URL");
assert(rows.some((row) => row.status === "uncached" && row.alt === "清水寺" && row.prompt === "畫一座清水寺"), "uncached keeps prompt and alt");
const cached = rows.find((row) => row.status === "cached");
assert(cached && cached.bytes === tiny.byteLength && !cached.url, "cached row is the small bitmap");
const url = dataUrlFromBytes(cached.blob, cached.mime);
assert(url.startsWith("data:image/webp;base64,"), url.slice(0, 40));
assert(formatByteSize(0) === "0 B" && formatByteSize(1536) === "1.5 KB", formatByteSize(1536));

await db.upsertConversations([{
  id: otherId,
  platform: "chatgpt",
  platformId: "bbbb2222-2222-4222-8222-222222222222",
  title: "Keep me",
  url: "https://chatgpt.com/c/bbbb2222-2222-4222-8222-222222222222",
}]);
await db.removeConversation(convId);
assert((await db.readImagesForMessages([msgId])).length === 0, "removing a conversation deletes its images");
assert((await db.imageCacheUsage()) === 0, "removing a conversation frees the image bytes");
assert((await db.searchConversations({ query: "" })).some((row) => row.id === otherId) ||
  (await db.listRecent()).some((row) => row.id === otherId), "other conversations stay");

await db.saveImageRecords(otherId, [{
  messageId: `${otherId}:u`,
  index: 0,
  status: "cached",
  mime: "image/jpeg",
  width: 40,
  height: 40,
  bytes: tiny.buffer,
  alt: "keep",
  prompt: "keep",
}]);
assert((await db.imageCacheUsage()) === tiny.byteLength, "usage returns after a new image");
await db.clearImageCache();
assert((await db.imageCacheUsage()) === 0, "clear image cache zeros the counter");
assert((await db.readImagesForMessages([`${otherId}:u`])).length === 0, "clear image cache drops bitmaps");
const kept = await db.listRecent();
assert(kept.some((row) => row.id === otherId), "clear image cache keeps conversations");

const sharedSrc = readFileSync(join(root, "content/shared.js"), "utf8");
const imagesSrc = readFileSync(join(root, "content/images.js"), "utf8");

function loadApi(html, pageUrl) {
  const dom = new JSDOM(html, { url: pageUrl });
  const fn = new Function(
    "document",
    "Node",
    "NodeFilter",
    "console",
    "chrome",
    `${sharedSrc}
     Chatseek.autoStart = false;
     ${imagesSrc}
     return Chatseek;`,
  );
  const api = fn(
    dom.window.document,
    dom.window.Node,
    dom.window.NodeFilter,
    { warn() {}, log() {} },
    { runtime: { id: "test" } },
  );
  return { api, document: dom.window.document };
}

function mark(img, w, h) {
  Object.defineProperty(img, "complete", { configurable: true, get: () => true });
  Object.defineProperty(img, "naturalWidth", { configurable: true, get: () => w });
  Object.defineProperty(img, "naturalHeight", { configurable: true, get: () => h });
}

function readyImages(api, el, platform, role) {
  return api.collectContentImages(el, { platform, role })
    .filter((item) => item.ready)
    .map((item) => item.img.id);
}

const chatgpt = loadApi(`
  <article id="turn" data-message-author-role="assistant">
    <img id="ava" class="avatar" alt="ChatGPT">
    <div class="markdown">京都的紅葉</div>
    <img id="gen" alt="清水寺紅葉">
    <img id="tiny" alt="spark">
  </article>`, "https://chatgpt.com/c/x");
for (const img of chatgpt.document.querySelectorAll("img")) {
  mark(img, img.id === "gen" ? 1024 : 24, img.id === "gen" ? 768 : 24);
}
assert(
  readyImages(chatgpt.api, chatgpt.document.getElementById("turn"), "chatgpt", "assistant").join() === "gen",
  "ChatGPT keeps the generated picture and skips the avatar and icon",
);
assert(
  chatgpt.api.imageTextOffset(
    chatgpt.document.getElementById("turn"),
    chatgpt.document.getElementById("gen"),
    "京都的紅葉",
  ) === "京都的紅葉".length,
  "an image after the text sits at the end",
);

const claude = loadApi(`
  <div id="user" data-testid="user-message">
    看這張收據
    <img id="upload" alt="收據">
    <img id="icon" class="icon" alt="">
    <div class="artifact"><img id="art" alt="chart"></div>
  </div>`, "https://claude.ai/chat/x");
for (const img of claude.document.querySelectorAll("img")) {
  mark(img, img.id === "icon" ? 16 : 400, img.id === "icon" ? 16 : 300);
}
assert(
  readyImages(claude.api, claude.document.getElementById("user"), "claude", "user").join() === "upload",
  "Claude keeps the user upload and skips the artifact and icon",
);
assert(
  readyImages(claude.api, claude.document.getElementById("user"), "claude", "assistant").length === 0,
  "Claude does not cache assistant or artifact images",
);

const gemini = loadApi(`
  <model-response id="reply">
    <img id="logo" class="logo" alt="Gemini">
    <generated-image><img id="flower" alt="蝴蝶蘭"></generated-image>
  </model-response>`, "https://gemini.google.com/app/x");
for (const img of gemini.document.querySelectorAll("img")) {
  mark(img, img.id === "flower" ? 800 : 32, 600);
}
assert(
  readyImages(gemini.api, gemini.document.getElementById("reply"), "gemini", "assistant").join() === "flower",
  "Gemini keeps the generated image",
);

const grok = loadApi(`
  <div id="msg" data-message-author-role="assistant">
    <img id="mark" class="logo" alt="">
    <figure><img id="boost" alt="助推器"></figure>
  </div>`, "https://grok.com/c/x");
for (const img of grok.document.querySelectorAll("img")) {
  mark(img, img.id === "boost" ? 900 : 20, img.id === "boost" ? 500 : 20);
}
assert(
  readyImages(grok.api, grok.document.getElementById("msg"), "grok", "assistant").join() === "boost",
  "Grok keeps the picture in the message",
);

function hooks({ taint = false, security = false, size = 80, empty = false } = {}) {
  const bytes = new Uint8Array([7, 8, 9, 10]).buffer;
  return {
    createCanvas() {
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            drawImage() {},
            getImageData() {
              if (taint) {
                const err = new Error("tainted");
                err.name = "SecurityError";
                throw err;
              }
              return { data: new Uint8ClampedArray(4) };
            },
          };
        },
      };
    },
    async toBlob() {
      if (security) {
        const err = new Error("tainted");
        err.name = "SecurityError";
        throw err;
      }
      if (empty) return null;
      return {
        size,
        async arrayBuffer() { return bytes; },
      };
    },
  };
}

const painted = { complete: true, naturalWidth: 800, naturalHeight: 400 };
const tainted = await chatgpt.api.encodeContentImage(painted, hooks({ taint: true }));
assert(tainted.status === "uncached", "a tainted canvas is stored as uncached");
const thrown = await chatgpt.api.encodeContentImage(painted, hooks({ security: true }));
assert(thrown.status === "uncached", "SecurityError from encoding is uncached");
const huge = await chatgpt.api.encodeContentImage(painted, hooks({ size: IMAGE_MAX_BYTES + 50 }));
assert(huge.status === "omit", "a bitmap that stays over 150KB is not stored");
const encoded = await chatgpt.api.encodeContentImage(painted, hooks({ size: 80 }));
assert(encoded.status === "cached" && encoded.mime === "image/webp", encoded.mime);
assert(encoded.width === 512 && encoded.height === 256, `scaled to ${encoded.width}x${encoded.height}`);
assert(encoded.bytes.byteLength === 4 && encoded.bytes.byteLength <= IMAGE_MAX_BYTES, "encoded bytes stay under the cap");

const dom = new JSDOM(`<!DOCTYPE html><div id="app"></div>`, { url: "https://example.test/reader" });
const opened = [];
const view = mountReader(dom.window.document.getElementById("app"), {
  locale: "zh-TW",
  conversation: {
    id: convId,
    platform: "chatgpt",
    platformId: "aaaa1111-1111-4111-8111-111111111111",
    title: "京都",
    url: "https://chatgpt.com/c/aaaa1111-1111-4111-8111-111111111111",
    updatedAt: Date.UTC(2026, 9, 2),
    updatedAtSource: "page-exact",
  },
  messages: [
    { id: msgId, role: "assistant", body: "清水寺在秋天。" },
    { id: `${convId}:m2`, role: "user", body: "再畫一張夜景。" },
  ],
  images: new Map([
    [msgId, [{
      messageId: msgId,
      index: 0,
      status: "cached",
      mime: "image/webp",
      blob: tiny.buffer,
      alt: "清水寺",
      prompt: "畫一座清水寺",
      offset: 0,
    }]],
    [`${convId}:m2`, [{
      messageId: `${convId}:m2`,
      index: 0,
      status: "uncached",
      alt: "夜景",
      prompt: "再畫一張夜景。",
      offset: 99,
    }]],
  ]),
  onOpenOriginal: (next) => opened.push(next),
});
assert(view.renderedMessages() >= 1, "reader mounted");
const app = dom.window.document.getElementById("app");
const thumb = app.querySelector(".cached-thumb");
assert(thumb && thumb.getAttribute("src").startsWith("data:image/webp"), "thumbnail is a data URL");
assert(![...app.querySelectorAll("[src]")].some((el) => /^https?:/i.test(el.getAttribute("src") || "")), "no remote image URL");
assert(app.textContent.includes(text("zh-TW", "imageUncached")), "placeholder uses the zh-TW sentence");
app.querySelector(".thumb-btn").click();
app.querySelector(".image-open").click();
assert(opened.length === 2 && opened.every((item) => item === "https://chatgpt.com/c/aaaa1111-1111-4111-8111-111111111111"), `opened ${opened.join(",")}`);

console.log("image-cache-test ok");
