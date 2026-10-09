#!/usr/bin/env node
// Open time and scroll p95 for 500 cached thumbnails in real Chrome.
//   node scripts/image-grid-bench.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chrome = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium"].find((path) => path && existsSync(path));
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };

const page = `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/sidepanel/panel.css">
<style>html,body{height:100%;margin:0}#grid{height:640px;width:320px}</style>
</head><body><div id="grid" class="image-grid"></div>
<script type="module">
import { saveImageRecords, upsertMessages, listImageCards, readImageBytes } from "/src/db.js";
import { filterImageCards, mountImageGrid, thumbUrl } from "/src/image-grid.js";
const canvas = document.createElement("canvas");
canvas.width = 96;
canvas.height = 64;
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#2f6b45";
ctx.fillRect(0, 0, 96, 64);
ctx.fillStyle = "#e25b45";
ctx.fillRect(8, 8, 40, 24);
const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.7));
const bytes = new Uint8Array(await blob.arrayBuffer());
const conv = {
  id: "chatgpt:bench-images",
  platform: "chatgpt",
  platformId: "bench-images",
  title: "bench",
  url: "https://chatgpt.com/c/bench-images",
  updatedAt: Date.now(),
  updatedAtSource: "observed",
};
const messages = Array.from({ length: 250 }, (_, i) => ({
  id: "chatgpt:bench-images:m" + i,
  role: i % 2 ? "assistant" : "user",
  body: "turn " + i,
}));
await upsertMessages(conv, messages, { pageMessageIds: messages.map((msg) => msg.id), captureId: conv.id });
const images = [];
for (let i = 0; i < 250; i += 1) {
  images.push({ messageId: messages[i].id, index: 0, status: "cached", mime: "image/webp", width: 96, height: 64, bytes, offset: 0 });
  images.push({ messageId: messages[i].id, index: 1, status: "cached", mime: "image/webp", width: 96, height: 64, bytes, offset: 4 });
}
for (let i = 0; i < images.length; i += 40) {
  await saveImageRecords(conv.id, images.slice(i, i + 40));
}
const t0 = performance.now();
const cards = filterImageCards(await listImageCards(), {});
const grid = document.getElementById("grid");
mountImageGrid(grid, {
  cards,
  locale: "en",
  width: 320,
  viewHeight: 640,
  async loadThumb(card) {
    const rec = await readImageBytes(card.messageId, card.index);
    if (!rec?.blob) return null;
    return thumbUrl(rec.blob, rec.mime);
  },
});
await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
await Promise.all([...grid.querySelectorAll(".shot-img")].map((img) => img.decode ? img.decode().catch(() => {}) : Promise.resolve()));
const openMs = performance.now() - t0;
const frames = [];
const step = 280;
const total = grid.scrollHeight;
for (let y = 0; y < total; y += step) {
  const s = performance.now();
  grid.scrollTop = y;
  grid.dispatchEvent(new Event("scroll"));
  void grid.offsetHeight;
  frames.push(performance.now() - s);
  await new Promise((resolve) => requestAnimationFrame(resolve));
}
frames.sort((a, b) => a - b);
const mounted = grid.querySelectorAll(".shot").length;
window.__bench = {
  cards: cards.length,
  openMs: Math.round(openMs),
  scrollSteps: frames.length,
  scrollP50: +frames[Math.floor(frames.length * 0.5)].toFixed(1),
  scrollP95: +frames[Math.floor(frames.length * 0.95)].toFixed(1),
  scrollMax: +frames[frames.length - 1].toFixed(1),
  mounted,
};
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/bench.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
    return;
  }
  try {
    const file = await readFile(join(here, path));
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
try {
  const runs = [];
  for (let run = 0; run < 3; run += 1) {
    const tab = await browser.newPage();
    await tab.setViewport({ width: 360, height: 800 });
    await tab.goto(`http://127.0.0.1:${server.address().port}/bench.html?run=${run}`);
    await tab.waitForFunction(() => window.__bench, { timeout: 60000 });
    runs.push(await tab.evaluate(() => window.__bench));
    await tab.close();
  }
  const median = (key) => runs.map((row) => row[key]).sort((a, b) => a - b)[1];
  console.log({
    cards: runs[0].cards,
    openMs: median("openMs"),
    scrollP50: median("scrollP50"),
    scrollP95: median("scrollP95"),
    scrollMax: median("scrollMax"),
    mounted: runs[0].mounted,
    runs,
  });
} finally {
  await browser.close();
  server.close();
}
