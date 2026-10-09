import { performance } from "node:perf_hooks";
import {
  SYNC_BATCH_SIZE,
  SYNC_GAP_MAX_MS,
  SYNC_GAP_MIN_MS,
  SYNC_REST_MS,
  activeSyncLimits,
  classifySyncPage,
  emptySyncState,
  estimateRemaining,
  gapDelay,
  homeUrl,
  mergeQueue,
  navigableConversationUrl,
  productionSyncLimits,
  publicSyncView,
  shouldSkip,
  stepSync,
} from "../src/sync-policy.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const prod = productionSyncLimits();
assert(prod.gapMin === 20000 && SYNC_GAP_MIN_MS === 20000, "production gap min");
assert(prod.gapMax === 40000 && SYNC_GAP_MAX_MS === 40000, "production gap max");
assert(prod.batch === 30 && SYNC_BATCH_SIZE === 30, "production batch");
assert(prod.rest === 10 * 60 * 1000 && SYNC_REST_MS === 600000, "production rest");
assert(activeSyncLimits(null).gapMin === 20000, "no override stays at production");
assert(activeSyncLimits({ gapMin: 999999, gapMax: 999999, batch: 999, rest: 999999999 }).gapMin === 20000, "override cannot lengthen the gap");
assert(activeSyncLimits({ rest: 999999999 }).rest === prod.rest, "override cannot lengthen the rest");
assert(activeSyncLimits({ batch: 99 }).batch === 30, "override cannot enlarge the batch");
const testPace = activeSyncLimits({ gapMin: 200, gapMax: 400, batch: 2, rest: 500, settle: 40, report: 300, emptyLimit: 3 });
assert(testPace.gapMin === 200 && testPace.gapMax === 400 && testPace.batch === 2 && testPace.rest === 500, "tests may shorten the pace");
assert(gapDelay(prod, () => 0) === 20000, "gap floor");
assert(gapDelay(prod, () => 1) === 40000, "gap ceiling");
for (let i = 0; i < 50; i += 1) {
  const gap = gapDelay(prod, Math.random);
  assert(gap >= 20000 && gap <= 40000, `gap out of range ${gap}`);
}

const id = (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, "0")}`;
const chat = (n) => `https://chatgpt.com/c/${id(n)}`;

assert(navigableConversationUrl(chat(1), "chatgpt") === chat(1), "chatgpt url");
assert(navigableConversationUrl("https://evil.example/c/" + id(1), "chatgpt") === "", "foreign host");
assert(navigableConversationUrl("javascript:alert(1)", "chatgpt") === "", "javascript url");
assert(navigableConversationUrl(`https://chatgpt.com/c/${id(1)}?temporary-chat=true`, "chatgpt") === chat(1), "query stripped");
assert(homeUrl("claude") === "https://claude.ai/new", "claude home");
assert(navigableConversationUrl("https://gemini.google.com/app/abcdefgh", "gemini") === "", "gemini id without a digit");
assert(navigableConversationUrl("https://gemini.google.com/app/abcd1234ef", "gemini").includes("/app/abcd1234ef"), "gemini app url");

assert(shouldSkip({ storedCount: 2, storedUpdatedAt: 2_000, sidebarUpdatedAt: 1_000, sidebarCount: null }), "older sidebar time skips");
assert(!shouldSkip({ storedCount: 2, storedUpdatedAt: 2_000, sidebarUpdatedAt: 3_000, sidebarCount: null }), "newer sidebar time visits");
assert(shouldSkip({ storedCount: 2, storedUpdatedAt: 2_000, sidebarUpdatedAt: null, sidebarCount: 2 }), "same count skips");
assert(!shouldSkip({ storedCount: 2, storedUpdatedAt: 2_000, sidebarUpdatedAt: null, sidebarCount: 4 }), "higher count visits");
assert(!shouldSkip({ storedCount: 2, storedUpdatedAt: 2_000, sidebarUpdatedAt: null, sidebarCount: null }), "no sidebar signal visits");
assert(!shouldSkip({ storedCount: 0, storedUpdatedAt: 2_000, sidebarUpdatedAt: 1_000, sidebarCount: 0 }), "title-only is not skipped");

const stored = [
  { id: `chatgpt:${id(1)}`, url: chat(1), updatedAt: 100, messageCount: 3 },
  { id: `chatgpt:${id(2)}`, url: chat(2), updatedAt: 300, messageCount: 1 },
];
const links = [
  { url: chat(2), updatedAt: 50, messageCount: null },
  { url: chat(3), updatedAt: null, messageCount: null },
  { url: "https://evil.example/c/" + id(9), updatedAt: 1, messageCount: 1 },
];
const queue = mergeQueue(stored, links, "chatgpt");
assert(queue.map((item) => item.id).join() === [`chatgpt:${id(2)}`, `chatgpt:${id(1)}`, `chatgpt:${id(3)}`].join(), "stored newest first, then new sidebar links");
assert(queue[0].skip === true, "older sidebar time on a stored chat skips");
assert(queue[2].skip === false && queue[2].storedCount === 0, "sidebar-only chat is visited");
assert(!queue.some((item) => item.url.includes("evil")), "foreign sidebar link dropped");

