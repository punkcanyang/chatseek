// Real browser layout + the actual reader/IndexedDB modules, sample data only.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/seed") { res.end("<!doctype html><title>Sample setup</title>"); return; }
    const file = await readFile(join(root, path));
    res.writeHead(200, { "content-type": types[extname(path)] || "application/octet-stream" });
    res.end(file);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setViewport({ width: 900, height: 800 });
  await page.evaluateOnNewDocument(() => {
    window.__listeners = [];
    window.chrome = { i18n: { getUILanguage: () => "en" }, runtime: {
      onMessage: { addListener: (fn) => window.__listeners.push(fn) },
    } };
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${origin}/seed`);
  const id = await page.evaluate(async () => {
    const { upsertMessages } = await import("/src/db.js");
    const id = "chatgpt:11111111-1111-4111-8111-111111111111";
    const conv = { id, platform: "chatgpt", title: "Sample travel notes", platformId: id.slice(8),
      url: `https://chatgpt.com/c/${id.slice(8)}`, updatedAt: Date.now(), updatedAtSource: "page-exact" };
    const rows = Array.from({ length: 120 }, (_, i) => ({ id: `${id}:m${i}`,
      role: i % 2 ? "assistant" : "user", body: `## Sample day ${i}\n\nA quiet walk through the garden. ${i === 0 || i === 70 ? "Maple needle trees." : "Green trees."}` }));
    await upsertMessages(conv, rows, { captureId: "sample", pageMessageIds: rows.map((msg) => msg.id) });
    return id;
  });
  await page.goto(`${origin}/reader/index.html?id=${encodeURIComponent(id)}&q=needle`);
  await page.waitForSelector('#app[data-state="messages"]');
  await page.click("#nextHit");
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await settle();
  const anchor = () => page.evaluate(() => {
    const top = document.getElementById("thread").getBoundingClientRect().top;
    const msg = [...document.querySelectorAll(".msg")].find((el) => el.getBoundingClientRect().bottom > top + 1);
    return { title: msg.querySelector("h2").textContent, offset: msg.getBoundingClientRect().top - top };
  });
  const before = await anchor();
  await page.evaluate(async (id) => {
    const { readConversation, upsertMessages } = await import("/src/db.js");
    const { conversation, messages } = await readConversation(id);
    messages.find((msg) => msg.id === `${id}:m70`).body = "## Sample day 70\n\nUpdated travel details with needle trees.";
    messages.unshift({ id: `${id}:earlier`, role: "user", body: "## Earlier sample\n\n" + "Earlier travel notes. ".repeat(50) });
    messages.push({ id: `${id}:later`, role: "assistant", body: "## Latest sample\n\nA newly captured needle route." });
    await upsertMessages(conversation, messages, { captureId: "sample", pageMessageIds: messages.map((msg) => msg.id) });
    await Promise.all(window.__listeners.map((fn) => fn({ type: "INDEX_UPDATED" })));
  }, id);
  await settle();
  const after = await anchor();
  assert.equal(after.title, before.title, "prepend and edit keep the same visible message");
  assert.ok(Math.abs(after.offset - before.offset) <= 2, `anchor drift: ${before.offset} -> ${after.offset}`);
  assert.ok(await page.$eval("#app", (el) => el.textContent.includes("Updated travel details")));
  await mkdir(join(root, "docs"), { recursive: true });
  await page.screenshot({ path: join(root, "docs/reader-1.7.5.1-refresh.png") });
  await page.click("#nextHit");
  await settle();
  assert.ok(await page.$eval("#app", (el) => el.textContent.includes("newly captured needle route")), "new search hit is reachable");
  await page.evaluate(async (id) => {
    const { removeConversation } = await import("/src/db.js");
    await removeConversation(id);
    await Promise.all(window.__listeners.map((fn) => fn({ type: "INDEX_UPDATED" })));
  }, id);
  assert.equal(await page.$eval("#app", (el) => el.dataset.state), "missing");
  assert.deepEqual(errors, []);
  console.log("e2e-reader-refresh ok", { anchor: before.title, driftPx: after.offset - before.offset,
    editedBody: true, newHit: true, deletion: true });
} finally {
  await browser?.close();
  server.close();
}
