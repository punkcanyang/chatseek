// Reader timing in real Chrome: 3000 Markdown-heavy messages, a search that
// hits many of them, every hit jump, and a scroll from top to bottom.
// Usage: node scripts/reader-bench.mjs [checkout ...]
// Pass another checkout (for example a worktree of main) to compare.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = process.argv.slice(2).length ? process.argv.slice(2).map((p) => resolve(p)) : [here];
const chrome = ["/usr/local/bin/google-chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
const QUERY = process.env.BENCH_QUERY || "maple";
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };

function body(i) {
  const word = i % 10 === 0 ? "maple" : "tea";
  return [
    `# Day ${i}`,
    "",
    `We walk to the **${word}** garden and *rest*.`,
    "",
    "- temple",
    "- path",
    "  - indoor",
    "",
    "> a quiet seat",
    "",
    "Shop `cafe`",
    "",
    "```js",
    `${"x".repeat(60)} const v = ${i}; // ${word}`,
    "```",
    "",
    "| day | plan |",
    "| --- | --- |",
    `| ${i} | ${word} |`,
    "",
    `[site](https://example.com/${i})`,
  ].join("\n");
}

const page = (root) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/reader/reader.css"></head><body><div id="app"></div>
<script type="module">
import { mountReader } from "/src/reader-view.js";
const messages = ${JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ id: "m" + i, role: i % 2 ? "assistant" : "user", body: body(i) })))};
const conversation = { id: "chatgpt:bench", platform: "chatgpt", title: "bench", url: "https://chatgpt.com/c/bench", updatedAt: Date.now(), messageCount: 3000 };
const app = document.getElementById("app");
const t0 = performance.now();
const view = mountReader(app, { locale: "en", conversation, messages, query: ${JSON.stringify(QUERY)} });
await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const mount = performance.now() - t0;
const t1 = performance.now();
const jumps = Math.min(200, view.hitCount() - 1);
for (let i = 0; i < jumps; i++) view.next();
const jump = (performance.now() - t1) / Math.max(1, jumps);
const thread = document.getElementById("thread");
thread.scrollTop = 0;
await new Promise((r) => requestAnimationFrame(r));
const frames = [];
const step = Math.max(200, Math.floor(thread.clientHeight * 0.9));
for (let y = 0; y < thread.scrollHeight; y += step) {
  const s = performance.now();
  thread.scrollTop = y;
  thread.dispatchEvent(new Event("scroll"));
  void thread.offsetHeight;
  frames.push(performance.now() - s);
  await new Promise((r) => requestAnimationFrame(r));
}
frames.sort((a, b) => a - b);
window.__bench = {
  hits: view.hitCount(),
  mountMs: Math.round(mount),
  jumpMs: +jump.toFixed(2),
  scrollSteps: frames.length,
  scrollP50: +frames[Math.floor(frames.length * 0.5)].toFixed(1),
  scrollP95: +frames[Math.floor(frames.length * 0.95)].toFixed(1),
  scrollMax: +frames[frames.length - 1].toFixed(1),
  mounted: document.querySelectorAll(".msg").length,
  nodes: document.querySelectorAll("*").length,
};
</script></body></html>`;

async function serve(root) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path === "/bench.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(root));
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
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server;
}

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
try {
  for (const root of roots) {
    const runs = [];
    for (let run = 0; run < 3; run++) {
      const server = await serve(root);
      const tab = await browser.newPage();
      await tab.setViewport({ width: 900, height: 900 });
      await tab.goto(`http://127.0.0.1:${server.address().port}/bench.html`);
      await tab.waitForFunction(() => window.__bench, { timeout: 60000 });
      runs.push(await tab.evaluate(() => window.__bench));
      await tab.close();
      server.close();
    }
    const median = (key) => runs.map((r) => r[key]).sort((a, b) => a - b)[1];
    console.log(root, {
      hits: runs[0].hits,
      mountMs: median("mountMs"),
      jumpMs: median("jumpMs"),
      scrollP50: median("scrollP50"),
      scrollP95: median("scrollP95"),
      scrollMax: median("scrollMax"),
      mounted: runs[0].mounted,
      nodes: runs[0].nodes,
    });
  }
} finally {
  await browser.close();
}
