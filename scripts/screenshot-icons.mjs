#!/usr/bin/env node
/**
 * Example-data screenshots of the faint row icons, the hovered row,
 * a 320px-wide side panel, and the reader header icon.
 *
 *   node scripts/screenshot-icons.mjs
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, copyFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const demo = "33333333-3333-4333-8333-333333333333";
const other = "44444444-4444-4444-8444-444444444444";
const demoUrl = `https://chatgpt.com/c/${demo}`;

function conv(platformId, title, url, updatedAt) {
  return {
    id: `chatgpt:${platformId}`,
    platform: "chatgpt",
    platformId,
    title,
    url,
    updatedAt,
    updatedAtSource: "page-exact",
  };
}

const now = Date.now();
const rows = [
  {
    conv: conv(demo, "京都红叶三日", demoUrl, now),
    messages: [
      { id: `chatgpt:${demo}:u`, role: "user", body: "十一月去京都看红叶，住在四条附近。" },
      { id: `chatgpt:${demo}:a`, role: "assistant", body: "第一天可以先去清水寺。" },
    ],
  },
  {
    conv: conv(other, "周末咖啡馆清单", `https://chatgpt.com/c/${other}`, now - 86400000),
    messages: [
      { id: `chatgpt:${other}:u`, role: "user", body: "想找一间可以坐一下午的店。" },
    ],
  },
];

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function startServer() {
  const bootstrap = `<!doctype html>
<meta charset="utf-8" />
<script type="module">
import { upsertMessages } from "/src/db.js";
const rows = ${JSON.stringify(rows)};
for (const row of rows) {
  await upsertMessages(row.conv, row.messages, {
    pageMessageIds: row.messages.map((msg) => msg.id),
    captureId: row.conv.id,
  });
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
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.(\/|\\|$))+/, "").replace(/^[/\\]+/, "");
    const file = join(root, rel);
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": types[extname(rel)] || "application/octet-stream" });
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

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const { server, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--lang=zh-CN", "--hide-scrollbars", "--font-render-hinting=none"],
  });
  try {
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await page.evaluateOnNewDocument((url) => {
      try {
        Object.defineProperty(navigator, "language", { get: () => "zh-CN" });
        Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh"] });
      } catch { /* --lang covers a locked navigator.language */ }
      try {
        localStorage.setItem("chatseek.uiLocale", "zh-CN");
      } catch { /* follow the browser language */ }
      window.__opens = [];
      window.__reuse = false;
      window.chrome = {
        i18n: { getUILanguage: () => "zh-CN" },
        tabs: {
          async query() {
            return [{ id: 1, windowId: 1, active: true, url }];
          },
          async update() {},
          async create(opts) { window.__opens.push({ created: opts }); },
          onActivated: { addListener() {} },
          onUpdated: { addListener() {} },
        },
        runtime: {
          onMessage: { addListener() {} },
          sendMessage(msg) {
            window.__opens.push(msg);
            return Promise.resolve({ focused: window.__reuse === true });
          },
          getURL(path) { return path; },
          lastError: null,
        },
        windows: { async getCurrent() { return { id: 1 }; } },
        action: { setBadgeText() { return Promise.resolve(); } },
      };
    }, demoUrl);

    const docs = join(root, "docs");
    const artifacts = "/opt/cursor/artifacts";
    await mkdir(docs, { recursive: true });
    await mkdir(artifacts, { recursive: true });
    const shots = {
      rest: join(docs, "panel-1.5.1-icons-rest.png"),
      hover: join(docs, "panel-1.5.1-icons-hover.png"),
      narrow: join(docs, "panel-1.5.1-icons-320.png"),
      reader: join(docs, "reader-1.5.1-open-icon.png"),
    };

    await page.setViewport({ width: 440, height: 640, deviceScaleFactor: 2 });
    await page.goto(`${origin}/__shot/bootstrap.html`, { waitUntil: "networkidle0", timeout: 20000 });
    await page.waitForFunction(() => {
      const row = document.querySelector(".row");
      const read = row?.querySelector(".read");
      const open = row?.querySelector(".open-site");
      return row?.querySelector(".item.is-current")
        && read?.getAttribute("aria-label") === "阅读"
        && open?.getAttribute("aria-label") === "去原网站打开"
        && read.querySelector("svg")
        && open.querySelector("svg");
    }, { timeout: 10000 });

    const restOpacity = await page.$eval(".read", (el) => getComputedStyle(el).opacity);
    assert(Number(restOpacity) < 0.5, `resting icon should be faint, got ${restOpacity}`);

    async function rowClip() {
      return page.evaluate(() => {
        const list = document.getElementById("list");
        const box = list.getBoundingClientRect();
        const top = Math.max(0, box.top - 8);
        const bottom = Math.min(window.innerHeight, box.top + box.height + 8);
        return { x: 0, y: window.scrollY + top, width: window.innerWidth, height: Math.ceil(bottom - top) };
      });
    }
    await page.screenshot({ path: shots.rest, clip: await rowClip() });

    await page.hover("#list li:nth-child(2) .row");
    const hoverOpacity = await page.$eval("#list li:nth-child(2) .read", (el) => getComputedStyle(el).opacity);
    const otherOpacity = await page.$eval("#list li:nth-child(1) .open-site", (el) => getComputedStyle(el).opacity);
    assert(Number(hoverOpacity) === 1, `hovered icon should be clear, got ${hoverOpacity}`);
    assert(Number(otherOpacity) < 0.5, `the other row stays faint, got ${otherOpacity}`);
    await page.screenshot({ path: shots.hover, clip: await rowClip() });

    await page.focus("#q");
    let landed = "";
    for (let i = 0; i < 30 && landed !== "open-site"; i++) {
      await page.keyboard.press("Tab");
      landed = await page.evaluate(() => document.activeElement?.className || "");
    }
    assert(landed.includes("open-site"), `tab should reach the original-site icon, got ${landed}`);
    const ring = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement);
      return `${style.outlineStyle} ${style.outlineWidth}`;
    });
    assert(ring.includes("solid") && !ring.startsWith("none"), `focus ring missing: ${ring}`);
    const before = await page.evaluate(() => window.__opens.length);
    await page.keyboard.press("Enter");
    await page.waitForFunction((n) => window.__opens.length > n, { timeout: 2000 }, before);
    const opened = await page.evaluate(() => window.__opens);
    assert(opened.some((item) => item.type === "FOCUS_ORIGINAL"), `Enter should ask to reuse a tab, got ${JSON.stringify(opened)}`);
    assert(opened.at(-1)?.created?.url?.includes(demo), "a missing chat still opens a new tab");
    await page.evaluate(() => { window.__reuse = true; window.__opens = []; });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__opens.length > 0, { timeout: 2000 });
    const reused = await page.evaluate(() => window.__opens);
    assert(reused.length === 1 && reused[0].type === "FOCUS_ORIGINAL", "an already-open chat does not create a second tab");

    await page.mouse.move(0, 0);
    await page.evaluate(() => document.activeElement?.blur());
    await page.setViewport({ width: 320, height: 640, deviceScaleFactor: 2 });
    await page.waitForFunction(() => document.querySelector(".item.is-current"), { timeout: 5000 });
    const fit = await page.evaluate(() => {
      function box(el) {
        const b = el.getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height };
      }
      function hits(a, b) {
        return a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
      }
      const problems = [];
      if (document.documentElement.scrollWidth > window.innerWidth + 1) {
        problems.push(`page scrolls sideways ${document.documentElement.scrollWidth}`);
      }
      for (const row of document.querySelectorAll(".row")) {
        const item = row.querySelector(".item");
        const itemBox = box(item);
        if (itemBox.right > window.innerWidth + 1) problems.push("card past the edge");
        for (const icon of row.querySelectorAll(".read, .open-site")) {
          const iconBox = box(icon);
          if (iconBox.width < 20 || iconBox.height < 20) problems.push("icon too small");
          if (iconBox.right > window.innerWidth + 1 || iconBox.left < 0) problems.push("icon outside");
          if (hits(iconBox, itemBox)) problems.push("icon overlaps the card");
          for (const part of [".item-title", ".item-preview", "time"]) {
            const el = row.querySelector(part);
            if (el && hits(iconBox, box(el))) problems.push(`icon overlaps ${part}`);
          }
        }
      }
      return problems;
    });
    assert(fit.length === 0, fit.join("; "));
    const localeFit = await page.evaluate(() => {
      const select = document.getElementById("lang");
      const problems = [];
      const codes = [...select.options].map((option) => option.value);
      const saved = select.value;
      for (const code of codes) {
        select.value = code;
        select.dispatchEvent(new Event("change"));
        if (document.documentElement.scrollWidth > window.innerWidth + 1) {
          problems.push(`${code} scrolls sideways ${document.documentElement.scrollWidth}`);
        }
        for (const icon of document.querySelectorAll(".read, .open-site")) {
          const box = icon.getBoundingClientRect();
          if (box.width > 30 || box.right > window.innerWidth + 1) {
            problems.push(`${code} icon ${icon.getAttribute("aria-label")} is ${Math.round(box.width)}px`);
          }
        }
      }
      select.value = saved;
      select.dispatchEvent(new Event("change"));
      return problems;
    });
    assert(localeFit.length === 0, localeFit.join("; "));
    await page.waitForFunction(() => {
      const read = document.querySelector(".read");
      return read?.getAttribute("aria-label") === "阅读" && document.querySelector(".item.is-current");
    }, { timeout: 5000 });
    await page.screenshot({ path: shots.narrow, clip: await rowClip() });

    await page.setViewport({ width: 880, height: 420, deviceScaleFactor: 2 });
    await page.goto(
      `${origin}/reader/index.html?id=${encodeURIComponent(`chatgpt:${demo}`)}`,
      { waitUntil: "networkidle0", timeout: 20000 },
    );
    await page.waitForFunction(() => {
      const btn = document.getElementById("openOriginal");
      return btn && !btn.hidden
        && btn.getAttribute("aria-label") === "去原网站打开"
        && btn.title === "去原网站打开"
        && btn.querySelector("svg");
    }, { timeout: 10000 });
    const headerClip = await page.evaluate(() => {
      const header = document.querySelector(".reader-top");
      const box = header.getBoundingClientRect();
      return { x: 0, y: 0, width: window.innerWidth, height: Math.ceil(box.bottom + 8) };
    });
    await page.screenshot({ path: shots.reader, clip: headerClip });

    for (const file of Object.values(shots)) {
      await copyFile(file, join(artifacts, file.split("/").pop()));
    }
    console.log(Object.values(shots).join("\n"));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
