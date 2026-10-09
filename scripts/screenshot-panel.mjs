#!/usr/bin/env node
/**
 * Headless Chrome screenshots of the real side panel with an example index.
 * Does not log into ChatGPT / Claude / Grok / Gemini. Example text only.
 *
 *   node scripts/screenshot-panel.mjs
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, copyFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const currentUrl = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const hour = 3600000;

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
  const kyoto = "11111111-1111-4111-8111-111111111111";
  const invoice = "22222222-2222-4222-8222-222222222222";
  const rocket = "33333333-3333-4333-8333-333333333333";
  const orchid = "a1b2c3d4e5f67890";
  const draft = "99999999-9999-4999-8999-999999999999";
  const user = (id, body) => ({ id, role: "user", body });
  const bot = (id, body) => ({ id, role: "assistant", body });
  return [
    {
      conv: conv("grok", rocket, "火箭回收笔记", `https://grok.com/c/${rocket}`, now - hour),
      messages: [
        user(
          `grok:${rocket}:u`,
          "我想弄清 STARSHIP 的助推器是怎么降落的。请用短句说明燃料、格栅翼和着陆腿各自做什么，不要展开历史。另外对比一次失败回收和成功回收的差别，控制在四条以内。",
        ),
        bot(`grok:${rocket}:a`, "好的，下面按部件说。"),
      ],
    },
    {
      conv: conv("chatgpt", kyoto, "京都红叶行程", `https://chatgpt.com/c/${kyoto}`, now - 2 * hour),
      messages: [
        user(
          `chatgpt:${kyoto}:u`,
          "我想在十一月去京都看红叶，住在四条附近，走路去八坂和清水寺，晚上找一家不吵的咖啡馆。不要排太满，把购物留到最后半天。如果下雨就改去室内的博物馆，并告诉我哪一天最适合拍照。",
        ),
        bot(`chatgpt:${kyoto}:a`, "好的，下面是三天安排。"),
      ],
    },
    {
      conv: conv("claude", invoice, "发票按月汇总", `https://claude.ai/chat/${invoice}`, now - 5 * hour),
      messages: [
        user(
          `claude:${invoice}:u`,
          "一月的发票已经放进文件夹。二月有三张餐饮和一张交通。三月的金额对不上，差额是 48。封面照片里的红叶是去年在京都拍的，跟报销无关，请忽略那张图，只核对金额和日期。四月开始改用新的表格，请按这个格式出一版汇总。",
        ),
        bot(`claude:${invoice}:a`, "我先按月份对齐金额。"),
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
        user(
          `gemini:${orchid}:u`,
          "阳台的蝴蝶兰叶子发黄，新根却还是绿的。浇水是一周一次，窗边没有直射。请告诉我要不要换土，以及黄叶要不要剪掉。",
        ),
        bot(`gemini:${orchid}:a`, "先别剪，看看是不是水多了。"),
      ],
    },
    {
      conv: conv(
        "chatgpt",
        draft,
        "还没点开的草稿",
        `https://chatgpt.com/c/${draft}`,
        now - 72 * hour,
      ),
      messages: null,
    },
    {
      conv: conv(
        "chatgpt",
        "44444444-4444-4444-8444-444444444444",
        "舊相機維修",
        "https://chatgpt.com/c/44444444-4444-4444-8444-444444444444",
        now - 10 * hour,
        { archived: true, archiveSource: "chatgpt:banner", archivedAt: now - 2 * hour },
      ),
      messages: [
        user(
          "chatgpt:44444444-4444-4444-8444-444444444444:u",
          "這台底片相機快門有時不釋放。請告訴我清潔和潤滑的順序，以及什麼情況該停手送修。",
        ),
        bot("chatgpt:44444444-4444-4444-8444-444444444444:a", "先不要上油。"),
      ],
    },
    {
      conv: conv(
        "claude",
        "55555555-5555-4555-8555-555555555555",
        "封存的讀書筆記",
        "https://claude.ai/chat/55555555-5555-4555-8555-555555555555",
        now - 30 * hour,
        // Seeded so the Archived tab shows a second platform. Claude has no
        // archive detector; this source is example data, not a capture claim.
        { archived: true, archiveSource: "example:seed", archivedAt: now - 5 * hour },
      ),
      messages: [
        user(
          "claude:55555555-5555-4555-8555-555555555555:u",
          "把這本小說的時間線整理成一頁，不要劇透結局。",
        ),
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

async function prepare(page, origin) {
  await page.goto(`${origin}/__shot/bootstrap.html`, { waitUntil: "networkidle0", timeout: 20000 });
  await page.waitForSelector(".item.is-current", { timeout: 15000 });
  await page.waitForFunction(() => {
    const badge = document.querySelector(".item-preview.is-title-only");
    const counts = document.getElementById("counts")?.textContent || "";
    const active = document.getElementById("filterActive")?.textContent || "";
    return badge?.textContent?.includes("僅有標題") && counts.includes("則訊息") && active === "活躍中";
  }, { timeout: 10000 });
  const border = await page.$eval(".item.is-current", (el) => getComputedStyle(el).borderTopColor);
  if (border !== "rgb(61, 220, 151)") {
    throw new Error(`current frame is ${border}, want rgb(61, 220, 151)`);
  }
  const frames = await page.$$eval(".item.is-current", (els) => els.length);
  if (frames !== 1) throw new Error(`expected one current row, got ${frames}`);
  const preview = await page.$eval(".item.is-current .item-preview", (el) => el.textContent || "");
  if (!preview.includes("我想在十一月")) throw new Error(`current preview is not the first prompt: ${preview}`);
  if (preview.startsWith("好的")) throw new Error("current preview showed the assistant reply");
  await page.evaluate(() => document.fonts.ready);
  const before = await page.$eval(".item.is-current .item-preview", (el) => el.clientHeight);
  await page.hover(".item.is-current");
  const after = await page.$eval(".item.is-current .item-preview", (el) => el.clientHeight);
  if (after <= before) throw new Error(`hover did not expand the preview (${before}px -> ${after}px)`);
  await page.mouse.move(0, 0);
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
    await page.setViewport({ width: 400, height: 920, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await page.evaluateOnNewDocument((url) => {
      try {
        Object.defineProperty(navigator, "language", { get: () => "zh-CN" });
        Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh"] });
      } catch { /* --lang=zh-CN covers this when the property is locked */ }
      try {
        if (!localStorage.getItem("chatseek.uiLocale")) localStorage.setItem("chatseek.uiLocale", "zh-TW");
      } catch { /* the panel falls back to the browser language */ }
      window.chrome = {
        tabs: {
          async query() {
            return [{ id: 1, active: true, url }];
          },
          async update() {},
          async create() {},
          onActivated: { addListener() {} },
          onUpdated: { addListener() {} },
        },
        runtime: {
          onMessage: { addListener() {} },
          sendMessage() {},
          lastError: null,
        },
        action: { setBadgeText() { return Promise.resolve(); } },
      };
    }, currentUrl);

    await prepare(page, origin);
    const docs = join(root, "docs");
    const artifacts = "/opt/cursor/artifacts";
    await mkdir(docs, { recursive: true });
    await mkdir(artifacts, { recursive: true });
    const shots = {
      active: join(docs, "panel-1.4.0-active.png"),
      archived: join(docs, "panel-1.4.0-archived.png"),
      remove: join(docs, "panel-1.4.0-remove.png"),
      en: join(docs, "panel-1.4.0-en.png"),
      ja: join(docs, "panel-1.4.0-ja.png"),
    };
    const order = await page.$$eval(".chip", (els) => els.map((el) => el.textContent));
    if (order.join("|") !== "活躍中|ChatGPT|Claude|Grok|Gemini|已封存|全部|圖片") {
      throw new Error(`tab order ${order.join("|")}`);
    }
    await page.screenshot({ path: shots.active, fullPage: true });

    await page.click("#filterArchived");
    await page.waitForFunction(() => {
      const badges = [...document.querySelectorAll(".badge-archived")];
      return badges.length >= 2 && badges.every((badge) => badge.textContent === "已封存");
    }, { timeout: 10000 });
    await page.screenshot({ path: shots.archived, fullPage: true });

    await page.click(".remove");
    await page.waitForFunction(() => {
      const dialog = document.getElementById("removeDialog");
      const body = document.getElementById("removeBody")?.textContent || "";
      return dialog && !dialog.hidden && body.includes("從本機索引移除");
    }, { timeout: 10000 });
    await page.screenshot({ path: shots.remove, fullPage: true });
    await page.click("#removeCancel");

    await page.select("#lang", "en");
    await page.waitForFunction(() => {
      const counts = document.getElementById("counts")?.textContent || "";
      const follow = document.querySelector("#lang option[value='auto']")?.textContent || "";
      return document.getElementById("filterActive")?.textContent === "Active"
        && counts.includes("messages")
        && follow === "Browser language";
    }, { timeout: 10000 });
    await page.screenshot({ path: shots.en, fullPage: true });

    await page.select("#lang", "ja");
    await page.waitForFunction(() => {
      return document.getElementById("filterActive")?.textContent === "アクティブ"
        && (document.getElementById("counts")?.textContent || "").includes("メッセージ");
    }, { timeout: 10000 });
    await page.screenshot({ path: shots.ja, fullPage: true });

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
