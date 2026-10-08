#!/usr/bin/env node
/**
 * Example-data screenshots for 1.6.1: reader Markdown, and the side panel
 * diagnostic copy control. Does not log in.
 *
 *   node scripts/screenshot-1.6.1.mjs
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, copyFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const demo = "77777777-7777-4777-8777-777777777777";
const diag = "[Chatseek] diag v=1.6.1 platform=chatgpt path=conversation hits=[data-turn]:2,[data-message-author-role]:0 used=[data-turn] user=1 assistant=1 chars=240 imgCache=0 imgHold=0 health=ok err=- at=2026-10-08T12:00:00.000Z";

const assistant = [
  "## 行程",
  "",
  "- 清水寺",
  "  - 塔",
  "",
  "1. 第二天",
  "",
  "```python",
  'print("hi")',
  "```",
  "",
  "| 天 | 安排 |",
  "| --- | --- |",
  "| 1 | 寺院 |",
  "",
  "看**红叶**，很*安静*，店名 `cafe`。",
  "",
  "[官网](https://www.city.kyoto.lg.jp/)",
  "",
  "> 靠窗",
  "",
  "---",
].join("\n");

const rows = [{
  conv: {
    id: `chatgpt:${demo}`,
    platform: "chatgpt",
    platformId: demo,
    title: "京都三日",
    url: `https://chatgpt.com/c/${demo}`,
    updatedAt: Date.now(),
    updatedAtSource: "page-exact",
  },
  messages: [
    { id: `chatgpt:${demo}:u`, role: "user", body: "line one\nline two" },
    { id: `chatgpt:${demo}:a`, role: "assistant", body: assistant },
  ],
}];

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
import { upsertMessages, saveCaptureHealth } from "/src/db.js";
const rows = ${JSON.stringify(rows)};
for (const row of rows) {
  await upsertMessages(row.conv, row.messages, {
    pageMessageIds: row.messages.map((msg) => msg.id),
    captureId: row.conv.id,
  });
}
await saveCaptureHealth("chatgpt", {
  at: Date.parse("2026-10-08T12:00:00.000Z"),
  pathKind: "conversation",
  sidebarCount: 1,
  messageCount: 2,
  selector: "[data-turn]",
  warn: false,
  diag: ${JSON.stringify(diag)},
});
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
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
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
        localStorage.setItem("chatseek.uiLocale", "zh-TW");
      } catch { /* follow the browser language */ }
      const clipboard = {
        writeText() {
          return Promise.reject(new Error("clipboard denied"));
        },
      };
      try {
        Object.defineProperty(navigator, "clipboard", { configurable: true, get: () => clipboard });
      } catch { /* the click handler still falls through when writeText rejects */ }
      window.chrome = {
        i18n: { getUILanguage: () => "zh-TW" },
        tabs: {
          async query() { return [{ id: 1, active: true, url: "https://chatgpt.com/" }]; },
          async update() {},
          async create() {},
          onActivated: { addListener() {} },
          onUpdated: { addListener() {} },
        },
        runtime: {
          onMessage: { addListener() {} },
          sendMessage() {},
          getURL(path) { return path; },
          lastError: null,
        },
        windows: { async getCurrent() { return { id: 1 }; } },
        action: { setBadgeText() { return Promise.resolve(); } },
      };
    });

    const docs = join(root, "docs");
    const artifacts = "/opt/cursor/artifacts";
    await mkdir(docs, { recursive: true });
    await mkdir(artifacts, { recursive: true });
    const shots = {
      reader: join(docs, "reader-1.6.1-markdown.png"),
      button: join(docs, "panel-1.6.1-diag.png"),
      text: join(docs, "panel-1.6.1-diag-text.png"),
    };

    await page.setViewport({ width: 400, height: 860, deviceScaleFactor: 2 });
    await page.goto(`${origin}/__shot/bootstrap.html`, { waitUntil: "networkidle0", timeout: 20000 });
    await page.waitForFunction(() => document.getElementById("copyDiagBtn")?.textContent === "複製診斷", { timeout: 10000 });
    await page.evaluate(() => document.getElementById("copyDiagBtn")?.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: shots.button, fullPage: true });

    await page.click("#copyDiagBtn");
    await page.waitForFunction((line) => {
      const box = document.getElementById("diagBox");
      return box && !box.hidden && box.value === line;
    }, { timeout: 10000 }, diag);
    await page.evaluate(() => document.getElementById("diagBox")?.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: shots.text, fullPage: true });

    await page.setViewport({ width: 880, height: 1100, deviceScaleFactor: 2 });
    await page.goto(`${origin}/reader/index.html?id=${encodeURIComponent(`chatgpt:${demo}`)}`, { waitUntil: "networkidle0", timeout: 20000 });
    await page.waitForFunction(() => {
      const body = document.querySelector(".msg-assistant .msg-body");
      return body?.querySelector("table")
        && body?.querySelector("pre")?.textContent?.includes('print("hi")')
        && body?.querySelector("h2")?.textContent === "行程";
    }, { timeout: 10000 });
    await page.screenshot({ path: shots.reader, fullPage: true });

    for (const file of Object.values(shots)) {
      await copyFile(file, join(artifacts, file.split("/").pop()));
    }
    console.log("screenshots", Object.values(shots).join(" "));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
