// Last-activity clock. A new ending is observed and can only move forward.
// Opening the same ending, scrollback, and a shorter repaint must not.
import "fake-indexeddb/auto";
import { openDb, readConversation, readConversationRow, readImagesForMessages, saveImageRecords, searchConversations, upsertConversations, upsertMessages } from "../src/db.js";
import { formatActivityLabel } from "../src/activity-time.js";

const OLD_AT = Date.UTC(2024, 3, 2, 9, 0, 0);
const USER = "The ridge path stays dry until the afternoon rain starts.";
const ASST = "A pangolin rolls into a ball when the ridge feels unsafe.";
const NEXT = "NEW_TAIL_TOKEN The pangolin asked what the ridge looks like after rain.";
const PLATFORMS = ["chatgpt", "claude", "gemini", "grok"];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function convId(platform, n) {
  const hex = { chatgpt: "a", claude: "b", gemini: "c", grok: "d" }[platform];
  const platformId = `${hex.repeat(8)}-${hex.repeat(4)}-4${hex}${hex}${hex}-8${String(n).padStart(3, "0")}-${hex.repeat(11)}${n}`;
  return { id: `${platform}:${platformId}`, platformId };
}

function row(platform, n, extra = {}) {
  const { id, platformId } = convId(platform, n);
  return {
    id,
    platform,
    platformId,
    title: `${platform} habitat ${n}`,
    url: `https://${platform}.example/c/${platformId}`,
    updatedAt: OLD_AT,
    updatedAtSource: "page-exact",
    ...extra,
  };
}

function read(platform, n) {
  return readConversationRow(convId(platform, n).id);
}

async function put(platform, n, messages, meta) {
  await upsertMessages(row(platform, n), messages, meta);
  return read(platform, n);
}