const many = Array.from({ length: 3000 }, (_, n) => ({
  id: `chatgpt:${id(n + 1)}`,
  url: chat(n + 1),
  updatedAt: n,
  messageCount: 1,
}));
const started = performance.now();
const merged = mergeQueue(many, [], "chatgpt");
const elapsed = performance.now() - started;
assert(merged.length === 3000, "3000 conversations stay in the queue");
assert(elapsed < 500, `merging 3000 conversations took ${elapsed.toFixed(0)}ms`);

assert(classifySyncPage({
  href: "https://chatgpt.com/",
  title: "ChatGPT",
  platform: "chatgpt",
  messageCount: 0,
}) === "ok", "home is ok");
assert(classifySyncPage({
  href: chat(1),
  title: "Habitat",
  platform: "chatgpt",
  messageCount: 2,
}) === "ok", "conversation is ok");
assert(classifySyncPage({
  href: "https://chatgpt.com/cdn-cgi/challenge-platform/h/b",
  title: "Just a moment",
  platform: "chatgpt",
  hasChallengeNode: true,
  messageCount: 0,
}) === "captcha", "cloudflare url");
assert(classifySyncPage({
  href: chat(4),
  title: "Chat",
  platform: "chatgpt",
  hasChallengeNode: true,
  messageCount: 0,
}) === "captcha", "challenge widget");
assert(classifySyncPage({
  href: "https://chatgpt.com/auth/login",
  title: "Log in",
  platform: "chatgpt",
  hasPassword: true,
  messageCount: 0,
}) === "login", "login url");
assert(classifySyncPage({
  href: chat(5),
  title: "Log in",
  platform: "chatgpt",
  hasPassword: true,
  messageCount: 0,
}) === "login", "password form");
assert(classifySyncPage({
  href: chat(6),
  title: "Notes",
  platform: "chatgpt",
  hasErrorBanner: true,
  messageCount: 0,
}) === "error", "error banner");
assert(classifySyncPage({
  href: chat(7),
  title: "Notes",
  platform: "chatgpt",
  hasRateBanner: true,
  messageCount: 0,
}) === "rate", "rate banner");
assert(classifySyncPage({
  href: "https://accounts.google.com/signin",
  title: "Sign in",
  platform: "gemini",
  messageCount: 0,
}) === "uncertain", "off-host login is uncertain");
assert(classifySyncPage({
  href: "https://chatgpt.com/unknown-area",
  title: "Hmm",
  platform: "chatgpt",
  messageCount: 0,
}) === "uncertain", "unknown path stops");

const limits = testPace;
const random = () => 0;
let now = 10_000;
let state = emptySyncState();
let step = stepSync(state, { type: "startup" }, now, limits, random);
assert(step.effect == null && step.state.status === "idle", "startup does nothing when idle");

step = stepSync(state, { type: "start", platform: "chatgpt", token: "panel", stored: stored }, now, limits, random);
assert(step.effect?.op === "create" && step.effect.url === "https://chatgpt.com/", "start opens the home tab");
assert(step.state.status === "running" && step.state.phase === "harvest", "start is running");
state = stepSync(step.state, { type: "tab", tabId: 4 }, now, limits, random).state;

step = stepSync(state, { type: "startup" }, now, limits, random);
assert(step.state.status === "paused" && step.state.reason === "startup" && step.effect == null, "startup pauses a live run and does not navigate");
state = stepSync(step.state, { type: "resume", token: "panel" }, now, limits, random).state;
assert(state.status === "running", "resume continues");

step = stepSync(state, { type: "tick", token: "other", tabStatus: "complete" }, now, limits, random);
assert(step.state.status === "paused" && step.state.reason === "panel" && step.effect == null, "a different panel pauses");
state = stepSync(step.state, { type: "resume", token: "panel" }, now + 5, limits, random).state;

