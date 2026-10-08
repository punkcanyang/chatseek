// Hostile input for the reader's Markdown: links that try to run script,
// raw HTML, input built to make the parser backtrack or recurse, very long
// lines, ragged tables, and search hits that land on markup.
import { JSDOM } from "jsdom";
import { markdownToPlain, parseMarkdown, safeLinkHref, visibleRanges } from "../src/markdown.js";
import { renderMarkdown } from "../src/markdown-dom.js";
import { bestSnippet, presentPreview, selectIdlePreview, nextPreviewFields } from "../src/preview.js";
import { collectHits, mountReader } from "../src/reader-view.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
const { document } = dom.window;
globalThis.pwned = undefined;

function render(source, opts = {}) {
  const host = document.createElement("div");
  renderMarkdown(host, source, { locale: "en", ...opts });
  return host;
}

function assertInert(host, label) {
  assert(!host.querySelector("img, script, iframe, object, embed, video, audio, source, svg, math, style, link, meta, form, input, base"), `active element: ${label}`);
  for (const el of host.querySelectorAll("*")) {
    for (const attr of el.getAttributeNames()) {
      assert(!/^on/i.test(attr), `event handler attribute ${attr}: ${label}`);
      assert(["class", "href", "target", "rel", "start", "data-hit", "aria-label", "type"].includes(attr), `unexpected attribute ${attr}: ${label}`);
    }
  }
  for (const anchor of host.querySelectorAll("[href]")) {
    const href = anchor.getAttribute("href");
    assert(anchor.tagName === "A", `href on ${anchor.tagName}: ${label}`);
    assert(/^https?:\/\/[^\s]/.test(href), `href ${href}: ${label}`);
    assert(new URL(href).protocol.match(/^https?:$/), `protocol ${href}: ${label}`);
    assert(anchor.getAttribute("target") === "_blank" && /\bnoopener\b/.test(anchor.getAttribute("rel")), `new tab + noopener: ${label}`);
  }
}