for (const platform of PLATFORMS) {
  const id = convId(platform, 1).id;
  const userId = `${id}:u`;
  const asstId = `${id}:a`;
  const newId = `${id}:new`;
  let clock = await put(platform, 1, [
    { id: userId, role: "user", body: USER },
    { id: asstId, role: "assistant", body: ASST },
  ], { pageMessageIds: [userId, asstId], captureId: `${platform}-init` });
  assert(clock.updatedAtSource === "page-exact" && clock.updatedAt === OLD_AT, `${platform} first ingest ${clock.updatedAtSource} ${clock.updatedAt}`);

  await sleep(8);
  clock = await put(platform, 1, [
    { id: userId, role: "user", body: USER },
    { id: asstId, role: "assistant", body: ASST },
  ], { pageMessageIds: [userId, asstId], captureId: `${platform}-reopen` });
  assert(clock.updatedAt === OLD_AT && clock.updatedAtSource === "page-exact", `${platform} reopen became ${clock.updatedAtSource}`);

  await sleep(8);
  clock = await put(platform, 1, [
    { id: newId, role: "user", body: NEXT },
  ], { pageMessageIds: [userId, asstId, newId], captureId: `${platform}-append` });
  assert(clock.updatedAtSource === "observed" && clock.updatedAt > OLD_AT, `${platform} stable append ${clock.updatedAtSource} ${clock.updatedAt}`);
  assert(formatActivityLabel(clock, Date.now(), "zh-TW").text === "剛剛", `${platform} label ${formatActivityLabel(clock, Date.now(), "zh-TW").text}`);
  const forwarded = clock.updatedAt;
  await upsertConversations([row(platform, 1, { sidebarIndex: 0 })]);
  clock = await read(platform, 1);
  assert(clock.updatedAt === forwarded && clock.updatedAtSource === "observed", `${platform} older page-exact rolled the clock back`);
  await upsertConversations([row(platform, 1, { updatedAt: Date.now(), updatedAtSource: "page-bucket", sidebarIndex: 0 })]);
  clock = await read(platform, 1);
  assert(clock.updatedAt === forwarded && clock.updatedAtSource === "observed", `${platform} page-bucket overwrote observed`);

  const sameId = convId(platform, 2).id;
  const sameUser = `${sameId}:u`;
  const sameAsst = `${sameId}:a`;
  clock = await put(platform, 2, [
    { id: sameUser, role: "user", body: USER },
    { id: sameAsst, role: "assistant", body: ASST },
  ], { pageMessageIds: [sameUser, sameAsst], captureId: `${platform}-same-init` });
  await sleep(8);
  clock = await put(platform, 2, [
    { id: `${sameId}:hu`, role: "user", body: USER },
    { id: `${sameId}:ha`, role: "assistant", body: `**${ASST}**` },
  ], { pageMessageIds: [`${sameId}:hu`, `${sameId}:ha`], captureId: `${platform}-same-rekey` });
  assert(clock.updatedAt === OLD_AT && clock.updatedAtSource === "page-exact", `${platform} same-ending rekey ${clock.updatedAtSource} ${clock.updatedAt}`);
  const sameRead = await readConversation(sameId);
  assert(sameRead.messages.length === 2, `${platform} rekey duplicated ${sameRead.messages.length}`);

  const shotId = convId(platform, 3).id;
  clock = await put(platform, 3, [
    { id: `${shotId}:u`, role: "user", body: USER },
    { id: `${shotId}:a`, role: "assistant", body: ASST },
  ], { pageMessageIds: [`${shotId}:u`, `${shotId}:a`], captureId: `${platform}-shot-init` });
  await sleep(8);
  clock = await put(platform, 3, [
    { id: `${shotId}:hu`, role: "user", body: USER },
    { id: `${shotId}:ha`, role: "assistant", body: `**${ASST}**` },
    { id: `${shotId}:hn`, role: "user", body: NEXT },
  ], {
    pageMessageIds: [`${shotId}:hu`, `${shotId}:ha`, `${shotId}:hn`],
    captureId: `${platform}-shot`,
  });
  assert(clock.updatedAtSource === "observed" && clock.updatedAt > OLD_AT, `${platform} re-keyed new tail ${clock.updatedAtSource}`);
  const shotRead = await readConversation(shotId);
  assert(shotRead.messages.length === 3, `${platform} new tail duplicated ${shotRead.messages.length}`);

  const growId = convId(platform, 4).id;
  const growUser = `${growId}:u`;
  const growAsst = `${growId}:a`;
  await put(platform, 4, [
    { id: growUser, role: "user", body: USER },
    { id: growAsst, role: "assistant", body: ASST },
  ], { pageMessageIds: [growUser, growAsst], captureId: `${platform}-grow-init` });
  await sleep(8);
  clock = await put(platform, 4, [
    { id: growAsst, role: "assistant", body: `${ASST} The ridge is green after rain.` },
  ], { pageMessageIds: [growUser, growAsst], captureId: `${platform}-grow` });
  assert(clock.updatedAtSource === "observed" && clock.updatedAt > OLD_AT, `${platform} tail growth ${clock.updatedAtSource}`);
  const growRead = await readConversation(growId);
  assert(growRead.messages.length === 2, `${platform} growth duplicated ${growRead.messages.length}`);

  const scrollId = convId(platform, 5).id;
  const startId = `${scrollId}:a`;
  const endId = `${scrollId}:b`;
  const olderId = `${scrollId}:old`;
  clock = await put(platform, 5, [
    { id: startId, role: "user", body: USER },
    { id: endId, role: "assistant", body: ASST },
  ], { pageMessageIds: [startId, endId], captureId: `${platform}-scroll-init` });
  await sleep(8);
  clock = await put(platform, 5, [
    { id: olderId, role: "user", body: "Older message loaded by scrolling up the transcript today." },
  ], { pageMessageIds: [olderId, startId, endId], captureId: `${platform}-scroll` });
  assert(clock.updatedAt === OLD_AT && clock.updatedAtSource === "page-exact", `${platform} scrollback ${clock.updatedAtSource} ${clock.updatedAt}`);

  const trimId = convId(platform, 6).id;
  const trimUser = `${trimId}:u`;
  const trimAsst = `${trimId}:a`;
  await put(platform, 6, [
    { id: trimUser, role: "user", body: USER },
    { id: trimAsst, role: "assistant", body: ASST },
  ], { pageMessageIds: [trimUser, trimAsst], captureId: `${platform}-trim-init` });
  await sleep(8);
  clock = await put(platform, 6, [
    { id: trimAsst, role: "assistant", body: ASST.slice(0, 40) },
  ], { pageMessageIds: [trimUser, trimAsst], captureId: `${platform}-trim` });
  assert(clock.updatedAt === OLD_AT && clock.updatedAtSource === "page-exact", `${platform} shorter tail ${clock.updatedAtSource} ${clock.updatedAt}`);

  const streamId = convId(platform, 8).id;
  const streamUser = `${streamId}:u`;
  await put(platform, 8, [
    { id: streamUser, role: "user", body: USER },
    { id: `${streamId}:a0`, role: "assistant", body: "Starting the ridge answer now." },
  ], { pageMessageIds: [streamUser, `${streamId}:a0`], captureId: `${platform}-stream-0` });
  await sleep(8);
  await put(platform, 8, [
    { id: `${streamId}:a1`, role: "assistant", body: "Starting the ridge answer now. The path is wet." },
  ], { pageMessageIds: [streamUser, `${streamId}:a1`], captureId: `${platform}-stream-1` });
  clock = await put(platform, 8, [
    { id: `${streamId}:a2`, role: "assistant", body: "Starting the ridge answer now. The path is wet. Then it dries." },
  ], { pageMessageIds: [streamUser, `${streamId}:a2`], captureId: `${platform}-stream-2` });
  const streamRead = await readConversation(streamId);
  assert(streamRead.messages.length === 2, `${platform} stream duplicated ${streamRead.messages.length}`);
  assert(streamRead.messages.some((msg) => msg.body.includes("Then it dries")), `${platform} stream dropped the grown body`);
  assert(clock.updatedAtSource === "observed" && clock.updatedAt > OLD_AT, `${platform} stream ${clock.updatedAtSource}`);

  const dup = convId(platform, 9).id;
  const ping = "ok";
  const note = "A separate note that is not the same sentence at all.";
  clock = await put(platform, 9, [
    { id: `${dup}:a`, role: "user", body: ping },
    { id: `${dup}:b`, role: "assistant", body: note },
    { id: `${dup}:c`, role: "user", body: ping },
  ], { pageMessageIds: [`${dup}:a`, `${dup}:b`, `${dup}:c`], captureId: `${platform}-dup-init` });
  const dupAt = clock.updatedAt;
  await sleep(8);
  clock = await put(platform, 9, [
    { id: `${dup}:ha`, role: "user", body: ping },
    { id: `${dup}:hb`, role: "assistant", body: `**${note}**` },
    { id: `${dup}:hc`, role: "user", body: ping },
  ], { pageMessageIds: [`${dup}:ha`, `${dup}:hb`, `${dup}:hc`], captureId: `${platform}-dup-rekey` });
  const dupRead = await readConversation(dup);
  assert(dupRead.messages.length === 3, `${platform} collapsed a real repeated send ${dupRead.messages.length}`);
  assert(dupRead.messages.filter((msg) => msg.role === "user" && msg.body === ping).length === 2, `${platform} lost a repeated send`);
  assert(clock.updatedAt === dupAt && clock.updatedAtSource === "page-exact", `${platform} repeated send looked new ${clock.updatedAtSource}`);

  const img = convId(platform, 10).id;
  const imgAsst = `${img}:a`;
  await put(platform, 10, [
    { id: `${img}:u`, role: "user", body: USER },
    { id: imgAsst, role: "assistant", body: ASST },
  ], { pageMessageIds: [`${img}:u`, imgAsst], captureId: `${platform}-img-init` });
  const savedShots = await saveImageRecords(img, [{
    messageId: imgAsst,
    index: 0,
    status: "uncached",
    alt: "ridge",
    offset: 0,
  }]);
  assert(savedShots.saved === 1, `${platform} image seed ${savedShots.saved}`);
  const imgNext = `${img}:ha`;
  await put(platform, 10, [
    { id: `${img}:hu`, role: "user", body: USER },
    { id: imgNext, role: "assistant", body: `**${ASST}**` },
  ], { pageMessageIds: [`${img}:hu`, imgNext], captureId: `${platform}-img` });
  const shots = await readImagesForMessages([imgNext, imgAsst]);
  assert(shots.some((row) => row.messageId === imgNext), `${platform} image did not follow the re-key`);
  assert(!shots.some((row) => row.messageId === imgAsst), `${platform} image stayed on the old id`);
  const imgRead = await readConversation(img);
  assert(imgRead.messages.length === 2, `${platform} image rekey duplicated ${imgRead.messages.length}`);
}

