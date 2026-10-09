import "fake-indexeddb/auto";
import { JSDOM } from "jsdom";
import { clearImageCache, listImageCards, saveImageRecords, upsertMessages } from "../src/db.js";
import {
  filterImageCards,
  gridLayout,
  mountImageGrid,
  releaseUrl,
  sortImageCards,
  thumbUrl,
  visibleRange,
} from "../src/image-grid.js";
import { readerPageUrl, parseReaderSearch } from "../src/reader-url.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const older = {
  conversationId: "chatgpt:old",
  platform: "chatgpt",
  updatedAt: 1_700_000_000_000,
  chatUrl: "https://chatgpt.com/c/old",
};
const newer = {
  conversationId: "claude:new",
  platform: "claude",
  updatedAt: 1_800_000_000_000,
  chatUrl: "https://claude.ai/chat/new",
};
const cards = [
  { ...older, messageId: "chatgpt:old:b", index: 0, status: "cached", bytes: 10, offset: 40, messageRank: 1 },
  { ...older, messageId: "chatgpt:old:a", index: 1, status: "cached", bytes: 10, offset: 4, messageRank: 0 },
  { ...older, messageId: "chatgpt:old:a", index: 0, status: "cached", bytes: 10, offset: 4, messageRank: 0 },
  { ...newer, messageId: "claude:new:a", index: 0, status: "cached", bytes: 12, offset: 0, messageRank: 0 },
  { ...older, messageId: "chatgpt:old:a", index: 2, status: "uncached", bytes: 0, offset: 8, messageRank: 0 },
  { ...newer, messageId: "claude:new:b", index: 0, status: "oversized", bytes: 0, offset: 3, messageRank: 1 },
];
const shown = filterImageCards(cards, {});
assert(shown.map((card) => `${card.conversationId}:${card.messageId}:${card.index}`).join("|")
  === "claude:new:claude:new:a:0|chatgpt:old:chatgpt:old:a:0|chatgpt:old:chatgpt:old:a:1|chatgpt:old:chatgpt:old:b:0",
  `order ${shown.map((card) => card.messageId + ":" + card.index).join(",")}`);
assert(shown.every((card) => card.status === "cached"), "placeholders are hidden by default");
const withHoles = filterImageCards(cards, { showUncached: true });
assert(withHoles.some((card) => card.status === "uncached") && withHoles.some((card) => card.status === "oversized"), "show uncached keeps the reason");
assert(withHoles.find((card) => card.messageId === "chatgpt:old:a" && card.index === 2).status === "uncached", "placeholder stays in appearance order");
assert(filterImageCards(cards, { platform: "gemini" }).length === 0, "an empty platform matches nothing");
assert(filterImageCards(cards, { platform: "claude" }).length === 1, "platform filter keeps cached claude only");
assert(filterImageCards(cards, { platform: "claude", showUncached: true }).length === 2, "platform filter can include placeholders");
assert(sortImageCards(shown)[0].conversationId === "claude:new", "newest conversation stays first");
assert(gridLayout(320).cols === 2 && gridLayout(200).cols === 1, "320px keeps two columns");
const windowed = visibleRange({ scrollTop: 0, viewHeight: 300, count: 500, cols: 2, rowHeight: 148 });
assert(windowed.end < 40 && windowed.end > 0, `first window is small ${windowed.end}`);
const deep = visibleRange({ scrollTop: 5000, viewHeight: 300, count: 500, cols: 2, rowHeight: 148 });
assert(deep.start > 40 && deep.end < 120, `scrolled window ${deep.start}-${deep.end}`);

const packed = thumbUrl(new Uint8Array([1, 2, 3, 4]), "image/webp");
assert(packed.url.startsWith("data:image/webp;base64,"), "thumbnail is a data URL");
packed.release();
const revoked = [];
const originalRevoke = URL.revokeObjectURL;
URL.revokeObjectURL = (url) => revoked.push(url);
releaseUrl("blob:https://chatgpt.com/secret");
releaseUrl("data:image/webp;base64,AA==");
URL.revokeObjectURL = originalRevoke;
assert(revoked.length === 1 && revoked[0].startsWith("blob:"), "only an object URL is revoked");

