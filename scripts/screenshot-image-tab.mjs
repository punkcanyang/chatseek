#!/usr/bin/env node
/**
 * Example-data screenshots for the 1.6.5 image tab.
 * Does not log into ChatGPT, Claude, Grok, or Gemini.
 *
 *   node scripts/screenshot-image-tab.mjs
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const chrome = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const now = Date.now();
const hour = 3600000;

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function startServer() {
  const bootstrap = `<!DOCTYPE html><meta charset="utf-8" />
<script type="module">
import { upsertMessages, saveImageRecords } from "/src/db.js";

function paint(draw) {
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 320;
  const ctx = canvas.getContext("2d");
  draw(ctx, canvas);
  return new Promise((resolve) => canvas.toBlob(async (blob) => {
    resolve(new Uint8Array(await blob.arrayBuffer()));
  }, "image/webp", 0.8));
}

const temple = await paint((ctx) => {
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
  ctx.moveTo(0, 250); ctx.lineTo(80, 160); ctx.lineTo(160, 230); ctx.lineTo(240, 120);
  ctx.lineTo(330, 230); ctx.lineTo(420, 150); ctx.lineTo(480, 220); ctx.lineTo(480, 320); ctx.lineTo(0, 320);
  ctx.fill();
  ctx.fillStyle = "#f3d2a4";
  ctx.fillRect(190, 190, 110, 80);
  ctx.fillStyle = "#8d3b32";
  ctx.beginPath();
  ctx.moveTo(175, 190); ctx.lineTo(245, 140); ctx.lineTo(315, 190);
  ctx.fill();
});
const path = await paint((ctx) => {
  ctx.fillStyle = "#d7ecfb";
  ctx.fillRect(0, 0, 480, 320);
  ctx.fillStyle = "#c4493a";
  ctx.beginPath();
  ctx.arc(80, 70, 36, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#6b4a32";
  ctx.fillRect(0, 230, 480, 90);
  ctx.fillStyle = "#e7d3b0";
  ctx.beginPath();
  ctx.moveTo(40, 320); ctx.quadraticCurveTo(180, 180, 440, 320);
  ctx.fill();
});
const orchid = await paint((ctx) => {
  ctx.fillStyle = "#f7f1e8";
  ctx.fillRect(0, 0, 480, 320);
  ctx.fillStyle = "#7d9a78";
  ctx.fillRect(228, 150, 8, 140);
  ctx.fillStyle = "#c9a24d";
  ctx.beginPath();
  ctx.ellipse(200, 150, 36, 18, -0.6, 0, Math.PI * 2);
  ctx.ellipse(260, 150, 36, 18, 0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f4f7f2";
  ctx.beginPath();
  ctx.ellipse(232, 150, 14, 18, 0, 0, Math.PI * 2);
  ctx.fill();
});

const kyoto = "11111111-1111-4111-8111-111111111111";
const invoice = "22222222-2222-4222-8222-222222222222";
const flower = "a1b2c3d4e5f67890";
const chats = [
  {
    conv: {
      id: "chatgpt:" + kyoto,
      platform: "chatgpt",
      platformId: kyoto,
      title: "清水寺的秋天",
      url: "https://chatgpt.com/c/" + kyoto,
      updatedAt: ${now} - ${hour},
      updatedAtSource: "observed",
    },
    messages: [
      { id: "chatgpt:" + kyoto + ":u", role: "user", body: "畫一座京都清水寺，秋天的紅葉剛轉紅。" },
      { id: "chatgpt:" + kyoto + ":a", role: "assistant", body: "這是清水寺舞台，和通往舞台的坡道。" },
    ],
    images: [
      { messageId: "chatgpt:" + kyoto + ":u", index: 0, status: "cached", mime: "image/webp", width: 480, height: 320, bytes: temple, alt: "清水寺", offset: 0 },
      { messageId: "chatgpt:" + kyoto + ":a", index: 0, status: "cached", mime: "image/webp", width: 480, height: 320, bytes: path, alt: "坡道", offset: 0 },
      { messageId: "chatgpt:" + kyoto + ":a", index: 1, status: "uncached", alt: "原圖", offset: 8 },
    ],
  },
  {
    conv: {
      id: "claude:" + invoice,
      platform: "claude",
      platformId: invoice,
      title: "發票封面",
      url: "https://claude.ai/chat/" + invoice,
      updatedAt: ${now} - ${5 * hour},
      updatedAtSource: "page-exact",
    },
    messages: [
      { id: "claude:" + invoice + ":u", role: "user", body: "封面那張紅葉不用報銷。" },
    ],
    images: [
      { messageId: "claude:" + invoice + ":u", index: 0, status: "cached", mime: "image/webp", width: 480, height: 320, bytes: orchid, alt: "封面", offset: 0 },
    ],
  },
  {
    conv: {
      id: "gemini:" + flower,
      platform: "gemini",
      platformId: flower,
      title: "陽台蘭花",
      url: "https://gemini.google.com/app/" + flower,
      updatedAt: ${now} - ${26 * hour},
      updatedAtSource: "page-exact",
    },
    messages: [
      { id: "gemini:" + flower + ":u", role: "user", body: "這盆蝴蝶蘭的葉子發黃。" },
    ],
    images: [
      { messageId: "gemini:" + flower + ":u", index: 0, status: "uncached", alt: "蘭花", offset: 0 },
    ],
  },
];
for (const row of chats) {
  await upsertMessages(row.conv, row.messages, {
    pageMessageIds: row.messages.map((msg) => msg.id),
    captureId: row.conv.id,
  });
  await saveImageRecords(row.conv.id, row.images);
}
location.replace("/sidepanel/index.html");
</script>`;

  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/__shot/bootstrap.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(bootstrap);
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

const { server, port } = await startServer();
const origin = `http://127.0.0.1:${port}`;
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars", "--font-render-hinting=none"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 320, height: 720, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem("chatseek.uiLocale", "zh-TW"); } catch { /* panel follows the browser */ }
    window.chrome = {
      tabs: {
        async query() { return [{ id: 1, active: true, url: "https://chatgpt.com/" }]; },
        async update() {},
        async create() {},
        onActivated: { addListener() {} },
        onUpdated: { addListener() {} },
      },
      runtime: {
        onMessage: { addListener() {} },
        sendMessage() { return Promise.resolve({ focused: false }); },
        getURL(path) { return location.origin + "/" + String(path).replace(/^\//, ""); },
        lastError: null,
      },
      action: { setBadgeText() { return Promise.resolve(); } },
      i18n: { getUILanguage: () => "zh-TW" },
    };
  });
  await page.goto(`${origin}/__shot/bootstrap.html`, { waitUntil: "networkidle0", timeout: 20000 });
  await page.waitForSelector("#filterImages", { timeout: 15000 });
  await page.click("#filterImages");
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll(".shot-img")];
    return imgs.length >= 3 && imgs.every((img) => (img.getAttribute("src") || "").startsWith("data:image/"));
  }, { timeout: 10000 });
  const docs = join(root, "docs");
  await mkdir(docs, { recursive: true });
  const grid = join(docs, "panel-1.6.5-images-320.png");
  const holes = join(docs, "panel-1.6.5-uncached.png");
  const readerShot = join(docs, "reader-1.6.5-scrolled.png");
  await page.screenshot({ path: grid });
  await page.click("#showUncached");
  await page.waitForFunction(() => document.querySelector(".shot-missing")?.dataset.reason === "uncached", { timeout: 10000 });
  await page.screenshot({ path: holes });
  const kyoto = "11111111-1111-4111-8111-111111111111";
  await page.goto(`${origin}/reader/index.html?id=${encodeURIComponent("chatgpt:" + kyoto)}&m=${encodeURIComponent("chatgpt:" + kyoto + ":a")}&i=0`, {
    waitUntil: "networkidle0",
    timeout: 20000,
  });
  await page.waitForSelector(".image-slot.is-target", { timeout: 10000 });
  await page.screenshot({ path: readerShot });
  console.log("screenshots", grid, holes, readerShot);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
