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

function load(html, url, chrome = { runtime: { id: "test" } }) {
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
    chrome,
  );
  return { dom, api, warns };
}

const TOP_SELECTORS = [
  "[data-message-author-role]",
  "[data-turn]",
  "[data-testid*='conversation-turn']",
  "[data-turn-id], [data-turn-id-container]",
  "[data-message-id]",
  "[data-message-content]",
  "[class*='conversation-turn']",
  "main article",
];

function assertTopMisses(doc, label) {
  for (const sel of TOP_SELECTORS) {
    const n = doc.querySelectorAll(sel).length;
    assert(n === 0, `${label} top selector ${sel} hit ${n}`);
  }
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

const USER = "User asked about the pangolin habitat across the southern forest ridge today.";
const ASST = "Assistant explained that a pangolin rolls into a ball when it feels threatened.";
const iframeUrl = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";
const iframeCase = load(
  `<body><p>outer shell</p><iframe id="f"></iframe><footer><p>Footer chrome must stay out of the stored transcript entirely.</p></footer></body>`,
  iframeUrl,
);
const frame = iframeCase.dom.window.document.getElementById("f");
frame.contentDocument.body.innerHTML = `<main>
  <div><h2>You</h2><p>${USER}</p></div>
  <div><h2>ChatGPT</h2><p>${ASST}</p></div>
  <div><textarea>draft a very long prompt about pangolins that must not be stored</textarea></div>
</main>`;
assertTopMisses(iframeCase.dom.window.document, "iframe page");
assertTopMisses(frame.contentDocument, "iframe document");
const iframeHit = iframeCase.api.platforms.chatgpt.inspect();
assert(iframeHit.selector === "heuristic", `iframe prose should use heuristic, got ${iframeHit.selector}`);
assert(iframeHit.messages.length === 2, `iframe messages ${iframeHit.messages.length}`);
assert(iframeHit.messages[0].body.includes("southern forest ridge"), "iframe user body missing");
assert(iframeHit.messages[1].body.includes("rolls into a ball"), "iframe assistant body missing");
assert(iframeHit.messages.map((m) => m.role).join(",") === "user,assistant", `iframe roles ${iframeHit.messages.map((m) => m.role)}`);
assert(!iframeHit.messages.some((m) => /must not be stored|stored transcript/i.test(m.body)), "composer or footer leaked");
const iframeStructure = iframeHit.structure;
const iframeBlob = JSON.stringify(iframeStructure);
assert(!/pangolin|southern forest|must not be stored/i.test(iframeBlob), `iframe diag leaked text: ${iframeBlob}`);
assert(iframeStructure.main.includes("iframe"), `iframe main flag ${iframeStructure.main}`);
assert(iframeStructure.frames.some((item) => item.startsWith("about:")), `iframe host ${iframeStructure.frames}`);
assert(
  !iframeStructure.frames.some((item) => /[/?#]/.test(String(item))),
  `frame diag must be host only: ${JSON.stringify(iframeStructure.frames)}`,
);
const iframeLine = iframeCase.api.formatStructure(iframeStructure);
assert(/main=/.test(iframeLine) && /frames=/.test(iframeLine) && /shadows=/.test(iframeLine) && /skeleton=/.test(iframeLine), iframeLine);
assert(iframeLine.includes("iframe>") || iframeStructure.skeleton.includes("iframe>"), `skeleton ${iframeStructure.skeleton}`);

const shadowUrl = "https://chatgpt.com/c/33333333-3333-4333-8333-333333333333";
const openShadow = load(`<body><div id="host"></div></body>`, shadowUrl);
const openHost = openShadow.dom.window.document.getElementById("host");
const openRoot = openHost.attachShadow({ mode: "open" });
openRoot.innerHTML = `<main>
  <div><h2>You</h2><p>${USER}</p></div>
  <div><h2>ChatGPT</h2><p>${ASST}</p></div>
</main>`;
assertTopMisses(openShadow.dom.window.document, "open shadow page");
assert(openRoot.querySelectorAll("[data-turn]").length === 0, "open shadow fixture must not use the turn selector");
const openHit = openShadow.api.platforms.chatgpt.inspect();
assert(openHit.selector === "heuristic", `open shadow prose should use heuristic, got ${openHit.selector}`);
assert(openHit.messages.length === 2, `open shadow messages ${openHit.messages.length}`);
assert(openHit.messages[0].body.includes("southern forest ridge"), "open shadow user body missing");
assert(!/pangolin|southern forest/i.test(JSON.stringify(openHit.structure)), "open shadow diag leaked text");
assert(openHit.structure.shadows.some((item) => item.tag === "div" && item.mode === "open"), JSON.stringify(openHit.structure.shadows));
assert(openHit.structure.main.includes("shadow"), `shadow main flag ${openHit.structure.main}`);
assert(openHit.structure.skeleton.includes("shadow>"), `shadow skeleton ${openHit.structure.skeleton}`);

let closedRoot = null;
const closedUrl = "https://chatgpt.com/c/44444444-4444-4444-8444-444444444444";
const closedCase = load(`<body><div id="host"></div></body>`, closedUrl, {
  runtime: { id: "test" },
  dom: {
    openOrClosedShadowRoot(el) {
      return el?.id === "host" ? closedRoot : null;
    },
  },
});
const closedHost = closedCase.dom.window.document.getElementById("host");
closedRoot = closedHost.attachShadow({ mode: "closed" });
closedRoot.innerHTML = `<main><div><h2>ChatGPT</h2><p>${ASST}</p></div></main>`;
assert(closedHost.shadowRoot == null, "closed shadow is not exposed as shadowRoot");
assertTopMisses(closedCase.dom.window.document, "closed shadow page");
const closedHit = closedCase.api.platforms.chatgpt.inspect();
assert(closedHit.messages.length === 1, `closed shadow messages ${closedHit.messages.length}`);
assert(closedHit.messages[0].body.includes("rolls into a ball"), "closed shadow body missing");
assert(closedHit.selector === "heuristic", `closed shadow selector ${closedHit.selector}`);
assert(closedHit.structure.shadows.some((item) => item.mode === "closed"), JSON.stringify(closedHit.structure.shadows));
assert(!/pangolin|rolls into a ball/i.test(JSON.stringify(closedHit.structure)), "closed shadow diag leaked text");

const gizmoDecoy = "77777777-7777-4777-8777-777777777777";
const afterSlashC = "66666666-6666-4666-8666-666666666666";
assert(
  iframeCase.api.conversationIdFromPath(`/g/${gizmoDecoy}/c/${afterSlashC}?model=gpt-4`) === afterSlashC,
  "fixture id helper must keep the uuid after /c/",
);

console.log("chatgpt-fixture ok", {
  selector: turnedHit.selector,
  messages: turnedHit.messages.length,
  emptyWarn: emptyHit.health.warn,
});
