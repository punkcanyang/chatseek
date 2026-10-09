/**
 * 1.7.2 P0(d): ChatGPT image-generation progress must not become one stored
 * assistant message per percentage step.
 *
 * Part 0  classifier unit checks (multi-locale phrases; "%" prose survives;
 *         DOM markers; a settled content image wins over the phrase)
 * Part A  root cause: a progress turn has no data-message-id, so every rewrite
 *         hashes to a fresh id. Seeding what <= 1.7.1 stored shows 3 duplicates.
 * Part B  fixed capture path: a progress rewrite writes nothing and never moves
 *         lastActivity; the settled turn is written once and stamped "observed"
 * Part C  migration: repairProgressDuplicates() folds stored runs into the
 *         final turn, keeps its image records, never touches updatedAt, idempotent
 * Part D  top / same-origin iframe / open+closed shadow all settle to one row
 */
import "fake-indexeddb/auto";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import * as db from "../src/db.js";
import { pageShowsNewActivity } from "../src/activity-time.js";
import {
  isProgressText,
  isProgressMessage,
  planProgressMerges,
  PROGRESS_PHRASES,
} from "../src/image-progress.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sharedSrc = readFileSync(join(root, "content/shared.js"), "utf8");
const chatgptSrc = readFileSync(join(root, "content/chatgpt.js"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------- Part 0
const PHRASES = [
  "正在建立圖像25%", "正在勾勒草圖38%", "正在生成初稿51%", "正在打磨細節80%",
  "正在創建圖像 12%", "正在创建图像25%", "正在勾勒草图38%", "正在打磨细节80%",
  "Creating image", "Creating image 25%", "Sketching 38%", "Adding details 80%",
  "Creating your image 5%", "Generating image 63%",
  "画像を作成しています 25%", "スケッチを作成しています 40%",
  "이미지 생성 중 40%", "스케치하는 중 12%",
  "Creando imagen 30%", "Création de l'image 20%", "Bild wird erstellt 10%", "Criando imagem 15%",
];
for (const p of PHRASES) assert(isProgressText(p), `should be progress: ${p}`);

// Ordinary prose that happens to carry a percentage must never be swallowed.
const NOT_PROGRESS = [
  "目前完成度 25%，下午會繼續",
  "這張圖的完成度是 80% 左右",
  "The model is 25% faster on this benchmark",
  "今天進度 51%",
  "Profit grew 12% and costs fell",
  "Creating image quality is a real topic",
  "正在建立圖像，進度 25%",
  "",
  "Hello world",
];
for (const p of NOT_PROGRESS) assert(!isProgressText(p), `must not be progress: ${p}`);
assert(PROGRESS_PHRASES.some((p) => /[\u4e00-\u9fff]/.test(p)), "zh phrases present");
assert(PROGRESS_PHRASES.some((p) => /[\u3040-\u30ff]/.test(p)), "ja phrases present");
assert(PROGRESS_PHRASES.some((p) => /[\uac00-\ud7af]/.test(p)), "ko phrases present");

{
  // A settled content image makes the turn non-progress even if the text matches.
  const withImage = new JSDOM(`<div id="t"><span>Creating image 25%</span><img src="https://cdn.example/a.png"></div>`);
  assert(!isProgressMessage("Creating image 25%", withImage.window.document.getElementById("t")), "a content image means settled");
  const noImage = new JSDOM(`<div id="t"><span>Creating image 25%</span></div>`);
  assert(isProgressMessage("Creating image 25%", noImage.window.document.getElementById("t")), "no image -> progress");
  // A data: pixel is decoration, not a settled image.
  const pixel = new JSDOM(`<div id="t"><span>Creating image 25%</span><img src="data:image/png;base64,AAAA"></div>`);
  assert(isProgressMessage("Creating image 25%", pixel.window.document.getElementById("t")), "a data: pixel is not a content image");
  // An explicit streaming marker plus a short unpunctuated line is progress
  // even when the phrase is not in the list.
  const streaming = new JSDOM(`<div id="t" data-is-streaming="true"><span>正在準備回應</span></div>`);
  assert(isProgressMessage("正在準備回應", streaming.window.document.getElementById("t")), "streaming marker + short status");
  const prose = new JSDOM(`<div id="t" data-is-streaming="true"><p>這是一段很長的一般回覆，裡面有標點符號。</p></div>`);
  assert(!isProgressMessage("這是一段很長的一般回覆，裡面有標點符號。", prose.window.document.getElementById("t")), "prose with a marker is not progress");
}

{
  const rows = [
    { id: "u", role: "user", body: "hi" },
    { id: "p1", role: "assistant", body: "Creating image 10%" },
    { id: "p2", role: "assistant", body: "Sketching 40%" },
    { id: "p3", role: "assistant", body: "Adding details 80%" },
    { id: "final", role: "assistant", body: "Here is the image." },
  ];
  const plans = planProgressMerges(rows.map(row => ({ ...row, conversationId: "fixture", captureIndex: 1, turnId: "fixture-turn" })));
  assert(plans.length === 1, "one merge plan");
  assert(plans[0].keep === "final", "the settled turn is kept");
  assert(plans[0].drop.join(",") === "p1,p2,p3", "the progress run is dropped");
  // Without a settled tail the run keeps its last row only with a shared turn.
  const tail = planProgressMerges([
    { id: "tu", role: "user", body: "draw", conversationId: "fixture", captureIndex: 0 },
    { id: "a", role: "assistant", body: "Sketching 40%", conversationId: "fixture", captureIndex: 1, turnId: "tail-turn" },
    { id: "b", role: "assistant", body: "Adding details 80%", conversationId: "fixture", captureIndex: 1, turnId: "tail-turn" },
  ]);
  assert(tail.length === 1 && tail[0].keep === "b" && tail[0].drop[0] === "a", "a run without a settled tail keeps its last row");
  // Same slot but no evidence at all: left alone (keep a duplicate, never
  // delete a different turn).
  const noEvidence = planProgressMerges([
    { id: "a", role: "assistant", body: "Sketching 40%", conversationId: "fixture", captureIndex: 1 },
    { id: "b", role: "assistant", body: "Adding details 80%", conversationId: "fixture", captureIndex: 1 },
  ]);
  assert(noEvidence.length === 0, "same slot with no position evidence is not merged");
  assert(planProgressMerges([{ id: "s", role: "assistant", body: "Sketching 40%" }]).length === 0, "a lone progress row is left alone");
}

// ---------------------------------------------------------------- harness
function buildApi(dom, chromeExtra = {}, sources = { sharedSrc, chatgptSrc }) {
  const fn = new Function(
    "document", "location", "Node", "NodeFilter", "console", "chrome",
    `${sources.sharedSrc}
     Chatseek.autoStart = false;
     if (!Chatseek.scheduleMessageImages) Chatseek.scheduleMessageImages = () => {};
     ${sources.chatgptSrc}
     return Chatseek;`,
  );
  return fn(
    dom.window.document,
    dom.window.location,
    dom.window.Node,
    dom.window.NodeFilter,
    { warn() {}, log() {} },
    { runtime: { id: "test" }, ...chromeExtra },
  );
}

let captureMessageCalls = 0;
function route(payload) {
  if (!payload) return Promise.resolve({ ok: true });
  if (payload.type === "CAPTURE_MESSAGES") {
    captureMessageCalls += 1;
    return db
      .upsertMessages(payload.conversation, payload.messages || [], {
        captureId: payload.captureId,
        pageMessageIds: payload.pageMessageIds,
      })
      .then((r) => ({ ok: true, observed: !!r?.observed }));
  }
  if (payload.type === "CAPTURE_CONVERSATIONS") {
    return db.upsertConversations(payload.conversations || []).then(() => ({ ok: true }));
  }
  if (payload.type === "CAPTURE_HEALTH") {
    return db.saveCaptureHealth(payload.platform, payload.health).then(() => ({ ok: true }));
  }
  if (payload.type === "CAPTURE_IMAGES") {
    return db.saveImageRecords(payload.conversationId, payload.images || []).then((r) => ({ ok: true, saved: r?.saved || 0 }));
  }
  return Promise.resolve({ ok: true });
}

function loadChatseek() {
  const fn = new Function(
    "document", "location", "chrome", "NodeFilter", "setTimeout", "clearTimeout", "setInterval",
    `${sharedSrc}
     return Chatseek;`,
  );
  return fn(
    { scripts: [], hidden: false, querySelectorAll() { return []; } },
    { href: "https://chatgpt.com/" },
    { runtime: { id: "test", sendMessage: (payload, cb) => { route(payload).then((r) => cb(r), () => cb(null)); } } },
    { SHOW_ELEMENT: 1 },
    (f, ms) => { const t = setTimeout(f, ms); t.unref?.(); return t; },
    clearTimeout,
    setInterval,
  );
}

const PLATFORM_ID = "11111111-1111-4111-8111-111111111111";
const CONV_ID = `chatgpt:${PLATFORM_ID}`;
const CONV = {
  id: CONV_ID,
  platform: "chatgpt",
  platformId: PLATFORM_ID,
  title: "Sample image chat",
  url: `https://chatgpt.com/c/${PLATFORM_ID}`,
  updatedAt: Date.UTC(2026, 9, 8, 12, 0, 0),
  updatedAtSource: "page-exact",
};
const TICKS = ["正在建立圖像25%", "正在勾勒草圖38%", "正在生成初稿51%"];
const LAST_TICK = "正在打磨細節80%";
const USER_TEXT = "畫一張楓葉圖放在山脊上";
const SETTLED_BODY = "這是你要的楓葉圖。";
const SETTLED_HTML = `${SETTLED_BODY}<img src="https://cdn.example/maple.png">`;
const HEALTH = {
  pathKind: "conversation",
  selector: "[data-turn]",
  selectorsTried: ["[data-turn]"],
  selectorHits: {},
  userCount: 1,
  assistantCount: 1,
  charCount: 30,
  untitled: false,
};

function turn(role, inner) {
  return `<div data-turn="${role}"><div class="markdown">${inner}</div></div>`;
}
function page(turns) {
  return `<main>${turns.join("")}</main>`;
}

async function seedRows({ conversation, messages, order, images = [] }) {
  const database = await db.openDb();
  const stores = ["conversations", "messages", "meta"];
  if (database.objectStoreNames.contains("images")) stores.push("images");
  const tx = database.transaction(stores, "readwrite");
  tx.objectStore("conversations").put(conversation);
  for (const m of messages) tx.objectStore("messages").put(m);
  if (order) {
    tx.objectStore("meta").put({ key: `order:${conversation.id}`, conversationId: conversation.id, ids: order });
  }
  for (const img of images) tx.objectStore("images").put(img);
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}

// The tidy is bounded per transaction, so a test that wants a whole scan clears
// the resume cursor and keeps calling until it reports done; only that final
// result carries the cumulative merged/dropped counts.
async function clearRepairFlag() {
  const database = await db.openDb();
  await new Promise((res, rej) => {
    const tx = database.transaction("meta", "readwrite");
    tx.objectStore("meta").delete("progressRepair");
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

async function repairAll() {
  await clearRepairFlag();
  let last = null;
  for (let i = 0; i < 500; i += 1) {
    last = await db.repairProgressDuplicates();
    if (last.done || last.stalled) return last;
  }
  throw new Error("progress repair did not finish");
}

// ---------------------------------------------------------------- Part A
// Root cause. A progress turn carries no data-message-id, so its hash id moves
// with the body: three rewrites are three ids, and the <= 1.7.1 write filed
// each one as a new assistant message.
{
  const ids = [];
  for (const b of [...TICKS, LAST_TICK]) {
    const dom = new JSDOM(page([turn("assistant", b)]), { url: `https://chatgpt.com/c/${PLATFORM_ID}` });
    const api = buildApi(dom);
    const out = api.platforms.chatgpt.extractMessages(PLATFORM_ID, dom.window.document, false);
    assert(out.messages.length === 1, `one turn expected, got ${out.messages.length}`);
    assert(out.messages[0].progress === true, `turn must be marked progress: ${b}`);
    ids.push(out.messages[0].id);
  }
  console.log("Part A  progress turn ids:", ids.length, "distinct:", new Set(ids).size);
  assert(new Set(ids).size === 4, "root cause: each rewrite hashes to a new id");

  // Run the actual reviewed main implementation, not a hand-seeded imitation.
  // Only its DB name is isolated; capture, identity and write logic are intact.
  const baselineDir = mkdtempSync(join(tmpdir(), "chatseek-progress-baseline-"));
  const runGit = promisify(execFile);
  const fromMain = async (file) => (await runGit("git", ["show", `ad8f7d1:${file}`], { cwd: root, encoding: "utf8" })).stdout;
  try {
    writeFileSync(join(baselineDir, "package.json"), '{"type":"module"}');
    const loaded = new Set();
    const loadModule = async (file) => {
      if (loaded.has(file)) return;
      loaded.add(file);
      let source = await fromMain(`src/${file}`);
      for (const match of source.matchAll(/from "\.\/([^"\n]+)"/g)) await loadModule(match[1]);
      if (file === "db.js") source = source.replace('const DB_NAME = "chatseek"', 'const DB_NAME = "chatseek-progress-baseline"');
      writeFileSync(join(baselineDir, file), source);
    };
    await loadModule("db.js");
    const oldDb = await import(`file://${baselineDir}/db.js`);
    const baselineSources = { sharedSrc: await fromMain("content/shared.js"), chatgptSrc: await fromMain("content/chatgpt.js") };
    const dom = new JSDOM(page([turn("user", USER_TEXT), turn("assistant", TICKS[0])]), { url: CONV.url });
    const oldApi = buildApi(dom, {}, baselineSources);
    for (const tick of [...TICKS, LAST_TICK]) {
      dom.window.document.querySelector('[data-turn="assistant"]').textContent = tick;
      const messages = oldApi.platforms.chatgpt.extractMessages(PLATFORM_ID, dom.window.document, false).messages;
      await oldDb.upsertMessages(CONV, messages, { captureId: tick, pageMessageIds: messages.map(m => m.id) });
    }
    const actual = await oldDb.readConversation(CONV_ID);
    const progressRows = actual.messages.filter(m => isProgressText(m.body));
    console.log("Part A  actual ad8f7d1 writes:", actual.messages.length, "rows;", progressRows.length, "progress");
    assert(actual.messages.length === 5 && progressRows.length === 4, "actual pre-fix write path reproduces duplicates");
    assert(progressRows.every(m => m.captureIndex === 1), "legacy rewrites retain the same capture position");
    (await oldDb.openDb()).close();
  } finally { rmSync(baselineDir, { recursive: true, force: true }); }

  // Seed exactly what <= 1.7.1 wrote for one progress turn: four rows, with the
  // stored order meta anchored on the user id so the rewrites came out reversed.
  const CONV_A = `${CONV_ID}:a`;
  const U = `${CONV_A}:u`;
  const p = (n) => `${CONV_A}:p${n}`;
  const T = Date.UTC(2026, 9, 8, 11, 0, 0);
  await seedRows({
    conversation: {
      ...CONV, id: CONV_A, messageCount: 5, tailMessageId: p(4), updatedAt: T, updatedAtSource: "observed",
      lastPreview: LAST_TICK, lastPreviewRole: "assistant",
    },
    messages: [
      { id: U, conversationId: CONV_A, role: "user", body: USER_TEXT, capturedAt: T, captureIndex: 0 },
      ...TICKS.map((body, i) => ({
        id: p(i + 1), conversationId: CONV_A, role: "assistant", body, capturedAt: T + 1 + i, captureIndex: 1,
      })),
      { id: p(4), conversationId: CONV_A, role: "assistant", body: LAST_TICK, capturedAt: T + 4, captureIndex: 1 },
    ],
    order: [U, p(4), p(3), p(2), p(1)],
  });
  const storedA = await db.readConversation(CONV_A);
  const bodiesA = storedA.messages.map((m) => m.body);
  console.log("Part A  what <= 1.7.1 stored:", storedA.messages.length, "rows;", storedA.messages.filter((m) => isProgressText(m.body)).length, "progress");
  assert(storedA.messages.length === 5, "1.7.1 stored one row per rewrite");
  assert(storedA.messages.filter((m) => isProgressText(m.body)).length === 4, "four near-identical progress rows");
  assert(bodiesA[0] === USER_TEXT, "the user turn is first");

  // Requirement 4: a progress rewrite is not observed activity.
  const activity = pageShowsNewActivity({
    baselineCount: 4,
    baselineTail: p(4),
    baselineTailBody: LAST_TICK,
    pageIds: [U, "page-progress-next"],
    pageBodies: [{ id: U, body: USER_TEXT }, { id: "page-progress-next", body: "正在生成圖像90%" }],
  });
  assert(activity === false, "a progress rewrite must not count as new activity");
}

// ---------------------------------------------------------------- Part B
// The fixed capture path. A persistent state stands in for the observe loop, so
// an unchanged message fingerprint really does short-circuit before any write.
{
  const Chatseek = loadChatseek();
  const CONV_B = { ...CONV, id: `${CONV_ID}:b` };
  const opts = (messages) => ({
    platform: "chatgpt",
    sidebar: [],
    archivedRows: [],
    conversation: { ...CONV_B },
    messages,
    health: { ...HEALTH },
    restoreOnNewMessages: false,
  });
  const state = {};
  const extract = (turns) => {
    const dom = new JSDOM(page(turns), { url: `https://chatgpt.com/c/${PLATFORM_ID}` });
    const api = buildApi(dom);
    return api.platforms.chatgpt.extractMessages(PLATFORM_ID, dom.window.document, false).messages;
  };

  await Chatseek.runCapture(state, opts(extract([turn("user", USER_TEXT), turn("assistant", "好的，正在準備。")])));
  const afterBase = await db.readConversation(CONV_B.id);
  const baseCount = afterBase.messages.length;
  const baseSource = afterBase.conversation.updatedAtSource;
  const baseUpdated = afterBase.conversation.updatedAt;
  const writesAfterBase = captureMessageCalls;
  console.log("Part B  baseline rows:", baseCount, "source:", baseSource);

  const writes = [];
  for (const tick of TICKS) {
    const messages = extract([turn("user", USER_TEXT), turn("assistant", "好的，正在準備。"), turn("assistant", tick)]);
    assert(messages.some((m) => m.progress === true), "progress turn flagged");
    await Chatseek.runCapture(state, opts(messages));
    const row = await db.readConversation(CONV_B.id);
    writes.push(captureMessageCalls);
    assert(row.messages.length === baseCount, `a progress tick must not add a row (${tick})`);
    assert(row.conversation.updatedAtSource === baseSource, `a progress tick must not move lastActivity (${tick})`);
    assert(row.conversation.updatedAt === baseUpdated, `a progress tick must not move the stored time (${tick})`);
  }
  console.log("Part B  CAPTURE_MESSAGES writes across progress ticks:", writes.join(","), "base:", writesAfterBase);
  assert(writes.every((n) => n === writesAfterBase), "progress ticks must not reach the write path at all");

  await Chatseek.runCapture(state, opts(extract([
    turn("user", USER_TEXT), turn("assistant", "好的，正在準備。"), turn("assistant", SETTLED_HTML),
  ])));
  const afterSettle = await db.readConversation(CONV_B.id);
  console.log("Part B  after settle rows:", afterSettle.messages.length, "source:", afterSettle.conversation.updatedAtSource);
  assert(afterSettle.messages.length === baseCount + 1, "settling writes exactly one new row");
  assert(afterSettle.conversation.updatedAtSource === "observed", "settling stamps just now");
  assert(captureMessageCalls === writesAfterBase + 1, "settling reaches the write path once");
  const settledRow = afterSettle.messages[afterSettle.messages.length - 1];
  assert(settledRow.body.includes("楓葉圖"), "the settled body is stored");
}

// ---------------------------------------------------------------- Part C
// Migration with explicit persisted position evidence. Legacy rows lacking
// turn identity (Part A) must survive; captureIndex is only window-local.
// Time order and stored order disagree: keep the settled turn.
{
  const Chatseek = loadChatseek();
  const CONV_C = `${CONV_ID}:c`;
  const p = (n) => `${CONV_C}:prog${n}`;
  const q = (n) => `${CONV_C}:old${n}`;
  const finalId = `${CONV_C}:final`;
  const T = Date.UTC(2026, 9, 8, 11, 30, 0);
  await seedRows({
    conversation: {
      ...CONV, id: CONV_C, messageCount: 6, tailMessageId: p(2), captureBaselineTail: p(2),
      updatedAt: T, updatedAtSource: "observed", lastPreview: TICKS[2], lastPreviewRole: "assistant",
    },
    messages: [
      { id: `${CONV_C}:u`, conversationId: CONV_C, role: "user", body: USER_TEXT, capturedAt: T - 1, captureIndex: 0 },
      { id: p(1), conversationId: CONV_C, role: "assistant", body: TICKS[0], capturedAt: T, captureIndex: 0, turnId: "settled-turn" },
      { id: p(2), conversationId: CONV_C, role: "assistant", body: TICKS[1], capturedAt: T + 1, captureIndex: 0, turnId: "settled-turn" },
      { id: finalId, conversationId: CONV_C, role: "assistant", body: SETTLED_BODY, capturedAt: T + 2, captureIndex: 0, turnId: "settled-turn" },
      { id: q(1), conversationId: CONV_C, role: "assistant", body: "Sketching 38%", capturedAt: T + 3, captureIndex: 1, turnId: "orphan-turn" },
      { id: q(2), conversationId: CONV_C, role: "assistant", body: "Adding details 80%", capturedAt: T + 4, captureIndex: 1, turnId: "orphan-turn" },
    ],
    order: [`${CONV_C}:u`, p(1), finalId, p(2), q(1), q(2)],
    images: [
      { messageId: finalId, index: 0, status: "cached", mime: "image/webp", width: 4, height: 4, bytes: 1, conversationId: CONV_C },
      { messageId: p(2), index: 1, status: "cached", mime: "image/webp", width: 4, height: 4, bytes: 1, conversationId: CONV_C },
    ],
  });
  const before = await db.readConversation(CONV_C);
  console.log("Part C  seeded rows:", before.messages.length);
  assert(before.messages.length === 6, "seed should hold 6 rows");

  const first = await repairAll();
  console.log("Part C  repair merged:", first.merged, "dropped:", first.dropped, "done:", first.done);
  assert(first.done === true, "repair reports done");
  assert((await db.readConversation(`${CONV_ID}:a`)).messages.length === 5,
    "legacy duplicate rows without turn evidence remain intact");
  assert(first.merged >= 2, "the seeded runs were merged");
  const after = await db.readConversation(CONV_C);
  const ids = after.messages.map((m) => m.id);
  console.log("Part C  rows kept:", ids.join("  "));
  assert(ids.length === 3, `progress runs should collapse to user + 2 rows, got ${ids.length}`);
  assert(ids.includes(`${CONV_C}:u`), "the governing user prompt survives");
  assert(ids.includes(finalId), "the settled turn survives (time order, not the stored meta)");
  assert(ids.includes(q(2)), "a run without a settled tail keeps its last row");
  assert(!ids.includes(p(1)) && !ids.includes(p(2)), "the earlier progress rows are gone");
  assert(!ids.includes(q(1)), "the earlier orphan progress row is gone");
  assert(after.conversation.messageCount === 3, "messageCount follows the merge");
  assert(after.conversation.tailMessageId === finalId, "the tail pointer remaps off a dropped row");
  assert(after.conversation.captureBaselineTail === finalId, "the capture baseline remaps too");
  assert(after.conversation.updatedAt === T && after.conversation.updatedAtSource === "observed", "updatedAt must not change");
  assert(after.conversation.lastPreview === SETTLED_BODY, "the sidebar preview follows the kept turn");

  const images = await db.readImagesForMessages([finalId]);
  console.log("Part C  images on the kept turn:", images.map((r) => `${r.index}:${r.status}`).join(","));
  assert(images.length === 2, `images should follow the kept turn, got ${images.length}`);
  assert(images.every((r) => r.messageId === finalId), "no image row left on a dropped id");

  // Idempotent even without the meta flag: a second full scan finds nothing.
  const second = await repairAll();
  const again = await db.readConversation(CONV_C);
  console.log("Part C  second run merged:", second.merged, "rows:", again.messages.length);
  assert(second.merged === 0, "a re-run with no runs merges nothing");
  assert(again.messages.length === 3, "repair must be idempotent");
}

// ---------------------------------------------------------------- Part D
// The same collapse in every scope the extractor walks. Each case runs the real
// capture path three times while the status text changes, then once when the
// image appears, and must end with exactly one assistant row.
{
  const Chatseek = loadChatseek();
  const SCOPE_IDS = {
    top: "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a",
    iframe: "1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b",
    "shadow-open": "1c1c1c1c-1c1c-4c1c-8c1c-1c1c1c1c1c1c",
    "shadow-closed": "1d1d1d1d-1d1d-4d1d-8d1d-1d1d1d1d1d1d",
  };

  function makeScope(kind) {
    const pid = SCOPE_IDS[kind];
    const shell = kind === "top"
      ? ""
      : kind === "iframe" ? "<main><iframe></iframe></main>" : "<main><div id=\"host\"></div></main>";
    const dom = new JSDOM(
      `<!DOCTYPE html><html><head><title>scope ${kind}</title></head><body>${shell}</body></html>`,
      { url: `https://chatgpt.com/c/${pid}` },
    );
    const map = new Map();
    let rootNode = dom.window.document.body;
    if (kind === "iframe") rootNode = dom.window.document.querySelector("iframe").contentDocument.body;
    else if (kind === "shadow-open" || kind === "shadow-closed") {
      const host = dom.window.document.getElementById("host");
      const shadow = host.attachShadow({ mode: kind === "shadow-closed" ? "closed" : "open" });
      map.set(host, shadow);
      rootNode = shadow;
    }
    const chromeExtra = kind === "shadow-closed"
      ? { dom: { openOrClosedShadowRoot: (el) => map.get(el) || null } }
      : {};
    return {
      pid,
      dom,
      chromeExtra,
      setTurns: (turns) => { rootNode.innerHTML = page(turns); },
    };
  }

  for (const kind of Object.keys(SCOPE_IDS)) {
    const scope = makeScope(kind);
    const api = buildApi(scope.dom, scope.chromeExtra);
    const convId = `chatgpt:${scope.pid}`;
    const conv = { ...CONV, id: convId, platformId: scope.pid, url: `https://chatgpt.com/c/${scope.pid}` };
    const state = {};
    const opts = (messages) => ({
      platform: "chatgpt",
      sidebar: [],
      archivedRows: [],
      conversation: { ...conv },
      messages,
      health: { ...HEALTH },
      restoreOnNewMessages: false,
    });
    const extract = (turns) => {
      scope.setTurns(turns);
      return api.platforms.chatgpt.extractMessages(scope.pid, scope.dom.window.document, false).messages;
    };

    for (const tick of TICKS) {
      const messages = extract([turn("user", USER_TEXT), turn("assistant", tick)]);
      assert(messages.filter((m) => m.progress === true).length === 1, `${kind}: progress turn flagged`);
      await Chatseek.runCapture(state, opts(messages));
      const row = await db.readConversation(convId);
      const assistants = (row?.messages || []).filter((m) => m.role === "assistant");
      assert(assistants.length === 0, `${kind}: no assistant row while progressing (got ${assistants.length})`);
    }

    const settled = extract([turn("user", USER_TEXT), turn("assistant", SETTLED_HTML)]);
    const tail = settled[settled.length - 1];
    assert(tail.progress !== true, `${kind}: the settled turn is not progress`);
    await Chatseek.runCapture(state, opts(settled));
    const row = await db.readConversation(convId);
    const assistants = (row?.messages || []).filter((m) => m.role === "assistant");
    console.log(`Part D  ${kind}: assistant rows at settle = ${assistants.length}`);
    assert(assistants.length === 1, `${kind}: exactly one assistant row (got ${assistants.length})`);
    assert(assistants[0].body.includes("楓葉圖"), `${kind}: the settled body is stored`);
    assert(row.conversation.updatedAtSource === "observed", `${kind}: settle stamps just now`);
  }
}

console.log("progress ok");
