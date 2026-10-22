import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { IDBDatabase } from "fake-indexeddb";
import { JSDOM } from "jsdom";
import { clearAll, openDb, readConversation, readConversationRow, removeConversation,
  upsertConversations, upsertMessages } from "../src/db.js";
import { mountReader } from "../src/reader-view.js";

const id = "chatgpt:11111111-1111-4111-8111-111111111111";
const conv = { id, platform: "chatgpt", platformId: id.slice(8), title: "Sample reader",
  url: `https://chatgpt.com/c/${id.slice(8)}`, updatedAt: Date.now(), updatedAtSource: "page-exact" };
const messages = Array.from({ length: 100 }, (_, i) => ({
  id: `${id}:m${i}`, role: "user", body: `Sample message ${i}${i === 0 || i === 70 ? " needle" : ""}`,
}));
const capture = (rows, extra = {}) => upsertMessages({ ...conv, ...extra }, rows,
  { captureId: "sample", pageMessageIds: rows.map((msg) => msg.id) });
await capture(messages);
const initial = await readConversationRow(id);
assert.ok(initial.contentRevision);
await capture(messages);
assert.equal((await readConversationRow(id)).contentRevision, initial.contentRevision, "unchanged capture keeps revision");

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: `https://extension.test/reader/index.html?id=${encodeURIComponent(id)}&q=needle`,
});
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
  location: dom.window.location, localStorage: dom.window.localStorage })) globalThis[key] = value;
const listeners = [];
globalThis.chrome = { i18n: { getUILanguage: () => "en" }, runtime: {
  onMessage: { addListener: (fn) => listeners.push(fn) },
} };
await import("../reader/reader.js");
const notify = () => Promise.all(listeners.map((fn) => fn({ type: "INDEX_UPDATED" })));
const text = () => document.getElementById("app").textContent;
const transaction = IDBDatabase.prototype.transaction;
let bodyReads = 0;
IDBDatabase.prototype.transaction = function (stores, mode, ...args) {
  if (mode === "readonly" && Array.from(typeof stores === "string" ? [stores] : stores).includes("messages")) bodyReads++;
  return transaction.call(this, stores, mode, ...args);
};
try {
  document.getElementById("nextHit").click();
  assert.ok(document.querySelector('.msg[data-index="70"]'), "jump to later hit");
  const oldThread = document.getElementById("thread");
  await upsertConversations([{ ...conv, archived: true, archiveSource: "site-deleted" }]);
  await notify();
  assert.equal(bodyReads, 0, "archive/time notifications never read message bodies");
  assert.equal(document.getElementById("thread"), oldThread, "metadata keeps the mounted view");
  assert.equal(document.getElementById("siteDeletedNote").hidden, false);

  messages[70] = { ...messages[70], body: "Edited sample seventy needle" };
  await capture(messages);
  assert.notEqual((await readConversationRow(id)).contentRevision, initial.contentRevision, "same-count edit changes revision");
  await notify();
  assert.equal(bodyReads, 1, "body revision reads one snapshot");
  assert.ok(text().includes("Edited sample seventy"), "same-count edit reaches the visible body");
  assert.ok(document.querySelector('.msg[data-index="70"]'), "refresh preserves later reading window");
  assert.equal(document.querySelector('.msg[data-index="0"]'), null, "refresh does not jump to first hit");

  await upsertConversations([{ ...conv, title: "Renamed sample" }]);
  await notify();
  assert.equal(document.getElementById("readerTitle").textContent, "Renamed sample");
  const readsBefore = bodyReads;
  await Promise.all(Array.from({ length: 20 }, notify));
  assert.equal(bodyReads, readsBefore, "duplicate notifications do not reread bodies");

  // A legacy conversation gains a revision lazily on its first real edit.
  const db = await openDb();
  const legacy = await readConversationRow(id);
  delete legacy.contentRevision;
  await new Promise((resolve, reject) => {
    const tx = db.transaction("conversations", "readwrite");
    tx.objectStore("conversations").put(legacy);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  await notify();
  messages.push({ id: `${id}:m100`, role: "assistant", body: "New sample final needle" });
  await capture(messages);
  await notify();
  document.getElementById("nextHit").click();
  assert.ok(text().includes("New sample final"), "new messages and search hits refresh on a legacy row");

  await removeConversation(id);
  await notify();
  assert.equal(document.getElementById("app").dataset.state, "missing");
  assert.ok(!text().includes("New sample final"), "deletion removes old text from reader");
  await capture([{ id: `${id}:reopened`, role: "user", body: "Reopened example needle" }]);
  await notify();
  assert.ok(text().includes("Reopened example"), "missing reader recovers when conversation is recaptured");
  await clearAll();
  await notify();
  assert.equal(document.getElementById("app").dataset.state, "missing", "clear all removes visible content");

  // The view anchors by message identity when older turns are prepended.
  const host = document.createElement("div");
  document.body.append(host);
  const first = mountReader(host, { conversation: conv, messages, query: "needle" });
  first.next();
  const saved = first.position();
  first.destroy();
  const next = mountReader(host, { conversation: conv, query: "needle", position: saved,
    messages: [{ id: "older", role: "user", body: "Older example" }, ...messages] });
  assert.equal(next.position().messageId, saved.messageId, "prepending preserves anchored message");
  assert.equal(next.position().offset, saved.offset, "prepending preserves offset within message");
  assert.equal(next.hitIndex(), 1, "active search hit is preserved by message and range");
  next.destroy();
  assert.equal(await readConversation(id), null);
} finally {
  IDBDatabase.prototype.transaction = transaction;
  dom.window.close();
}
console.log("reader-refresh ok: revisions, metadata-only reads, edits, appended hits, legacy rows, deletion, recreation, position");