const reportHome = {
  href: "https://chatgpt.com/",
  title: "ChatGPT",
  messageCount: 0,
  links,
};
step = stepSync(state, { type: "tick", token: "panel", tabStatus: "complete", report: reportHome }, now + 20, limits, random);
assert(step.state.phase === "gap" && step.effect == null, "harvest waits before the first conversation");
assert(step.state.queue.some((item) => item.skip) && step.state.queue.some((item) => item.id.endsWith(id(3))), "harvest keeps sidebar links");
state = step.state;
const gapLeft = state.waitUntil - (now + 20);
step = stepSync(state, { type: "pause", token: "panel" }, now + 20 + 10, limits, random);
assert(step.state.status === "paused" && step.state.remainMs === gapLeft - 10, `pause freezes the wait, remain ${step.state.remainMs}`);
state = stepSync(step.state, { type: "resume", token: "panel" }, now + 5000, limits, random).state;
assert(state.status === "running" && state.waitUntil === now + 5000 + (gapLeft - 10), "resume restores the remaining wait");

step = stepSync(state, { type: "tick", token: "panel" }, state.waitUntil, limits, random);
assert(step.effect?.op === "navigate" && step.effect.url === chat(1), `first visit is the unskipped stored chat, got ${step.effect && step.effect.url}`);
assert(!String(step.effect.url).includes(id(2)), "skipped chat is not opened");
state = step.state;
step = stepSync(state, {
  type: "tick",
  token: "panel",
  tabStatus: "complete",
  report: { href: chat(1), title: "New", messageCount: 2, links },
}, state.openedAt + 10, limits, random);
assert(step.state.captured === 1 && step.state.skipped >= 1, "captured the chat and counted skips");
state = step.state;

step = stepSync(state, { type: "tab-closed" }, state.waitUntil, limits, random);
assert(step.state.status === "stopped" && step.state.reason === "tab-closed" && step.effect == null, "closing the sync tab stops");

function runEmpty() {
  const rows = [1, 2, 3, 4].map((n) => ({ url: chat(n), updatedAt: null, messageCount: null }));
  const emptyPace = activeSyncLimits({ gapMin: 200, gapMax: 200, batch: 30, rest: 500, emptyLimit: 3, settle: 40, report: 300 });
  let cursor = 20_000;
  let current = stepSync(emptySyncState(), {
    type: "start",
    platform: "chatgpt",
    token: "panel",
    stored: [],
  }, cursor, emptyPace, random).state;
  current = stepSync(current, { type: "tab", tabId: 9 }, cursor, emptyPace, random).state;
  let opened = [];
  current = stepSync(current, {
    type: "tick",
    token: "panel",
    tabStatus: "complete",
    report: { href: "https://chatgpt.com/", title: "ChatGPT", messageCount: 0, links: rows },
  }, cursor, emptyPace, random).state;
  for (let guard = 0; guard < 20 && current.status === "running"; guard += 1) {
    cursor = Math.max(cursor + 1, current.waitUntil || cursor);
    const tick = stepSync(current, { type: "tick", token: "panel", tabStatus: "loading" }, cursor, emptyPace, random);
    if (tick.effect?.op === "navigate") opened.push(tick.effect.url);
    current = tick.state;
    if (current.phase !== "opening") continue;
    const page = stepSync(current, {
      type: "tick",
      token: "panel",
      tabStatus: "complete",
      report: { href: current.queue[current.index].url, title: "Empty", messageCount: 0, links: rows },
    }, cursor + emptyPace.settle, emptyPace, random);
    current = page.state;
  }
  return { current, opened };
}
const emptyRun = runEmpty();
assert(emptyRun.opened.length === 3, `three empty pages then stop, opened ${emptyRun.opened.length}`);
assert(!emptyRun.opened.includes(chat(4)), "the fourth empty page is not opened");
assert(emptyRun.current.status === "stopped" && emptyRun.current.reason === "empty", "empty streak stops");

function stopOn(kind, report) {
  let cursor = 30_000;
  let current = stepSync(emptySyncState(), {
    type: "start",
    platform: "chatgpt",
    token: "panel",
    stored: [{ id: `chatgpt:${id(8)}`, url: chat(8), updatedAt: 1, messageCount: 0 }],
  }, cursor, limits, random).state;
  current = stepSync(current, { type: "tab", tabId: 3 }, cursor, limits, random).state;
  current = stepSync(current, {
    type: "tick",
    token: "panel",
    tabStatus: "complete",
    report: { href: "https://chatgpt.com/", title: "ChatGPT", messageCount: 0, links: [{ url: chat(8) }] },
  }, cursor, limits, random).state;
  cursor = current.waitUntil;
  current = stepSync(current, { type: "tick", token: "panel", tabStatus: "complete" }, cursor, limits, random).state;
  const page = stepSync(current, {
    type: "tick",
    token: "panel",
    tabStatus: "complete",
    report,
  }, cursor + 5, limits, random);
  assert(page.state.status === "stopped" && page.state.reason === kind && page.effect == null, `${kind} stops without another navigation`);
  assert(page.state.tabId === 3, `${kind} leaves the sync tab id in place`);
}
stopOn("captcha", { href: chat(8), title: "Just a moment", hasChallengeNode: true, messageCount: 0, links: [] });
stopOn("login", { href: "https://chatgpt.com/auth/login", title: "Log in", hasPassword: true, messageCount: 0, links: [] });
stopOn("rate", { href: chat(8), title: "Slow down", hasRateBanner: true, messageCount: 0, links: [] });
stopOn("error", { href: chat(8), title: "Error", hasErrorBanner: true, messageCount: 0, links: [] });
stopOn("uncertain", { href: "https://chatgpt.com/somewhere", title: "?", messageCount: 0, links: [] });

