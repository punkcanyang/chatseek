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
  const tx = v3.transaction(["conversations", "messages", "tokenMap", "meta"], "readwrite");
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
  tx.objectStore("meta").put({ key: "removed:chatgpt:cccc3333-3333-4333-8333-333333333333", removedAt: 1700000000000 });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
assert(v3.version === 3 && !v3.objectStoreNames.contains("images"), "fixture should be a 1.5.1 database");
v3.close();

const db = await import("../src/db.js");
const { normalizeImageRecord, formatByteSize, formatCacheSize, dataUrlFromBytes, IMAGE_MAX_BYTES } = await import("../src/image-cache.js");
const { text, CATALOG, LOCALE_ORDER } = await import("../src/i18n.js");
const { mountReader } = await import("../src/reader-view.js");

const handle = await db.openDb();
const buriedId = "chatgpt:cccc3333-3333-4333-8333-333333333333";
const tombBefore = await requestDone(handle.transaction("meta").objectStore("meta").get(`removed:${buriedId}`));
assert(tombBefore?.removedAt === 1700000000000, "a 1.5.1 tombstone survives the image-store upgrade");
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
assert(formatCacheSize(0) === "0 KB" && formatCacheSize(1536) === "1.5 KB", formatCacheSize(0));
const pendingRow = normalizeImageRecord(convId, {
  messageId: msgId,
  index: 3,
  status: "not-loaded",
  alt: "還沒好",
  prompt: "等一下",
  url: "https://cdn.example/late.png",
});
assert(pendingRow?.status === "not-loaded" && !pendingRow.url, "a picture that has not loaded is a placeholder without a url");
const timed = normalizeImageRecord(convId, {
  messageId: msgId,
  index: 4,
  status: "timeout",
  alt: "太慢",
  prompt: "轉檔",
  src: "https://cdn.example/slow.png",
});
assert(timed?.status === "timeout" && !timed.src && timed.bytes === 0, "a timed-out encode keeps no bytes and no url");

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

function loadApi(html, pageUrl, chrome = { runtime: { id: "test" } }) {
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
    chrome,
  );
  return { api, document: dom.window.document, window: dom.window };
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

const ordered = loadApi(`
  <article id="turn" data-message-author-role="assistant">
    <button type="button"><img id="tool" alt="copy"></button>
    <button type="button"><img id="lightbox" alt="清水寺"></button>
    <img id="first" alt="第一張">
    <img id="dup" alt="第一張">
    <img id="second" alt="第二張">
    <img id="mid" alt="中等">
    <img id="small" alt="小裝飾">
  </article>`, "https://chatgpt.com/c/x");
for (const img of ordered.document.querySelectorAll("img")) {
  img.setAttribute("src", img.id === "first" || img.id === "dup" ? "blob:same" : `blob:${img.id}`);
  const size = img.id === "tool" || img.id === "small" ? 16 : (img.id === "mid" ? 50 : 400);
  mark(img, size, size);
}
assert(
  readyImages(ordered.api, ordered.document.getElementById("turn"), "chatgpt", "assistant").join() === "lightbox,first,second,mid",
  "ChatGPT keeps a large button image and a 50px picture, skips the toolbar icon, and drops a duplicate source",
);
const loading = ordered.document.getElementById("first");
Object.defineProperty(loading, "complete", { configurable: true, get: () => false });
Object.defineProperty(loading, "naturalWidth", { configurable: true, get: () => 0 });
const pendingList = ordered.api.collectContentImages(ordered.document.getElementById("turn"), {
  platform: "chatgpt",
  role: "assistant",
});
assert(pendingList.some((item) => item.img.id === "first" && item.ready === false), "an unfinished image is waited on");
assert(pendingList.some((item) => item.img.id === "second" && item.ready), "a loaded sibling is not blocked by the unfinished one");
Object.defineProperty(loading, "complete", { configurable: true, get: () => true });
Object.defineProperty(loading, "naturalWidth", { configurable: true, get: () => 0 });
assert(
  !ordered.api.collectContentImages(ordered.document.getElementById("turn"), {
    platform: "chatgpt",
    role: "assistant",
  }).some((item) => item.img.id === "first"),
  "a finished image with no pixels is skipped instead of waited on",
);

