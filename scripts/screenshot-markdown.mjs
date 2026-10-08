#!/usr/bin/env node
/**
 * Before/after screenshots of the same example Markdown conversation.
 * 1.5.0 is served from git (439884d) for the raw view. Does not log in.
 *
 *   node scripts/screenshot-markdown.mjs
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, copyFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REV = "439884d";
const demo = "77777777-7777-4777-8777-777777777777";
const codeId = "88888888-8888-4888-8888-888888888888";
const demoUrl = `https://chatgpt.com/c/${demo}`;

const markdown = [
  "# 京都三日",
  "",
  "十一月去京都看**红叶**，住在四条附近。",
  "",
  "- 第一天：清水寺",
  "- 第二天：哲学之道",
  "- 下雨就改去室内",
  "",
  "> 靠窗的位置就好。",
  "",
  "店名用 `cafe` 记下来。",
  "",
  "```",
  "Day 2 evening: cafe",
  "const quiet = true;",
  "```",
  "",
  "| 天 | 安排 |",
  "| --- | --- |",
  "| 1 | 清水寺 |",
  "| 2 | 咖啡馆 |",
  "",
  "官网：[京都旅游](https://www.city.kyoto.lg.jp/)",
  "",
  "![清水寺](https://example.com/kiyomizu.jpg)",
  "",
  "---",
  "",
  "就排到这里。",
].join("\n");

const longCode = `\`\`\`\n${"x".repeat(180)} const NEEDLE = 1;\n\`\`\``

function conv(platform, platformId, title, url, updatedAt) {
  return {
    id: `${platform}:${platformId}`,
    platform,
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
    conv: conv("chatgpt", demo, "京都三日", demoUrl, now),
    messages: [
      { id: `chatgpt:${demo}:u`, role: "user", body: markdown },
      { id: `chatgpt:${demo}:a`, role: "assistant", body: "好，就按这个排，别排太满。" },
    ],
  },
  {
    conv: conv("chatgpt", codeId, "代码里的记号", `https://chatgpt.com/c/${codeId}`, now - 3600000),
    messages: [
      { id: `chatgpt:${codeId}:u`, role: "user", body: "看这一行末尾。" },
      { id: `chatgpt:${codeId}:a`, role: "assistant", body: longCode },
    ],
  },
];

const oldPaths = ["reader/index.html", "reader/reader.js", "reader/reader.css", "src/reader-view.js"];
const oldFiles = new Map(oldPaths.map((rel) => [rel, execFileSync("git", ["show", `${REV}:${rel}`])]));

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
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.(\/|\\|$))+/, "").replace(/^[/\\]+/, "");
    let body = null;
    if (rel.startsWith("v150/")) {
      rel = rel.slice("v150/".length);
      body = oldFiles.get(rel) || null;
    }
    if (!body) {
      const file = join(root, rel);
      if (!file.startsWith(root)) {
        res.writeHead(403);
        res.end();
        return;
      }
      try {
        body = readFileSync(file);
      } catch {
        res.writeHead(404);
        res.end();
        return;
      }
    }
    res.writeHead(200, { "content-type": types[extname(rel)] || "application/octet-stream" });
    res.end(body);
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
  const remote = [];
  try {
    const page = await browser.newPage();
    page.on("request", (req) => {
      const url = req.url();
      if (!url.startsWith(origin) && !url.startsWith("data:")) remote.push(url);
    });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await page.evaluateOnNewDocument(() => {
      try {
        Object.defineProperty(navigator, "language", { get: () => "zh-CN" });
        Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh"] });
      } catch { /* --lang covers a locked navigator.language */ }
      try {
        localStorage.setItem("chatseek.uiLocale", "zh-CN");
      } catch { /* follow the browser language */ }
      window.chrome = {
        i18n: { getUILanguage: () => "zh-CN" },
        tabs: {
          async query() { return []; },
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
      before: join(docs, "reader-1.5.0-markdown-raw.png"),
      after: join(docs, "reader-1.5.1-markdown.png"),
      hit: join(docs, "reader-1.5.1-hit.png"),
      preview: join(docs, "panel-1.5.1-preview.png"),
    };

    await page.setViewport({ width: 440, height: 720, deviceScaleFactor: 2 });
    await page.goto(`${origin}/__shot/bootstrap.html`, { waitUntil: "networkidle0", timeout: 20000 });
    await page.waitForFunction(() => (document.querySelector(".item-title")?.textContent || "").includes("京都三日"), { timeout: 10000 });
    await page.click("#q");
    await page.keyboard.type("红叶");
    await page.waitForFunction(() => {
      const preview = document.querySelector(".item-preview");
      const text = preview?.textContent || "";
      const mark = preview?.querySelector("mark")?.textContent || "";
      return mark === "红叶" && text.includes("红叶") && !text.includes("**") && !text.includes("#") && !text.includes("```") && !text.includes("|");
    }, { timeout: 10000 });
    const previewClip = await page.evaluate(() => {
      const search = document.querySelector(".search").getBoundingClientRect();
      const row = document.querySelector(".row");
      const bottom = row ? row.getBoundingClientRect().bottom : search.bottom + 120;
      const top = Math.max(0, search.top - 8);
      return { x: 0, y: window.scrollY + top, width: 440, height: Math.ceil(bottom - top + 16) };
    });
    await page.screenshot({ path: shots.preview, clip: previewClip });

    async function shootReader(url, file, ready, width, height) {
      await page.setViewport({ width, height, deviceScaleFactor: 2 });
      await page.goto(url, { waitUntil: "networkidle0", timeout: 20000 });
      await page.waitForFunction(ready, { timeout: 10000 });
      const overflow = await page.evaluate(() => {
        const thread = document.getElementById("thread");
        if (!thread) return 0;
        return Math.max(0, thread.scrollHeight - thread.clientHeight);
      });
      if (overflow > 24) {
        await page.setViewport({ width, height: height + overflow + 32, deviceScaleFactor: 2 });
        await page.waitForFunction(ready, { timeout: 10000 });
      }
      await page.screenshot({ path: file, fullPage: false });
    }

    const id = `chatgpt:${demo}`;
    await shootReader(
      `${origin}/v150/reader/index.html?id=${encodeURIComponent(id)}`,
      shots.before,
      () => {
        const text = document.querySelector(".msg-user .msg-body")?.textContent || "";
        return text.includes("# 京都三日") && text.includes("**红叶**") && text.includes("const quiet = true;");
      },
      980,
      1280,
    );

    await shootReader(
      `${origin}/reader/index.html?id=${encodeURIComponent(id)}`,
      shots.after,
      () => {
        const body = document.querySelector(".msg-user .msg-body");
        const text = body?.textContent || "";
        const link = body?.querySelector("a.md-anchor");
        const image = body?.querySelector(".md-image")?.textContent || "";
        return body?.querySelector("h1")?.textContent === "京都三日"
          && body?.querySelector("ul.md-list")
          && body?.querySelector("blockquote")
          && body?.querySelector("code.md-code")?.textContent === "cafe"
          && body?.querySelector("button.code-copy")?.textContent === "复制"
          && body?.querySelector("pre.code")?.textContent.includes("const quiet = true;")
          && body?.querySelector("table")
          && link?.getAttribute("target") === "_blank"
          && link?.textContent.includes("京都旅游")
          && link?.textContent.includes("https://www.city.kyoto.lg.jp/")
          && image.includes("[图片: 清水寺]")
          && image.includes("https://example.com/kiyomizu.jpg")
          && body?.querySelector("hr")
          && !body?.querySelector("img")
          && !text.includes("**")
          && !text.includes("```");
      },
      980,
      1280,
    );

    await shootReader(
      `${origin}/reader/index.html?id=${encodeURIComponent(id)}&q=${encodeURIComponent("红叶")}`,
      shots.hit,
      () => {
        const mark = document.querySelector("mark.is-current");
        return mark?.textContent === "红叶" && mark.parentElement?.tagName === "STRONG"
          && (document.getElementById("hitCount")?.textContent || "").startsWith("1 /");
      },
      980,
      860,
    );
    const yellow = await page.$eval("mark.is-current", (el) => getComputedStyle(el).backgroundColor);
    assert(yellow === "rgb(255, 224, 138)", `current hit background ${yellow}`);

    await page.setViewport({ width: 860, height: 520, deviceScaleFactor: 2 });
    await page.goto(
      `${origin}/reader/index.html?id=${encodeURIComponent(`chatgpt:${codeId}`)}&q=${encodeURIComponent("NEEDLE")}`,
      { waitUntil: "networkidle0", timeout: 20000 },
    );
    await page.waitForFunction(() => document.querySelector("pre.code mark.is-current")?.textContent === "NEEDLE", { timeout: 10000 });
    const wide = await page.evaluate(() => {
      const mark = document.querySelector("pre.code mark.is-current");
      const pre = mark.closest("pre");
      const markBox = mark.getBoundingClientRect();
      const preBox = pre.getBoundingClientRect();
      return {
        scrollLeft: pre.scrollLeft,
        markLeft: markBox.left,
        markRight: markBox.right,
        preLeft: preBox.left,
        preRight: preBox.right,
      };
    });
    assert(
      wide.markLeft >= wide.preLeft - 2 && wide.markRight <= wide.preRight + 2,
      `code hit is outside the fence ${JSON.stringify(wide)}`,
    );
    assert(wide.scrollLeft > 0, `code hit did not scroll horizontally ${JSON.stringify(wide)}`);
    assert(remote.length === 0, `unexpected network: ${remote.join(", ")}`);

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
