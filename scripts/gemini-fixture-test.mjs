import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { applySidebarEstimates, formatActivityLabel } from "../src/activity-time.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sharedSrc = readFileSync(join(root, "content/shared.js"), "utf8");
const geminiSrc = readFileSync(join(root, "content/gemini.js"), "utf8");
const threadHtml = readFileSync(join(root, "fixtures/gemini-thread.html"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function absoluteStamp(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
     ${geminiSrc}
     return Chatseek;`,
  );
  const api = fn(
    dom.window.document,
    dom.window.location,
    dom.window.Node,
    dom.window.NodeFilter,
    { warn: (line) => warns.push(String(line)), log() {} },
    { runtime: { id: "fixture" } },
  );
  return { api, warns };
}

const thread = load(threadHtml, "https://gemini.google.com/u/1/app/a1b2c3d4e5f67890");
const planned = thread.api.platforms.gemini.inspect();
const messages = planned.messages;

assert(messages.length === 4, `expected 4 messages, got ${messages.length}: ${JSON.stringify(messages)}`);
assert(
  messages.map((m) => m.role).join(",") === "user,assistant,user,assistant",
  `roles ${messages.map((m) => m.role).join(",")}`,
);
assert(messages[0].body.includes("ZUCCHINI_TOKEN"), "first user text missing");
assert(messages[1].body.includes("garden notes"), "first Gemini reply missing");
assert(messages[2].body.includes("RAINBOW_TOKEN"), "second user text missing");
assert(messages[3].body.includes("stays in order"), "second Gemini reply missing");

const blob = messages.map((m) => m.body).join("\n");
for (const banned of [
  "You said",
  "你說了",
  "Gemini 說了",
  "THINKING_SECRET",
  "THOUGHTS_CONTAINER_LEAK",
  "ONLY_THINKING",
  "INPUT_EDITOR_LEAK",
  "Show thinking",
  "Edit",
  "Copy",
]) {
  assert(!blob.includes(banned), `message text included ${banned}`);
}

assert(planned.conversation?.title === "Zucchini protocol", planned.conversation?.title);
assert(planned.health.warn === false, "a thread with messages should not warn");
assert(planned.health.messageCount === 4, "health should report the message count");
assert(planned.health.pathKind === "conversation", planned.health.pathKind);
assert(planned.selector === "user-query, model-response", planned.selector);
assert(
  planned.conversation.url === "https://gemini.google.com/u/1/app/a1b2c3d4e5f67890",
  planned.conversation.url,
);
assert(planned.conversation.updatedAt == null, "an undated Gemini thread must not invent a timestamp");
assert(planned.conversation.updatedAtSource == null, planned.conversation.updatedAtSource);

const sidebar = [...planned.sidebar].sort((a, b) => a.sidebarIndex - b.sidebarIndex);
assert(sidebar.length === 4, `sidebar ${sidebar.length}`);
const byId = Object.fromEntries(sidebar.map((row) => [row.platformId, row]));
assert(byId.a1b2c3d4e5f67890?.url === "https://gemini.google.com/u/1/app/a1b2c3d4e5f67890", "account prefix dropped");
assert(
  byId.bbccddee11223344?.url === "https://gemini.google.com/u/1/app/bbccddee11223344",
  `jslog row lost /u/1/: ${byId.bbccddee11223344?.url}`,
);
assert(
  byId.cafebabecafebabe?.url === "https://gemini.google.com/u/1/app/cafebabecafebabe",
  `plain /app link lost the open account: ${byId.cafebabecafebabe?.url}`,
);
assert(
  byId["0123456789abcdef"]?.url ===
    "https://gemini.google.com/u/1/gem/coding-helper/0123456789abcdef",
  byId["0123456789abcdef"]?.url,
);
assert(!sidebar.some((row) => /SHARE_SHOULD_SKIP|GEM_EDIT_SHOULD_SKIP|New chat/i.test(row.title)), "skipped pages were stored");
sidebar.forEach((row, index) => {
  assert(row.sidebarIndex === index, `sidebarIndex ${row.sidebarIndex} at ${index}`);
  assert(row.updatedAtSource == null, "undated sidebar rows stay unstamped for the shared estimate");
});
const noAnchor = applySidebarEstimates(sidebar, Date.now());
assert(noAnchor.every((row) => row.updatedAtSource === "first-seen"), "no anchors means first-seen");
for (let i = 1; i < noAnchor.length; i++) {
  assert(noAnchor[i - 1].updatedAt > noAnchor[i].updatedAt, "sidebar order should still sort newest first");
}
const unknownHant = formatActivityLabel(noAnchor[0], Date.now(), "zh-TW");
const unknownHans = formatActivityLabel(noAnchor[0], Date.now(), "zh-CN");
assert(unknownHant.unknown && unknownHant.text.includes("日期未知（收錄於"), unknownHant.text);
assert(unknownHans.unknown && unknownHans.text.includes("日期未知（收录于"), unknownHans.text);
assert(!unknownHant.text.includes("約"), "first-seen must not render as 約");

const shared = load(threadHtml, "https://gemini.google.com/share/deadbeefdeadbeef").api.platforms.gemini.inspect();
assert(shared.conversation === null, "share pages must not be stored");
assert(shared.messages.length === 0, "share page messages must not be stored");
assert(shared.health.pathKind === "other" && shared.health.warn === false, "share pages are not empty-thread failures");

const bare = load(threadHtml, "https://gemini.google.com/app").api.platforms.gemini.inspect();
assert(bare.platformId == null, "/app without an id must be skipped");
assert(bare.conversation === null, "id-less /app stored a conversation");
assert(bare.health.warn === false, "id-less /app must not warn");

const editor = load(threadHtml, "https://gemini.google.com/gem/coding-helper/edit").api.platforms.gemini.inspect();
assert(editor.platformId == null, "gem editor must be skipped");

const gem = load(threadHtml, "https://gemini.google.com/u/4/gem/coding-helper/0123456789abcdef")
  .api.platforms.gemini.inspect();
assert(gem.conversation?.platformId === "0123456789abcdef", "gem conversation id missing");
assert(
  gem.conversation.url === "https://gemini.google.com/u/4/gem/coding-helper/0123456789abcdef",
  gem.conversation.url,
);

const timed = load(
  `<!DOCTYPE html><html><body>
    <div class="conversation-items-container">
      <div data-test-id="conversation" jslog="c_aaaaaaaaaaaaaaaa">
        <div class="conversation-title">Newest</div>
      </div>
      <div data-test-id="conversation" jslog="c_bbbbbbbbbbbbbbbb">
        <div class="conversation-title">Middle</div>
        <time datetime="2024-05-01T00:00:00.000Z"></time>
      </div>
      <a href="/app/bbbbbbbbbbbbbbbb"><span class="conversation-title">Middle</span></a>
      <div data-test-id="conversation" jslog="c_cccccccccccccccc">
        <div class="conversation-title">Oldest</div>
      </div>
    </div>
  </body></html>`,
  "https://gemini.google.com/u/2/app/aaaaaaaaaaaaaaaa",
).api.platforms.gemini.inspect();
const rows = [...timed.sidebar].sort((a, b) => a.sidebarIndex - b.sidebarIndex);
assert(rows.length === 3, `timed sidebar ${rows.length}`);
const mid = rows.find((row) => row.platformId === "bbbbbbbbbbbbbbbb");
const newest = rows.find((row) => row.platformId === "aaaaaaaaaaaaaaaa");
const oldest = rows.find((row) => row.platformId === "cccccccccccccccc");
const exact = Date.parse("2024-05-01T00:00:00.000Z");
assert(mid?.updatedAtSource === "page-exact" && mid.updatedAt === exact, `middle ${mid?.updatedAtSource} ${mid?.updatedAt}`);
assert(newest.updatedAtSource == null && oldest.updatedAtSource == null, "neighbors must not be stamped in the adapter");
assert(
  newest.url === "https://gemini.google.com/u/2/app/aaaaaaaaaaaaaaaa",
  newest.url,
);
const estimated = applySidebarEstimates(rows, Date.now());
const estNew = estimated.find((row) => row.platformId === "aaaaaaaaaaaaaaaa");
const estMid = estimated.find((row) => row.platformId === "bbbbbbbbbbbbbbbb");
const estOld = estimated.find((row) => row.platformId === "cccccccccccccccc");
assert(estMid.updatedAt === exact && estMid.updatedAtSource === "page-exact", "anchor time must stay page-exact");
assert(estNew.updatedAtSource === "sidebar-rank" && estOld.updatedAtSource === "sidebar-rank", "neighbors should be sidebar-rank");
assert(estNew.updatedAt > estMid.updatedAt && estOld.updatedAt < estMid.updatedAt, "sidebar estimate should keep newest first");
assert(estNew.olderThanAt == null, "the row above the clock has no before-bound");
assert(estOld.olderThanAt === exact, "the row below stores the exact anchor time");
const stamp = absoluteStamp(exact);
const belowHant = formatActivityLabel(estOld, Date.now(), "zh-TW");
const belowHans = formatActivityLabel(estOld, Date.now(), "zh-CN");
const belowEn = formatActivityLabel(estOld, Date.now(), "en");
assert(belowHant.before && belowHant.text === `早於 ${stamp}` && !belowHant.text.includes("約"), belowHant.text);
assert(belowHans.before && belowHans.text === `早于 ${stamp}` && !belowHans.text.includes("约"), belowHans.text);
assert(belowEn.before && belowEn.text === `before ${stamp}`, belowEn.text);
const aboveHant = formatActivityLabel(estNew, Date.now(), "zh-TW");
assert(aboveHant.unknown && aboveHant.text.includes("日期未知（收錄於") && !aboveHant.text.includes("約"), aboveHant.text);
const midLabel = formatActivityLabel(estMid, Date.now(), "zh-TW");
assert(!midLabel.approx && !midLabel.before, "page-exact must not render as 約 or 早於");

const fallback = load(
  `<!DOCTYPE html><main>
    <div data-message-author-role="user"><p>FALLBACK_USER_TEXT</p></div>
    <div data-message-author-role="model">
      <div class="markdown">FALLBACK_MODEL_TEXT</div>
      <span class="cdk-visually-hidden">You said</span>
    </div>
  </main>`,
  "https://gemini.google.com/app/abcdefabcdefabcd",
).api.platforms.gemini.inspect();
const fb = fallback.messages;
assert(fb.length === 2, `fallback count ${fb.length}`);
assert(fallback.selector === "[data-message-author-role]", fallback.selector);
assert(fb[0].role === "user" && fb[0].body.includes("FALLBACK_USER_TEXT"), fb[0]?.body);
assert(fb[1].role === "assistant" && fb[1].body.includes("FALLBACK_MODEL_TEXT"), fb[1]?.body);
assert(!fb[1].body.includes("You said"), "fallback kept the screen-reader label");

const emptyLoad = load(
  `<!DOCTYPE html><title>Ghost - Google Gemini</title><body>
    <div class="ql-editor">INPUT_EDITOR_LEAK</div>
    <p>no messages here</p>
  </body>`,
  "https://gemini.google.com/u/3/app/eeeeeeeeeeeeeeee",
);
const ghost = emptyLoad.api.platforms.gemini.inspect();
assert(ghost.messages.length === 0, "empty page returned messages");
assert(ghost.sidebar.length === 0, "empty page returned sidebar rows");
assert(ghost.conversation?.updatedAt == null, "unknown time must not invent an activity timestamp");
assert(ghost.health.warn === true, "0 messages on an /app/<id> page should warn");
assert(ghost.health.pathKind === "conversation" && ghost.health.messageCount === 0, "empty thread health drifted");
assert(
  ghost.conversation.url === "https://gemini.google.com/u/3/app/eeeeeeeeeeeeeeee",
  ghost.conversation.url,
);
assert(
  emptyLoad.warns.some((line) =>
    line.includes("[Chatseek] gemini: 0 messages on conversation page, selectors tried:") &&
    line.includes("user-query, model-response")
  ),
  `missing gemini health warning: ${emptyLoad.warns.join(" | ")}`,
);
assert(!emptyLoad.warns.some((line) => line.includes("INPUT_EDITOR_LEAK")), "health log included page text");
assert(!JSON.stringify(ghost.conversation).includes("INPUT_EDITOR_LEAK"), "editor text leaked into the conversation");

for (const page of ["download", "settings", "extensions"]) {
  const viewed = load(threadHtml, `https://gemini.google.com/app/${page}`).api.platforms.gemini.inspect();
  assert(viewed.platformId == null && viewed.conversation === null, `/app/${page} is not a conversation`);
  assert(viewed.health.warn === false, `/app/${page} must not raise the redesign warning`);
}

const linked = load(
  `<!DOCTYPE html><body>
    <div class="conversation-items-container">
      <div data-test-id="conversation" jslog="c_1111111111111111">
        <div class="conversation-title">Real row<mat-icon>push_pin</mat-icon></div>
      </div>
      <div data-test-id="conversation" jslog="c_2222222222222222">
        <div class="conversation-title">Second row</div>
      </div>
    </div>
    <main>
      <div class="conversation-container" id="x1">
        <user-query><div class="query-text">continue</div></user-query>
        <model-response><message-content><div class="markdown">
          See <a href="https://gemini.google.com/app/3333333333333333">PASTED_LINK_TITLE</a>.
        </div></message-content></model-response>
      </div>
      <user-query><div class="query-text">continue</div></user-query>
      <user-query><div class="query-text">continue</div></user-query>
    </main>
  </body>`,
  "https://gemini.google.com/app/1111111111111111",
).api.platforms.gemini.inspect();
const linkedRows = [...linked.sidebar].sort((a, b) => a.sidebarIndex - b.sidebarIndex);
assert(
  linkedRows.map((row) => row.platformId).join() === "1111111111111111,2222222222222222",
  `a link inside a reply became a sidebar row: ${linkedRows.map((row) => row.title).join(" | ")}`,
);
assert(linkedRows[0].title === "Real row", `icon text leaked into title: ${linkedRows[0].title}`);
const linkedIds = linked.messages.map((m) => m.id);
assert(linked.messages.length === 4, `expected 4 messages, got ${linked.messages.length}`);
assert(new Set(linkedIds).size === linkedIds.length, `duplicate message ids: ${linkedIds.join(", ")}`);
assert(linkedIds[0] === "gemini:1111111111111111:x1:user", linkedIds[0]);
assert(linkedIds[1] === "gemini:1111111111111111:x1:assistant", linkedIds[1]);

console.log("gemini-fixture ok", {
  messages: messages.length,
  sidebar: sidebar.length,
  updatedAtSource: estMid.updatedAtSource,
});