const claudeOrder = loadApi(`
  <div id="old" data-testid="user-message"><img id="oldimg" alt="上一則"></div>
  <div class="gap"></div>
  <div class="font-claude-message"><img id="chart" alt="圖表"></div>
  <div id="files"><img id="up" alt="上傳"></div>
  <div id="user" data-testid="user-message">
    看這張
    <img id="inside" alt="內文">
    <img id="again" alt="內文">
  </div>
  <div class="artifact"><iframe src="https://claude.ai/artifact"></iframe><img id="art" alt="artifact"></div>`, "https://claude.ai/chat/x");
for (const img of claudeOrder.document.querySelectorAll("img")) {
  img.setAttribute("src", img.id === "again" ? "blob:inside" : `blob:${img.id}`);
  const inside = claudeOrder.document.getElementById("inside");
  if (img.id === "again") img.setAttribute("src", inside.getAttribute("src"));
  mark(img, 400, 280);
}
assert(
  readyImages(claudeOrder.api, claudeOrder.document.getElementById("user"), "claude", "user").join() === "up,inside",
  "Claude keeps the upload row before the bubble, in document order, once",
);
assert(
  !readyImages(claudeOrder.api, claudeOrder.document.getElementById("user"), "claude", "user").includes("oldimg"),
  "Claude does not take the previous turn's image",
);
assert(
  !readyImages(claudeOrder.api, claudeOrder.document.getElementById("user"), "claude", "user").includes("chart"),
  "Claude stops at the previous assistant message",
);
assert(
  readyImages(claudeOrder.api, claudeOrder.document.getElementById("old"), "claude", "user").join() === "oldimg",
  "the previous Claude turn keeps its own image",
);

const geminiShadow = loadApi(`
  <model-response id="reply">
    <img id="logo" class="logo" alt="Gemini">
    <div id="host"></div>
  </model-response>`, "https://gemini.google.com/app/x");
const host = geminiShadow.document.getElementById("host");
const shadow = host.attachShadow({ mode: "open" });
const nested = geminiShadow.document.createElement("span");
const inner = geminiShadow.document.createElement("img");
inner.id = "flower";
inner.alt = "蝴蝶蘭";
nested.append(inner);
const shell = geminiShadow.document.createElement("div");
shell.append(nested);
shadow.append(shell);
const deep = nested.attachShadow({ mode: "open" });
deep.append(inner);
for (const img of [geminiShadow.document.getElementById("logo"), inner]) {
  mark(img, img.id === "flower" ? 800 : 32, 600);
}
assert(
  readyImages(geminiShadow.api, geminiShadow.document.getElementById("reply"), "gemini", "assistant").join() === "flower",
  "Gemini reads an open shadow root and skips the logo",
);

const chatShadow = loadApi(`
  <article id="turn" data-message-author-role="assistant">
    <div class="markdown">京都的紅葉很晚</div>
    <div id="host"></div>
  </article>`, "https://chatgpt.com/c/x");
const shadowHost = chatShadow.document.getElementById("host");
const openRoot = shadowHost.attachShadow({ mode: "open" });
const shadowImg = chatShadow.document.createElement("img");
shadowImg.id = "shadowpic";
shadowImg.alt = "舞台";
openRoot.append(shadowImg);
mark(shadowImg, 640, 480);
assert(
  readyImages(chatShadow.api, chatShadow.document.getElementById("turn"), "chatgpt", "assistant").join() === "shadowpic",
  "ChatGPT reads an image inside an open shadow root",
);

