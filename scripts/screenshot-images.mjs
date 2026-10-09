#!/usr/bin/env node
/**
 * Example-data screenshots for the 1.6.0 image cache.
 * Does not log into ChatGPT, Claude, Grok, or Gemini.
 *
 *   node scripts/screenshot-images.mjs
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const id = "12121212-1212-4121-8121-121212121212";
const convId = `chatgpt:${id}`;

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function startServer() {
  const bootstrap = `<!DOCTYPE html>
<meta charset="utf-8" />
<script type="module">
import { upsertMessages, saveImageRecords } from "/src/db.js";
const conv = {
  id: ${JSON.stringify(convId)},
  platform: "chatgpt",
  platformId: ${JSON.stringify(id)},
  title: "清水寺的秋天",
  url: ${JSON.stringify(`https://chatgpt.com/c/${id}`)},
  updatedAt: Date.now() - 3600000,
  updatedAtSource: "page-exact",
};
const userId = conv.id + ":u";
const botId = conv.id + ":a";
await upsertMessages(conv, [
  { id: userId, role: "user", body: "畫一座京都清水寺，秋天的紅葉剛轉紅。" },
  { id: botId, role: "assistant", body: "這是清水寺舞台和對面山坡的紅葉。" },
], { pageMessageIds: [userId, botId], captureId: conv.id });

const canvas = document.createElement("canvas");
canvas.width = 480;
canvas.height = 320;
const ctx = canvas.getContext("2d");
const sky = ctx.createLinearGradient(0, 0, 0, 220);
sky.addColorStop(0, "#8ec6ef");
sky.addColorStop(1, "#f4e2c4");
ctx.fillStyle = sky;
ctx.fillRect(0, 0, 480, 320);
ctx.fillStyle = "#e25b45";
ctx.beginPath();
ctx.arc(390, 70, 28, 0, Math.PI * 2);
ctx.fill();
ctx.fillStyle = "#2f6b45";
ctx.beginPath();
ctx.moveTo(0, 250);
ctx.lineTo(80, 160);
ctx.lineTo(150, 230);
ctx.lineTo(230, 120);
ctx.lineTo(320, 240);
ctx.lineTo(400, 150);
ctx.lineTo(480, 230);
ctx.lineTo(480, 320);
ctx.lineTo(0, 320);
ctx.fill();
ctx.fillStyle = "#c4493a";
ctx.fillRect(70, 250, 28, 18);
ctx.fillStyle = "#f3d2a4";
ctx.fillRect(200, 200, 90, 70);
ctx.fillStyle = "#8d3b32";
ctx.beginPath();
ctx.moveTo(190, 200);
ctx.lineTo(245, 150);
ctx.lineTo(300, 200);
ctx.fill();
const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.8));
const bytes = await blob.arrayBuffer();
await saveImageRecords(conv.id, [
  {
    messageId: botId,
    index: 0,
    status: "cached",
    mime: "image/webp",
    width: 480,
    height: 320,
    bytes,
    alt: "清水寺紅葉",
    prompt: "畫一座京都清水寺，秋天的紅葉剛轉紅。",
    offset: 0,
  },
  {
    messageId: userId,
    index: 0,
    status: "uncached",
    alt: "參考照片",
    prompt: "畫一座京都清水寺，秋天的紅葉剛轉紅。",
    offset: 99,
  },
  {
    messageId: userId,
    index: 1,
    status: "oversized",
    alt: "原始大圖",
    prompt: "畫一座京都清水寺，秋天的紅葉剛轉紅。",
    offset: 99,
  },
]);
location.replace("/reader/index.html?id=" + encodeURIComponent(conv.id));
</script>`;

  const statesId = "34343434-3434-4343-8343-343434343434";
  const statesConv = `chatgpt:${statesId}`;
  const states = `<!DOCTYPE html>
<meta charset="utf-8" />
<script type="module">
import { upsertMessages, saveImageRecords, saveCaptureHealth } from "/src/db.js";
const conv = {
  id: ${JSON.stringify(statesConv)},
  platform: "chatgpt",
  platformId: ${JSON.stringify(statesId)},
  title: "四種圖片狀態",
  url: ${JSON.stringify(`https://chatgpt.com/c/${statesId}`)},
  updatedAt: Date.now() - 1200000,
  updatedAtSource: "page-exact",
};
const botId = conv.id + ":a";
const story = "清水寺的舞台伸向山坡，紅葉沿著欄杆一路排開，對面的楓樹剛轉成深紅。".repeat(6);
await upsertMessages(conv, [
  { id: conv.id + ":u", role: "user", body: "畫一座京都清水寺，秋天的紅葉剛轉紅。" },
  { id: botId, role: "assistant", body: story },
], { pageMessageIds: [conv.id + ":u", botId], captureId: conv.id });
const canvas = document.createElement("canvas");
canvas.width = 480;
canvas.height = 320;
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#2f6b45";
ctx.fillRect(0, 0, 480, 320);
ctx.fillStyle = "#e25b45";
ctx.beginPath();
ctx.arc(360, 80, 36, 0, Math.PI * 2);
ctx.fill();
const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.8));
const bytes = await blob.arrayBuffer();
const prompt = "畫一座京都清水寺，秋天的紅葉剛轉紅。";
await saveImageRecords(conv.id, [
  { messageId: botId, index: 0, status: "cached", mime: "image/webp", width: 480, height: 320, bytes, alt: "清水寺紅葉", prompt, offset: 0 },
  { messageId: botId, index: 1, status: "uncached", alt: "參考照片", prompt, offset: 32 },
  { messageId: botId, index: 2, status: "oversized", alt: "原始大圖", prompt, offset: 64 },
  { messageId: botId, index: 3, status: "timeout", alt: "轉檔中的圖", prompt, offset: 96 },
  { messageId: botId, index: 4, status: "not-loaded", alt: "還沒載完的圖", prompt, offset: 128 },
]);
await saveCaptureHealth("chatgpt", {
  pathKind: "c",
  messageCount: 2,
  selector: "role",
  warn: false,
  at: Date.now(),
  diag: "[Chatseek] diag v=1.6.3 platform=chatgpt path=c hits=role:2 used=role user=1 assistant=1 chars=80 imgCache=1 imgHold=4 imgs=5/1/4 fail=tainted:1,too-big:1,timeout:1,not-loaded:1 health=ok err=- at=2026-10-09T00:00:00.000Z",
});
location.replace("/reader/index.html?id=" + encodeURIComponent(conv.id));
</script>`;

  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/__shot/bootstrap.html" || url.pathname === "/__shot/states.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(url.pathname.endsWith("states.html") ? states : bootstrap);
      return;
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.(\/|\\|$))+/, "");
    const file = join(root, rel);
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const { server, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--lang=zh-TW", "--hide-scrollbars", "--font-render-hinting=none"],
  });
  try {
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await page.evaluateOnNewDocument(() => {
      try {
        Object.defineProperty(navigator, "language", { get: () => "zh-TW" });
        Object.defineProperty(navigator, "languages", { get: () => ["zh-TW", "zh"] });
      } catch { /* lang flag covers a locked navigator.language */ }
      try { localStorage.setItem("chatseek.uiLocale", "zh-TW"); } catch { /* follow the browser */ }
      window.chrome = {
        i18n: { getUILanguage: () => "zh-TW" },
        tabs: {
          async query() { return []; },
          async update() {},
          async create() {},
          onActivated: { addListener() {} },
          onUpdated: { addListener() {} },
        },
        runtime: {
          onMessage: { addListener() {} },
          sendMessage() { return Promise.resolve({ focused: false }); },
          getURL(path) { return path; },
          lastError: null,
        },
        windows: { async getCurrent() { return { id: 1 }; } },
        action: { setBadgeText() { return Promise.resolve(); } },
      };
    });
    await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
    await page.goto(`${origin}/sidepanel/index.html`, { waitUntil: "networkidle0", timeout: 20000 });
    await page.waitForFunction(() => {
      const usage = document.getElementById("imageCache")?.textContent || "";
      const button = document.getElementById("clearImagesBtn");
      return usage.includes("圖片快取 0 KB") && button?.disabled === true;
    }, { timeout: 10000 });
    await page.evaluate(() => document.querySelector(".foot")?.scrollIntoView({ block: "end" }));
    const docsEarly = join(root, "docs");
    await mkdir(docsEarly, { recursive: true });
    await page.screenshot({ path: join(docsEarly, "panel-1.6.3-image-cache-zero.png"), fullPage: true });

    await page.setViewport({ width: 760, height: 920, deviceScaleFactor: 2 });
    await page.goto(`${origin}/__shot/bootstrap.html`, { waitUntil: "networkidle0", timeout: 20000 });
    await page.waitForFunction(() => {
      const thumb = document.querySelector(".cached-thumb");
      const notes = [...document.querySelectorAll(".image-missing-text")].map((node) => node.textContent || "").join("\n");
      return thumb && thumb.getAttribute("src")?.startsWith("data:image/")
        && notes.includes("原網站限制") && notes.includes("檔案過大");
    }, { timeout: 10000 });
    await page.evaluate(() => document.fonts?.ready);
    const docs = join(root, "docs");
    await mkdir(docs, { recursive: true });
    const thumbPath = join(docs, "reader-1.6.0-thumb.png");
    const placeholderPath = join(docs, "reader-1.6.0-placeholder.png");
    const panelPath = join(docs, "panel-1.6.0-image-cache.png");

    async function clipOf(selector) {
      await page.evaluate((sel) => {
        document.querySelector(sel)?.closest(".msg")?.scrollIntoView({ block: "center" });
      }, selector);
      return page.evaluate((sel) => {
        const slot = document.querySelector(sel)?.closest(".msg");
        const box = slot.getBoundingClientRect();
        const y = Math.max(0, box.top - 8);
        const height = Math.min(920 - y, Math.ceil(box.height + 10));
        return { x: 16, y, width: 728, height: Math.max(80, height) };
      }, selector);
    }
    await page.screenshot({ path: thumbPath, clip: await clipOf(".cached-thumb") });
    await page.screenshot({ path: placeholderPath, clip: await clipOf(".image-missing") });

    await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
    await page.goto(`${origin}/sidepanel/index.html`, { waitUntil: "networkidle0", timeout: 20000 });
    await page.waitForFunction(() => {
      const usage = document.getElementById("imageCache")?.textContent || "";
      const button = document.getElementById("clearImagesBtn")?.textContent || "";
      return /圖片快取\s+\d/.test(usage) && button === "清除圖片快取";
    }, { timeout: 10000 });
    await page.evaluate(() => document.querySelector(".foot")?.scrollIntoView({ block: "end" }));
    const footClip = await page.evaluate(() => {
      const foot = document.querySelector(".foot");
      const box = foot.getBoundingClientRect();
      const y = Math.max(0, box.top - 8);
      return {
        x: 0,
        y,
        width: 420,
        height: Math.min(860 - y, Math.ceil(box.height + 16)),
      };
    });
    await page.screenshot({ path: panelPath, clip: footClip });

    await page.setViewport({ width: 760, height: 1100, deviceScaleFactor: 2 });
    await page.goto(`${origin}/__shot/states.html`, { waitUntil: "networkidle0", timeout: 20000 });
    await page.waitForFunction(() => {
      const notes = [...document.querySelectorAll(".image-missing-text")].map((node) => node.textContent || "").join("\n");
      const thumb = document.querySelector(".cached-thumb");
      return thumb?.getAttribute("src")?.startsWith("data:image/")
        && notes.includes("原網站限制")
        && notes.includes("檔案過大")
        && notes.includes("轉檔逾時")
        && notes.includes("圖還沒載完");
    }, { timeout: 10000 });
    await page.evaluate(() => document.fonts?.ready);
    const statesReader = join(docs, "reader-1.6.3-placeholders.png");
    const statesThumb = join(docs, "reader-1.6.3-thumb.png");
    await page.screenshot({ path: statesReader, fullPage: true });
    await page.screenshot({ path: statesThumb, clip: await clipOf(".cached-thumb") });

    await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
    await page.goto(`${origin}/sidepanel/index.html`, { waitUntil: "networkidle0", timeout: 20000 });
    await page.waitForFunction(() => {
      const usage = document.getElementById("imageCache")?.textContent || "";
      const button = document.getElementById("clearImagesBtn");
      return /圖片快取\s+\d/.test(usage) && !usage.includes("0 KB") && button && button.disabled === false;
    }, { timeout: 10000 });
    await page.evaluate(() => document.querySelector(".foot")?.scrollIntoView({ block: "end" }));
    const cachePath = join(docs, "panel-1.6.3-image-cache.png");
    await page.screenshot({ path: cachePath, fullPage: true });
    await page.evaluate(() => {
      if (navigator.clipboard) navigator.clipboard.writeText = () => Promise.reject(new Error("denied"));
    });
    await page.click("#copyDiagBtn");
    await page.waitForFunction(() => {
      const box = document.getElementById("diagBox");
      return box && !box.hidden && /imgs=5\/1\/4 fail=tainted:1,too-big:1,timeout:1,not-loaded:1/.test(box.value || "");
    }, { timeout: 10000 });
    const diagPath = join(docs, "panel-1.6.3-diag-imgs.png");
    await page.screenshot({ path: diagPath, fullPage: true });
    console.log("screenshots", { thumbPath, placeholderPath, panelPath, statesReader, statesThumb, cachePath, diagPath, zero: join(docs, "panel-1.6.3-image-cache-zero.png") });
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