const dom = new JSDOM("<!DOCTYPE html><div id='grid'></div>");
const scroller = dom.window.document.getElementById("grid");
Object.defineProperty(scroller, "clientWidth", { value: 292 });
Object.defineProperty(scroller, "clientHeight", { value: 300 });
const many = Array.from({ length: 500 }, (_, i) => ({
  conversationId: "chatgpt:many",
  platform: "chatgpt",
  updatedAt: 1_800_000_000_000,
  chatUrl: "https://chatgpt.com/c/many",
  messageId: `chatgpt:many:m${Math.floor(i / 2)}`,
  index: i % 2,
  status: "cached",
  bytes: 8,
  offset: i,
  messageRank: Math.floor(i / 2),
  alt: "",
}));
const loads = [];
const releases = [];
const opened = [];
const sites = [];
const view = mountImageGrid(scroller, {
  cards: many,
  locale: "zh-TW",
  width: 292,
  viewHeight: 300,
  loadThumb(card) {
    loads.push(`${card.messageId}:${card.index}`);
    return {
      url: "data:image/webp;base64,AA==",
      release() { releases.push(`${card.messageId}:${card.index}`); },
    };
  },
  onOpenReader(card) { opened.push(card); },
  onOpenSite(url) { sites.push(url); },
});
await new Promise((resolve) => setTimeout(resolve, 20));
assert(view.mounted() < 40, `mounted ${view.mounted()} of 500`);
assert(loads.length === view.mounted(), `decoded ${loads.length} for ${view.mounted()} cells`);
assert(scroller.querySelector(".shot-img")?.getAttribute("src")?.startsWith("data:image/"), "visible thumb is decoded");
assert(!scroller.innerHTML.includes("https://"), "grid markup has no remote address");
scroller.scrollTop = 5000;
scroller.dispatchEvent(new dom.window.Event("scroll"));
await new Promise((resolve) => setTimeout(resolve, 20));
assert(releases.length > 0, "leaving the window releases the thumbnail");
assert(view.mounted() < 40, `still virtualized ${view.mounted()}`);
assert(!loads.includes("chatgpt:many:m0:0") || releases.includes("chatgpt:many:m0:0"), "the first thumb is not kept after scrolling away");
scroller.querySelector(".shot-open").click();
assert(opened.length === 1 && opened[0].messageId.startsWith("chatgpt:many:"), "open passes the card, not an image address");
scroller.querySelector(".shot-site").click();
assert(sites.length === 1 && sites[0] === "https://chatgpt.com/c/many", `site icon ${sites[0]}`);
view.destroy();
assert(scroller.children.length === 0, "destroy drops the grid");

const round = readerPageUrl("chatgpt:old", "", { getURL: (path) => `chrome-extension://chatseek-test/${path}` }, {
  messageId: "chatgpt:old:a",
  index: 1,
});
const parsed = parseReaderSearch(new URL(round).search);
assert(parsed.id === "chatgpt:old" && parsed.messageId === "chatgpt:old:a" && parsed.imageIndex === 1, round);
assert(!round.includes("http"), "the reader link is not an image address");

const conv = {
  id: "chatgpt:old",
  platform: "chatgpt",
  platformId: "old",
  title: "舊的",
  url: "https://chatgpt.com/c/old",
  updatedAt: 1_700_000_000_000,
  updatedAtSource: "page-exact",
};
await upsertMessages(conv, [
  { id: "chatgpt:old:a", role: "user", body: "first" },
  { id: "chatgpt:old:b", role: "assistant", body: "second" },
], { pageMessageIds: ["chatgpt:old:a", "chatgpt:old:b"], captureId: "old" });
await saveImageRecords(conv.id, [
  { messageId: "chatgpt:old:b", index: 0, status: "cached", mime: "image/webp", width: 4, height: 4, offset: 3, bytes: [9, 8, 7, 6], alt: "later" },
  { messageId: "chatgpt:old:a", index: 0, status: "cached", mime: "image/webp", width: 4, height: 4, offset: 1, bytes: [1, 2, 3, 4], alt: "https://cdn.example/secret.png" },
  { messageId: "chatgpt:old:a", index: 1, status: "uncached", offset: 2, url: "https://cdn.example/secret.png", src: "blob:https://chatgpt.com/x" },
]);
let listed = await listImageCards();
assert(listed.length === 3, `listed ${listed.length}`);
assert(listed.every((row) => !("blob" in row) && !("url" in row) && !("src" in row)), "the list does not carry bytes or addresses");
assert(!JSON.stringify(listed).includes("cdn.example"), `alt kept an address ${JSON.stringify(listed.map((row) => row.alt))}`);
const ordered = filterImageCards(listed, { showUncached: true });
assert(ordered.map((row) => `${row.messageId}:${row.index}:${row.status}`).join(",")
  === "chatgpt:old:a:0:cached,chatgpt:old:a:1:uncached,chatgpt:old:b:0:cached",
  `stored order ${ordered.map((row) => row.messageId + ":" + row.index).join(",")}`);
await clearImageCache();
listed = filterImageCards(await listImageCards(), {});
assert(listed.length === 0, "clearing the cache removes thumbs from the default grid");
const holes = filterImageCards(await listImageCards(), { showUncached: true });
assert(holes.filter((row) => row.status === "cleared").length === 2, "cached rows become cleared placeholders");
assert(holes.some((row) => row.status === "uncached"), "an existing placeholder stays");

console.log("image-grid-test ok");