let batch = stepSync(emptySyncState(), {
  type: "start",
  platform: "chatgpt",
  token: "panel",
  stored: [],
}, 40_000, limits, random).state;
batch = stepSync(batch, { type: "tab", tabId: 1 }, 40_000, limits, random).state;
batch = stepSync(batch, {
  type: "tick",
  token: "panel",
  tabStatus: "complete",
  report: {
    href: "https://chatgpt.com/",
    title: "ChatGPT",
    messageCount: 0,
    links: [1, 2, 3].map((n) => ({ url: chat(n) })),
  },
}, 40_000, limits, random).state;
let clock = batch.waitUntil;
batch = stepSync(batch, { type: "tick", token: "panel" }, clock, limits, random).state;
batch = stepSync(batch, {
  type: "tick",
  token: "panel",
  tabStatus: "complete",
  report: { href: chat(1), title: "A", messageCount: 1, links: [] },
}, clock + 10, limits, random).state;
clock = batch.waitUntil;
batch = stepSync(batch, { type: "tick", token: "panel" }, clock, limits, random).state;
batch = stepSync(batch, {
  type: "tick",
  token: "panel",
  tabStatus: "complete",
  report: { href: chat(2), title: "B", messageCount: 1, links: [] },
}, clock + 10, limits, random).state;
assert(batch.status === "resting" && batch.phase === "rest", "a full batch rests");
const during = stepSync(batch, { type: "tick", token: "panel" }, batch.waitUntil - 1, limits, random);
assert(during.effect == null && during.state.status === "resting", "rest does not navigate early");
const after = stepSync(batch, { type: "tick", token: "panel" }, batch.waitUntil, limits, random);
assert(after.effect?.url === chat(3), "the next batch opens the next conversation");

const stopped = stepSync(after.state, { type: "stop" }, after.state.openedAt, limits, random);
assert(stopped.state.status === "stopped" && stopped.state.reason === "user", "stop is manual");
const view = publicSyncView(stopped.state, 50_000, limits);
assert(!/https?:|aaaaaaaa-aaaa/i.test(JSON.stringify(view)), "panel status has no url or id");
assert(estimateRemaining(stopped.state, 50_000, limits) === 0, "a stopped run has no remaining time");

let hold = stepSync(emptySyncState(), {
  type: "start",
  platform: "chatgpt",
  token: "panel",
  stored: [],
}, 60_000, testPace, random).state;
hold = stepSync(hold, { type: "tab", tabId: 9 }, 60_000, testPace, random).state;
hold = stepSync(hold, {
  type: "tick",
  token: "panel",
  tabStatus: "complete",
  report: { href: "https://chatgpt.com/", title: "ChatGPT", messageCount: 0, links: [{ url: chat(1) }] },
}, 60_000, testPace, random).state;
hold = stepSync(hold, { type: "tick", token: "panel" }, hold.waitUntil, testPace, random).state;
const stillOpen = stepSync(hold, {
  type: "tick",
  token: "panel",
  tabStatus: "complete",
  report: { href: chat(1), title: "A", messageCount: 2, storedCount: 0, links: [] },
}, hold.openedAt + 50, testPace, random);
assert(stillOpen.effect?.op === "inspect" && stillOpen.state.index === hold.index, "visible messages wait until they are stored");
const unsaved = stepSync(hold, {
  type: "tick",
  token: "panel",
  tabStatus: "complete",
  report: { href: chat(1), title: "A", messageCount: 2, storedCount: 0, links: [] },
}, hold.openedAt + testPace.report, testPace, random);
assert(unsaved.state.status === "stopped" && unsaved.state.reason === "uncertain" && unsaved.state.tabId === 9, "unstored page stops and keeps the tab");

const quiet = stepSync(emptySyncState(), { type: "tick", token: "panel" }, 1, limits, random);
assert(quiet.effect == null && quiet.state.status === "idle", "a tick never starts a run by itself");

console.log("sync-test ok", { merged: merged.length, mergeMs: Math.round(elapsed) });
