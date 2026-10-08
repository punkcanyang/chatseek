// Gemini content script → real background.js handler → IndexedDB.
// Checks the date claims on the production message path, not on db.js alone.
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { formatAbsoluteStamp, formatActivityLabel } from "../src/activity-time.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sharedSrc = readFileSync(join(root, "content/shared.js"), "utf8");
const geminiSrc = readFileSync(join(root, "content/gemini.js"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function absoluteStamp(ts, locale) {
  return formatAbsoluteStamp(ts, locale);
}

let listener = null;
globalThis.chrome = {
  runtime: {
    id: "test",
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(fn) { listener = fn; } },
    sendMessage: () => Promise.resolve(),
  },
  sidePanel: { setPanelBehavior: () => Promise.resolve() },
  action: {
    setBadgeText: () => Promise.resolve(),
    setBadgeBackgroundColor: () => Promise.resolve(),
  },
};
await import("../background.js");
const { listRecent } = await import("../src/db.js");
assert(typeof listener === "function", "background.js did not register onMessage");

const OPEN = "a1b2c3d4e5f60001";
const ROWS = ["f0e1d2c3b4a50000", OPEN, "9988776655443322", "1122334455667788"];
const TITLES = {
  f0e1d2c3b4a50000: "Top chat",
  [OPEN]: "Open chat",
  "9988776655443322": "Third chat",
  "1122334455667788": "Bottom chat",
};

function sidebarHtml(order) {
  return order.map((id) => `
    <div data-test-id="conversation" jslog='1;BardVeMetadataKey:[["c_${id}",null,0]]'>
      <a href="/u/1/app/${id}"><div class="conversation-title gds-label-l">${TITLES[id]}</div></a>
      <button data-test-id="actions-menu-button"><mat-icon>more_vert</mat-icon></button>
    </div>`).join("");
}

function exchange(id, user, reply) {
  return `
    <div class="conversation-container" id="${id}">
      <user-query><div class="query-text">
        <span class="cdk-visually-hidden">You said</span><p class="query-text-line">${user}</p>
      </div></user-query>
      <model-response><message-content class="model-response-text">
        <div class="markdown"><p>${reply}</p></div>
      </message-content></model-response>
    </div>`;
}

const dom = new JSDOM(`<!DOCTYPE html><html><head><title>Google Gemini</title></head><body>
  <bard-sidenav><conversations-list class="conversation-items-container" id="side">${sidebarHtml(ROWS)}</conversations-list></bard-sidenav>
  <main id="thread">${exchange("r1", "OLD_QUESTION_TOKEN", "OLD_ANSWER_TOKEN")}</main>
</body></html>`, { url: `https://gemini.google.com/u/1/app/${OPEN}` });
const doc = dom.window.document;

const warns = [];
const contentChrome = {
  runtime: {
    id: "test",
    lastError: undefined,
    sendMessage(payload, cb) {
      const sender = { tab: { url: dom.window.location.href } };
      const async = listener(payload, sender, (res) => cb?.(res));
      if (async !== true) cb?.(undefined);
    },
  },
};
const api = new Function(
  "document", "location", "Node", "NodeFilter", "console", "chrome",
  `${sharedSrc}
   Chatseek.autoStart = false;
   ${geminiSrc}
   return Chatseek;`,
)(
  doc,
  dom.window.location,
  dom.window.Node,
  dom.window.NodeFilter,
  { warn: (line) => warns.push(String(line)), log: (line) => warns.push(String(line)) },
  contentChrome,
);
const gemini = api.platforms.gemini;

async function stored() {
  const rows = await listRecent({ platform: "gemini", limit: 50 });
  return Object.fromEntries(rows.map((row) => [row.platformId, row]));
}

async function order() {
  const rows = await listRecent({ platform: "gemini", limit: 50 });
  return rows.map((row) => row.platformId);
}

// 1. First visit: no anchors anywhere. Everything is unknown but keeps sidebar order,
//    including the thread we opened (it used to sink to the bottom).
assert(await gemini.capture(), "first capture failed");
let rows = await stored();
assert(Object.keys(rows).length === 4, `stored ${Object.keys(rows).length} rows`);
for (const id of ROWS) {
  assert(rows[id].updatedAtSource === "first-seen", `${id} should be first-seen, got ${rows[id].updatedAtSource}`);
  const label = formatActivityLabel(rows[id], Date.now(), "zh-TW");
  assert(label.unknown && label.text.startsWith("日期未知（收錄於"), label.text);
}
assert((await order()).join() === ROWS.join(), `opened thread broke sidebar order: ${(await order()).join()}`);
assert(rows[OPEN].messageCount === 2, `messageCount ${rows[OPEN].messageCount}`);

// 2. Scrolling up loads an older exchange above. That is not new activity.
doc.getElementById("thread").insertAdjacentHTML(
  "afterbegin",
  exchange("r0", "OLDER_QUESTION_TOKEN", "OLDER_ANSWER_TOKEN"),
);
assert(await gemini.capture(), "scrollback capture failed");
rows = await stored();
assert(rows[OPEN].updatedAtSource === "first-seen", `scrollback became ${rows[OPEN].updatedAtSource}`);
assert(rows[OPEN].messageCount === 4, `scrollback messageCount ${rows[OPEN].messageCount}`);

// 3. The user sends a message in the open tab. That is an exact "now" for this
//    thread. Neighbours below it display "before" that clock; the row above has
//    no clock above it, so it stays unknown. Sort keys are still estimated.
const before = Date.now();
doc.getElementById("thread").insertAdjacentHTML(
  "beforeend",
  exchange("r2", "NEW_QUESTION_TOKEN", "Thinking"),
);
assert(await gemini.capture(), "append capture failed");
rows = await stored();
const anchor = rows[OPEN];
assert(anchor.updatedAtSource === "observed", `new tail should be observed, got ${anchor.updatedAtSource}`);
assert(anchor.updatedAt >= before && anchor.updatedAt <= Date.now(), "observed time should be now");
const anchorLabel = formatActivityLabel(anchor, Date.now(), "zh-TW");
assert(!anchorLabel.approx && !anchorLabel.unknown, `observed label ${anchorLabel.text}`);
const aboveId = ROWS[0];
const aboveLabel = formatActivityLabel(rows[aboveId], Date.now(), "zh-TW");
assert(rows[aboveId].updatedAtSource === "sidebar-rank" && rows[aboveId].olderThanAt == null, aboveId);
assert(aboveLabel.unknown && aboveLabel.text.startsWith("日期未知（收錄於"), aboveLabel.text);
assert(!aboveLabel.text.includes("約") && !aboveLabel.text.includes("早於"), aboveLabel.text);
for (const id of ROWS.slice(2)) {
  assert(rows[id].updatedAtSource === "sidebar-rank", `${id} should be estimated, got ${rows[id].updatedAtSource}`);
  assert(rows[id].olderThanAt === anchor.updatedAt, `${id} should use the nearest clock above`);
  const hant = formatActivityLabel(rows[id], Date.now(), "zh-TW");
  const hans = formatActivityLabel(rows[id], Date.now(), "zh-CN");
  const en = formatActivityLabel(rows[id], Date.now(), "en");
  assert(hant.before && hant.text === `早於 ${absoluteStamp(anchor.updatedAt, "zh-TW")}` && !hant.text.includes("約"), hant.text);
  assert(hans.before && hans.text === `早于 ${absoluteStamp(anchor.updatedAt, "zh-CN")}` && !hans.text.includes("约"), hans.text);
  assert(en.before && en.text === `before ${absoluteStamp(anchor.updatedAt, "en")}`, en.text);
  assert(hant.text === formatActivityLabel(rows[ROWS[2]], Date.now(), "zh-TW").text, "rows under one clock share a label");
}
assert(rows[ROWS[0]].updatedAt >= anchor.updatedAt, "row above the anchor must not sort older than it");
assert(rows[ROWS[2]].updatedAt < anchor.updatedAt, "rows below the anchor must sort older");
assert(rows[ROWS[3]].updatedAt < rows[ROWS[2]].updatedAt, "estimates must keep sidebar order");

// 4. The reply streams into the same exchange. One row, not one per partial body.
const reply = doc.querySelector("#r2 .markdown p");
reply.textContent = "Thinking about NEW_ANSWER_TOKEN and the rest of a longer streamed reply.";
assert(await gemini.capture(), "streaming capture failed");
rows = await stored();
assert(rows[OPEN].messageCount === 6, `streaming made extra rows: ${rows[OPEN].messageCount}`);

// 5. Gemini moves the thread to the top. Order and anchor still agree.
const moved = [OPEN, ...ROWS.filter((id) => id !== OPEN)];
doc.getElementById("side").innerHTML = sidebarHtml(moved);
assert(await gemini.capture(), "reorder capture failed");
rows = await stored();
assert((await order()).join() === moved.join(), `order after reorder: ${(await order()).join()}`);
assert(rows[OPEN].updatedAtSource === "observed", "reorder must not downgrade the observed anchor");
for (const id of moved.slice(1)) {
  assert(rows[id].updatedAtSource === "sidebar-rank", `${id} after reorder: ${rows[id].updatedAtSource}`);
  assert(rows[id].olderThanAt === rows[OPEN].updatedAt, `${id} after reorder should sit before the open chat`);
  assert(
    formatActivityLabel(rows[id], Date.now(), "zh-TW").text === `早於 ${absoluteStamp(rows[OPEN].updatedAt, "zh-TW")}`,
    id,
  );
}

assert(Object.values(TITLES).every((title) => Object.values(rows).some((row) => row.title === title)), "titles drifted");
assert(!Object.values(rows).some((row) => /more_vert/.test(row.title)), "icon text leaked into a title");
const logged = warns.join("\n");
for (const secret of ["OLD_QUESTION_TOKEN", "NEW_ANSWER_TOKEN", "OLDER_ANSWER_TOKEN"]) {
  assert(!logged.includes(secret), `console included ${secret}`);
}

console.log("gemini-capture ok", {
  anchor: anchor.updatedAtSource,
  neighbours: moved.slice(1).map((id) => rows[id].updatedAtSource),
  messages: rows[OPEN].messageCount,
});
process.exit(0);