// 1. Links that must stay text.
const schemes = [
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "JAVASCRIPT:alert(1)",
  " javascript:alert(1)",
  "\tjavascript:alert(1)",
  "java\tscript:alert(1)",
  "java\nscript:alert(1)",
  "java%0ascript:alert(1)",
  "%6A%61vascript:alert(1)",
  "&#106;avascript:alert(1)",
  "&#x6A;avascript:alert(1)",
  "&#0000106&#0000097vascript:alert(1)",
  "javascript&colon;alert(1)",
  "javascript&#58;alert(1)",
  "\u0000javascript:alert(1)",
  "\u200bjavascript:alert(1)",
  "\ufeffjavascript:alert(1)",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "DATA:text/html,<script>alert(1)</script>",
  "data:image/svg+xml,<svg onload=alert(1)>",
  "vbscript:msgbox(1)",
  "VbScRiPt:msgbox(1)",
  "file:///etc/passwd",
  "chrome://settings",
  "chrome-extension://abcdefghijklmnop/reader/index.html",
  "blob:https://chatgpt.com/uuid",
  "filesystem:https://a/b",
  "about:blank",
  "//evil.example/a",
  "/\\evil.example",
  "\\\\evil.example\\share",
  "https:evil.example",
  "https:/evil.example",
  "http:\\\\evil.example",
  "ftp://evil.example/a",
  "mailto:a@b.c",
  "tel:123",
  "#top",
  "?q=1",
  "relative/path",
];
for (const dest of schemes) {
  assert(safeLinkHref(dest) === "", `safeLinkHref let through ${JSON.stringify(dest)}`);
  for (const sample of [`[x](${dest})`, `[x](<${dest}>)`, `[x](${dest} "t")`, `<${dest}>`, `![x](${dest})`, dest]) {
    const host = render(sample);
    assertInert(host, sample);
    if (!/https?:\/\//i.test(dest)) assert(host.querySelector("a") == null, `clickable: ${JSON.stringify(sample)}`);
  }
}
for (const ok of ["https://example.com/a?b=1#c", "HTTP://EXAMPLE.COM/", "https://例子.测试/路径", "http://127.0.0.1:8080/x"]) {
  assert(safeLinkHref(ok).startsWith("http"), `rejected ${ok}`);
}
{
  const host = render('[x](https://ok.example/a"onmouseover="alert(1))');
  assertInert(host, "quote in href");
  const href = host.querySelector("a")?.getAttribute("href") || "";
  assert(!href.includes('"'), `raw quote kept in href ${href}`);
}
{
  const host = render("[x](https://ok.example/a) and [y](javascript:alert(1)) and https://ok.example/b");
  assert(host.querySelectorAll("a").length === 2, "only the two http(s) links are anchors");
  assert(host.textContent.includes("javascript:alert(1)"), "the refused address stays readable");
}

// 2. Raw HTML is text.
const html = [
  "<script>globalThis.pwned=1</script>",
  "<SCRIPT SRC=https://evil.example/x.js></SCRIPT>",
  '<img src=x onerror="globalThis.pwned=1">',
  "<img/src=x/onerror=globalThis.pwned=1>",
  "<svg onload=globalThis.pwned=1>",
  "<svg><script>globalThis.pwned=1</script></svg>",
  "<math><mtext><table><mglyph><style><img src=x onerror=globalThis.pwned=1>",
  '<a href="javascript:globalThis.pwned=1">x</a>',
  '<iframe srcdoc="<script>parent.pwned=1</script>"></iframe>',
  '<object data="javascript:globalThis.pwned=1"></object>',
  "<style>*{background:url(https://evil.example/x)}</style>",
  '<link rel=stylesheet href="https://evil.example/x.css">',
  '<meta http-equiv="refresh" content="0;url=javascript:globalThis.pwned=1">',
  '<base href="https://evil.example/">',
  '<form action="https://evil.example"><input autofocus onfocus=globalThis.pwned=1>',
  "<!-- <img src=x onerror=globalThis.pwned=1> -->",
  "<![CDATA[<script>globalThis.pwned=1</script>]]>",
  "**<img src=x onerror=globalThis.pwned=1>**",
  "`<img src=x onerror=globalThis.pwned=1>`",
  "```html\n<img src=x onerror=globalThis.pwned=1>\n```",
  "| <script>globalThis.pwned=1</script> | b |\n| --- | --- |\n| <img src=x onerror=globalThis.pwned=1> | c |",
  "> <script>globalThis.pwned=1</script>",
  "- <img src=x onerror=globalThis.pwned=1>",
  "# <script>globalThis.pwned=1</script>",
  "[<img src=x onerror=globalThis.pwned=1>](https://ok.example)",
  "![<script>x</script>](https://evil.example/a.png)",
  "&lt;script&gt;globalThis.pwned=1&lt;/script&gt;",
];
for (const sample of html) {
  const host = render(sample);
  assertInert(host, sample);
  const visible = host.textContent;
  const angle = sample.match(/<[a-z!/]/i);
  if (angle) assert(visible.includes(angle[0]), `tag is not shown as text: ${sample} -> ${visible}`);
}
assert(globalThis.pwned === undefined, "no payload ran");

// 3. Backtracking, recursion, and long lines. Each case must finish quickly
// and must not overflow the stack.
const N = 60000;
const hostile = {
  openBrackets: "[".repeat(N),
  openLinks: "[a](".repeat(N / 4),
  openImages: "![".repeat(N / 2),
  nestedImages: "![".repeat(N / 4) + "x" + "](y)".repeat(N / 4),
  nestedLinks: "[".repeat(N / 4) + "x" + "](y)".repeat(N / 4),
  backtickRuns: Array.from({ length: 340 }, (_, i) => "`".repeat(i + 1)).join(" a "),
  backtickPairs: "` ``".repeat(N / 4),
  emPairs: "*a* ".repeat(N / 4),
  strongPairs: "**a** ".repeat(N / 6),
  openStars: "*a ".repeat(N / 3),
  starsThenUnders: "*a ".repeat(N / 6) + "b_ ".repeat(N / 6),
  ruleOfThree: "***a**".repeat(N / 6),
  underscores: "_".repeat(N),
  mixed: "**_[`<h".repeat(N / 7),
  autolinkOpen: "<".repeat(N),
  autolinkFar: "<https://a" + "b".repeat(N),
  destSpaces: "[a](" + " ".repeat(N) + "x",
  destParens: "[a](" + "(".repeat(N),
  titleOpen: '[a](x "'.repeat(N / 8),
  urlParens: "https://x/" + "(".repeat(N / 2) + ")".repeat(N / 2),
  urlTrailingParens: "https://x/a" + ")".repeat(N),
  manyUrls: "http://a.b ".repeat(N / 11),
  escapes: "\\".repeat(N),
  escapedBrackets: "\\[".repeat(N / 2),
  deepQuote: ">".repeat(N) + " x",
  quoteLadder: Array.from({ length: 300 }, (_, i) => ">".repeat(i) + " x").join("\n"),
  deepList: "- ".repeat(N / 2) + "x",
  listLadder: Array.from({ length: 300 }, (_, i) => "  ".repeat(i) + "- x").join("\n"),
  orderedLadder: Array.from({ length: 300 }, (_, i) => "   ".repeat(i) + "1. x").join("\n"),
  quoteListMix: "> - ".repeat(N / 4) + "x",
  hrLike: "* ".repeat(N / 2) + "x",
  setextLike: "a\n".repeat(N / 2) + "===",
  fenceNeverClosed: "```\n" + "x\n".repeat(N / 2),
  fencesAlternating: "```\n~~~\n".repeat(N / 8),
  tableWide: "|" + "a|".repeat(2000) + "\n|" + "-|".repeat(2000) + "\n|" + "b|".repeat(2000),
  tableRagged: "|a|b|c|\n|-|-|-|\n" + Array.from({ length: 3000 }, (_, i) => "|x".repeat(i % 9)).join("\n"),
  pipes: "|".repeat(N),
  longLine: "word ".repeat(N * 4),
  longWord: "a".repeat(N * 10),
  longUrl: "https://example.com/" + "a".repeat(N * 4),
  longCodeLine: "```\n" + "x".repeat(N * 4) + "\n```",
  crlf: "a\r\n".repeat(N / 3),
  headingSpaces: "# a" + " ".repeat(N) + "b",
  headingHashes: "# a" + " #".repeat(N / 2) + "x",
  spaceRun: "a" + " ".repeat(N) + "b",
  tabRun: "a" + "\t".repeat(N) + "b\n" + " \t".repeat(N / 2) + "c",
  nulls: "\u0000*a*\u0000".repeat(N / 6),
};
for (const [name, source] of Object.entries(hostile)) {
  const started = performance.now();
  let host;
  try {
    host = render(source);
    markdownToPlain(source);
    presentPreview(source);
  } catch (err) {
    throw new Error(`${name} threw: ${err.message}`);
  }
  const ms = performance.now() - started;
  assert(ms < 2500, `${name} took ${ms.toFixed(0)}ms`);
  assertInert(host, name);
}
{
  const started = performance.now();
  const blocks = parseMarkdown("[".repeat(400000));
  assert(blocks.length === 1, "one paragraph");
  assert(performance.now() - started < 1500, "400k open brackets parse in linear time");
}

// 4. Ragged tables keep every cell.
{
  const host = render("| a | b | c |\n| --- | --- | --- |\n| 1 |\n| 1 | 2 | 3 | 4 | 5 |\n| x | y |");
  const rows = [...host.querySelectorAll("tbody tr")].map((tr) => tr.children.length);
  assert(rows.join() === "3,5,3", `ragged rows ${rows.join()}`);
  assert(host.textContent.includes("4") && host.textContent.includes("5"), "cells past the header stay visible");
  assert(host.querySelectorAll("thead th").length === 3, "header width");
  const short = render("| a | b |\n| --- |\n| 1 | 2 |");
  assert(!short.querySelector("table"), "a delimiter row with the wrong width is not a table");
  assert(short.textContent.includes("| a | b |"), "and stays readable");
}

// 5. Search hits on rendered Markdown.
function view(bodies, query) {
  const page = new JSDOM("<!DOCTYPE html><div id=app></div>");
  const app = page.window.document.getElementById("app");
  const messages = bodies.map((body, i) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", body }));
  const controls = mountReader(app, {
    locale: "en",
    viewportHeight: 4000,
    conversation: { id: "chatgpt:hits", platform: "chatgpt", title: "t", url: "https://chatgpt.com/c/hits", updatedAt: Date.now() },
    messages,
    query,
  });
  return { app, controls, messages };
}
function distinctHits(app) {
  return new Set([...app.querySelectorAll("mark[data-hit]")].map((m) => m.dataset.hit)).size;
}

{
  const { app, controls } = view(["```python\nprint(1)\n```", "| a | b |\n| --- | --- |\n| 1 | 2 |", '[site](https://ok.example "python title")'], "python");
  assert(controls.hitCount() === 1, `hidden link title is not a hit, fence label is: ${controls.hitCount()}`);
  assert(app.querySelector(".code-lang mark.is-current")?.textContent === "python", "the code language label carries the hit");
}
{
  const { controls } = view(["| a | b |\n| --- | --- |\n| 1 | 2 |"], "|");
  assert(controls.hitCount() === 0, "table pipes are markup, not hits");
}
{
  const { controls } = view(["# Title\n\n**bold** and `code`"], "**");
  assert(controls.hitCount() === 0, "emphasis markers are not hits");
}
{
  const { app, controls } = view(["1. first\n2. room 1\n\n> 1) quoted"], "1");
  assert(controls.hitCount() === 1 && app.querySelector("li mark")?.textContent === "1", `list numbers are markup: ${controls.hitCount()}`);
  const fence = view(["~~~ js title=word\ncode word\n~~~"], "word");
  assert(fence.controls.hitCount() === 1 && fence.app.querySelector("pre mark"), "only the code line is a hit, not the fence info");
  const many = "word ".repeat(20000) + "\n" + "[a](https://x \"word\")";
  const started = performance.now();
  const big = view([many], "word");
  assert(big.controls.hitCount() === 20000, `title hit dropped, body hits kept: ${big.controls.hitCount()}`);
  assert(performance.now() - started < 4000, "the markup check stays bounded on a long line");
}
{
  const bodies = [
    "Kyoto **autumn leaves** trip",
    "See [autumn guide](https://example.com/autumn) now",
    "```\nconst autumn = 1; // autumn\n```",
    "| when | what |\n| --- | --- |\n| Nov | *autumn* |",
    "> quote about autumn\n\n- list autumn",
    "no match here",
    "`autumn` inline and au**tumn** split",
  ];
  const { app, controls } = view(bodies, "autumn");
  const expected = 1 + 2 + 2 + 1 + 2 + 0 + 1;
  assert(controls.hitCount() === expected, `hit count ${controls.hitCount()} != ${expected}`);
  assert(distinctHits(app) === expected, `painted hits ${distinctHits(app)} != ${expected}`);
  assert(app.querySelector("strong mark")?.textContent === "autumn", "hit inside bold");
  assert(app.querySelector("a.md-anchor mark")?.textContent === "autumn", "hit inside link text");
  assert(app.querySelector("a.md-anchor .md-url mark")?.textContent === "autumn", "hit inside the shown URL");
  assert(app.querySelector("pre.code mark")?.textContent === "autumn", "hit inside a code block");
  assert(app.querySelector("td em mark")?.textContent === "autumn", "hit inside a table cell");
  assert(app.querySelector("blockquote mark") && app.querySelector("li mark"), "hits in quote and list");
  assert(app.querySelector("code.md-code mark")?.textContent === "autumn", "hit inside inline code");
  const order = [];
  for (let i = 0; i < expected; i += 1) {
    if (i) controls.next();
    assert(controls.hitIndex() === i, `index ${controls.hitIndex()} at step ${i}`);
    const current = [...app.querySelectorAll("mark.is-current")];
    assert(current.length >= 1 && current.every((m) => m.dataset.hit === String(i)), `one current hit at step ${i}`);
    order.push(Number(current[0].closest(".msg").dataset.index));
  }
  assert(order.every((v, i) => i === 0 || v >= order[i - 1]), `next walks in reading order: ${order}`);
  controls.next();
  assert(controls.hitIndex() === expected - 1, "next stops at the last hit");
  for (let i = expected - 1; i > 0; i -= 1) controls.prev();
  assert(controls.hitIndex() === 0, "prev walks back to the first");
  controls.prev();
  assert(controls.hitIndex() === 0, "prev stops at the first hit");
  assert(app.querySelector("#hitCount").textContent.includes(`/ ${expected}`), "counter shows the visible total");
}
{
  const body = "x " + "needle ".repeat(4000);
  const started = performance.now();
  const { app, controls } = view([body], "needle");
  assert(controls.hitCount() === 4000, "4000 hits in one message");
  assert(app.querySelectorAll("mark").length === 4000, "each hit painted once");
  assert(performance.now() - started < 3000, "many hits in one message stay fast");
}
{
  // A newline in an inline code span is shown as a space. Each hit inside it
  // has to be its own mark; painting the whole span for the first hit drops
  // the rest, so Previous / Next cannot land on them.
  const wrapped = view(["before `foo\nbar` after foo"], "foo");
  const fooMarks = [...wrapped.app.querySelectorAll("mark")].map((mark) => mark.textContent);
  assert(wrapped.controls.hitCount() === 2, `two foo hits, one inside the span: ${wrapped.controls.hitCount()}`);
  assert(fooMarks.join("|") === "foo|foo", `each foo is its own mark: ${fooMarks.join("|")}`);
  const beta = view(["`alpha\nbeta`"], "beta");
  assert(beta.controls.hitCount() === 1 && beta.app.querySelector("code mark")?.textContent === "beta", "the hit is beta, not the whole span");
  const crlf = view(["`foo\r\nbar` and bar"], "bar");
  const barMarks = [...crlf.app.querySelectorAll("mark")].map((mark) => mark.textContent);
  assert(crlf.controls.hitCount() === 2 && barMarks.join("|") === "bar|bar", `CRLF code span keeps both hits: ${barMarks.join("|")}`);
  const spaced = view(["use ` cafe ` today"], "cafe");
  assert(spaced.controls.hitCount() === 1 && spaced.app.querySelector("code mark")?.textContent === "cafe", "a padded code span still highlights the word");
  const pair = view(["`one two\nthree two`", "tail"], "two");
  assert(pair.controls.hitCount() === 2, `two hits inside one wrapped span: ${pair.controls.hitCount()}`);
  pair.controls.next();
  assert(pair.controls.hitIndex() === 1, "next reaches the second hit in the span");
  const current = [...pair.app.querySelectorAll("mark.is-current")];
  assert(current.length === 1 && current[0].textContent === "two" && current[0].dataset.hit === "1", "the second hit is the one painted current");
}
{
  const source = "pre **bold** `x` [lab*el*](https://u.example/p \"title\") ![alt](https://i.example/a.png)";
  const ranges = visibleRanges(parseMarkdown(source));
  for (const [s, e] of ranges) assert(e > s && s >= 0 && e <= source.length, "visible range in bounds");
  const shown = ranges.map(([s, e]) => source.slice(s, e)).join("");
  assert(!shown.includes("**") && !shown.includes("`") && !shown.includes("title"), `markup in visible text ${shown}`);
  assert(shown.includes("https://u.example/p") && shown.includes("alt") && shown.includes("label"), `visible text ${shown}`);
  const strayCode = render("pre **bo`ld** x`");
  assert(strayCode.querySelector("code")?.textContent === "ld** x" && !strayCode.querySelector("strong"), "a code span binds tighter than emphasis");
  const hits = collectHits("", [{ body: source }], "https");
  assert(hits.length === 2, "both shown URLs are hits");
}

// 6. Side-panel previews.
{
  const legacy = "Plan ## Day 1 | a | b | | --- | --- | | 1 | 2 | ``` code ``` --- end";
  const shown = presentPreview(legacy);
  for (const marker of ["##", "|", "```", "---"]) assert(!shown.includes(marker), `legacy one-line excerpt still shows ${marker}: ${shown}`);
  assert(shown.includes("Day 1") && shown.includes("code") && shown.includes("end"), shown);
  assert(presentPreview("2 * 3 = 6 and C# or a - b") === "2 * 3 = 6 and C# or a - b", "prose symbols stay");
  const stored = nextPreviewFields({}, [{ id: "u", role: "user", body: "Intro\n\n## Plan\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```js\nx = a*b*c\n```" }], ["u"]);
  assert(stored.firstUserPreview.includes("\n"), "new excerpts keep line breaks");
  const idle = selectIdlePreview(stored);
  for (const marker of ["##", "|", "```", "---"]) assert(!idle.text.includes(marker), `excerpt shows ${marker}: ${idle.text}`);
  assert(idle.text.includes("a*b*c"), `code text is not re-parsed: ${idle.text}`);
  const snip = bestSnippet(["```\nconst v = a*b*c; // needle\n```"], "needle");
  assert(snip?.text.includes("a*b*c"), `snippet keeps code asterisks: ${snip?.text}`);
}

assert(globalThis.pwned === undefined, "nothing ran");
console.log("markdown-attack-test ok", { cases: schemes.length * 6 + html.length + Object.keys(hostile).length });
