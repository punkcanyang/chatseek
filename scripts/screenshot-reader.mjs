#!/usr/bin/env node
/**
 * Headless Chrome screenshots of the 1.5.0 reader and the new Read control.
 * Example index only. Does not log into ChatGPT / Claude / Grok / Gemini.
 *
 *   node scripts/screenshot-reader.mjs
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, copyFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hour = 3600000;
const kyoto = "11111111-1111-4111-8111-111111111111";
const draft = "99999999-9999-4999-8999-999999999999";
const camera = "44444444-4444-4444-8444-444444444444";
const walk = "55555555-5555-4555-8555-555555555555";
const kyotoUrl = `https://chatgpt.com/c/${kyoto}`;

function conv(platform, platformId, title, url, updatedAt, extra = {}) {
  return {
    id: `${platform}:${platformId}`,
    platform,
    platformId,
    title,
    url,
    updatedAt,
    updatedAtSource: "page-exact",
    ...extra,
  };
}

function rows(now) {
  const user = (id, body) => ({ id, role: "user", body });
  const bot = (id, body) => ({ id, role: "assistant", body });
  const invoice = "22222222-2222-4222-8222-222222222222";
  const rocket = "33333333-3333-4333-8333-333333333333";
  const orchid = "a1b2c3d4e5f67890";
  return [
    {
      conv: conv(
        "chatgpt",
        walk,
        "从京都车站走到哲学之道再折回四条河原町的红叶散步路线，标题故意写长以便确认圆形按钮不会盖住文字也不会压到绿色边框",
        `https://chatgpt.com/c/${walk}`,
        now - 20 * 60 * 1000,
      ),
      messages: [
        user(`chatgpt:${walk}:u`, "这条路如果下雨，哪一段要改去室内？"),
        bot(`chatgpt:${walk}:a`, "先把哲学之道换成室内展厅。"),
      ],
    },
    {
      conv: conv("chatgpt", kyoto, "京都红叶行程", kyotoUrl, now - 35 * 60 * 1000),
      messages: [
        user(
          `chatgpt:${kyoto}:u`,
          "我想在十一月去京都看红叶，住在四条附近。晚上找一家不吵的咖啡馆，下雨就改去室内。",
        ),
        bot(
          `chatgpt:${kyoto}:a`,
          "好的。第二天傍晚去那家咖啡馆，不要排太满。\n```\nDay 2 evening: cafe\n```",
        ),
      ],
    },
    {
      conv: conv("claude", invoice, "发票按月汇总", `https://claude.ai/chat/${invoice}`, now - 5 * hour),
      messages: [
        user(`claude:${invoice}:u`, "一月的发票已经放进文件夹。三月的差额是 48。"),
        bot(`claude:${invoice}:a`, "我先按月份对齐金额。"),
      ],
    },
    {
      conv: conv("grok", rocket, "火箭回收笔记", `https://grok.com/c/${rocket}`, now - hour),
      messages: [
        user(`grok:${rocket}:u`, "STARSHIP 的助推器是怎么降落的？请用短句说明。"),
        bot(`grok:${rocket}:a`, "燃料、格栅翼和着陆腿各做一件事。"),
      ],
    },
    {
      conv: conv(
        "gemini",
        orchid,
        "阳台兰花",
        `https://gemini.google.com/u/2/app/${orchid}`,
        now - 26 * hour,
      ),
      messages: [
        user(`gemini:${orchid}:u`, "蝴蝶兰叶子发黄，新根还是绿的。要不要换土？"),
        bot(`gemini:${orchid}:a`, "先别剪，看看是不是水多了。"),
      ],
    },
    {
      conv: conv("chatgpt", draft, "还没点开的草稿", `https://chatgpt.com/c/${draft}`, now - 72 * hour),
      messages: null,
    },
    {
      conv: conv(
        "chatgpt",
        camera,
        "旧相机维修",
        `https://chatgpt.com/c/${camera}`,
        now - 10 * hour,
        { archived: true, archiveSource: "chatgpt:banner", archivedAt: now - 2 * hour },
      ),
      messages: [
        user(`chatgpt:${camera}:u`, "这台底片相机快门有时不释放。请告诉我清洁的顺序。"),
        bot(`chatgpt:${camera}:a`, "先不要上油。"),
      ],
    },
  ];
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function startServer(seedRows) {
  const bootstrap = `<!DOCTYPE html>
<meta charset="utf-8" />
<script type="module">
import { upsertConversations, upsertMessages } from "/src/db.js";
const rows = ${JSON.stringify(seedRows)};
for (const row of rows) {
  if (row.messages) {
    await upsertMessages(row.conv, row.messages, {
      pageMessageIds: row.messages.map((msg) => msg.id),
      captureId: row.conv.id,
    });
  } else {
    await upsertConversations([row.conv]);
  }
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
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

async function main() {
  const { server, port } = await startServer(rows(Date.now()));
  const origin = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--lang=zh-CN",
      "--hide-scrollbars",
      "--font-render-hinting=none",
    ],
  });
  try {
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await page.evaluateOnNewDocument(() => {
      try {
        Object.defineProperty(navigator, "language", { get: () => "zh-CN" });
        Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh"] });
      } catch { /* --lang covers a locked navigator.language */ }
      try {
        localStorage.setItem("chatseek.uiLocale", "zh-CN");
      } catch { /* the page then follows the browser language */ }
      window.chrome = {
        i18n: { getUILanguage: () => "zh-CN" },
        tabs: {
          async query(q) {
            if (q && q.url) return [];
            if (q && (q.active || q.windowId || q.currentWindow)) {
              return [{
                id: 1,
                windowId: 1,
                active: true,
                url: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111",
              }];
            }
            return [];
          },
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

    await page.setViewport({ width: 440, height: 860, deviceScaleFactor: 2 });
    await page.goto(`${origin}/__shot/bootstrap.html`, { waitUntil: "networkidle0", timeout: 20000 });
    await page.waitForFunction(() => {
      const read = document.querySelector(".read")?.textContent || "";
      const counts = document.getElementById("counts")?.textContent || "";
      const current = document.querySelector(".item.is-current .item-title")?.textContent || "";
      return read === "阅读" && counts.includes("条消息") && current === "京都红叶行程";
    }, { timeout: 10000 });
    await page.evaluate(() => document.fonts?.ready);
    const docs = join(root, "docs");
    const artifacts = "/opt/cursor/artifacts";
    await mkdir(docs, { recursive: true });
    await mkdir(artifacts, { recursive: true });
    const shots = {
      panel: join(docs, "panel-1.5.0-read.png"),
      removeX: join(docs, "panel-1.5.0-remove-x.png"),
      hit: join(docs, "reader-1.5.0-hit.png"),
      titleOnly: join(docs, "reader-1.5.0-title-only.png"),
      archived: join(docs, "reader-1.5.0-archived.png"),
    };
    await page.screenshot({ path: shots.panel, fullPage: true });

    await page.setViewport({ width: 360, height: 900, deviceScaleFactor: 2 });
    await page.evaluate(() => {
      const hover = [...document.querySelectorAll(".row")].find((row) =>
        (row.querySelector(".item-title")?.textContent || "").includes("哲学之道"),
      );
      hover.dataset.shot = "hover";
      const current = document.querySelector(".item.is-current");
      current.parentElement.querySelector(".remove").dataset.shot = "focus";
      const top = Math.min(
        hover.getBoundingClientRect().top,
        current.parentElement.getBoundingClientRect().top,
      );
      window.scrollBy(0, top - 28);
    });
    await page.hover("[data-shot='hover'] .item-title");
    await page.evaluate(() => {
      document.querySelector("[data-shot='focus']").focus({ focusVisible: true, preventScroll: true });
    });
    const layout = await page.evaluate(() => {
      const overlaps = (a, b) =>
        a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, right: r.right, bottom: r.bottom, left: r.left };
      };
      const problems = [];
      for (const row of document.querySelectorAll(".row")) {
        const item = row.querySelector(".item");
        const x = row.querySelector(":scope > .remove");
        if (!item || !x) continue;
        const xb = box(x);
        for (const [name, el] of [
          ["title", item.querySelector(".item-title")],
          ["preview", item.querySelector(".item-preview")],
          ["time", item.querySelector("time")],
        ]) {
          if (el && overlaps(xb, box(el))) problems.push(`${item.dataset.id} X overlaps ${name}`);
        }
        const bw = parseFloat(getComputedStyle(item).borderTopWidth) || 0;
        const itemBox = box(item);
        const inner = {
          top: itemBox.top + bw,
          right: itemBox.right - bw,
          bottom: itemBox.bottom - bw,
          left: itemBox.left + bw,
        };
        const xcs = getComputedStyle(x);
        const ring = (parseFloat(xcs.outlineWidth) || 0) + (parseFloat(xcs.outlineOffset) || 0);
        const visual = {
          top: xb.top - ring,
          right: xb.right + ring,
          bottom: xb.bottom + ring,
          left: xb.left - ring,
        };
        if (
          visual.top < inner.top - 0.5
          || visual.right > inner.right + 0.5
          || visual.bottom > inner.bottom + 0.5
          || visual.left < inner.left - 0.5
        ) {
          problems.push(`${item.dataset.id} X meets the card frame`);
        }
      }
      const hover = document.querySelector("[data-shot='hover'] > .remove");
      const focus = document.querySelector("[data-shot='focus']");
      const idle = [...document.querySelectorAll(".row > .remove")].find((el) => el !== hover && el !== focus);
      const hoverRow = document.querySelector("[data-shot='hover']");
      const focusItem = document.querySelector(".item.is-current");
      const top = Math.min(hoverRow.getBoundingClientRect().top, focusItem.getBoundingClientRect().top);
      const bottom = Math.max(hoverRow.getBoundingClientRect().bottom, focusItem.getBoundingClientRect().bottom);
      const clipTop = Math.max(0, top - 10);
      return {
        problems,
        hoverOpacity: getComputedStyle(hover).opacity,
        focusOpacity: getComputedStyle(focus).opacity,
        focusVisible: focus.matches(":focus-visible"),
        outline: `${getComputedStyle(focus).outlineStyle} ${getComputedStyle(focus).outlineWidth}`,
        idleOpacity: getComputedStyle(idle).opacity,
        longTitle: (hoverRow.querySelector(".item-title")?.textContent || "").length,
        green: getComputedStyle(document.querySelector(".item.is-current")).borderTopColor,
        aria: focus.getAttribute("aria-label"),
        title: focus.title,
        width: window.innerWidth,
        clipTop: window.scrollY + clipTop,
        clipHeight: Math.ceil(bottom - clipTop + 16),
        hoverTop: hoverRow.getBoundingClientRect().top,
        hoverBottom: hoverRow.getBoundingClientRect().bottom,
        focusTop: focusItem.getBoundingClientRect().top,
        focusBottom: focusItem.getBoundingClientRect().bottom,
        viewport: window.innerHeight,
      };
    });
    if (layout.problems.length) throw new Error(layout.problems.join("; "));
    if (layout.width > 360) throw new Error(`panel wider than the narrow check: ${layout.width}`);
    if (layout.longTitle < 40) throw new Error("long title was not rendered");
    if (layout.hoverOpacity !== "1") throw new Error(`hovered X opacity ${layout.hoverOpacity}`);
    if (layout.focusOpacity !== "1" || !layout.focusVisible) {
      throw new Error(`focused X opacity ${layout.focusOpacity} visible ${layout.focusVisible} ${layout.outline}`);
    }
    if (!layout.outline.startsWith("solid")) throw new Error(`focus ring ${layout.outline}`);
    if (Number(layout.idleOpacity) > 0.5) throw new Error(`idle X opacity ${layout.idleOpacity}`);
    if (layout.green !== "rgb(61, 220, 151)") throw new Error(`green frame ${layout.green}`);
    if (layout.aria !== "从索引移除" || layout.title !== "从索引移除") {
      throw new Error(`remove name ${layout.aria} / ${layout.title}`);
    }
    if (layout.hoverTop < 8 || layout.focusBottom > layout.viewport - 8) {
      throw new Error(`rows outside the viewport ${JSON.stringify({
        hoverTop: layout.hoverTop,
        focusBottom: layout.focusBottom,
        viewport: layout.viewport,
      })}`);
    }
    if (layout.focusBottom + 28 > layout.viewport) {
      throw new Error(`focused row has no room below it ${layout.focusBottom}`);
    }
    await page.screenshot({
      path: shots.removeX,
      clip: { x: 0, y: layout.clipTop, width: 360, height: layout.clipHeight },
    });

    await page.setViewport({ width: 960, height: 520, deviceScaleFactor: 2 });
    const kyotoId = `chatgpt:${kyoto}`;
    await page.goto(
      `${origin}/reader/index.html?id=${encodeURIComponent(kyotoId)}&q=${encodeURIComponent("咖啡馆")}`,
      { waitUntil: "networkidle0", timeout: 20000 },
    );
    await page.waitForFunction(() => {
      const mark = document.querySelector("mark.is-current");
      const count = document.getElementById("hitCount")?.textContent || "";
      const open = document.getElementById("openOriginal")?.textContent || "";
      return mark?.textContent === "咖啡馆" && count.startsWith("1 /") && open === "去原网站打开";
    }, { timeout: 10000 });
    const yellow = await page.$eval("mark.is-current", (el) => getComputedStyle(el).backgroundColor);
    if (yellow !== "rgb(255, 224, 138)") throw new Error(`current hit background ${yellow}`);
    await page.screenshot({ path: shots.hit, fullPage: false });

    await page.setViewport({ width: 960, height: 360, deviceScaleFactor: 2 });
    await page.goto(
      `${origin}/reader/index.html?id=${encodeURIComponent(`chatgpt:${draft}`)}`,
      { waitUntil: "networkidle0", timeout: 20000 },
    );
    await page.waitForFunction(() => {
      return document.getElementById("readerNote")?.textContent === "仅有标题，未收录消息"
        && document.getElementById("openOriginal")?.textContent === "去原网站打开";
    }, { timeout: 10000 });
    await page.screenshot({ path: shots.titleOnly, fullPage: false });

    await page.setViewport({ width: 960, height: 460, deviceScaleFactor: 2 });
    await page.goto(
      `${origin}/reader/index.html?id=${encodeURIComponent(`chatgpt:${camera}`)}`,
      { waitUntil: "networkidle0", timeout: 20000 },
    );
    await page.waitForFunction(() => {
      const badge = document.getElementById("archivedBadge");
      return badge && !badge.hidden && badge.textContent === "已归档"
        && (document.querySelector(".msg")?.textContent || "").includes("快门");
    }, { timeout: 10000 });
    const grey = await page.$eval("#archivedBadge", (el) => getComputedStyle(el).color);
    if (grey !== "rgb(107, 114, 128)") throw new Error(`archived label color ${grey}`);
    await page.screenshot({ path: shots.archived, fullPage: false });

    for (const file of Object.values(shots)) {
      await copyFile(file, join(artifacts, file.split("/").pop()));
    }
    console.log("screenshots", Object.values(shots).join(" "));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
