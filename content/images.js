/* Thumbnails from images the page has already painted. No new loads. */
(() => {
  const MAX_EDGE = 512;
  const MAX_BYTES = 150 * 1024;
  const QUALITIES = [0.82, 0.66, 0.48, 0.32, 0.2];
  const MIN_EDGE = 48;
  const BLOB_TIMEOUT_MS = 1500;
  const MAX_TRIES = 4;
  const CLAUDE_MESSAGE = [
    "[data-testid='user-message']",
    "[data-testid='human-message']",
    "[data-testid='assistant-message']",
    "[data-testid='ai-message']",
    ".font-claude-message",
  ].join(", ");

  const queue = [];
  const done = new Map();
  const outcomes = {
    conversationId: "",
    detected: 0,
    cached: 0,
    placeholder: 0,
    fail: { tainted: 0, tooBig: 0, timeout: 0, notLoaded: 0 },
  };
  const statusOf = new Map();
  const waiting = new WeakSet();
  // An <img> node belongs to the first message that claimed it.
  const ownerOf = new WeakMap();
  const tries = new Map();
  let pumping = false;

  function inChildFrame() {
    try {
      if (typeof window === "undefined" || !window.top) return false;
      return window.top !== window;
    } catch {
      // A cross-origin frame cannot read window.top. The top frame owns the scan.
      return true;
    }
  }

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
    ownerOf.set(img, messageId);
    return true;
  }

  // A nested frame's own message is the closer host. The outer message must
  // not store the same pixels again.
  function closerPeer(img, messageEl, peers) {
    if (!img || !messageEl || !peers) return false;
    for (const other of peers) {
      if (!other || other === messageEl) continue;
      let holds = false;
      try { holds = !!other.contains?.(img); } catch { holds = false; }
      if (!holds) continue;
      let nested = false;
      try { nested = !!messageEl.contains?.(other); } catch { nested = false; }
      const differentDoc = messageEl.ownerDocument !== other.ownerDocument;
      if (nested || differentDoc) return true;
    }
    return false;
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
  function textBesideImages(el) {
    if (!el) return "";
    try {
      const clone = el.cloneNode(true);
      clone.querySelectorAll?.("img, picture, svg, canvas").forEach((node) => node.remove());
      return String(clone.textContent || "").replace(/\s+/g, " ").trim();
    } catch {
      return String(el.textContent || "").replace(/\s+/g, " ").trim();
    }
  }

  function isArtifact(el) {
    if (!el || el.nodeType !== 1) return false;
    const blob = `${classText(el)} ${el.getAttribute?.("data-testid") || ""}`;
    return /artifact/i.test(blob);
  }

  function isChromeBox(el) {
    if (!el || el.nodeType !== 1) return true;
    if (/^(NAV|HEADER|FOOTER|FORM|TEXTAREA|INPUT)$/.test(el.tagName || "")) return true;
    const role = (el.getAttribute?.("role") || "").toLowerCase();
    return role === "navigation" || role === "contentinfo";
  }

  // Image-only rows next to a heuristic text block are not part of that block.
  function adjacentImageRoots(el, platform) {
    if (platform === "claude" || !el) return [];
    const out = [];
    for (const dir of ["previousElementSibling", "nextElementSibling"]) {
      let sib = el[dir];
      let steps = 0;
      while (sib && steps < 2) {
        if (isChromeBox(sib) || isArtifact(sib)) break;
        if (textBesideImages(sib).length >= 24) break;
        out.push(sib);
        sib = sib[dir];
        steps += 1;
      }
    }
    return out;
  }

  function searchRoots(el, platform) {
    const extra = adjacentImageRoots(el, platform);
    if (platform !== "claude" || !el) return [el, ...extra];
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

  function pushImgs(out, seen, root) {
    if (!root?.querySelectorAll) return;
    try {
      root.querySelectorAll("img").forEach((img) => {
        if (seen.has(img)) return;
        seen.add(img);
        out.push(img);
      });
    } catch {
      // A root the page will not let us read stays empty.
    }
  }

  function adoptedShadow(node) {
    if (!node || node.nodeType !== 1 || node.tagName === "IFRAME") return null;
    if (node.shadowRoot) return node.shadowRoot;
    try {
      const dom = typeof chrome !== "undefined" ? chrome.dom : null;
      return dom?.openOrClosedShadowRoot?.(node) || null;
    } catch {
      return null;
    }
  }

  // Light DOM, open shadow, closed shadow, and same-origin frames.
  // Cross-origin frames have no contentDocument; they are not fetched.
  async function collectDeepImages(root, out, seenImg, seenRoot, depth) {
    if (!root || depth > 4 || seenRoot.has(root)) return;
    seenRoot.add(root);
    pushImgs(out, seenImg, root);
    let list = [];
    try {
      list = root.querySelectorAll ? root.querySelectorAll("*") : [];
    } catch {
      list = [];
    }
    const limit = Math.min(list.length || 0, 800);
    for (let i = 0; i < limit; i += 1) {
      if (i && (i & 63) === 0 && typeof Chatseek.paceDom === "function") await Chatseek.paceDom();
      const node = list[i];
      if (!node || node.nodeType !== 1 || isArtifact(node)) continue;
      if (node.tagName === "IFRAME") {
        let doc = null;
        try { doc = node.contentDocument; } catch { doc = null; }
        const base = doc?.documentElement || doc?.body;
        if (base) await collectDeepImages(base, out, seenImg, seenRoot, depth + 1);
        continue;
      }
      const shadow = adoptedShadow(node);
      if (shadow) await collectDeepImages(shadow, out, seenImg, seenRoot, depth + 1);
    }
  }

  async function listedImages(root) {
    const out = [];
    if (!root || root.nodeType !== 1) return out;
    await collectDeepImages(root, out, new Set(), new Set(), 0);
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
      "nav, header, footer, [role='navigation'], svg, " +
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
    const inButton = !!img.closest?.("button, [role='button']");
    // Not painted yet: a placeholder now, and a later scan can fill it in.
    // A finished image with no pixels is decorative or broken, not a picture.
    if (!img.complete) {
      if (inButton && /avatar|profile|logo|emoji|\bicon\b|copy/.test(`${blob} ${alt}`)) return true;
      return "later";
    }
    if (!(img.naturalWidth > 0) || !(img.naturalHeight > 0)) return true;
    if (Math.max(img.naturalWidth, img.naturalHeight) < MIN_EDGE) return true;
    return false;
  }

  async function collectContentImages(el, { platform, role, messageId = "", peers = null, allowImage = null } = {}) {
    if (!el || el.nodeType !== 1) return [];
    if (platform === "claude" && role !== "user") return [];
    const seen = new Set();
    const localSrc = new Set();
    const ready = [];
    for (const root of searchRoots(el, platform)) {
      for (const img of await listedImages(root)) {
        if (seen.has(img)) continue;
        seen.add(img);
        const why = blocked(img, platform);
        if (why === true) continue;
        if (closerPeer(img, el, peers)) continue;
        if (allowImage && !allowImage(img)) continue;
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
        if (blob === BLOB_TIMEOUT) return { status: "timeout" };
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

  function byteList(value) {
    let view = null;
    if (value instanceof ArrayBuffer) view = new Uint8Array(value);
    else if (ArrayBuffer.isView(value)) view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    // A number list survives structured clone. An ArrayBuffer arrives empty.
    // 150KB of bytes is the cap; the list is one image, then it can be dropped.
    if (!view || view.byteLength < 1 || view.byteLength > MAX_BYTES) return null;
    return Array.from(view);
  }

  function storedStatus(encoded) {
    if (encoded?.status === "cached" || encoded?.status === "oversized" || encoded?.status === "uncached") {
      return encoded.status;
    }
    if (encoded?.status === "timeout" || encoded?.status === "not-loaded") return encoded.status;
    return "";
  }

  function failBucket(status) {
    if (status === "uncached") return "tainted";
    if (status === "oversized") return "tooBig";
    if (status === "timeout") return "timeout";
    if (status === "not-loaded") return "notLoaded";
    return "";
  }

  function noteOutcome(conversationId, countKey, status) {
    if (outcomes.conversationId !== conversationId) {
      outcomes.conversationId = conversationId;
      outcomes.detected = 0;
      outcomes.cached = 0;
      outcomes.placeholder = 0;
      outcomes.fail = { tainted: 0, tooBig: 0, timeout: 0, notLoaded: 0 };
      statusOf.clear();
    }
    const prev = statusOf.get(countKey) || "";
    if (prev === status) return;
    if (prev) {
      outcomes.detected -= 1;
      if (prev === "cached") outcomes.cached -= 1;
      else outcomes.placeholder -= 1;
      const prevBucket = failBucket(prev);
      if (prevBucket) outcomes.fail[prevBucket] -= 1;
    }
    statusOf.set(countKey, status);
    outcomes.detected += 1;
    if (status === "cached") outcomes.cached += 1;
    else outcomes.placeholder += 1;
    const bucket = failBucket(status);
    if (bucket) outcomes.fail[bucket] += 1;
    try { Chatseek.refreshImageDiag(); } catch { /* diag must not break images */ }
  }

  function currentHref() {
    return typeof location !== "undefined" ? location.href : document?.location?.href || "";
  }

  function currentJob(job) {
    try {
      return (!job.captureHref || currentHref() === job.captureHref) &&
        job.el?.isConnected !== false && (!job.isCurrent || job.isCurrent()) &&
        Chatseek.safeDomText(job.el, job.role === "user").text === job.domText;
    } catch { return false; }
  }

  function imageSource(img) {
    return JSON.stringify([img.getAttribute?.("src") || "", img.getAttribute?.("srcset") || "",
      [...(img.parentElement?.tagName === "PICTURE" ? img.parentElement.querySelectorAll("source") : [])]
        .map(source => [source.getAttribute("srcset"), source.getAttribute("media")])]);
  }

  // Freeze which pictures were present when the message was accepted. The
  // queued scan may yield or run after a reused host has acquired new images.
  function imageSnapshot(el, platform) {
    const images = new Map();
    const seen = new Set();
    const visit = (root, depth) => {
      if (!root || depth > 4 || seen.has(root)) return;
      seen.add(root);
      root.querySelectorAll?.("img").forEach(img => images.set(img, {
        source: imageSource(img), currentSrc: img.currentSrc || "",
      }));
      const nodes = root.querySelectorAll?.("*") || [];
      for (let i = 0; i < Math.min(nodes.length, 800); i += 1) {
        const node = nodes[i];
        if (isArtifact(node)) continue;
        if (node.tagName === "IFRAME") {
          try { visit(node.contentDocument?.documentElement, depth + 1); } catch { /* inaccessible frame */ }
        } else visit(adoptedShadow(node), depth + 1);
      }
    };
    for (const root of searchRoots(el, platform)) visit(root, 0);
    return images;
  }

  function currentImage(job, img) {
    const initial = job.images.get(img);
    return !!initial && img.isConnected !== false && initial.source === imageSource(img) &&
      (!initial.currentSrc || initial.currentSrc === img.currentSrc);
  }

  async function processJob(job, found) {
    if (!currentJob(job)) return false;
    const platform = platformOf(job.conversationId);
    if (!found) {
      found = await collectContentImages(job.el, {
        platform,
        role: job.role,
        messageId: job.messageId,
        peers: job.peers,
        allowImage: img => currentJob(job) && currentImage(job, img),
      });
    }
    let worked = false;
    for (let index = 0; index < found.length; index += 1) {
      if (!currentJob(job)) return false;
      const item = found[index];
      const img = item.img;
      if (!currentImage(job, img)) continue;
      const key = `${job.messageId}:${index}`;
      const prev = String(done.get(key) || "");
      if (prev.endsWith(":stop") || (tries.get(key) || 0) >= MAX_TRIES) continue;
      if (!item.ready) {
        if (prev === "not-loaded") continue;
        await storeImage(job, img, index, { status: "not-loaded" }, "not-loaded");
        continue;
      }
      const fpBase = `${img.naturalWidth}x${img.naturalHeight}`;
      if (prev.startsWith(`${fpBase}:`)) continue;
      if (worked) await yieldToBrowser();
      let encoded;
      try {
        encoded = await encodeContentImage(img);
      } catch {
        encoded = { status: "uncached" };
      }
      if (encoded.status === "pending") {
        await storeImage(job, img, index, { status: "not-loaded" }, "not-loaded");
        continue;
      }
      const status = storedStatus(encoded);
      if (!status) continue;
      await storeImage(job, img, index, encoded, `${fpBase}:${status}`);
      worked = true;
    }
    return worked;
  }

  async function storeImage(job, img, index, encoded, fp) {
    // Collection, idle painting and canvas encoding all yield. A job from
    // another page must not store a newly reused host's images or metadata.
    if (!currentJob(job) || !currentImage(job, img)) return;
    const key = `${job.messageId}:${index}`;
    const status = storedStatus(encoded);
    if (!status) return;
    const preset = job.offsets && typeof job.offsets.get === "function" && job.offsets.has(img)
      ? job.offsets.get(img)
      : null;
    const record = {
      messageId: job.messageId,
      index,
      alt: clip(img.getAttribute?.("alt"), 500),
      prompt: clip(job.prompt, 1000),
      offset: Number.isFinite(preset) ? preset : imageTextOffset(job.el, img, job.body),
      status,
      mime: encoded.mime || "",
      width: encoded.width || 0,
      height: encoded.height || 0,
      // A raw ArrayBuffer arrives in the service worker as an empty object.
      bytes: status === "cached" ? byteList(encoded.bytes) : null,
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
    if (res?.error === "quota") {
      done.set(key, `${fp}:stop`);
      return;
    }
    if (!res?.ok || !(res.saved > 0)) {
      const n = (tries.get(key) || 0) + 1;
      tries.set(key, n);
      if (n >= MAX_TRIES) done.set(key, `${fp}:stop`);
      return;
    }
    tries.delete(key);
    done.set(key, fp);
    noteOutcome(job.conversationId, `${job.conversationId}:${key}`, status);
  }

  function watchUntilPainted(job, img) {
    if (!currentJob(job) || !img || !currentImage(job, img) || waiting.has(img) || typeof img.addEventListener !== "function") return;
    if (img.complete) return;
    waiting.add(img);
    let settled = false;
    const finish = (loaded) => {
      if (settled) return;
      settled = true;
      waiting.delete(img);
      if (!loaded || !currentJob(job) || !currentImage(job, img)) return;
      scheduleMessageImages({
        conversationId: job.conversationId,
        captureHref: job.captureHref,
        isCurrent: job.isCurrent,
        items: [{
          messageId: job.messageId,
          role: job.role,
          el: job.el,
          body: job.body,
          offsets: job.offsets,
          prompt: job.prompt,
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
    const step = async () => {
      if (!queue.length) {
        pumping = false;
        return;
      }
      const job = queue.shift();
      let found = [];
      try {
        if (currentJob(job)) found = await collectContentImages(job.el, {
          platform: platformOf(job.conversationId),
          role: job.role,
          messageId: job.messageId,
          peers: job.peers,
          allowImage: img => currentJob(job) && currentImage(job, img),
        });
      } catch {
        found = [];
      }
      for (const item of found) {
        if (!item.ready) watchUntilPainted(job, item.img);
      }
      try {
        if (found.length) await processJob(job, found);
      } catch {
        // One message must not stall the rest of the queue.
      }
      if (queue.length) setTimeout(step, found.length ? 40 : 0);
      else pumping = false;
    };
    setTimeout(() => {
      step().catch(() => {
        pumping = false;
        if (queue.length) setTimeout(step, 40);
      });
    }, 0);
  }

  function scheduleMessageImages(job) {
    try {
      scheduleMessageImagesInner(job);
    } catch (err) {
      try { Chatseek.rememberError(err); } catch { /* image failures stay off the text path */ }
    }
  }

  function scheduleMessageImagesInner({ conversationId, items, isCurrent, captureHref = currentHref() } = {}) {
    if (inChildFrame()) return;
    if (!conversationId || !items?.length) return;
    const prompts = new Map();
    let lastUser = "";
    for (const item of items) {
      if (!item?.messageId) continue;
      if (item.role === "user" && item.body) lastUser = clip(item.body, 1000);
      const carried = typeof item.prompt === "string" ? clip(item.prompt, 1000) : "";
      prompts.set(item.messageId, carried || (item.role === "user" ? clip(item.body, 1000) : lastUser));
    }
    const fresh = new Map();
    for (const item of items) {
      if (!item?.messageId || !item.el) continue;
      fresh.set(item.messageId, item);
    }
    const peers = [...fresh.values()].map((item) => item.el);
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (fresh.has(queue[i].messageId)) queue.splice(i, 1);
    }
    for (const item of fresh.values()) {
      queue.push({
        conversationId,
        captureHref,
        isCurrent,
        messageId: item.messageId,
        role: item.role || "",
        el: item.el,
        body: String(item.body || ""),
        offsets: item.offsets || null,
        domText: Chatseek.safeDomText(item.el, item.role === "user").text,
        images: imageSnapshot(item.el, platformOf(conversationId)),
        prompt: prompts.get(item.messageId) || "",
        peers,
      });
    }
    pump();
  }

  Chatseek.imageDiagCounts = () => ({
    detected: outcomes.detected,
    cached: outcomes.cached,
    placeholder: outcomes.placeholder,
    fail: {
      tainted: outcomes.fail.tainted,
      tooBig: outcomes.fail.tooBig,
      timeout: outcomes.fail.timeout,
      notLoaded: outcomes.fail.notLoaded,
    },
  });
  Chatseek.collectContentImages = collectContentImages;
  Chatseek.encodeContentImage = encodeContentImage;
  Chatseek.imageTextOffset = imageTextOffset;
  Chatseek.scheduleMessageImages = scheduleMessageImages;
})();