const closedRoots = new WeakMap();
const chatClosed = loadApi(`
  <article id="turn" data-message-author-role="assistant">
    <div class="markdown">京都的紅葉很晚才紅</div>
    <div id="closed"></div>
  </article>`, "https://chatgpt.com/c/x", {
  runtime: { id: "test" },
  dom: { openOrClosedShadowRoot: (el) => closedRoots.get(el) || null },
});
const closedHost = chatClosed.document.getElementById("closed");
const closedRoot = closedHost.attachShadow({ mode: "closed" });
closedRoots.set(closedHost, closedRoot);
const closedImg = chatClosed.document.createElement("img");
closedImg.id = "closedpic";
closedImg.alt = "夜景";
closedRoot.append(closedImg);
mark(closedImg, 700, 420);
assert(closedHost.shadowRoot == null, "the closed root is not exposed as shadowRoot");
assert(
  readyImages(chatClosed.api, chatClosed.document.getElementById("turn"), "chatgpt", "assistant").join() === "closedpic",
  "ChatGPT reads an image inside a closed shadow root",
);

const framed = loadApi(`
  <article id="turn" data-message-author-role="assistant">
    <div class="markdown">同源頁框裡的圖也要收到</div>
    <iframe id="frame"></iframe>
  </article>`, "https://chatgpt.com/c/x");
const frame = framed.document.getElementById("frame");
const frameImg = frame.contentDocument.createElement("img");
frameImg.id = "framepic";
frameImg.alt = "頁框";
frame.contentDocument.body.append(frameImg);
mark(frameImg, 360, 240);
assert(
  readyImages(framed.api, framed.document.getElementById("turn"), "chatgpt", "assistant").join() === "framepic",
  "ChatGPT reads an image in a same-origin iframe",
);

const beside = loadApi(`
  <div id="turn"><p>這段備援文字夠長，所以圖在旁邊的區塊也要算進這一則。</p></div>
  <div id="pic"><img id="besidepic" alt="旁邊的圖"></div>`, "https://chatgpt.com/c/x");
mark(beside.document.getElementById("besidepic"), 500, 320);
assert(
  readyImages(beside.api, beside.document.getElementById("turn"), "chatgpt", "assistant").join() === "besidepic",
  "a heuristic text block also takes the image-only sibling",
);

const pictured = loadApi(`
  <article id="turn" data-message-author-role="assistant">
    <picture>
      <source srcset="https://cdn.example/a.png 1x">
      <img id="picked" alt="選中的圖">
    </picture>
  </article>`, "https://chatgpt.com/c/x");
const picked = pictured.document.getElementById("picked");
Object.defineProperty(picked, "currentSrc", { configurable: true, get: () => "https://cdn.example/a.png" });
mark(picked, 300, 200);
assert(
  readyImages(pictured.api, pictured.document.getElementById("turn"), "chatgpt", "assistant").join() === "picked",
  "picture/srcset uses the image element the browser already selected",
);

