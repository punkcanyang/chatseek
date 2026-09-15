import "fake-indexeddb/auto";
import {
  upsertMessages,
  searchConversations,
  stats,
} from "../src/db.js";

const longBody =
  "UNIQUE_NEEDLE_" + "padding".repeat(800) + "_END_MARKER_payload";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const origTx = IDBDatabase.prototype.transaction;
const openedDuringSearch = [];
let recording = false;
IDBDatabase.prototype.transaction = function (storeNames, mode) {
  if (recording) {
    const list = Array.isArray(storeNames) ? storeNames : [storeNames];
    openedDuringSearch.push(...list);
  }
  return origTx.call(this, storeNames, mode);
};

const origGetAll = IDBObjectStore.prototype.getAll;
IDBObjectStore.prototype.getAll = function (...args) {
  if (recording && this.name === "messages") {
    throw new Error("search called getAll() on the messages store");
  }
  return origGetAll.apply(this, args);
};

await upsertMessages(
  {
    id: "chatgpt:11111111-1111-1111-1111-111111111111",
    platform: "chatgpt",
    platformId: "11111111-1111-1111-1111-111111111111",
    title: "Alpha planning notes",
    url: "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111",
  },
  [
    { id: "chatgpt:m1", role: "user", body: longBody },
    { id: "chatgpt:m2", role: "assistant", body: "Short reply about bananas." },
  ],
);

await upsertMessages(
  {
    id: "claude:22222222-2222-2222-2222-222222222222",
    platform: "claude",
    platformId: "22222222-2222-2222-2222-222222222222",
    title: "Claude travel list",
    url: "https://claude.ai/chat/22222222-2222-2222-2222-222222222222",
  },
  [
    {
      id: "claude:m1",
      role: "user",
      body: "请帮我写一段关于京都红叶的介绍，包含哲学。",
    },
  ],
);


await upsertMessages(
  {
    id: "grok:33333333-3333-3333-3333-333333333333",
    platform: "grok",
    platformId: "33333333-3333-3333-3333-333333333333",
    title: "Grok rocket notes",
    url: "https://grok.com/c/33333333-3333-3333-3333-333333333333",
  },
  [
    {
      id: "grok:m1",
      role: "user",
      body: "Explain STARSHIP_NEEDLE boosters without truncating this long body.",
    },
    {
      id: "grok:m2",
      role: "assistant",
      body: "STARSHIP_NEEDLE stages stack for orbital insertion.",
    },
  ],
);

const s = await stats();
assert(s.messages === 5, `expected 5 messages, got ${s.messages}`);
assert(longBody.length > 4000, "fixture must be a long message");

recording = true;
const byNeedle = await searchConversations({ query: "UNIQUE_NEEDLE" });
const byEnd = await searchConversations({ query: "END_MARKER" });
const byCjk = await searchConversations({ query: "京都" });
const byGrok = await searchConversations({ query: "STARSHIP_NEEDLE", platform: "grok" });
recording = false;

assert(
  byNeedle.length === 1 && byNeedle[0].id.startsWith("chatgpt:"),
  "long-message needle should hit ChatGPT conversation",
);
assert(byEnd.length === 1, "token near the end of a long body should hit");
assert(
  byCjk.some((row) => row.platform === "claude"),
  "CJK tokens in message body should hit",
);
assert(
  byGrok.length === 1 && byGrok[0].platform === "grok",
  "platform filter should hit Grok conversation",
);
assert(
  !openedDuringSearch.includes("messages"),
  `search opened messages store: ${openedDuringSearch.join(",")}`,
);

console.log("search-test ok", {
  longBody: longBody.length,
  stores: [...new Set(openedDuringSearch)],
  stats: s,
});
