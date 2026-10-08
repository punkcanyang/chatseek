import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sharedSrc = readFileSync(join(root, "content/shared.js"), "utf8");
const chatgptSrc = readFileSync(join(root, "content/chatgpt.js"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const ACTIVE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OPEN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OLD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function load(html, url) {
  const dom = new JSDOM(html, { url });
  const sent = [];
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
    { warn() {}, log() {} },
    {
      runtime: {
        id: "test",
        sendMessage(payload, cb) {
          sent.push(payload);
          cb({ ok: true });
        },
      },
    },
  );
  return { api, sent, dom };
}

async function capture(html, url) {
  const loaded = load(html, url);
  const ok = await loaded.api.platforms.chatgpt.capture();
  assert(ok === true, "capture should ack");
  const batches = loaded.sent.filter((row) => row.type === "CAPTURE_CONVERSATIONS");
  const rows = batches.flatMap((row) => row.conversations || []);
  return { rows, signals: loaded.api.readArchiveSignals(loaded.dom.window.document, loaded.dom.window.location, "chatgpt") };
}

const story = await capture(`
  <nav>
    <a href="/c/${ACTIVE}">Active trip</a>
  </nav>
  <main>
    <div data-turn="user" data-message-id="m1"><div class="markdown">This conversation is archived in the story only</div></div>
  </main>
`, `https://chatgpt.com/c/${OPEN}`);
const storyOpen = story.rows.find((row) => row.platformId === OPEN);
const storyActive = story.rows.find((row) => row.platformId === ACTIVE);
assert(story.signals.banner === false, "message text is not an archive banner");
assert(storyOpen?.archived === false && storyOpen.archiveSource === "chatgpt:conversation", JSON.stringify(storyOpen));
assert(storyActive?.archived === false && storyActive.archiveSource === "chatgpt:sidebar", "sidebar row stays active");

const banner = await capture(`
  <nav><a href="/c/${ACTIVE}">Active trip</a></nav>
  <main>
    <div role="status">This conversation is archived. <button type="button">Unarchive</button></div>
    <div data-turn="user" data-message-id="m1"><div class="markdown">hello from the thread</div></div>
  </main>
`, `https://chatgpt.com/c/${OPEN}`);
const bannerOpen = banner.rows.find((row) => row.platformId === OPEN);
assert(banner.signals.banner === true, "status banner should count");
assert(bannerOpen?.archived === true && bannerOpen.archiveSource === "chatgpt:banner", JSON.stringify(bannerOpen));
assert(banner.rows.find((row) => row.platformId === ACTIVE)?.archived === false, "other sidebar row stays active");

const menu = load(`
  <nav><a href="/c/${ACTIVE}">Active trip</a></nav>
  <div role="menu"><button role="menuitem" type="button">Unarchive chat</button></div>
  <main><div data-turn="user" data-message-id="m1"><div class="markdown">still active</div></div></main>
`, `https://chatgpt.com/c/${OPEN}`);
assert(
  menu.api.readArchiveSignals(menu.dom.window.document, menu.dom.window.location, "chatgpt").banner === false,
  "a menu item named Unarchive is not a conversation banner",
);

const listed = await capture(`
  <nav><a href="/c/${ACTIVE}">Active trip</a></nav>
  <div role="dialog" aria-label="Archived chats">
    <h2>Archived chats</h2>
    <a href="/c/${OLD}">Old camera</a>
    <a href="/c/${ACTIVE}">Active trip</a>
  </div>
`, "https://chatgpt.com/");
const listedOld = listed.rows.find((row) => row.platformId === OLD);
const listedActive = listed.rows.filter((row) => row.platformId === ACTIVE);
assert(listed.signals.archiveRoot, "archive dialog should be found");
assert(listedOld?.archived === true && listedOld.archiveSource === "chatgpt:archive-list", JSON.stringify(listedOld));
assert(listedOld.sidebarIndex == null, "archive-list rows are not sidebar-rank neighbours");
assert(listedActive.length === 1 && listedActive[0].archived === false, "a chat still in the sidebar stays active");
assert(!listed.rows.some((row) => row.platformId === OLD && row.archived === false), "archive-only chat is not marked active");

const claudeDom = load(`
  <div role="dialog"><h2>Archived chats</h2><a href="/chat/${OLD}">Old</a></div>
  <p role="status">This conversation is archived</p>
`, "https://claude.ai/chat/" + OLD);
assert(
  claudeDom.api.readArchiveSignals(claudeDom.dom.window.document, claudeDom.dom.window.location, "claude").supported === false,
  "Claude has no conversation-archive signal",
);
assert(
  claudeDom.api.readArchiveSignals(claudeDom.dom.window.document, claudeDom.dom.window.location, "grok").supported === false,
  "Grok has no archive signal",
);
assert(
  claudeDom.api.readArchiveSignals(claudeDom.dom.window.document, claudeDom.dom.window.location, "gemini").supported === false,
  "Gemini has no archive signal",
);

const db = await import("../src/db.js");

function requestDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const pid = (n) => `${n}${n}${n}${n}${n}${n}${n}${n}-0000-4000-8000-00000000000${n}`;
const conv = (platform, n, title, extra = {}) => ({
  id: `${platform}:${pid(n)}`,
  platform,
  platformId: pid(n),
  title,
  url: platform === "claude"
    ? `https://claude.ai/chat/${pid(n)}`
    : platform === "gemini"
      ? `https://gemini.google.com/app/${pid(n)}`
      : `https://chatgpt.com/c/${pid(n)}`,
  updatedAt: Date.now() - n * 1000,
  updatedAtSource: "page-exact",
  ...extra,
});

const kept = conv("chatgpt", "1", "Scopeword active gpt");
await db.upsertConversations([kept]);
await db.upsertConversations([{ ...kept, archived: true, archiveSource: "chatgpt:banner" }]);
const handle = await db.openDb();
const read = (id) => requestDone(handle.transaction("conversations").objectStore("conversations").get(id));
let row = await read(kept.id);
assert(row.archived === true && row.archiveSource === "chatgpt:banner" && row.archivedAt > 0, "archive state is stored");
const stamped = row.archivedAt;
await db.upsertConversations([{ ...kept, title: "Scopeword active gpt", archived: true, archiveSource: "chatgpt:banner" }]);
row = await read(kept.id);
assert(row.archivedAt === stamped, "the same archive source keeps its timestamp");
await db.upsertConversations([{ ...kept, title: "Scopeword renamed" }]);
row = await read(kept.id);
assert(row.archived === true && row.title === "Scopeword renamed", "omitting archived does not clear it");
await db.upsertConversations([conv("chatgpt", "2", "Scopeword neighbour", { archived: false, archiveSource: "chatgpt:sidebar" })]);
row = await read(kept.id);
assert(row.archived === true, "a sidebar scan that does not include the chat leaves it archived");
await db.upsertConversations([{ ...kept, archived: false, archiveSource: "chatgpt:sidebar" }]);
row = await read(kept.id);
assert(row.archived === false && row.archiveSource == null && row.archivedAt == null, "seeing it active restores it");

const activeGpt = conv("chatgpt", "3", "Scopeword beach");
const archivedGpt = conv("chatgpt", "4", "Scopeword camera", { archived: true, archiveSource: "chatgpt:archive-list" });
const activeClaude = conv("claude", "5", "Scopeword invoice");
const archivedGemini = conv("gemini", "6", "Scopeword orchid", { archived: true, archiveSource: "chatgpt:banner" });
await db.upsertConversations([activeGpt, archivedGpt, activeClaude, archivedGemini]);
for (const item of [activeGpt, archivedGpt, activeClaude, archivedGemini]) {
  const msg = { id: `${item.id}:u`, role: "user", body: `scopeword body ${item.title}` };
  await db.upsertMessages(item, [msg], { pageMessageIds: [msg.id], captureId: item.id });
}

const ids = (rows) => rows.map((item) => item.id).sort();
assert(
  ids(await db.listRecent({ scope: "active", limit: 20 })).join() === [activeGpt.id, kept.id, conv("chatgpt", "2", "").id, activeClaude.id].sort().join(),
  "active tab is every unarchived platform",
);
assert(
  ids(await db.searchConversations({ query: "scopeword", scope: "active", platform: "chatgpt" })).every((id) => id.startsWith("chatgpt:")),
  "platform search stays on that platform",
);
const gptActive = await db.searchConversations({ query: "scopeword", scope: "active", platform: "chatgpt" });
assert(!gptActive.some((item) => item.id === archivedGpt.id), "ChatGPT tab hides archived chats");
assert(gptActive.some((item) => item.id === activeGpt.id), "ChatGPT tab shows the active chat");
const archivedHits = await db.searchConversations({ query: "scopeword", scope: "archived" });
assert(ids(archivedHits).join() === [archivedGpt.id, archivedGemini.id].sort().join(), `archived search ${ids(archivedHits)}`);
const allHits = await db.searchConversations({ query: "camera", scope: "all" });
assert(allHits.some((item) => item.id === archivedGpt.id), "all tab search includes archived chats");
const activeMiss = await db.searchConversations({ query: "camera", scope: "active" });
assert(activeMiss.length === 0, "active tab search does not return the archived camera chat");

await db.removeConversation(archivedGpt.id);
assert((await db.searchConversations({ query: "camera", scope: "all" })).length === 0, "remove drops the conversation from search");
assert((await read(archivedGpt.id)) == null, "remove drops the conversation row");
const msgLeft = await requestDone(handle.transaction("messages").objectStore("messages").get(`${archivedGpt.id}:u`));
assert(msgLeft == null, "remove drops messages");
const tokenLeft = await requestDone(
  handle.transaction("tokenMap").objectStore("tokenMap").index("conversationId").get(archivedGpt.id),
);
assert(tokenLeft == null, "remove drops inverted index rows");
assert((await db.searchConversations({ query: "beach", scope: "all" })).length === 1, "other chats stay searchable");

await db.upsertConversations([conv("chatgpt", "4", "Scopeword camera again")]);
const again = await read(archivedGpt.id);
assert(again && again.archived !== true, "a later visit can capture the chat again as active");

console.log("archive-test ok");
