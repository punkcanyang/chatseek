import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { markdownToPlain, safeLinkHref } from "../src/markdown.js";
import { renderMarkdown } from "../src/markdown-dom.js";
import {
  buildPreview,
  nextPreviewFields,
  presentPreview,
  selectIdlePreview,
} from "../src/preview.js";
import { collectHits, MAX_NODES, mountReader } from "../src/reader-view.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const dom = new JSDOM("<!DOCTYPE html><html><body><div id=\"app\"></div></body></html>");
const { document } = dom.window;
let copied = "";
Object.defineProperty(dom.window.navigator, "clipboard", {
  configurable: true,
  value: {
    writeText(value) {
      copied = String(value);
      return Promise.resolve();
    },
  },
});

function render(source, { hits = [], current = 0, locale = "zh-TW" } = {}) {
  const host = document.createElement("div");
  renderMarkdown(host, source, { hits, current, locale });
  return host;
}

function marks(host) {
  return [...host.querySelectorAll("mark")].map((mark) => ({
    text: mark.textContent,
    hit: mark.dataset.hit,
    current: mark.classList.contains("is-current"),
  }));
}

const heading = render("# 京都三日\n\n## 第二天");
assert(heading.querySelector("h1")?.textContent === "京都三日", "h1 text");
assert(heading.querySelector("h2")?.textContent === "第二天", "h2 text");
assert(!heading.textContent.includes("#"), "heading marks are not shown");

const emphasis = render("say **bold** and *em* and ***both*** and __also__");
assert(emphasis.querySelector("strong")?.textContent === "bold", "strong");
assert(emphasis.querySelector("em")?.textContent === "em", "em");
assert(emphasis.querySelector("em strong, strong em")?.textContent === "both", "bold italic");
assert(emphasis.textContent.includes("also"), "underscore strong");
assert(!emphasis.textContent.includes("**"), "emphasis markers hidden");

const lists = render("- one\n- two\n  - nested\n\n1. first\n2. second");
assert(lists.querySelectorAll("ul.md-list").length === 2, "bullet list and nested list");
assert(lists.querySelector("ol.md-list")?.children.length === 2, "ordered list");
assert(lists.textContent.includes("nested") && lists.textContent.includes("first"), "list text");
assert(!/^[-*] /m.test(lists.textContent), "bullets are not typed out");

const quote = render("> 靠窗的位置\n> 就好");
assert(quote.querySelector("blockquote.md-quote")?.textContent.includes("靠窗"), "blockquote");
assert(!quote.textContent.includes(">"), "quote marker hidden");

const inline = render("店名用 `cafe` 记下");
assert(inline.querySelector("code.md-code")?.textContent === "cafe", "inline code");
assert(!inline.textContent.includes("`"), "backticks hidden");

const fenced = render("before\n```js\nconst x = 1;\n```\nafter");
const pre = fenced.querySelector("pre.code");
assert(pre?.textContent === "const x = 1;", `fence text ${pre?.textContent}`);
assert(!fenced.textContent.includes("```"), "fence markers hidden");
assert(fenced.textContent.includes("before") && fenced.textContent.includes("after"), "text around the fence");
const copy = fenced.querySelector("button.code-copy");
assert(copy?.textContent === "複製" && copy.getAttribute("aria-label") === "複製", "copy button is localised");
copy.click();
await Promise.resolve();
assert(copied === "const x = 1;", `clipboard got ${copied}`);

const table = render("| 天 | 安排 |\n| ---: | :--- |\n| 1 | 清水寺 |\n| 2 | 咖啡馆 |");
assert(table.querySelector(".table-wrap table"), "table scrolls in a wrapper");
assert(table.querySelectorAll("th").length === 2, "header cells");
assert(table.querySelectorAll("td").length === 4, "body cells");
assert(table.querySelector("th.align-right") && table.querySelector("th.align-left"), "column alignment classes");
assert(!table.textContent.includes("|") && !table.textContent.includes("---"), "table pipes hidden");

const link = render("看 [京都旅游](https://www.city.kyoto.lg.jp/path)");
const anchor = link.querySelector("a.md-anchor");
assert(anchor?.getAttribute("href") === "https://www.city.kyoto.lg.jp/path", "https link href");
assert(anchor?.getAttribute("target") === "_blank", "link opens a new tab");
assert(anchor?.getAttribute("rel") === "noopener noreferrer", "link rel");
assert(anchor?.textContent.includes("京都旅游"), "link text");
assert(anchor?.textContent.includes("https://www.city.kyoto.lg.jp/path"), "link url is visible");

