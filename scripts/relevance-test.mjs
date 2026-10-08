import "fake-indexeddb/auto";
import { clearAll, searchConversations, upsertConversations, upsertMessages } from "../src/db.js";
import { compareConversations, RELEVANCE_WEIGHT } from "../src/sort-list.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const { TITLE, PHRASE, USER, ASSISTANT, HIT_CAP } = RELEVANCE_WEIGHT;
assert(TITLE > PHRASE + USER * HIT_CAP, "TITLE stays above a phrase plus capped user hits");
assert(PHRASE > USER * HIT_CAP, "PHRASE stays above capped scattered user hits");
assert(USER > ASSISTANT * HIT_CAP, "one user hit stays above capped assistant hits");

const BASE = 1710000000000;

function chat(id, title, updatedAt) {
  return {
    id: `chatgpt:${id}`,
    platform: "chatgpt",
    platformId: id,
    title,
    url: `https://chatgpt.com/c/${id}`,
    updatedAt,
    updatedAtSource: "page-exact",
  };
}

function msgs(id, bodies, role = "user") {
  return bodies.map((body, index) => ({
    id: `${id}-m${index}`,
    role,
    body,
  }));
}

async function putMessages(id, title, updatedAt, bodies, role = "user") {
  await upsertMessages(chat(id, title, updatedAt), msgs(id, bodies, role));
}

async function ranked(query, dir = "desc") {
  return searchConversations({
    query,
    sort: { field: "relevance", dir, locale: "zh-CN" },
    scope: "all",
    limit: 80,
  });
}

function describe(rows) {
  return rows.map((row) => `${row.id}:${row.relevance}`).join(", ");
}

await clearAll();

await upsertConversations([chat("title-hit", "blue orchid notes", BASE + 1000)]);
await putMessages(
  "body-strong",
  "garden log",
  BASE + 9000,
  Array.from({ length: HIT_CAP + 4 }, () => "blue orchid"),
);

await putMessages("phrase-cjk", "周末安排", BASE + 2000, ["去咖啡馆坐一下"]);
await putMessages(
  "scatter-cjk",
  "行程备忘",
  BASE + 8000,
  Array.from({ length: 12 }, (_, index) => (index % 2 === 0 ? "想喝咖啡" : "啡馆在旁边")),
);

await putMessages("user-hit", "practice log", BASE + 3000, ["violin"]);
await putMessages(
  "assistant-hit",
  "recital notes",
  BASE + 7000,
  Array.from({ length: HIT_CAP + 12 }, () => "violin"),
  "assistant",
);

const scattered = "green stone and marble";
await upsertConversations([chat("title-phrase", "green marble bowl", BASE + 4000)]);
await putMessages("phrase-en", "studio notes", BASE + 5000, ["green marble"]);
await putMessages("hits-few", "few chips", BASE + 6000, Array.from({ length: 2 }, () => scattered));
await putMessages(
  "hits-cap",
  "cap chips",
  BASE + 6100,
  Array.from({ length: HIT_CAP }, () => scattered),
);
await putMessages(
  "hits-flood",
  "flood chips",
  BASE + 500,
  Array.from({ length: 100 }, () => scattered),
);

await putMessages("tie-new", "shelf new", BASE + 9500, ["quartz sample"]);
await putMessages("tie-old", "shelf old", BASE + 1500, ["quartz sample"]);

await putMessages("leaf-title", "落叶整理", BASE + 2500, ["秋天的红叶很美"]);
await putMessages("leaf-plain", "周末散步", BASE + 2400, ["秋天的红叶很美"]);
await putMessages("orchid-half", "blue notes", BASE + 2600, ["an orchid on the desk"], "assistant");

function watchMessages() {
  const storeProto = IDBObjectStore.prototype;
  const indexProto = IDBIndex.prototype;
  const origStoreCursor = storeProto.openCursor;
  const origGet = storeProto.get;
  const origIndexCursor = indexProto.openCursor;
  const origIndexGet = indexProto.get;
  let reads = 0;
  storeProto.openCursor = function (...args) {
    if (this.name === "messages") reads += 1;
    return origStoreCursor.apply(this, args);
  };
  storeProto.get = function (...args) {
    if (this.name === "messages") reads += 1;
    return origGet.apply(this, args);
  };
  indexProto.openCursor = function (...args) {
    if (this.objectStore?.name === "messages") reads += 1;
    return origIndexCursor.apply(this, args);
  };
  indexProto.get = function (...args) {
    if (this.objectStore?.name === "messages") reads += 1;
    return origIndexGet.apply(this, args);
  };
  return {
    reads: () => reads,
    restore() {
      storeProto.openCursor = origStoreCursor;
      storeProto.get = origGet;
      indexProto.openCursor = origIndexCursor;
      indexProto.get = origIndexGet;
    },
  };
}

