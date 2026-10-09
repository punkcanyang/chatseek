#!/usr/bin/env node
// Side-panel list open time with 3000 title-only conversations.
// Usage: node scripts/list-bench.mjs [checkout ...]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = process.argv.slice(2).length ? process.argv.slice(2).map((p) => resolve(p)) : [here];
const chrome = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium"].find((path) => path && existsSync(path));
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png" };

function bootstrap() {
  const rows = Array.from({ length: 3000 }, (_, i) => ({
    id: `chatgpt:list-${i}`,
    platform: "chatgpt",
    platformId: `list-${i}`,
    title: `List row ${i}`,
    url: `https://chatgpt.com/c/list-${i}`,
    updatedAt: 1_700_000_000_000 + i * 1000,
    updatedAtSource: "page-exact",
    messageCount: 0,
  }));
  return `<!DOCTYPE html><meta charset="utf-8"><script type="module">
import { upsertConversations } from "/src/db.js";
const rows = ${JSON.stringify(rows)};
for (let i = 0; i < rows.length; i += 200) await upsertConversations(rows.slice(i, i + 200));
location.replace("/sidepanel/index.html");
</script>`;
}

async function serve(root) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path === "/bootstrap.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(bootstrap());
      return;
    }
    try {
      const file = await readFile(join(root, path));
      res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" });
      res.end(file);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
try {
  for (const root of roots) {
    const runs = [];
    for (let run = 0; run < 3; run += 1) {
      const server = await serve(root);
      const tab = await browser.newPage();
      await tab.setViewport({ width: 360, height: 800 });
      await tab.evaluateOnNewDocument(() => {
        window.__panelMark = performance.now();
        window.chrome = {
          tabs: {
            async query() { return [{ id: 1, active: true, url: "https://example.com/" }]; },
            async update() {},
            async create() {},
            onActivated: { addListener() {} },
            onUpdated: { addListener() {} },
          },
          runtime: { onMessage: { addListener() {} }, sendMessage() {}, getURL: (path) => path },
          action: { setBadgeText() { return Promise.resolve(); } },
          i18n: { getUILanguage: () => "en" },
        };
      });
      const port = server.address().port;
      await tab.goto(`http://127.0.0.1:${port}/bootstrap.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await tab.waitForFunction(() => location.pathname.includes("sidepanel") && document.querySelectorAll("#list .item").length >= 80, { timeout: 30000 });
      const openMs = await tab.evaluate(() => Math.round(performance.now() - window.__panelMark));
      const frames = [];
      const list = await tab.$("#list");
      const height = await tab.evaluate(() => document.body.scrollHeight);
      for (let y = 0; y < height; y += 400) {
        const s = Date.now();
        await tab.evaluate((top) => { window.scrollTo(0, top); }, y);
        frames.push(Date.now() - s);
      }
      frames.sort((a, b) => a - b);
      runs.push({
        openMs,
        rows: await tab.$$eval("#list .item", (nodes) => nodes.length),
        scrollP95: frames[Math.floor(frames.length * 0.95)] || 0,
      });
      await tab.close();
      server.close();
      void list;
    }
    const median = (key) => runs.map((row) => row[key]).sort((a, b) => a - b)[1];
    console.log(root, { rows: runs[0].rows, openMs: median("openMs"), scrollP95: median("scrollP95"), runs });
  }
} finally {
  await browser.close();
}
