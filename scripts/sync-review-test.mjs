import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { IDBObjectStore } from "fake-indexeddb";
import { emptySyncState, homeUrl, mergeQueue, productionSyncLimits, stepSync } from "../src/sync-policy.js";
import { readSyncSession, writeSyncSession } from "../src/db.js";
import { handleSyncMessage } from "../src/sync-runner.js";

const uuid = (n) => `${n.repeat(8)}-${n.repeat(4)}-${n.repeat(4)}-${n.repeat(4)}-${n.repeat(12)}`;
const targets = {
  chatgpt: (n) => `https://chatgpt.com/c/${uuid(n)}`,
  claude: (n) => `https://claude.ai/chat/${uuid(n)}`,
  grok: (n) => `https://grok.com/c/${uuid(n)}`,
  gemini: (n) => `https://gemini.google.com/u/2/app/${n.repeat(12)}`,
};
const pace = productionSyncLimits();
const now = Date.now();
for (const [platform, url] of Object.entries(targets)) {
  const id = `${platform}:${platform === "gemini" ? "1".repeat(12) : uuid("1")}`;
  const stored = [{ id, url: url("1"), updatedAt: now, messageCount: 2 }];
  for (const missing of [null, undefined, "", "  ", NaN, Infinity]) {
    const [item] = mergeQueue(stored, [{ url: url("1"), updatedAt: missing, messageCount: null }], platform);
    assert.equal(item.sidebarUpdatedAt, null, `${platform}: unknown date stays unknown`);
    assert.equal(item.skip, false, `${platform}: unknown date must visit`);
  }
  assert.equal(mergeQueue(stored, [{ url: url("1"), updatedAt: now - 1000 }], platform)[0].skip, true);
  assert.equal(mergeQueue(stored, [{ url: url("1"), updatedAt: now + 1000 }], platform)[0].skip, false);
  const state = { ...emptySyncState(), status: "running", phase: "opening", platform,
    token: "panel", tabId: 7, openedAt: now, queue: [{ url: url("1") }] };
  const tick = (href, at, extra = {}) => stepSync(state, {
    type: "tick", token: "panel", tabStatus: "complete",
    report: { href, title: "Sample", messageCount: 2, storedCount: 2, ...extra },
  }, at, pace);
  const held = tick(url("2"), now + 1000);
  assert.equal(held.state.captured, 0);
  assert.equal(held.state.index, 0);
  assert.equal(held.effect.op, "inspect", "transient old document waits for target");
  const stopped = tick(url("2"), now + pace.report);
  assert.equal(stopped.state.status, "stopped");
  assert.equal(stopped.state.reason, "uncertain");
  assert.equal(stopped.state.captured, 0);
  assert.equal(tick(homeUrl(platform), now + pace.report).state.reason, "uncertain", "home redirect cannot count as target");
  const success = tick(url("1") + "?sample=1#tail", now + 1500);
  assert.equal(success.state.captured, 1, "correct target after transient mismatch succeeds");
  assert.equal(success.state.status, "done");
  const challenge = tick(url("2"), now + 1000, { hasChallengeNode: true });
  assert.equal(challenge.state.reason, "captcha", "identity check does not postpone challenge stop");
}

// Exercise the actual runner and IndexedDB writer during a ten-minute rest.
const state = { ...emptySyncState(), status: "resting", phase: "rest", platform: "chatgpt",
  token: "panel", tabId: 7, waitUntil: now + pace.rest,
  queue: Array.from({ length: 5000 }, () => ({ url: targets.chatgpt("1") })) };
await writeSyncSession(state);
globalThis.chrome = { tabs: { get: async () => ({ id: 7, status: "complete" }) } };
const put = IDBObjectStore.prototype.put;
let writes = 0;
let rejectNext = false;
IDBObjectStore.prototype.put = function (value, ...args) {
  if (value?.key === "sync:session") {
    writes += 1;
    if (rejectNext) { rejectNext = false; throw new Error("simulated storage failure"); }
  }
  return put.call(this, value, ...args);
};
try {
  for (let i = 0; i < 40; i++) await handleSyncMessage({ type: "SYNC_TICK", token: "panel" });
  assert.equal(writes, 0, "unchanged rest with 5000 entries never rewrites the queue");
  assert.equal((await handleSyncMessage({ type: "SYNC_PAUSE", token: "panel" })).status, "paused");
  assert.equal(writes, 1, "pause is durable");
  await handleSyncMessage({ type: "SYNC_TICK", token: "panel" });
  assert.equal(writes, 1, "unchanged pause is not rewritten");
  await handleSyncMessage({ type: "SYNC_RESUME", token: "panel" });
  assert.equal(writes, 2, "resume is durable");
  await Promise.all(Array.from({ length: 10 }, () => handleSyncMessage({ type: "SYNC_TICK", token: "panel" })));
  assert.equal(writes, 2, "serialized concurrent ticks remain read-only");
  rejectNext = true;
  await handleSyncMessage({ type: "SYNC_PAUSE", token: "panel" });
  assert.equal((await readSyncSession()).status, "resting", "failed save leaves durable state intact");
  await handleSyncMessage({ type: "SYNC_TICK", token: "panel" });
  assert.equal(writes, 4, "next unchanged tick retries the failed save");
  assert.equal((await readSyncSession()).status, "paused");
  const restarted = await import("../src/sync-runner.js?review-restart");
  assert.equal((await restarted.handleSyncMessage({ type: "SYNC_STATUS", token: "panel" })).status, "paused");
  assert.equal(writes, 4, "worker restart reuses durable state without another write");
} finally {
  IDBObjectStore.prototype.put = put;
}
console.log("sync-review ok", { platforms: 4, queue: 5000, unchangedTicks: 40, unchangedWrites: 0, failureRetry: true });
