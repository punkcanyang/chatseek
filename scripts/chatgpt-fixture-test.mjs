import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sharedSrc = readFileSync(join(root, "content/shared.js"), "utf8");
const chatgptSrc = readFileSync(join(root, "content/chatgpt.js"), "utf8");
const threadHtml = readFileSync(join(root, "fixtures/chatgpt-thread.html"), "utf8");
const threadUrl = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function load(html, url) {
  const dom = new JSDOM(html, { url });
  const warns = [];
  const fn = new Function(
    "document",
    "location",
    "Node",
    "NodeFilter",
    "console",
    "chrome",
    `${sharedSrc}
     Chatseek.autoStart = false;
     ${chatgptSrc}
     return Chatseek;`,
  );
  const api = fn(
    dom.window.document,
    dom.window.location,
    dom.window.Node,
    dom.window.NodeFilter,
    { warn: (line) => warns.push(String(line)), log() {} },
    { runtime: { id: "test" } },
  );
  return { dom, api, warns };
}

const turned = load(threadHtml, threadUrl);
const turnedHit = turned.api.platforms.chatgpt.inspect();
assert(turnedHit.selector === "[data-turn]", `expected data-turn layer, got ${turnedHit.selector}`);
assert(turnedHit.messages.length === 2, `expected 2 messages, got ${turnedHit.messages.length}`);
assert(turnedHit.messages[0].role === "user", "user turn should stay user");
assert(turnedHit.messages[1].role === "assistant", "assistant data-turn must not be labeled user");
assert(turnedHit.messages[0].body.includes("zebrafox1008"), "user text missing");
assert(turnedHit.messages[1].body.includes("pangolin"), "assistant text missing");
assert(turnedHit.messages[1].body.includes("chart total 42"), "widget text should be kept");
assert(!/copy/i.test(turnedHit.messages[1].body), "composer chrome should be stripped");
assert(turnedHit.health.warn === false, "a matched thread should not warn");
assert(turnedHit.health.messageCount === 2, "health should report the message count");
assert(
  turnedHit.selectorsTried.includes("[data-message-author-role]") &&
    turnedHit.selectorsTried.includes("[data-message-id]"),
  "health should list the fallback selectors",
);

const classicHtml = `<main>
  <div data-message-author-role="user" data-message-id="u1"><div class="whitespace-pre-wrap">classic user line</div></div>
  <div data-message-author-role="assistant" data-message-id="a1"><div class="markdown">classic assistant line</div></div>
</main>`;
const classic = load(classicHtml, threadUrl);
const classicHit = classic.api.platforms.chatgpt.inspect();
assert(
  classicHit.selector === "[data-message-author-role]",
  `classic DOM should still use author role, got ${classicHit.selector}`,
);
assert(classicHit.messages.map((m) => m.role).join(",") === "user,assistant", "classic roles drifted");
assert(classicHit.messages[1].body.includes("classic assistant"), "classic assistant body missing");

const empty = load("<main><p>Welcome back</p></main>", threadUrl);
const emptyHit = empty.api.platforms.chatgpt.inspect();
assert(emptyHit.messages.length === 0, "empty thread should yield 0 messages");
assert(emptyHit.health.warn === true, "0 messages on /c/ should warn");
assert(emptyHit.health.pathKind === "conversation", " /c/ should be a conversation page");
assert(
  empty.warns.some((line) =>
    line.includes("[Chatseek] chatgpt: 0 messages on /c/ page, selectors tried:")
  ),
  `missing console hint: ${empty.warns.join(" | ")}`,
);

const temporary = load("<main></main>", `${threadUrl}?temporary-chat=true`);
const temporaryHit = temporary.api.platforms.chatgpt.inspect();
assert(temporaryHit.health.pathKind === "temporary", "temporary chats should be labeled");
assert(temporaryHit.health.warn === false, "temporary chats are not a selector failure");

const shadow = load('<main><div id="host"></div></main>', threadUrl);
const host = shadow.dom.window.document.getElementById("host");
const shadowRoot = host.attachShadow({ mode: "open" });
shadowRoot.innerHTML =
  '<div data-turn="user" data-message-id="sh1"><div class="whitespace-pre-wrap">shadow zebrafox</div></div>';
const shadowHit = shadow.api.platforms.chatgpt.inspect();
assert(shadowHit.messages.length === 1, "open shadow messages should be readable");
assert(shadowHit.messages[0].body.includes("shadow zebrafox"), "shadow body missing");
assert(shadowHit.messages[0].role === "user", "shadow data-turn role missing");

const shellHtml = `<main>
  <div data-message-author-role="assistant" data-message-id="shell"><h5>ChatGPT</h5><button type="button">Copy</button></div>
  <article data-testid="conversation-turn-8" data-turn="assistant" data-message-id="real">
    <div class="markdown"><p>The real prose is pangolin.</p></div>
  </article>
</main>`;
const shell = load(shellHtml, threadUrl);
const shellHit = shell.api.platforms.chatgpt.inspect();
assert(shellHit.messages.length === 1, `shell layer must not hide the turn: ${shellHit.messages.length}`);
assert(shellHit.messages[0].body.includes("pangolin"), "turn prose missing behind the shell");
assert(!/chatgpt/i.test(shellHit.messages[0].body), "speaker label was stored as the message");
assert(shellHit.selector === "[data-turn]", `shell should fall through, got ${shellHit.selector}`);
assert((shellHit.selectorHits?.["[data-message-author-role]"] || 0) >= 1, "diag should count the shell selector");

const rich = load(readFileSync(join(root, "fixtures/chatgpt-thread-2026.html"), "utf8"), threadUrl);
const richHit = rich.api.platforms.chatgpt.inspect();
assert(richHit.messages.length === 2, `2026 DOM messages ${richHit.messages.length}`);
assert(richHit.messages[0].role === "user" && richHit.messages[0].body === "line one\nline two", richHit.messages[0].body);
assert(!/[*#]|https?:/.test(richHit.messages[0].body), "user text should stay plain");
const answer = richHit.messages[1].body;
for (const piece of ["## 行程", "- 清水寺", "  - 塔", "1. 第二天", "```python", "print(\"hi\")", "| 天 | 安排 |", "| --- | --- |", "| 1 | 寺院 |", "**红叶**", "*安静*", "`cafe`", "[官网](https://www.city.kyoto.lg.jp/)", "> 靠窗", "---"]) {
  assert(answer.includes(piece), `markdown missing ${piece}\n${answer}`);
}
assert(!answer.includes("Copy"), "code chrome leaked");
assert(richHit.health.warn === false, "a 2026 thread with prose should not warn");

console.log("chatgpt-fixture ok", {
  selector: turnedHit.selector,
  messages: turnedHit.messages.length,
  emptyWarn: emptyHit.health.warn,
});