const http = render("plain http://example.com/a.");
assert(http.querySelector("a")?.getAttribute("href") === "http://example.com/a", "bare http url");
assert(http.textContent.endsWith("."), "trailing period stays outside the url");

for (const sample of [
  "[x](javascript:alert(1))",
  "[x](JaVaScRiPt:alert(1))",
  "[x](data:text/html,<script>alert(1)</script>)",
  "[x](file:///etc/passwd)",
  "[x](chrome-extension://abcdef/page.html)",
  "[x](/relative)",
  "[x](//evil.example/a)",
  "[x](mailto:a@b.c)",
]) {
  const host = render(sample);
  assert(host.querySelector("a") == null, `not clickable: ${sample}`);
  assert(host.textContent.includes("x") || host.textContent.includes("mailto") || host.textContent.includes("javascript") || host.textContent.includes("data:") || host.textContent.includes("file:") || host.textContent.includes("chrome-extension") || host.textContent.includes("/relative") || host.textContent.includes("evil"), `text kept for ${sample}`);
}

assert(safeLinkHref("javascript:alert(1)") === "", "javascript rejected");
assert(safeLinkHref("data:text/html,x") === "", "data rejected");
assert(safeLinkHref("file:///tmp/a") === "", "file rejected");
assert(safeLinkHref("chrome-extension://abc/x") === "", "extension url rejected");
assert(safeLinkHref("/relative") === "", "relative rejected");
assert(safeLinkHref("//evil.example/a") === "", "protocol-relative rejected");
assert(safeLinkHref("https://ok.example/a") === "https://ok.example/a", "https allowed");
assert(safeLinkHref("http://ok.example/a") === "http://ok.example/a", "http allowed");

const image = render("![清水寺](https://example.com/kiyomizu.png)", { locale: "zh-CN" });
assert(image.querySelector("img") == null, "remote image is not an element");
assert(image.textContent.includes("[图片: 清水寺]"), image.textContent);
assert(image.textContent.includes("https://example.com/kiyomizu.png"), "image url stays text");
assert(image.querySelector("a") == null, "image url is not a link");

const hr = render("上\n\n---\n\n下");
assert(hr.querySelector("hr.md-hr"), "thematic break");
assert(hr.textContent.includes("上") && hr.textContent.includes("下"), "text around the rule");

