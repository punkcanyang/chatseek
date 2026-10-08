import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sharedSrc = readFileSync(join(root, "content/shared.js"), "utf8");
const id = "11111111-1111-4111-8111-111111111111";

const PIECES = [
  "## 行程",
  "- 清水寺",
  "  - 塔",
  "1. 第二天",
  "```python",
  'print("hi")',
  "| 天 | 安排 |",
  "| --- | --- |",
  "| 1 | 寺院 |",
  "**红叶**",
  "*安静*",
  "`cafe`",
  "[官网](https://www.city.kyoto.lg.jp/)",
  "> 靠窗",
  "---",
];

const rich = `
  <h2>行程</h2>
  <ul><li>清水寺<ul><li>塔</li></ul></li></ul>
  <ol><li>第二天</li></ol>
  <pre><code class="language-python">print("hi")</code></pre>
  <table>
    <tr><th>天</th><th>安排</th></tr>
    <tr><td>1</td><td>寺院</td></tr>
  </table>
  <p>看<strong>红叶</strong>，很<em>安静</em>，店名 <code>cafe</code>，<a href="https://www.city.kyoto.lg.jp/">官网</a>。</p>
  <blockquote><p>靠窗</p></blockquote>
  <hr>
  <button type="button">Copy</button>
`;

const user = `<div class="whitespace-pre-wrap">line one\nline two</div>`;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function load(file, html, url) {
  const src = readFileSync(join(root, file), "utf8");
  const dom = new JSDOM(html, { url });
  const fn = new Function(
    "document",
    "location",
    "Node",
    "NodeFilter",
    "console",
    "chrome",
    `${sharedSrc}
     Chatseek.autoStart = false;
     let captured = null;
     let handler = null;
     Chatseek.runCapture = async (_state, payload) => {
       captured = payload;
       return true;
     };
     Chatseek.observe = (next) => { handler = next; };
     ${src}
     return { api: Chatseek, handler, read: () => captured };`,
  );
  const loaded = fn(
    dom.window.document,
    dom.window.location,
    dom.window.Node,
    dom.window.NodeFilter,
    { warn() {}, log() {} },
    { runtime: { id: "markdown-capture", getManifest: () => ({ version: "1.6.1" }) } },
  );
  return {
    api: loaded.api,
    run: async () => {
      if (!loaded.handler) throw new Error(`${file} did not register a capture`);
      await loaded.handler();
      return loaded.read();
    },
  };
}

function expectMarkdown(platform, messages) {
  assert(messages.length === 2, `${platform} messages ${messages.length}`);
  const userMsg = messages.find((msg) => msg.role === "user");
  const answer = messages.find((msg) => msg.role === "assistant");
  assert(userMsg && answer, `${platform} roles ${messages.map((msg) => msg.role).join(",")}`);
  assert(userMsg.body.includes("line one") && userMsg.body.includes("line two"), `${platform} user ${userMsg.body}`);
  assert(!/[*#`]|https?:/.test(userMsg.body), `${platform} user kept markdown: ${userMsg.body}`);
  for (const piece of PIECES) {
    assert(answer.body.includes(piece), `${platform} missing ${piece}\n${answer.body}`);
  }
  assert(!answer.body.includes("Copy"), `${platform} code chrome leaked`);
  const diag = capturedDiag(messages);
  assert(diag.startsWith("[Chatseek] diag "), diag);
  assert(!/清水寺|红叶|line one|print/.test(diag), `${platform} diag leaked text: ${diag}`);
  assert(/user=1/.test(diag) && /assistant=1/.test(diag), diag);
}

function capturedDiag(messages) {
  const stats = { userCount: 0, assistantCount: 0, charCount: 0 };
  for (const msg of messages) {
    if (msg.role === "assistant") stats.assistantCount += 1;
    else stats.userCount += 1;
    stats.charCount += msg.body.length;
  }
  return ChatseekForDiag.formatDiag(ChatseekForDiag.diagFields({
    platform: "chatgpt",
    pathKind: "conversation",
    selector: "[data-turn]",
    selectorHits: { "[data-turn]": 2 },
    ...stats,
    healthState: "ok",
    title: messages.map((msg) => msg.body).join("\n"),
    body: messages.map((msg) => msg.body).join("\n"),
    prompt: "line one",
    alt: "清水寺",
    url: `https://chatgpt.com/c/${id}`,
  }));
}

const walkerDom = new JSDOM(`<main><article id="a">${rich}</article><article id="u">${user}</article></main>`);
const walker = new Function(
  "document",
  "Node",
  "console",
  "chrome",
  `${sharedSrc}
   Chatseek.autoStart = false;
   return Chatseek;`,
)(
  walkerDom.window.document,
  walkerDom.window.Node,
  { warn() {}, log() {} },
  { runtime: { getManifest: () => ({ version: "1.6.1" }) } },
);
const ChatseekForDiag = walker;
const assistantText = walker.domText(walkerDom.window.document.getElementById("a"), false).text;
const userText = walker.domText(walkerDom.window.document.getElementById("u"), true).text;
for (const piece of PIECES) assert(assistantText.includes(piece), `walker missing ${piece}\n${assistantText}`);
assert(userText === "line one\nline two", userText);
assert(!assistantText.includes("Copy"), "walker kept Copy");

const chatgpt = load(
  "content/chatgpt.js",
  `<main>
    <article data-testid="conversation-turn-1" data-turn="user" data-message-id="u">${user}</article>
    <article data-testid="conversation-turn-2" data-turn="assistant" data-message-id="a"><div class="markdown">${rich}</div></article>
  </main>`,
  `https://chatgpt.com/c/${id}`,
);
expectMarkdown("chatgpt", chatgpt.api.platforms.chatgpt.inspect().messages);

const claude = load(
  "content/claude.js",
  `<div data-testid="user-message">${user}</div>
   <div data-testid="assistant-message"><div class="font-claude-message">${rich}</div></div>`,
  `https://claude.ai/chat/${id}`,
);
expectMarkdown("claude", (await claude.run()).messages);

const gemini = load(
  "content/gemini.js",
  `<user-query><div class="query-text whitespace-pre-wrap">line one\nline two</div></user-query>
   <model-response><message-content class="markdown">${rich}</message-content></model-response>`,
  "https://gemini.google.com/app/a1b2c3d4e5f67890",
);
expectMarkdown("gemini", gemini.api.platforms.gemini.inspect().messages);

const grok = load(
  "content/grok.js",
  `<div data-message-author-role="user">${user}</div>
   <div data-message-author-role="assistant">${rich}</div>`,
  `https://grok.com/c/${id}`,
);
expectMarkdown("grok", (await grok.run()).messages);

console.log("markdown-capture ok", { pieces: PIECES.length });
