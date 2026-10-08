/* Thumbnails from images the page has already painted. No new loads. */
(() => {
  const MAX_EDGE = 512;
  const MAX_BYTES = 150 * 1024;
  const QUALITIES = [0.82, 0.66, 0.48, 0.32, 0.2];
  const MIN_EDGE = 64;
  const BLOB_TIMEOUT_MS = 1500;
  const CLAUDE_MESSAGE = [
    "[data-testid='user-message']",
    "[data-testid='human-message']",
    "[data-testid='assistant-message']",
    "[data-testid='ai-message']",
    ".font-claude-message",
  ].join(", ");

  const queue = [];
  const done = new Map();
  const waiting = new WeakSet();
  // An <img> node belongs to the first message that claimed it.
  const ownerOf = new WeakMap();
  // Same picture rendered twice in one message (two elements, one source).
  // The key is a hash, not the URL, and it is not written to IndexedDB.
  const srcOwner = new Map();
  let pumping = false;

  function clip(value, limit) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length <= limit ? text : text.slice(0, limit);
  }

  function classText(el) {
    if (!el) return "";
    if (typeof el.className === "string") return el.className;
    return el.getAttribute?.("class") || "";
  }

  function srcKey(img) {
    const src = String(img?.currentSrc || img?.getAttribute?.("src") || "");
    if (!src) return "";
    let h = 2166136261;
    for (let i = 0; i < src.length; i += 1) {
      h ^= src.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return `${src.length}:${(h >>> 0).toString(16)}`;
  }

  function claimImage(img, messageId) {
    const owner = ownerOf.get(img);
    if (owner && owner !== messageId) return false;
    const key = srcKey(img);
    if (key) {
      const srcMessage = srcOwner.get(key);
      if (srcMessage && srcMessage !== messageId) return false;
      srcOwner.set(key, messageId);
    }
    ownerOf.set(img, messageId);
    return true;
  }

  function isClaudeBoundary(node) {
    if (!node || node.nodeType !== 1) return false;
    try {
      if (typeof node.matches === "function" && node.matches(CLAUDE_MESSAGE)) return true;
      if (node.querySelector?.(CLAUDE_MESSAGE)) return true;
    } catch {
      return false;
    }
    return false;
  }

  /**
   * Platform image DOM, scoped to one message (plus Claude's upload row).
   * ChatGPT: img inside the turn. Generated and uploaded pictures are img;
   * avatars and toolbar marks are small or classed as avatar/icon.
   * Claude: user uploads only. The row just above the bubble is a previous
   * sibling, at most three of them, and the walk stops at another message
   * so a picture is not glued onto the wrong turn. Artifact frames are not
   * opened and not searched.
   * Gemini: img under user-query / model-response, including generated-image
   * and single-image, plus open shadow roots inside that message.
   * Grok: img / figure img inside the message bubble.
   */
  function searchRoots(el, platform) {
    if (platform !== "claude" || !el) return [el];
    const before = [];
    let sib = el.previousElementSibling;
    let steps = 0;
    while (sib && steps < 3) {
      if (isClaudeBoundary(sib)) break;
      if (sib.querySelector?.("iframe, [data-testid*='artifact' i], [class*='artifact' i]")) break;
      before.push(sib);
      sib = sib.previousElementSibling;
      steps += 1;
    }
    before.reverse();
    return [...before, el];
  }

  function pushImgs(out, root) {
    if (!root?.querySelectorAll) return;
    try {
      root.querySelectorAll("img").forEach((img) => out.push(img));
    } catch {
      // A closed root is not readable.
    }
  }

  function collectShadowImages(root, out, depth) {
    if (!root?.querySelectorAll || depth > 4) return;
    let nodes = [];
    try {
      nodes = root.querySelectorAll("*");
    } catch {
      return;
    }
    for (const node of nodes) {
      if (!node.shadowRoot || node.tagName === "IFRAME") continue;
      pushImgs(out, node.shadowRoot);
      collectShadowImages(node.shadowRoot, out, depth + 1);
    }
  }

  function listedImages(root, platform) {
    const out = [];
    if (!root || root.nodeType !== 1) return out;
    pushImgs(out, root);
    if (platform === "gemini") collectShadowImages(root, out, 0);
    return out;
  }

  function documentOrder(a, b) {
    if (!a || !b || a === b || typeof a.compareDocumentPosition !== "function") return 0;
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  function blocked(img, platform) {
    if (!img || img.tagName !== "IMG") return true;
    if (img.closest?.(
      "iframe, nav, header, footer, button, [role='button'], [role='navigation'], svg, " +
      "[data-testid*='artifact' i], [class*='artifact' i]",
    )) return true;
    const blob = `${classText(img)} ${classText(img.parentElement)} ${img.getAttribute?.("data-testid") || ""}`.toLowerCase();
    if (/avatar|profile|logo|emoji|\bicon\b/.test(blob)) return true;
    if (img.closest?.("[class*='avatar' i], [class*='logo' i], [data-testid*='avatar' i]")) return true;
    const alt = (img.getAttribute?.("alt") || "").trim();
    if (/^(user|assistant|chatgpt|claude|grok|gemini)$/i.test(alt)) return true;
    if (platform === "claude" && img.closest?.(
      "[data-testid='assistant-message'], [data-testid='ai-message'], .font-claude-message",
    )) return true;
    // Not painted yet: wait. Already settled with no pixels: skip, don't wait.
    if (!img.complete) return "later";
    if (!(img.naturalWidth > 0) || !(img.naturalHeight > 0)) return true;
    if (Math.max(img.naturalWidth, img.naturalHeight) < MIN_EDGE) return true;
    return false;
  }

  function collectContentImages(el, { platform, role, messageId = "" } = {}) {
    if (!el || el.nodeType !== 1) return [];
    if (platform === "claude" && role !== "user") return [];
    const seen = new Set();
    const localSrc = new Set();
    const ready = [];
    for (const root of searchRoots(el, platform)) {
      for (const img of listedImages(root, platform)) {
        if (seen.has(img)) continue;
        seen.add(img);
        const why = blocked(img, platform);
        if (why === true) continue;
        if (messageId && !claimImage(img, messageId)) continue;
        const key = srcKey(img);
        if (key) {
          if (localSrc.has(key)) continue;
          localSrc.add(key);
        }
        ready.push({ img, ready: why !== "later" });
        if (ready.length >= 24) break;
      }
      if (ready.length >= 24) break;
    }
    ready.sort((a, b) => documentOrder(a.img, b.img));
    return ready;
  }

  const BLOB_TIMEOUT = { timeout: true };

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob((blob) => {
          try {
            resolve(blob || null);
          } catch (err) {
            reject(err);
          }
        }, type, quality);
      } catch (err) {
        reject(err);
      }
    });
  }

  function withTimeout(pending, timeoutMs) {
    let timer = 0;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(BLOB_TIMEOUT), timeoutMs);
    });
    return Promise.race([
      Promise.resolve(pending).then((value) => value ?? null, (err) => {
        throw err;
      }),
      timeout,
    ]).finally(() => clearTimeout(timer));
  }

  function isSecurity(err) {
    const name = err?.name || "";
    return name === "SecurityError" || /SecurityError/.test(String(err || ""));
  }

  function yieldToBrowser() {
    return new Promise((resolve) => {
      const idle = globalThis.requestIdleCallback;
      if (typeof idle === "function") idle(() => resolve(), { timeout: 48 });
      else setTimeout(resolve, 0);
    });
  }

  async function paintScaled(img, canvas, ctx, width, height, hooks) {
    if (!hooks && typeof createImageBitmap === "function") {
      let bitmap = null;
      try {
        bitmap = await createImageBitmap(img, {
          resizeWidth: width,
          resizeHeight: height,
          resizeQuality: "low",
        });
        ctx.drawImage(bitmap, 0, 0, width, height);
        return;
      } catch (err) {
        if (isSecurity(err)) throw err;
      } finally {
        bitmap?.close?.();
      }
    }
    ctx.drawImage(img, 0, 0, width, height);
  }

  async function encodeContentImage(img, hooks) {
    try {
      return await encodeContentImageInner(img, hooks);
    } catch {
      return { status: "uncached" };
    }
  }

  async function encodeContentImageInner(img, hooks) {
    if (!img || !img.complete || !(img.naturalWidth > 0) || !(img.naturalHeight > 0)) {
      return { status: "pending" };
    }
    const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = hooks?.createCanvas
      ? hooks.createCanvas(width, height)
      : document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
    if (!ctx || typeof ctx.drawImage !== "function") return { status: "uncached" };
    try {
      await paintScaled(img, canvas, ctx, width, height, hooks);
      if (typeof ctx.getImageData === "function") ctx.getImageData(0, 0, 1, 1);
    } catch {
      return { status: "uncached" };
    }
    const timeoutMs = Number(hooks?.blobTimeout) > 0 ? Number(hooks.blobTimeout) : BLOB_TIMEOUT_MS;
    let produced = false;
    for (const type of ["image/webp", "image/jpeg"]) {
      for (const quality of QUALITIES) {
        let blob = null;
        try {
          const pending = hooks?.toBlob
            ? hooks.toBlob(canvas, type, quality)
            : canvasToBlob(canvas, type, quality);
          blob = await withTimeout(pending, timeoutMs);
        } catch {
          return { status: "uncached" };
        }
        if (blob === BLOB_TIMEOUT) return { status: "uncached" };
        if (!blob) continue;
        produced = true;
        const size = Number(blob.size ?? blob.byteLength) || 0;
        if (size > MAX_BYTES) continue;
        let bytes;
        try {
          bytes = hooks?.blobBytes ? await hooks.blobBytes(blob) : await blob.arrayBuffer();
        } catch {
          return { status: "uncached" };
        }
        const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
        if (!view || view.byteLength > MAX_BYTES || view.byteLength < 1) continue;
        return { status: "cached", mime: type, width, height, bytes: view.buffer || view };
      }
    }
    if (produced) return { status: "oversized" };
    return { status: "uncached" };
  }

  function imageTextOffset(messageEl, img, body) {
    const text = String(body || "");
    if (!text || !messageEl || !img) return 0;
    const host = messageEl.querySelector?.(
      ".markdown, .prose, .whitespace-pre-wrap, .query-text, message-content, .model-response-text",
    );
    try {
      if (host && (img.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING)) return 0;
      if (host && host.contains(img) && messageEl.ownerDocument?.createRange) {
        const range = messageEl.ownerDocument.createRange();
        range.setStart(host, 0);
        range.setEndBefore(img);
        const before = range.toString().replace(/\s+/g, " ").trim();
        if (!before) return 0;
        const probe = before.slice(0, 48);
        const at = text.indexOf(probe);
        if (at >= 0) return Math.min(text.length, at + probe.length);
      }
    } catch {
      // Fall through to "after the text".
    }
    return text.length;
  }

  function platformOf(conversationId) {
    const name = String(conversationId || "").split(":")[0];
    if (name === "chatgpt" || name === "claude" || name === "grok" || name === "gemini") return name;
    return "";
  }

  function storedStatus(encoded) {
    if (encoded?.status === "cached" || encoded?.status === "oversized") return encoded.status;
    if (encoded?.status === "uncached") return "uncached";
    return "";
  }

  async function processJob(job) {
    const platform = platformOf(job.conversationId);
    const found = collectContentImages(job.el, {
      platform,
      role: job.role,
      messageId: job.messageId,
    });
    let worked = false;
    for (let index = 0; index < found.length; index += 1) {
      const item = found[index];
      if (!item.ready) continue;
      const img = item.img;
      const fp = `${img.naturalWidth}x${img.naturalHeight}:${clip(img.getAttribute?.("alt"), 80)}`;
      const key = `${job.messageId}:${index}`;
      if (done.get(key) === fp) continue;
      if (worked) await yieldToBrowser();
      let encoded;
      try {
        encoded = await encodeContentImage(img);
      } catch {
        encoded = { status: "uncached" };
      }
      if (encoded.status === "pending") continue;
      const status = storedStatus(encoded);
      if (!status) continue;
      const record = {
        messageId: job.messageId,
        index,
        alt: clip(img.getAttribute?.("alt"), 500),
        prompt: clip(job.prompt, 1000),
        offset: imageTextOffset(job.el, img, job.body),
        status,
        mime: encoded.mime || "",
        width: encoded.width || 0,
        height: encoded.height || 0,
        bytes: status === "cached" ? encoded.bytes : null,
      };
      let res = null;
      try {
        res = await Chatseek.send({
          type: "CAPTURE_IMAGES",
          conversationId: job.conversationId,
          images: [record],
        });
      } catch {
        res = null;
      }
      if (res?.ok || res?.error === "quota") done.set(key, fp);
      worked = true;
    }
    return worked;
  }

  function watchUntilPainted(job, img) {
    if (!img || waiting.has(img) || typeof img.addEventListener !== "function") return;
    if (img.complete) return;
    waiting.add(img);
    let settled = false;
    const finish = (loaded) => {
      if (settled) return;
      settled = true;
      waiting.delete(img);
      if (!loaded) return;
      scheduleMessageImages({
        conversationId: job.conversationId,
        items: [{
          messageId: job.messageId,
          role: job.role,
          el: job.el,
          body: job.body,
        }],
      });
    };
    img.addEventListener("load", () => finish(true), { once: true });
    img.addEventListener("error", () => finish(false), { once: true });
    if (img.complete && img.naturalWidth > 0) finish(true);
  }

  function pump() {
    if (pumping) return;
    pumping = true;
    const step = () => {
      let empty = 0;
      const runEmpty = () => {
        while (queue.length && empty < 30) {
          const job = queue.shift();
          const platform = platformOf(job.conversationId);
          const found = collectContentImages(job.el, {
            platform,
            role: job.role,
            messageId: job.messageId,
          });
          for (const item of found) {
            if (!item.ready) watchUntilPainted(job, item.img);
          }
          if (found.some((item) => item.ready)) {
            Promise.resolve()
              .then(() => processJob(job))
              .catch(() => {})
              .then(() => { setTimeout(step, 40); });
            return;
          }
          empty += 1;
        }
        if (queue.length) setTimeout(step, 0);
        else pumping = false;
      };
      try {
        runEmpty();
      } catch {
        pumping = false;
        if (queue.length) setTimeout(step, 40);
      }
    };
    setTimeout(step, 0);
  }

  function scheduleMessageImages({ conversationId, items } = {}) {
    if (!conversationId || !items?.length) return;
    const prompts = new Map();
    let lastUser = "";
    for (const item of items) {
      if (!item?.messageId) continue;
      if (item.role === "user" && item.body) lastUser = clip(item.body, 1000);
      prompts.set(item.messageId, item.role === "user" ? clip(item.body, 1000) : lastUser);
    }
    const fresh = new Map();
    for (const item of items) {
      if (!item?.messageId || !item.el) continue;
      fresh.set(item.messageId, item);
    }
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (fresh.has(queue[i].messageId)) queue.splice(i, 1);
    }
    for (const item of fresh.values()) {
      queue.push({
        conversationId,
        messageId: item.messageId,
        role: item.role || "",
        el: item.el,
        body: String(item.body || ""),
        prompt: prompts.get(item.messageId) || "",
      });
    }
    pump();
  }

  Chatseek.collectContentImages = collectContentImages;
  Chatseek.encodeContentImage = encodeContentImage;
  Chatseek.imageTextOffset = imageTextOffset;
  Chatseek.scheduleMessageImages = scheduleMessageImages;
})();
