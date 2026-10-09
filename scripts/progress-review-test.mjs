import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import * as db from "../src/db.js";
import { isProgressMessage, planProgressMerges } from "../src/image-progress.js";
import { readerPageUrl, parseReaderSearch } from "../src/reader-url.js";
import { tokenize } from "../src/tokenize.js";

const shared = readFileSync(new URL("../content/shared.js", import.meta.url), "utf8");
const adapter = readFileSync(new URL("../content/chatgpt.js", import.meta.url), "utf8");
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log("review PASS", name); }
  catch (err) { failures.push(name); console.error("review FAIL", name, err.message); }
}
const row = (id, body, captureIndex = 1, role = "assistant") =>
  ({ id, body, captureIndex, role, conversationId: "chatgpt:review" });

// The tidy is bounded per transaction, so a test that wants a whole scan must
// keep calling until it reports done. Only that last result carries the
// cumulative merged/dropped counts.
async function repairAll() {
  let last = null;
  for (let i = 0; i < 500; i += 1) {
    last = await db.repairProgressDuplicates();
    if (last.done || last.stalled) return last;
  }
  throw new Error("progress repair did not finish");
}

await check("migration requires the same position and conversation", () => {
  assert.equal(planProgressMerges([row("a", "Sketching 40%", 1), row("b", "Adding details 80%", 2)]).length, 0);
  assert.equal(planProgressMerges([row("a", "Sketching 40%"), { ...row("b", "Done"), conversationId: "chatgpt:other" }]).length, 0);
  assert.equal(planProgressMerges([row("a", "Sketching 40%"), row("u", "separator", 2, "user"), row("b", "Adding details 80%")]).length, 0);
  assert.equal(planProgressMerges([row("a", "Sketching 40%", undefined), { id: "b", role: "assistant", body: "Done" }]).length, 0);
  assert.equal(planProgressMerges([row("a", "Sketching 40%", -1), row("b", "Adding details 80%", -1)]).length, 0);
  // Codex BLOCK 2: captureIndex is batch-local, so two capture windows can
  // both report slot 1 for different turns. The same slot alone is not proof
  // of position and must not merge.
  assert.equal(planProgressMerges([row("a", "Sketching 40%", 1), row("b", "Adding details 80%", 1)]).length, 0,
    "same slot with no position evidence must not merge");
  assert.equal(planProgressMerges([
    row("a", "Sketching 40%", 1),
    { ...row("b", "Adding details 80%", 1), conversationId: "chatgpt:other" },
  ]).length, 0, "cross-conversation same slot must not merge");
  // Same slot but different turn ids are different turns.
  assert.equal(planProgressMerges([
    { ...row("a", "Sketching 40%", 1), turnId: "t1" },
    { ...row("b", "Adding details 80%", 1), turnId: "t2" },
  ]).length, 0, "different turn ids must not merge");
  // A governing user row is the accepted extra position evidence.
  const anchored = planProgressMerges([
    { id: "u", role: "user", body: "Draw a leaf", conversationId: "chatgpt:review", captureIndex: 0 },
    row("a", "Sketching 40%", 1),
    row("b", "Adding details 80%", 1),
  ]);
  assert.equal(anchored.length, 1, "a preceding user row is enough evidence");
  assert.equal(anchored[0].keep, "b");
  assert.deepEqual(anchored[0].drop, ["a"]);
  // A shared turn id is the other accepted evidence.
  const turnBound = planProgressMerges([
    { ...row("a", "Sketching 40%", 1), turnId: "t1" },
    { ...row("b", "Adding details 80%", 1), turnId: "t1" },
  ]);
  assert.equal(turnBound.length, 1, "a shared turn id is enough evidence");
  assert.equal(turnBound[0].keep, "b");
});

await check("short legitimate replies and controls are not progress", () => {
  for (const body of ["Drawing", "OK", "25%", "正在學習 JavaScript"]) {
    const dom = new JSDOM('<div id="t"><input aria-valuenow="25"></div>');
    assert.equal(isProgressMessage(body, dom.window.document.querySelector("#t")), false, body);
  }
  const dom = new JSDOM('<div id="t"><figure></figure>Creating image 25%</div>');
  assert.equal(isProgressMessage("Creating image 25%", dom.window.document.querySelector("#t")), true);
});