function hooks({ taint = false, security = false, size = 80, empty = false, getImageDataError = false } = {}) {
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
              if (taint || getImageDataError) {
                const err = new Error(taint ? "tainted" : "canvas failed");
                if (taint) err.name = "SecurityError";
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
assert(huge.status === "oversized", "a bitmap that stays over 150KB is a placeholder, not dropped");
const genericThrow = await chatgpt.api.encodeContentImage(painted, hooks({
  taint: false,
  getImageDataError: true,
}));
assert(genericThrow.status === "uncached", "a non-security canvas error degrades to uncached");
const hung = await chatgpt.api.encodeContentImage(painted, {
  ...hooks(),
  blobTimeout: 40,
  toBlob() { return new Promise(() => {}); },
});
assert(hung.status === "timeout", "a toBlob that never calls back is a timeout placeholder");
const brokenEncode = await chatgpt.api.encodeContentImage(
  { complete: false, naturalWidth: 0, naturalHeight: 0 },
  hooks(),
);
assert(brokenEncode.status === "pending", "an image that has not loaded is not encoded yet");
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
  query: "maple",
  messages: [
    { id: msgId, role: "assistant", body: "maple 之前\n\n![清水寺](https://cdn.example/secret.png)\n\nmaple 之後" },
    { id: `${convId}:m2`, role: "user", body: "再畫一張夜景。maple" },
    { id: `${convId}:m3`, role: "assistant", body: "這張太大。另見 ![別張](https://cdn.example/other.png)" },
  ],
  images: new Map([
    [msgId, [{
      messageId: msgId,
      index: 0,
      status: "cached",
      mime: "image/webp",
      blob: tiny.buffer,
      alt: "清水寺",
      prompt: "<script>alert(1)</script>",
      offset: "maple 之前\n\n".length,
    }]],
    [`${convId}:m2`, [{
      messageId: `${convId}:m2`,
      index: 0,
      status: "uncached",
      alt: "夜景",
      prompt: "再畫一張夜景。",
      offset: 99,
    }]],
    [`${convId}:m3`, [{
      messageId: `${convId}:m3`,
      index: 0,
      status: "oversized",
      alt: "<img src=x onerror=alert(1)>",
      prompt: "<script>alert(1)</script>",
      offset: 99,
    }, {
      messageId: `${convId}:m3`,
      index: 1,
      status: "timeout",
      alt: "轉太久",
      prompt: "慢",
      offset: 0,
    }, {
      messageId: `${convId}:m3`,
      index: 2,
      status: "not-loaded",
      alt: "還沒畫完",
      prompt: "等",
      offset: 0,
    }]],
  ]),
  onOpenOriginal: (next) => opened.push(next),
});
assert(view.renderedMessages() >= 1, "reader mounted");
const app = dom.window.document.getElementById("app");
const thumb = app.querySelector(".cached-thumb");
assert(thumb && thumb.getAttribute("src").startsWith("data:image/webp"), "thumbnail is a data URL");
assert(thumb.alt === "清水寺", "thumbnail alt is text");
assert(![...app.querySelectorAll("[src]")].some((el) => /^https?:/i.test(el.getAttribute("src") || "")), "no remote image URL");
assert(!app.querySelector("script"), "prompt and alt are not parsed as HTML");
assert(app.textContent.includes(text("zh-TW", "imageUncached")), "site-limit placeholder uses the zh-TW sentence");
assert(app.textContent.includes(text("zh-TW", "imageOversized")), "oversized placeholder uses the zh-TW sentence");
assert(app.querySelector("[data-reason='site']") && app.querySelector("[data-reason='oversized']"), "the two placeholders are distinct");
assert(app.querySelector("[data-reason='timeout']") && app.textContent.includes(text("zh-TW", "imageTimeout")), "timeout placeholder uses the zh-TW sentence");
assert(app.querySelector("[data-reason='not-loaded']") && app.textContent.includes(text("zh-TW", "imageNotLoaded")), "not-loaded placeholder uses the zh-TW sentence");
assert(!app.textContent.includes("https://cdn.example/secret.png"), "a cached image replaces the matching Markdown placeholder");
assert(app.textContent.includes("https://cdn.example/other.png"), "a different Markdown image stays as text");
assert(app.textContent.includes("maple 之前") && app.textContent.includes("maple 之後"), "text around the thumbnail stays");
assert(view.hitCount() === 3, `maple hits stay countable, got ${view.hitCount()}`);
assert(app.querySelector("mark.is-current"), "the current hit is painted");
view.next();
assert(view.hitIndex() === 1, "next hit still moves");
view.prev();
assert(view.hitIndex() === 0, "previous hit still moves");
app.querySelector(".thumb-btn").click();
app.querySelector(".image-open").click();
app.querySelector("[data-reason='oversized'] .image-open").click();
assert(opened.length === 3 && opened.every((item) => item === "https://chatgpt.com/c/aaaa1111-1111-4111-8111-111111111111"), `opened ${opened.join(",")}`);
for (const code of LOCALE_ORDER) {
  assert(CATALOG[code].imageOversized && CATALOG[code].imageOversized !== CATALOG[code].imageUncached, `${code} distinguishes an oversized image`);
  assert(CATALOG[code].imageTimeout && CATALOG[code].imageTimeout !== CATALOG[code].imageUncached, `${code} distinguishes a timeout`);
  assert(CATALOG[code].imageNotLoaded && CATALOG[code].imageNotLoaded !== CATALOG[code].imageTimeout, `${code} distinguishes an image that is still loading`);
}