const watch = watchMessages();
try {
  const titleVsBody = await ranked("blue orchid");
  assert(
    titleVsBody.map((row) => row.id).join() === "chatgpt:title-hit,chatgpt:body-strong,chatgpt:orchid-half",
    `title hit should beat a strong body hit, got ${describe(titleVsBody)}`,
  );
  const half = titleVsBody.find((row) => row.id === "chatgpt:orchid-half");
  assert(half.relevance < TITLE, `one word of two in the title is not a title hit (${half.relevance})`);

  const leaves = await ranked("红叶");
  const leafTitle = leaves.find((row) => row.id === "chatgpt:leaf-title");
  const leafPlain = leaves.find((row) => row.id === "chatgpt:leaf-plain");
  assert(leafTitle && leafPlain, `both 红叶 rows found ${describe(leaves)}`);
  assert(leafTitle.relevance < TITLE, `叶 alone in the title is not a title hit (${leafTitle.relevance})`);
  assert(leafTitle.relevance === leafPlain.relevance, `same body, same score ${describe(leaves)}`);
  assert(
    leaves.findIndex((row) => row.id === "chatgpt:leaf-title") < leaves.findIndex((row) => row.id === "chatgpt:leaf-plain"),
    "equal 红叶 scores keep the newer row first",
  );

  const cjk = await ranked("咖啡馆");
  assert(
    cjk.map((row) => row.id).join() === "chatgpt:phrase-cjk,chatgpt:scatter-cjk",
    `contiguous phrase should beat scattered CJK hits, got ${describe(cjk)}`,
  );

  const roles = await ranked("violin");
  assert(
    roles.map((row) => row.id).join() === "chatgpt:user-hit,chatgpt:assistant-hit",
    `user prompt should beat assistant volume, got ${describe(roles)}`,
  );

  const volume = await ranked("green marble");
  const byId = Object.fromEntries(volume.map((row) => [row.id, row]));
  const few = byId["chatgpt:hits-few"];
  const cap = byId["chatgpt:hits-cap"];
  const flood = byId["chatgpt:hits-flood"];
  const phrase = byId["chatgpt:phrase-en"];
  const titled = byId["chatgpt:title-phrase"];
  assert(few && cap && flood && phrase && titled, `volume search missing rows ${describe(volume)}`);
  assert(few.relevance < cap.relevance, `2 hits (${few.relevance}) should score below the cap (${cap.relevance})`);
  assert(flood.relevance === cap.relevance, `100 hits (${flood.relevance}) should tie the cap (${cap.relevance})`);
  assert(flood.relevance < phrase.relevance, "capped volume should stay under a phrase hit");
  assert(phrase.relevance < titled.relevance, "a phrase should stay under a title hit");
  assert(
    volume.findIndex((row) => row.id === "chatgpt:hits-cap")
      < volume.findIndex((row) => row.id === "chatgpt:hits-flood"),
    "equal capped scores keep the newer conversation first",
  );

  const tieDesc = await ranked("quartz", "desc");
  const tieAsc = await ranked("quartz", "asc");
  assert(
    tieDesc.map((row) => row.id).join() === "chatgpt:tie-new,chatgpt:tie-old",
    `newer tie should lead, got ${tieDesc.map((row) => `${row.id}:${row.relevance}:${row.updatedAt}`)}`,
  );
  assert(tieDesc[0].relevance === tieDesc[1].relevance, "the tie case really has equal scores");
  assert(
    tieAsc.map((row) => row.id).join() === tieDesc.map((row) => row.id).join(),
    "reversing relevance does not swap an equal-score tie",
  );

  const roleAsc = await ranked("violin", "asc");
  assert(
    roleAsc.map((row) => row.id).join() === "chatgpt:assistant-hit,chatgpt:user-hit",
    `direction toggle should reverse unequal relevance, got ${roleAsc.map((row) => row.id)}`,
  );
  assert(watch.reads() === 0, `relevance search read the messages store ${watch.reads()} times`);
} finally {
  watch.restore();
}

const older = { id: "old", relevance: 5, updatedAt: 20 };
const newer = { id: "new", relevance: 5, updatedAt: 30 };
for (const dir of ["asc", "desc"]) {
  const order = [older, newer]
    .slice()
    .sort((a, b) => compareConversations(a, b, { field: "relevance", dir }));
  assert(order[0].id === "new", `${dir} keeps the newer equal score first`);
}

console.log("relevance-test ok");