await check("one DOM turn can rewrite arbitrary prose without a new row", async () => {
  const pid = "88888888-8888-4888-8888-888888888888";
  const dom = new JSDOM('<main><div data-turn="user">Draw a leaf</div><div data-turn="assistant">A preliminary answer</div></main>', { url: `https://chatgpt.com/c/${pid}` });
  const api = new Function("document", "location", "Node", "NodeFilter", "console", "chrome", `${shared}; Chatseek.autoStart=false; ${adapter}; return Chatseek;`)(
    dom.window.document, dom.window.location, dom.window.Node, dom.window.NodeFilter, { warn() {}, log() {} }, { runtime: { id: "test" } });
  const conv = { id: `chatgpt:${pid}`, platform: "chatgpt", platformId: pid, title: "Sample", url: dom.window.location.href };
  const extract = () => api.platforms.chatgpt.extractMessages(pid, dom.window.document, false).messages;
  let msgs = extract();
  await db.upsertMessages(conv, msgs, { pageMessageIds: msgs.map(m => m.id), captureId: "first" });
  dom.window.document.querySelector('[data-turn="assistant"]').textContent = "A completely different final answer";
  msgs = extract();
  await db.upsertMessages(conv, msgs, { pageMessageIds: msgs.map(m => m.id), captureId: "second" });
  const result = await db.readConversation(conv.id);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages.at(-1).body, "A completely different final answer");
  const replacement = dom.window.document.createElement("div");
  replacement.dataset.turn = "assistant"; replacement.textContent = "Replaced element, same reply position";
  dom.window.document.querySelector('[data-turn="assistant"]').replaceWith(replacement);
  msgs = extract();
  await db.upsertMessages(conv, msgs, { pageMessageIds: msgs.map(m => m.id), captureId: "replacement" });
  assert.equal((await db.readConversation(conv.id)).messages.length, 2);
  assert.equal((await db.readConversation(conv.id)).messages.at(-1).body, replacement.textContent);
  // runCapture's old length/tail fingerprint missed equal-length head edits.
  api.send = async (payload) => {
    if (payload.type === "CAPTURE_MESSAGES") {
      const result = await db.upsertMessages(payload.conversation, payload.messages, payload);
      return { ok: true, observed: result.observed };
    }
    if (payload.type === "CAPTURE_CONVERSATIONS") await db.upsertConversations(payload.conversations);
    return { ok: true };
  };
  const state = {};
  const capture = () => api.runCapture(state, { platform: "chatgpt", sidebar: [], conversation: conv, messages: extract() });
  const tailNode = dom.window.document.querySelector('[data-turn="assistant"]');
  tailNode.textContent = "A" + "x".repeat(200);
  await capture();
  tailNode.textContent = "B" + "x".repeat(200);
  await capture();
  assert.equal((await db.readConversation(conv.id)).messages.at(-1).body, "B" + "x".repeat(200));
  assert.equal((await db.readConversation(conv.id)).messages.length, 2);
  // A different turn, even with the same text, stays distinct.
  const extra = dom.window.document.createElement("div");
  extra.dataset.turn = "assistant"; extra.textContent = tailNode.textContent;
  dom.window.document.querySelector("main").append(extra);
  msgs = extract();
  await db.upsertMessages(conv, msgs, { pageMessageIds: msgs.map(m => m.id), captureId: "third" });
  assert.equal((await db.readConversation(conv.id)).messages.length, 3);
  // A finished image without prose must still have a capturable host/body.
  extra.textContent = "";
  const image = dom.window.document.createElement("img"); image.src = "https://example.invalid/leaf.png"; extra.append(image);
  assert.equal(extract().length, 3);
  // Stale progress next to a real image must not leak onto the stable body.
  extra.prepend(dom.window.document.createTextNode("Creating image 25%"));
  assert.equal(extract().at(-1).body, "🖼");
  dom.window.document.querySelector('[data-turn="user"]').textContent = "Creating image 25%";
  assert.equal(extract()[0].progress, false, "user text must remain intact");
});