const replaced = await db.saveImageRecords(convId, [{
  messageId: msgId,
  index: 1,
  status: "cached",
  mime: "image/webp",
  width: 8,
  height: 8,
  bytes: tiny.buffer,
  alt: "計數",
  prompt: "計數",
}]);
assert(replaced.saved === 1, "replacement setup saved");
const smaller = new Uint8Array([1, 2]);
await db.saveImageRecords(convId, [{
  messageId: msgId,
  index: 1,
  status: "cached",
  mime: "image/webp",
  width: 8,
  height: 8,
  bytes: smaller.buffer,
  alt: "計數",
  prompt: "計數",
}]);
assert((await db.imageCacheUsage()) === smaller.byteLength, "replacing a thumbnail recounts bytes");
await db.saveImageRecords(convId, [{
  messageId: msgId,
  index: 2,
  status: "oversized",
  alt: "太大",
  prompt: "仍要佔位",
  url: "https://cdn.example/huge.png",
}]);
assert((await db.imageCacheUsage()) === smaller.byteLength, "an oversized placeholder adds no bytes");
const oversizedRow = (await db.readImagesForMessages([msgId])).find((row) => row.status === "oversized");
assert(oversizedRow?.alt === "太大" && oversizedRow.prompt === "仍要佔位" && !oversizedRow.url, "oversized keeps prompt and alt only");

await db.upsertConversations([{
  id: buriedId,
  platform: "chatgpt",
  platformId: "cccc3333-3333-4333-8333-333333333333",
  title: "Buried",
  url: "https://chatgpt.com/c/cccc3333-3333-4333-8333-333333333333",
}]);
assert(!(await db.listRecent()).some((row) => row.id === buriedId), "a tombstone still blocks a sidebar rescan");

const origPut = IDBObjectStore.prototype.put;
IDBObjectStore.prototype.put = function put(value, key) {
  if (value && value.status === "cached" && value.blob) {
    const err = new DOMException("The quota has been exceeded.", "QuotaExceededError");
    throw err;
  }
  return origPut.call(this, value, key);
};
let quotaResult;
try {
  quotaResult = await db.saveImageRecords(convId, [{
    messageId: msgId,
    index: 3,
    status: "cached",
    mime: "image/webp",
    width: 8,
    height: 8,
    bytes: tiny.buffer,
    alt: "放不下",
    prompt: "放不下",
  }]);
} finally {
  IDBObjectStore.prototype.put = origPut;
}
assert(quotaResult?.quota === true && quotaResult.saved === 0, "a full disk fails the image write cleanly");
assert((await db.imageCacheUsage()) === smaller.byteLength, "a quota failure does not change the byte counter");
assert((await db.listRecent()).some((row) => row.id === otherId), "a quota failure leaves conversations");
await db.clearImageCache();
assert((await db.imageCacheUsage()) === 0, "clear still zeros usage");
const tombAfter = await requestDone(handle.transaction("meta").objectStore("meta").get(`removed:${buriedId}`));
assert(tombAfter?.removedAt === 1700000000000, "clearing image cache leaves tombstones");

console.log("image-cache-test ok");
