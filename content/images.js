/* Thumbnails from images the page has already painted. No new loads. */
(() => {
  const MAX_EDGE = 512;
  const MAX_BYTES = 150 * 1024;
  const QUALITIES = [0.82, 0.66, 0.48, 0.32, 0.2];
  const MIN_EDGE = 64;

  const queue = [];
  const done = new Map();
  const waiting = new WeakSet();
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

  /**
   * Platform image DOM, scoped to one message (plus Claude's upload row).
   * ChatGPT: img inside the turn. Generated and uploaded pictures are img;
   * avatars and toolbar marks are small or classed as avatar/icon.
   * Claude: user uploads only, including the sibling row just before the
   * user bubble. Artifact frames are not opened and not searched.
   * Gemini: img under user-query / model-response, including generated-image
   * and single-image. Header marks sit outside the message.
   * Grok: img / figure img inside the message bubble.
   */
  function searchRoots(el, platform) {
    const roots = [el];
    if (platform !== "claude" || !el) return roots;
    let sib = el.previousElementSibling;
    let steps = 0;
    while (sib && steps < 3) {
      const testId = (sib.getAttribute?.("data-testid") || "").toLowerCase();
      if (testId.includes("assistant") || testId.includes("ai-message")) break;
      if (sib.querySelector?.("iframe, [data-testid*='artifact' i]")) break;
      roots.push(sib);
      sib = sib.previousElementSibling;
      steps += 1;
    }
    return roots;
  }

  function listedImages(root) {
    const out = [];
    if (!root || root.nodeType !== 1 || !root.querySelectorAll) return out;
    let nodes = [];
    try {
      nodes = [...root.querySelectorAll("img")];
    } catch {
      nodes = [];
    }
    for (const img of nodes) out.push(img);
    let all = [];
    try {
      all = [...root.querySelectorAll("*")];
    } catch {
      all = [];
    }
    for (const node of all) {
      if (!node.shadowRoot || node.tagName === "IFRAME") continue;
      try {
        node.shadowRoot.querySelectorAll("img").forEach((img) => out.push(img));
      } catch {
        // A closed root is not readable. Leave it.
      }
    }
    return out;
  }

  function blocked(img, platform) {
    if (!img || img.tagName !== "IMG") return true;
    if (img.closest?.(
      "iframe, nav, header, footer, [role='navigation'], svg, " +
      "[data-testid*='artifact' i], [class*='artifact' i]",
    )) return true;
    const blob = `${classText(img)} ${classText(img.parentElement)}`.toLowerCase();
    if (/avatar|profile|logo|emoji|\bicon\b/.test(blob)) return true;
    const alt = (img.getAttribute?.("alt") || "").trim();
    if (/^(user|assistant|chatgpt|claude|grok|gemini)$/i.test(alt)) return true;
    if (platform === "claude" && img.closest?.(
      "[data-testid='assistant-message'], [data-testid='ai-message'], .font-claude-message",
    )) return true;
    if (!img.complete || !(img.naturalWidth > 0) || !(img.naturalHeight > 0)) return "later";
    if (Math.max(img.naturalWidth, img.naturalHeight) < MIN_EDGE) return true;
    return false;
  }

  function collectContentImages(el, { platform, role } = {}) {
    if (!el || el.nodeType !== 1) return [];
    if (platform === "claude" && role !== "user") return [];
    const seen = new Set();
    const ready = [];
    for (const root of searchRoots(el, platform)) {
      for (const img of listedImages(root)) {
        if (seen.has(img)) continue;
        seen.add(img);
        const why = blocked(img, platform);
        if (why === true) continue;
        ready.push({ img, ready: why !== "later" });
        if (ready.length >= 24) return ready;
      }
    }
    return ready;
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob((blob) => resolve(blob || null), type, quality);
      } catch (err) {
        reject(err);
      }
    });
  }

  function isSecurity(err) {
    const name = err?.name || "";
    return name === "SecurityError" || /SecurityError/.test(String(err || ""));
  }

  async function encodeContentImage(img, hooks) {
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
      ctx.drawImage(img, 0, 0, width, height);
      if (typeof ctx.getImageData === "function") ctx.getImageData(0, 0, 1, 1);
    } catch (err) {
      if (isSecurity(err)) return { status: "uncached" };
      return { status: "uncached" };
    }
    let produced = false;
    for (const type of ["image/webp", "image/jpeg"]) {
      for (const quality of QUALITIES) {
        let blob = null;
        try {
          blob = hooks?.toBlob
            ? await hooks.toBlob(canvas, type, quality)
            : await canvasToBlob(canvas, type, quality);
        } catch (err) {
          if (isSecurity(err)) return { status: "uncached" };
          return { status: "uncached" };
        }
        if (!blob) continue;
        produced = true;
        const size = Number(blob.size ?? blob.byteLength) || 0;
        if (size > MAX_BYTES) continue;
        let bytes;
        try {
          bytes = hooks?.blobBytes ? await hooks.blobBytes(blob) : await blob.arrayBuffer();
        } catch (err) {
          if (isSecurity(err)) return { status: "uncached" };
          return { status: "omit" };
        }
        const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
        if (!view || view.byteLength > MAX_BYTES || view.byteLength < 1) continue;
        return { status: "cached", mime: type, width, height, bytes: view.buffer || view };
      }
    }
    if (!produced) return { status: "uncached" };
    return { status: "omit" };
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

  async function processJob(job) {
    const platform = platformOf(job.conversationId);
    const found = collectContentImages(job.el, { platform, role: job.role });
    let worked = false;
    for (let index = 0; index < found.length; index += 1) {
      const item = found[index];
      if (!item.ready) continue;
      const img = item.img;
      const fp = `${img.naturalWidth}x${img.naturalHeight}:${clip(img.getAttribute?.("alt"), 80)}`;
      const key = `${job.messageId}:${index}`;
      if (done.get(key) === fp) continue;
      const encoded = await encodeContentImage(img);
      if (encoded.status === "pending") continue;
      if (encoded.status === "omit") {
        done.set(key, fp);
        continue;
      }
      const record = {
        messageId: job.messageId,
        index,
        alt: clip(img.getAttribute?.("alt"), 500),
        prompt: clip(job.prompt, 1000),
        offset: imageTextOffset(job.el, img, job.body),
        status: encoded.status === "cached" ? "cached" : "uncached",
        mime: encoded.mime || "",
        width: encoded.width || 0,
        height: encoded.height || 0,
        bytes: encoded.status === "cached" ? encoded.bytes : null,
      };
      const res = await Chatseek.send({
        type: "CAPTURE_IMAGES",
        conversationId: job.conversationId,
        images: [record],
      });
      if (res?.ok) done.set(key, fp);
      worked = true;
    }
    return worked;
  }

  function watchUntilPainted(job, img) {
    if (!img || waiting.has(img) || typeof img.addEventListener !== "function") return;
    waiting.add(img);
    img.addEventListener("load", () => {
      waiting.delete(img);
      scheduleMessageImages({
        conversationId: job.conversationId,
        items: [{
          messageId: job.messageId,
          role: job.role,
          el: job.el,
          body: job.body,
        }],
      });
    }, { once: true });
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
          const found = collectContentImages(job.el, { platform, role: job.role });
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