await check("failed migration rolls back and retries", async () => {
  const cid = "chatgpt:review-retry";
  const database = await db.openDb();
  const tx = database.transaction(["conversations", "messages", "meta"], "readwrite");
  tx.objectStore("meta").delete("progressRepair");
  tx.objectStore("conversations").put({ id: cid, platform: "chatgpt", messageCount: 3, updatedAt: 4567 });
  tx.objectStore("messages").put({ ...row(`${cid}:u`, "Make art", 0, "user"), conversationId: cid, capturedAt: 0 });
  for (const [id, body, time] of [["p", "Creating image 25%", 1], ["final", "Done", 2]]) {
    tx.objectStore("messages").put({ ...row(`${cid}:${id}`, body), conversationId: cid, capturedAt: time });
  }
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  const original = database.transaction;
  let failedOnce = false;
  database.transaction = function (...args) {
    const current = original.apply(this, args);
    if (args[1] === "readwrite" && args[0].includes("messages")) {
      const originalStore = current.objectStore.bind(current);
      const store = originalStore("conversations");
      const put = store.put.bind(store);
      store.put = (value) => {
        if (value.id === cid && !failedOnce) { failedOnce = true; throw new Error("simulated repair failure"); }
        return put(value);
      };
      current.objectStore = name => name === "conversations" ? store : originalStore(name);
    }
    return current;
  };
  try {
    assert.equal((await db.ensureProgressRepair()).done, false);
    assert.equal((await db.readConversation(cid)).messages.length, 3, "deletions must roll back");
  } finally { database.transaction = original; }
  assert.equal((await db.ensureProgressRepair()).done, true);
  assert.equal((await db.readConversation(cid)).messages.length, 2);
  assert.equal((await db.readConversation(cid)).conversation.updatedAt, 4567);
});

await check("3000 rows and 500 colliding thumbnails remain intact and jumpable", async () => {
  // Opt in to the much slower fake-IDB full-index stress case separately:
  // node scripts/progress-review-test.mjs --full-index
  const fullIndex = process.argv.includes("--full-index");
  const cid = "chatgpt:review-large";
  const database = await db.openDb();
  const tx = database.transaction(["conversations", "messages", "meta", "images", "tokenMap"], "readwrite");
  tx.objectStore("meta").delete("progressRepair");
  tx.objectStore("conversations").put({ id: cid, platform: "chatgpt", messageCount: 3001, updatedAt: 7890 });
  tx.objectStore("messages").put({ id: `${cid}:u`, conversationId: cid, role: "user", body: "Draw a leaf", capturedAt: -1, captureIndex: 0 });
  for (let i = 0; i < 3000; i++) {
    const id = `${cid}:${i}`;
    const body = i === 2999 ? "Final image" : `Creating image ${i % 100}%`;
    tx.objectStore("messages").put({ ...row(id, body), conversationId: cid, capturedAt: i });
    if (fullIndex) {
      for (const token of tokenize(body)) tx.objectStore("tokenMap").put({ token, conversationId: cid, source: id, role: "assistant", positions: [0] });
    }
    if (i < 500) {
      tx.objectStore("images").put({ messageId: id, index: 0, conversationId: cid, status: "cached", bytes: 1, mime: "image/webp", width: 64, height: 64 });
      tx.objectStore("meta").put({ key: `imgb:${id}\u00010`, blob: new Uint8Array([i % 256]).buffer });
    }
  }
  tx.objectStore("meta").put({ key: "imageBytes", bytes: 500 });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  const start = performance.now();
  let ticks = 0;
  let lastTick = start;
  let maxGap = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now(); maxGap = Math.max(maxGap, now - lastTick); lastTick = now; ticks += 1;
  }, 10);
  // Codex BLOCK 1: the tidy runs in bounded background batches and must never
  // hold the object stores for a whole-database scan. A capture issued while it
  // is running has to answer well inside the content script's 15s window.
  const probeConv = {
    id: "chatgpt:review-probe", platform: "chatgpt", platformId: "review-probe",
    title: "Probe", url: "https://chatgpt.com/c/review-probe",
  };
  const repairPromise = db.ensureProgressRepair();
  await new Promise((resolve) => setTimeout(resolve, 0));
  let captureMax = 0;
  for (let k = 0; k < 5; k += 1) {
    const probeMsgs = [{ id: `${probeConv.id}:m${k}`, role: "user", body: `probe ${k}` }];
    const t0 = performance.now();
    await db.upsertMessages(probeConv, probeMsgs, { captureId: `probe-${k}`, pageMessageIds: probeMsgs.map((m) => m.id) });
    captureMax = Math.max(captureMax, performance.now() - t0);
  }
  const captureMs = Math.round(captureMax);
  const repair = await repairPromise;
  assert(captureMs < 15000,
    `a capture must answer within 15s while the tidy runs (slowest ${captureMs}ms)`);
  console.log("review capture during repair max ms", captureMs, "full index", fullIndex);
  assert.equal(repair.done, true, "the tidy eventually finishes");
  assert.equal(repair.dropped, 2999, "every stored progress row is folded away");
  clearInterval(heartbeat);
  console.log("review migration 3000 rows / 500 thumbnails ms", Math.round(performance.now() - start), "event loop max gap ms", Math.round(maxGap), "full index", fullIndex);
  assert(ticks > 1, "migration must yield to the event loop");
  const images = await db.readImagesForMessages([`${cid}:2999`]);
  assert.equal(images.length, 500);
  assert.equal((await db.readConversation(cid)).messages.length, 2);
  assert.equal((await db.readConversation(cid)).conversation.updatedAt, 7890);
  if (fullIndex) assert.equal((await db.searchConversations({ query: "creating" })).filter(conv => conv.id === cid).length, 0);
  for (const image of images) {
    assert.equal(image.blob.byteLength, 1);
    const url = readerPageUrl(cid, "", null, image);
    assert.equal(parseReaderSearch(url.slice(url.indexOf("?"))).imageIndex, image.index);
  }
  const counter = await new Promise((resolve, reject) => {
    const req = database.transaction("meta").objectStore("meta").get("imageBytes");
    req.onsuccess = () => resolve(req.result.bytes); req.onerror = () => reject(req.error);
  });
  assert.equal(counter, 500);
  // A second scan without its completion flag must also be a no-op.
  const reset = database.transaction("meta", "readwrite"); reset.objectStore("meta").delete("progressRepair");
  await new Promise(resolve => { reset.oncomplete = resolve; });
  assert.equal((await db.repairProgressDuplicates()).dropped, 0);
});