const payloads = [
  '<script>alert(1)</script>',
  '<img src="https://evil.example/a.png" onerror="globalThis.pwned=1">',
  '<img src=x onerror=alert(1)>',
  '**<script>alert(1)</script>**',
  '[click](javascript:alert(1))',
  '![x](https://evil.example/b.png)',
  '&#60;img src=x onerror=alert(1)&#62;',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '**_unclosed [link](javascript:alert(1))',
  '<div onclick="alert(1)"><iframe src="https://evil.example"></iframe></div>',
];
for (const sample of payloads) {
  const host = render(sample);
  assert(!host.querySelector("img, script, iframe, object, embed, video, audio, source"), `inert: ${sample}`);
  assert(!host.innerHTML.includes("<script") && !host.innerHTML.includes("<img") && !host.innerHTML.includes("<iframe"), `no raw tags: ${sample}`);
  for (const anchor of host.querySelectorAll("a")) {
    const href = anchor.getAttribute("href") || "";
    assert(/^https?:\/\//i.test(href), `payload href ${href}`);
    assert(!href.includes("%22"), `href swallowed a quote: ${href}`);
  }
}
assert(globalThis.pwned === undefined, "payloads did not run");
const quoted = render('<img src="https://evil.example/a.png" onerror="globalThis.pwned=1">');
assert(quoted.querySelector("a")?.getAttribute("href") === "https://evil.example/a.png", "bare url stops before the quote");
assert(quoted.textContent.includes("onerror"), "handler text stays visible");

function hitHost(source, query) {
  const hits = collectHits("", [{ body: source }], query)
    .filter((hit) => hit.where === "message")
    .map((hit, index) => ({ index: collectHits("", [{ body: source }], query).indexOf(hit), range: hit.range }));
  const all = collectHits("", [{ body: source }], query);
  const mapped = all.map((hit, index) => ({ index, range: hit.range }));
  return { host: render(source, { hits: mapped, current: 0 }), hits: all };
}

const across = hitHost("pre**bold**post", '"eb"');
const acrossMarks = marks(across.host);
assert(acrossMarks.length === 2 && acrossMarks.every((mark) => mark.hit === "0" && mark.current), `span marks ${JSON.stringify(acrossMarks)}`);
assert(acrossMarks.map((mark) => mark.text).join("") === "eb", "visible parts of the spanning hit");
assert(across.host.querySelector("strong mark")?.textContent === "b", "part of the hit is inside strong");

const inside = hitHost("Say **hello world** today", "hello");
assert(inside.host.querySelector("strong mark")?.textContent === "hello", "hit inside bold");

const codeHit = hitHost(`before\n\`\`\`\n${"x".repeat(60)} const NEEDLE = 1;\n\`\`\``, "NEEDLE");
const codeMark = codeHit.host.querySelector("pre.code mark");
assert(codeMark?.textContent === "NEEDLE", "hit inside a code block");
assert(codeMark.closest("pre.code"), "code hit lives in the scroller");

const tableHit = hitHost("| 天 | **红叶** |\n| --- | --- |\n| 1 | 咖啡馆 |", "红叶");
assert(tableHit.host.querySelector("th strong mark, th mark")?.textContent === "红叶" || tableHit.host.querySelector("td strong mark, td mark, th strong mark")?.textContent === "红叶", "hit inside a table");
assert(tableHit.host.querySelector("mark")?.textContent === "红叶", "table hit text");

const userAndBot = new JSDOM("<!DOCTYPE html><div id=app></div>");
const app = userAndBot.window.document.getElementById("app");
const view = mountReader(app, {
  locale: "zh-CN",
  viewportHeight: 640,
  conversation: {
    id: "chatgpt:md",
    platform: "chatgpt",
    title: "行程",
    url: "https://chatgpt.com/c/md",
    updatedAt: Date.now(),
    updatedAtSource: "page-exact",
  },
  messages: [
    { id: "u", role: "user", body: "我想看**红叶**\n\n- 清水寺" },
    { id: "a", role: "assistant", body: "第二天去 `cafe`。\n\n```\nDay 2\n```" },
  ],
  query: "红叶 cafe",
});
assert(app.querySelector(".msg-user strong")?.textContent.includes("红叶"), "user markdown renders");
assert(app.querySelector(".msg-assistant code")?.textContent.includes("cafe") || app.querySelector(".msg-assistant .md-code")?.textContent === "cafe", "assistant inline code");
assert(app.querySelector(".msg-assistant pre.code")?.textContent.includes("Day 2"), "assistant fence");
assert(view.hitCount() === 2, `two hits, got ${view.hitCount()}`);
view.next();
assert(app.querySelector("mark.is-current")?.textContent.toLowerCase() === "cafe", "next reaches cafe");

const plain = markdownToPlain("# 京都三日\n\n十一月去看**红叶**。\n\n- 清水寺\n- `cafe`\n\n> 靠窗\n\n```\nDay 2\n```\n\n| 天 | 安排 |\n| --- | --- |\n| 1 | 咖啡馆 |\n\n[官网](https://www.city.kyoto.lg.jp/)\n\n![清水寺](https://example.com/a.png)\n\n---\n");
for (const symbol of ["#", "**", "`", "|", ">"]) {
  assert(!plain.includes(symbol), `plain text still has ${symbol}: ${plain}`);
}
assert(plain.includes("京都三日") && plain.includes("红叶") && plain.includes("清水寺") && plain.includes("cafe"), plain);
assert(plain.includes("靠窗") && plain.includes("Day 2") && plain.includes("咖啡馆"), plain);
assert(plain.includes("官网") && !plain.includes("city.kyoto"), "link preview keeps the label");
assert(plain.includes("https://example.com/a.png"), "image url remains readable");
assert(!plain.includes("!-") && !plain.includes("!["), "image punctuation is gone");

const stored = nextPreviewFields({}, [{ id: "u", role: "user", body: "# **红叶** 行程\n- 清水寺" }], ["u"]);
assert(stored.firstUserPreview.includes("**") || stored.firstUserPreview.includes("#"), "stored excerpt keeps the source");
const shown = selectIdlePreview({ firstUserPreview: stored.firstUserPreview, messageCount: 1 });
assert(shown.text.includes("红叶") && !shown.text.includes("**") && !shown.text.includes("#"), shown.text);

const searched = buildPreview(
  { title: "行程", firstUserPreview: stored.firstUserPreview, messageCount: 1 },
  "红叶",
  ["see **红叶** in the note"],
);
assert(searched.text.includes("红叶") && !searched.text.includes("**"), searched.text);
assert(searched.text.slice(searched.ranges[0][0], searched.ranges[0][1]) === "红叶", "preview highlight follows the stripped text");
assert(presentPreview("2 * 3 = 6") === "2 * 3 = 6", "loose asterisks stay");
assert(presentPreview("use_snake_case") === "use_snake_case", "snake case stays");

const heavyAt = [40, 1500, 2960];
function heavyBody(i) {
  const word = heavyAt.includes(i) ? "红叶" : "茶";
  const codeWord = i === 1500 ? "NEEDLE" : "quiet";
  return [
    `# 第 ${i} 天`,
    "",
    `段落里有 **${word}** 和 *斜体*。`,
    "",
    "- 清水寺",
    "- 哲学之道",
    "  - 室内",
    "",
    "> 靠窗的位置就好",
    "",
    "店名 `cafe`",
    "",
    "```",
    `${"x".repeat(48)} const ${codeWord} = ${i};`,
    "```",
    "",
    "| 天 | 安排 |",
    "| --- | --- |",
    `| ${i} | 咖啡馆 |`,
    "",
    `[官网](https://example.com/${i})`,
    "",
    `![图](https://example.com/${i}.png)`,
    "",
    "---",
    "",
    '<script>alert(1)</script>',
  ].join("\n");
}

const heavyMessages = Array.from({ length: 3000 }, (_, i) => ({
  id: `h-${i}`,
  role: i % 2 ? "assistant" : "user",
  body: heavyBody(i),
}));
const heavyDom = new JSDOM("<!DOCTYPE html><div id=app></div>");
const heavyApp = heavyDom.window.document.getElementById("app");
const started = performance.now();
const heavy = mountReader(heavyApp, {
  locale: "zh-CN",
  viewportHeight: 720,
  conversation: {
    id: "chatgpt:heavy",
    platform: "chatgpt",
    title: "很长",
    url: "https://chatgpt.com/c/heavy",
    updatedAt: Date.now(),
    updatedAtSource: "page-exact",
    messageCount: 3000,
  },
  messages: heavyMessages,
  query: "红叶",
});
const elapsed = performance.now() - started;
assert(elapsed < 1500, `3000 markdown messages took ${elapsed.toFixed(0)}ms`);
assert(heavy.renderedMessages() > 0 && heavy.renderedMessages() <= MAX_NODES, `bounded window ${heavy.renderedMessages()}`);
assert(heavyApp.querySelectorAll(".msg").length <= MAX_NODES, "mounted articles stay capped");
assert(heavyApp.querySelectorAll("img, script, iframe").length === 0, "heavy render created no active elements");
assert(heavy.hitCount() === heavyAt.length, `three markdown hits, got ${heavy.hitCount()}`);
for (let step = 0; step < heavyAt.length; step += 1) {
  if (step) heavy.next();
  const current = heavyApp.querySelector("mark.is-current");
  assert(current?.textContent === "红叶", `heavy hit ${step}`);
  assert(current.closest(".msg")?.dataset.index === String(heavyAt[step]), `jump ${step} -> ${current?.closest(".msg")?.dataset.index}`);
  assert(heavy.renderedMessages() <= MAX_NODES, "jumps stay bounded");
}
heavy.prev();
heavy.prev();
assert(heavyApp.querySelector("mark.is-current")?.closest(".msg")?.dataset.index === "40", "jump back to the first chunk");
const codeRoot = heavyDom.window.document.createElement("div");
const codeJump = mountReader(codeRoot, {
  locale: "en",
  viewportHeight: 640,
  conversation: {
    id: "chatgpt:codejump",
    platform: "chatgpt",
    title: "code",
    url: "https://chatgpt.com/c/codejump",
    updatedAt: Date.now(),
    updatedAtSource: "page-exact",
  },
  messages: heavyMessages,
  query: "NEEDLE",
});
assert(codeJump.hitCount() === 1, "one code needle");
assert(codeRoot.querySelector("pre.code mark.is-current")?.textContent === "NEEDLE", "code jump marks the needle inside the fence");
const parseStarted = performance.now();
const bench = heavyDom.window.document.createElement("div");
for (let i = 0; i < 60; i += 1) renderMarkdown(bench, heavyBody(i), { locale: "en" });
const parseElapsed = performance.now() - parseStarted;
assert(parseElapsed < 400, `60 markdown messages rendered in ${parseElapsed.toFixed(0)}ms`);
bench.replaceChildren();

const parserSrc = readFileSync(join(root, "src/markdown.js"), "utf8");
const domSrc = readFileSync(join(root, "src/markdown-dom.js"), "utf8");
assert(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(parserSrc + domSrc), "markdown renderer does not assign HTML");
assert(!/createElement\(\s*["'](img|script|iframe|object|embed)["']\s*\)/.test(domSrc), "renderer does not create active elements");
assert(!/cdn\.jsdelivr|unpkg\.com|cdnjs\.cloudflare|esm\.sh/.test(parserSrc + domSrc), "renderer has no CDN");

console.log("markdown-test ok", { elapsed: Math.round(elapsed), rendered: heavy.renderedMessages(), nodes: heavyApp.querySelectorAll("*").length });
