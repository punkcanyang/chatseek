// Offline fallback when the browser benchmarks cannot listen in the sandbox.
// Run once per checkout, sequentially: node scripts/search-syntax-bench.mjs /path/to/checkout
// Measures fake-indexeddb search and JSDOM reader; excludes browser layout/paint.
import "fake-indexeddb/auto";
import { JSDOM } from "jsdom";
import { performance } from "node:perf_hooks";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const root = resolve(process.argv.slice(2).find((arg) => arg !== "--images") || ".");
const load = (file) => import(pathToFileURL(join(root, file)).href);
if (process.argv.includes("--images")) {
  const { mountImageGrid } = await load("src/image-grid.js");
  const cards = Array.from({ length: 500 }, (_, i) => ({
    conversationId: "chatgpt:sample-images", platform: "chatgpt", updatedAt: 1700000000000,
    chatUrl: "https://chatgpt.com/c/sample-images", messageId: `sample-${i}`, index: 0,
    status: "cached", bytes: 1, offset: 0, messageRank: i, alt: "Sample thumbnail",
  }));
  const open = [], scroll = [];
  for (let run = -1; run < 5; run++) {
    const dom = new JSDOM("<!doctype html><div id='grid'></div>");
    const grid = dom.window.document.getElementById("grid");
    Object.defineProperty(grid, "clientWidth", { value: 320 });
    Object.defineProperty(grid, "clientHeight", { value: 640 });
    const at = performance.now();
    const view = mountImageGrid(grid, { cards, locale: "en", width: 320, viewHeight: 640,
      loadThumb() { return { url: "data:image/webp;base64,AA==", release() {} }; },
    });
    await Promise.resolve();
    const openMs = performance.now() - at;
    const frames = [];
    for (let step = 0; step < 100; step++) {
      grid.scrollTop = step * 300;
      const start = performance.now();
      grid.dispatchEvent(new dom.window.Event("scroll"));
      frames.push(performance.now() - start);
      await Promise.resolve();
    }
    frames.sort((a, b) => a - b);
    if (run >= 0) { open.push(openMs); scroll.push(frames[95]); }
    view.destroy();
    dom.window.close();
  }
  const median = (values) => +values.sort((a, b) => a - b)[2].toFixed(2);
  console.log(JSON.stringify({ version: JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")).version,
    thumbnails: 500, runs: 5, imageMountMs: median(open), imageScrollP95Ms: median(scroll),
    environment: "JSDOM with sample thumbnail placeholders; excludes image decode, browser layout/paint",
  }, null, 2));
  process.exit(0);
}
const { openDb, clearAll, searchConversations } = await load("src/db.js");
const { tokenize, tokenSpans } = await load("src/tokenize.js");
const { indexPlain } = await load("src/markdown.js");
const { mountReader } = await load("src/reader-view.js");
const version = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")).version;
const syntax = version === "1.7.4";
const count = 3000;
const runs = 5;
await clearAll();
const db = await openDb();
const tx = db.transaction(["conversations", "messages", "tokenMap"], "readwrite");
const messages = [];
for (let i = 0; i < count; i++) {
  const id = `chatgpt:bench-${i}`;
  const body = i % 10 === 0 ? `Walk to **blue** orchid with chatseek, day ${i}.` : `Tea garden with chatseek, day ${i}.`;
  const message = { id: `bench-m${i}`, conversationId: id, role: i % 2 ? "assistant" : "user", body };
  messages.push(message);
  const title = `Camera ${i % 13 === 0 ? "draft" : "notes"} ${i}`;
  tx.objectStore("conversations").put({ id, title, platform: "chatgpt", platformId: `bench-${i}`, messageCount: 1, firstUserPreview: body, updatedAt: 1700000000000 + i });
  tx.objectStore("messages").put(message);
  for (const token of tokenize(title)) tx.objectStore("tokenMap").put({ token, conversationId: id, source: "title" });
  const positions = new Map();
  for (const { token, start } of tokenSpans(indexPlain(body))) {
    const list = positions.get(token) || [];
    if (list.length < 32) list.push(start);
    positions.set(token, list);
  }
  for (const [token, list] of positions) tx.objectStore("tokenMap").put({ token, conversationId: id, source: message.id, role: message.role, positions: list });
}
await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
const median = (values) => +values.sort((a, b) => a - b)[Math.floor(values.length / 2)].toFixed(2);
const out = { version, conversations: count, messages: count, runs, environment: "Node + fake-indexeddb + JSDOM; no browser layout/paint", results: {} };
const cases = [
  { name: "ordinary", query: "blue orchid", baseline: "blue orchid" },
  { name: "phrase", query: '"blue orchid"', baseline: "blue orchid" },
  { name: "wildcard", query: "chat*", baseline: "chatseek" },
  { name: "exclude", query: "blue orchid -title:draft", baseline: "blue orchid" },
  { name: "title", query: "title:camera", baseline: "camera" },
  { name: "combined", query: '"blue orchid" chat* -title:draft', baseline: "blue orchid" },
];
out.baselineNote = "1.7.2.3 lacks syntax; baseline uses the listed ordinary query, with matching sample vocabulary. Exclusion has 300 candidates versus 276 results; phrase has 600 term highlights versus 300 phrase highlights. Ratios measure added work, not equivalent semantics.";
for (const sample of cases) {
  const query = syntax ? sample.query : sample.baseline;
  const search = [], mount = [], scroll = [];
  let found = 0, hits = 0;
  for (let run = -1; run < runs; run++) {
    let at = performance.now();
    const rows = await searchConversations({ query, sort: { field: "relevance", dir: "desc" }, limit: count });
    const searchMs = performance.now() - at;
    found = rows.length;
    const dom = new JSDOM("<!doctype html><body><div id='app'></div></body>");
    const host = dom.window.document.getElementById("app");
    at = performance.now();
    const view = mountReader(host, { conversation: { id: "chatgpt:reader-bench", title: "Camera garden", platform: "chatgpt", messageCount: count }, messages: messages.map((msg) => ({ ...msg })), query, viewportHeight: 720 });
    const mountMs = performance.now() - at;
    hits = view.hitCount();
    const thread = host.querySelector("#thread");
    Object.defineProperty(thread, "clientHeight", { value: 720 });
    const frames = [];
    for (let step = 0; step < 100; step++) {
      thread.scrollTop = step * 3000;
      at = performance.now();
      thread.dispatchEvent(new dom.window.Event("scroll"));
      frames.push(performance.now() - at);
    }
    frames.sort((a, b) => a - b);
    if (run >= 0) { search.push(searchMs); mount.push(mountMs); scroll.push(frames[95]); }
    dom.window.close();
  }
  out.results[sample.name] = { query, found, hits, searchMs: median(search), readerMountMs: median(mount), readerScrollP95Ms: median(scroll) };
}
db.close();
console.log(JSON.stringify(out, null, 2));