await check("migration preserves colliding thumbnails and their bytes", async () => {
  const cid = "chatgpt:review";
  const database = await db.openDb();
  const tx = database.transaction(["conversations", "messages", "meta", "tokenMap"], "readwrite");
  tx.objectStore("meta").delete("progressRepair");
  tx.objectStore("conversations").put({ id: cid, platform: "chatgpt", messageCount: 4, updatedAt: 1234, updatedAtSource: "observed", tailMessageId: `${cid}:final` });
  tx.objectStore("messages").put({ ...row(`${cid}:u`, "Draw a leaf", 0, "user"), capturedAt: 99 });
  [row(`${cid}:p1`, "Creating image 25%"), row(`${cid}:p2`, "Sketching 40%"), row(`${cid}:final`, "Done")].forEach((m, i) => {
    tx.objectStore("messages").put({ ...m, capturedAt: 100 + i });
    for (const token of tokenize(m.body)) tx.objectStore("tokenMap").put({ token, conversationId: cid, source: m.id, role: "assistant", positions: [0] });
  });
  tx.objectStore("meta").put({ key: `order:${cid}`, ids: [`${cid}:p2`, `${cid}:p1`, `${cid}:final`] });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  for (const [messageId, value] of [[`${cid}:p1`, 1], [`${cid}:p2`, 2], [`${cid}:final`, 3]]) {
    await db.saveImageRecords(cid, [{ messageId, index: 0, status: "cached", mime: "image/webp", bytes: [value], width: 4, height: 4 }]);
  }
  const result = await repairAll();
  assert.equal(result.done, true);
  const images = await db.readImagesForMessages([`${cid}:final`]);
  assert.equal(images.length, 3);
  assert.deepEqual(images.map(i => new Uint8Array(i.blob)[0]).sort(), [1, 2, 3]);
  const convo = await db.readConversation(cid);
  assert.equal(convo.messages.length, 2);
  assert.equal((await db.searchConversations({ query: "creating" })).filter(conv => conv.id === cid).length, 0, "dropped progress tokens must be gone");
  assert.equal((await db.searchConversations({ query: "Done" })).filter(conv => conv.id === cid).length, 1, "final tokens must remain");
  assert.equal(convo.conversation.updatedAt, 1234);
  assert.equal(convo.conversation.updatedAtSource, "observed");
  assert.equal((await db.repairProgressDuplicates()).dropped, 0);
});

if (failures.length) throw new Error(`${failures.length} review regressions failed: ${failures.join(", ")}`);
console.log("progress-review ok");