const chunkPlatform = "chatgpt";
const chunkKey = convId(chunkPlatform, 7);
const stored = Array.from({ length: 22 }, (_, i) => ({
  id: `${chunkKey.id}:m${i}`,
  role: i % 2 ? "assistant" : "user",
  body: `Turn ${i} stays on the ridge while the afternoon rain holds off the path.`,
}));
const storedIds = stored.map((msg) => msg.id);
await upsertMessages(row(chunkPlatform, 7), stored.slice(0, 20), {
  pageMessageIds: storedIds,
  captureId: "chunk-init",
});
await upsertMessages(row(chunkPlatform, 7), stored.slice(20), {
  pageMessageIds: storedIds,
  captureId: "chunk-init",
});
let chunk = await read(chunkPlatform, 7);
assert(chunk.updatedAt === OLD_AT && chunk.updatedAtSource === "page-exact", `chunked first ingest ${chunk.updatedAtSource}`);
const rekeyed = stored.map((msg, i) => ({ ...msg, id: `${chunkKey.id}:h${i}` }));
const extra = { id: `${chunkKey.id}:hnew`, role: "user", body: NEXT };
const page = [...rekeyed, extra];
const pageIds = page.map((msg) => msg.id);
await sleep(8);
await upsertMessages(row(chunkPlatform, 7), page.slice(0, 20), {
  pageMessageIds: pageIds,
  captureId: "chunk-add",
});
chunk = await read(chunkPlatform, 7);
assert(chunk.updatedAt === OLD_AT && chunk.updatedAtSource !== "observed", "the chunk before the new ending stamped observed");
await upsertMessages(row(chunkPlatform, 7), page.slice(20), {
  pageMessageIds: pageIds,
  captureId: "chunk-add",
});
chunk = await read(chunkPlatform, 7);
assert(chunk.updatedAtSource === "observed" && chunk.updatedAt > OLD_AT, `chunked re-key ${chunk.updatedAtSource}`);
const chunkRead = await readConversation(chunkKey.id);
assert(chunkRead.messages.length === 23, `chunked rekey stored ${chunkRead.messages.length}`);

