import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { upsertMessages } from "../src/db.js";
import { CATALOG, LOCALE_FOLDER, LOCALE_ORDER } from "../src/i18n.js";
import { mountReader } from "../src/reader-view.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const start = Date.now();
  while (Date.now() - start < 4000) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error(`timed out: ${label}`);
}

const id = "chatgpt:22222222-2222-4222-8222-222222222222";
await upsertMessages(
  {
    id,
    platform: "chatgpt",
    platformId: "22222222-2222-4222-8222-222222222222",
    title: "Icon sample",
    url: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222",
    updatedAt: Date.now(),
    updatedAtSource: "page-exact",
  },
  [{ id: `${id}:u`, role: "user", body: "hello" }],
  { pageMessageIds: [`${id}:u`], captureId: id },
);

const html = readFileSync(join(root, "sidepanel/index.html"), "utf8")
  .replace(/<script[^>]*panel\.js[^>]*><\/script>/, "");
const dom = new JSDOM(html, { url: "chrome-extension://test/sidepanel/index.html" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  value: { language: "zh-CN", languages: ["zh-CN"] },
  configurable: true,
});
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.chrome = {
  i18n: { getUILanguage: () => "zh-CN" },
  windows: { async getCurrent() { return { id: 1 }; } },
  tabs: {
    async query() { return []; },
    async update() {},
    async create() {},
    onActivated: { addListener() {} },
    onUpdated: { addListener() {} },
  },
  runtime: {
    onMessage: { addListener() {} },
    sendMessage() {},
    getURL: (path) => path,
  },
  action: { setBadgeText() { return Promise.resolve(); } },
};

await import("../sidepanel/panel.js");
await until(() => document.querySelector(".read") && document.querySelector(".open-site"), "rows render");

const panelCss = readFileSync(join(root, "sidepanel/panel.css"), "utf8");
const readerCss = readFileSync(join(root, "reader/reader.css"), "utf8");
assert(panelCss.includes(".read:focus-visible") && panelCss.includes(".open-site:focus-visible"), "sidebar icons show a focus ring");
assert(panelCss.includes(".row:hover > .row-actions > .read"), "hover reveals the read icon");
assert(panelCss.includes(".row:focus-within > .row-actions > .open-site"), "keyboard focus inside the row reveals the original-site icon");
assert(readerCss.includes(".btn-open:focus-visible"), "reader icon shows a focus ring");
assert(!/fonts\.googleapis|cdn\.|font-family:\s*["']?(?:lucide|fontawesome)/i.test(panelCss + readerCss), "icons do not use an external font");

const host = document.createElement("div");
for (const code of LOCALE_ORDER) {
  const folder = LOCALE_FOLDER[code];
  const messages = JSON.parse(readFileSync(join(root, "_locales", folder, "messages.json"), "utf8"));
  const read = CATALOG[code].read;
  const open = CATALOG[code].openOriginal;
  assert(typeof read === "string" && read.trim() && typeof open === "string" && open.trim(), `${code} has both labels`);
  assert(messages.read?.message === read, `${code} read message matches the catalog`);
  assert(messages.openOriginal?.message === open, `${code} original-site message matches the catalog`);

  document.getElementById("lang").value = code;
  document.getElementById("lang").dispatchEvent(new dom.window.Event("change"));
  await until(() => {
    const readBtn = document.querySelector(".read");
    const openBtn = document.querySelector(".open-site");
    return readBtn?.getAttribute("aria-label") === read
      && readBtn.title === read
      && openBtn?.getAttribute("aria-label") === open
      && openBtn.title === open;
  }, `${code} sidebar labels`);

  for (const btn of document.querySelectorAll(".read, .open-site")) {
    assert(btn.tagName === "BUTTON" && btn.type === "button", `${code} control is a button`);
    assert(btn.getAttribute("aria-label") && btn.title, `${code} button has a name and a tooltip`);
    assert(btn.querySelector("svg[aria-hidden='true']"), `${code} button is an inline icon`);
    assert(!btn.querySelector("img"), `${code} icon is not an image request`);
  }

  mountReader(host, {
    locale: code,
    conversation: {
      id,
      platform: "chatgpt",
      title: "Icon sample",
      url: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222",
      updatedAt: Date.now(),
      updatedAtSource: "page-exact",
    },
    messages: [{ id: `${id}:u`, role: "user", body: "hello" }],
  });
  const readerBtn = host.querySelector("#openOriginal");
  assert(readerBtn && !readerBtn.hidden, `${code} reader button is shown`);
  assert(readerBtn.getAttribute("aria-label") === open && readerBtn.title === open, `${code} reader label`);
  assert(readerBtn.tagName === "BUTTON" && readerBtn.type === "button", `${code} reader control is a button`);
  assert(readerBtn.querySelector("svg[aria-hidden='true']"), `${code} reader icon is inline`);
  assert(readerBtn.textContent.trim() === "", `${code} reader icon has no leftover caption`);
}

console.log("icon a11y tests passed");