const hist = convId("chatgpt", 11);
await put("chatgpt", 11, [
  { id: `${hist.id}:u`, role: "user", body: USER },
  { id: `${hist.id}:a`, role: "assistant", body: ASST },
], { pageMessageIds: [`${hist.id}:u`, `${hist.id}:a`], captureId: "hist-init" });
const histDb = await openDb();
await new Promise((resolve, reject) => {
  const tx = histDb.transaction(["messages", "meta", "conversations"], "readwrite");
  const now = Date.now();
  tx.objectStore("messages").put({
    id: `${hist.id}:hu`,
    conversationId: hist.id,
    role: "user",
    body: USER,
    capturedAt: now,
    captureIndex: 0,
  });
  tx.objectStore("messages").put({
    id: `${hist.id}:ha`,
    conversationId: hist.id,
    role: "assistant",
    body: ASST,
    capturedAt: now,
    captureIndex: 1,
  });
  tx.objectStore("meta").put({
    key: `order:${hist.id}`,
    conversationId: hist.id,
    ids: [`${hist.id}:u`, `${hist.id}:a`, `${hist.id}:hu`, `${hist.id}:ha`],
  });
  const getReq = tx.objectStore("conversations").get(hist.id);
  getReq.onsuccess = () => {
    const row = getReq.result;
    row.messageCount = 4;
    tx.objectStore("conversations").put(row);
  };
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
});
const histClock = await put("chatgpt", 11, [
  { id: `${hist.id}:u2`, role: "user", body: USER },
  { id: `${hist.id}:a2`, role: "assistant", body: ASST },
], { pageMessageIds: [`${hist.id}:u2`, `${hist.id}:a2`], captureId: "hist-collapse" });
const histRead = await readConversation(hist.id);
assert(histRead.messages.length === 2, `historical clone stayed ${histRead.messages.length}`);
assert(histClock.updatedAt === OLD_AT && histClock.updatedAtSource === "page-exact", `historical clone moved the clock ${histClock.updatedAtSource}`);
const both = convId("chatgpt", 12);
await put("chatgpt", 12, [
  { id: `${both.id}:u`, role: "user", body: USER },
  { id: `${both.id}:a`, role: "assistant", body: ASST },
  { id: `${both.id}:u2`, role: "user", body: USER },
  { id: `${both.id}:a2`, role: "assistant", body: ASST },
], { pageMessageIds: [`${both.id}:u`, `${both.id}:a`, `${both.id}:u2`, `${both.id}:a2`], captureId: "both-init" });
await put("chatgpt", 12, [
  { id: `${both.id}:u`, role: "user", body: USER },
  { id: `${both.id}:a`, role: "assistant", body: ASST },
  { id: `${both.id}:u2`, role: "user", body: USER },
  { id: `${both.id}:a2`, role: "assistant", body: ASST },
], { pageMessageIds: [`${both.id}:u`, `${both.id}:a`, `${both.id}:u2`, `${both.id}:a2`], captureId: "both-again" });
const bothRead = await readConversation(both.id);
assert(bothRead.messages.length === 4, `visible repeat was collapsed ${bothRead.messages.length}`);

const listed = await searchConversations({ sort: { field: "activity", dir: "desc" }, limit: 80 });
const freshAt = listed.findIndex((item) => item.id === chunkKey.id);
const staleAt = listed.findIndex((item) => item.id === convId("grok", 5).id);
assert(freshAt >= 0 && staleAt >= 0 && freshAt < staleAt, `activity sort put ${freshAt} before ${staleAt}`);
assert(listed[freshAt].updatedAt > listed[staleAt].updatedAt, "the updated chat is not newer than the untouched one");

console.log("activity-test ok", { platforms: PLATFORMS.length, listed: listed.length });
