/**
 * Real Chrome for Testing load of the extension against a local HTTPS fixture
 * that the browser treats as https://chatgpt.com. No extra host permission.
 *
 *   npm run test:e2e
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docs = join(root, "docs");
const chromePath = process.env.CHROME_PATH || "/tmp/chrome-for-testing/chrome-linux64/chrome";
const CLASSIC = "11111111-1111-4111-8111-111111111111";
const HEUR = "13131313-1313-4131-8131-131313131313";
const IFRAME = "22222222-2222-4222-8222-222222222222";
const SHADOW = "33333333-3333-4333-8333-333333333333";
const CLOSED = "44444444-4444-4444-8444-444444444444";
const EMPTY = "55555555-5555-4555-8555-555555555555";
const GIZMO_DECOY = "77777777-7777-4777-8777-777777777777";
const GIZMO = "66666666-6666-4666-8666-666666666666";
const PROJECT = "88888888-8888-4888-8888-888888888888";
const TITLE = "99999999-9999-4999-8999-999999999999";
const IMG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BIG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HEUR_IMG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SHADOW_IMG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CLOSED_IMG = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const FRAME_IMG = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const LAZY = "12121212-1212-4121-8121-121212121212";
const USER = "User asked about the pangolin habitat across the southern forest ridge today.";
const ASST = "Assistant explained that a pangolin rolls into a ball when it feels threatened.";
const TOP_SELECTORS = [
  "[data-message-author-role]",
  "[data-turn]",
  "[data-testid*='conversation-turn']",
  "[data-turn-id], [data-turn-id-container]",
  "[data-message-id]",
  "[data-message-content]",
  "[class*='conversation-turn']",
  "main article",
];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(fn, label, timeout = 20000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (err) {
      last = String(err && err.message ? err.message : err);
    }
    await sleep(250);
  }
  throw new Error(`timed out: ${label}; last=${String(last).slice(0, 500)}`);
}

function pageHtml({ title, classic, user, assistant }) {
  const prose = classic
    ? `<div data-message-author-role="user" data-message-id="u1"><div class="whitespace-pre-wrap">${user}</div></div>
       <div data-message-author-role="assistant" data-message-id="a1"><div class="markdown"><p>${assistant}</p></div></div>`
    : `<div><h2>You</h2><p>${user}</p></div>
       <div><h2>ChatGPT</h2><p>${assistant}</p></div>
       <div><textarea>draft a very long prompt about pangolins that must not be stored</textarea></div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main>${prose}</main></body></html>`;
}

function shadowPage(mode) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${mode} shadow habitat</title></head><body>
    <div id="host"></div>
    <script>
      const root = document.getElementById("host").attachShadow({ mode: ${JSON.stringify(mode)} });
      const main = document.createElement("main");
      function block(heading, text) {
        const div = document.createElement("div");
        const h = document.createElement("h2");
        h.textContent = heading;
        const p = document.createElement("p");
        p.textContent = text;
        div.append(h, p);
        return div;
      }
      main.append(block("You", ${JSON.stringify(USER)}), block("ChatGPT", ${JSON.stringify(ASST)}));
      root.append(main);
    </script>
  </body></html>`;
}

function iframePage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>iframe habitat</title></head><body>
    <p>outer shell</p>
    <iframe src="/inner/${IFRAME}"></iframe>
  </body></html>`;
}

function emptyPage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Habitat notes</title></head><body>
    <main><p>Welcome back</p></main>
    <iframe src="https://127.0.0.1/runner.html"></iframe>
    <div id="host"></div>
    <script>
      const root = document.getElementById("host").attachShadow({ mode: "open" });
      const span = document.createElement("span");
      span.textContent = "hi";
      root.append(span);
    </script>
  </body></html>`;
}

function titleOnlyPage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Seeded habitat title</title></head><body><main><p>Welcome back</p></main></body></html>`;
}

const phase = { titleBody: false };
let releaseSlow = () => {};
const slowGate = new Promise((resolve) => {
  releaseSlow = resolve;
});

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function solidPng(width, height, r, g, b) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const i = row + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const PNG_RED = solidPng(96, 64, 196, 73, 58);
const PNG_BLUE = solidPng(120, 80, 47, 107, 69);

function imageMessage({ user, assistant, images }) {
  return `<div data-message-author-role="user" data-message-id="u1"><div class="whitespace-pre-wrap">${user}</div></div>
    <div data-message-author-role="assistant" data-message-id="a1"><div class="markdown"><p>${assistant}</p>${images}</div></div>`;
}

function selectorImagePage(images) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Image habitat</title></head><body><main>
    ${imageMessage({
      user: "Draw the pangolin habitat with a southern forest ridge.",
      assistant: "Here is the southern forest ridge.",
      images,
    })}
  </main></body></html>`;
}

function heuristicImagePage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Heuristic image</title></head><body><main>
    <div><h2>You</h2><p>${USER}</p></div>
    <div>
      <h2>ChatGPT</h2>
      <p>${ASST}</p>
    </div>
    <div><img id="beside" alt="ridge" src="/blue.png" width="120" height="80"></div>
  </main></body></html>`;
}

function shadowImagePage(mode) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${mode} shadow image</title></head><body><main>
    ${imageMessage({
      user: "Draw the pangolin habitat with a southern forest ridge.",
      assistant: "Here is the southern forest ridge.",
      images: `<div id="host"></div>`,
    })}
  </main>
  <script>
    const root = document.getElementById("host").attachShadow({ mode: ${JSON.stringify(mode)} });
    const img = document.createElement("img");
    img.alt = "ridge";
    img.width = 120;
    img.height = 80;
    img.src = "/blue.png";
    root.append(img);
  </script>
  </body></html>`;
}

function frameImagePage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>iframe image</title></head><body>
    <p>outer shell</p>
    <iframe src="/inner-img/${FRAME_IMG}"></iframe>
  </body></html>`;
}

function frameImageInner() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>inner image</title></head><body><main>
    <div><h2>You</h2><p>${USER}</p></div>
    <div><h2>ChatGPT</h2><p>${ASST}</p><img alt="ridge" src="/blue.png" width="120" height="80"></div>
  </main></body></html>`;
}

function lazyImagePage() {
  return selectorImagePage(`<img id="late" alt="late ridge" src="/hold.png" width="96" height="64">`);
}

function noisePage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Large image</title></head><body><main>
    ${imageMessage({
      user: "Draw a very large picture of the southern forest ridge.",
      assistant: "The large picture is attached.",
      images: `<img id="noise" alt="large ridge" width="480" height="480">`,
    })}
    <script>
      const canvas = document.createElement("canvas");
      canvas.width = 480;
      canvas.height = 480;
      const ctx = canvas.getContext("2d");
      const pixels = ctx.createImageData(480, 480);
      for (let i = 0; i < pixels.data.length; i += 4) {
        pixels.data[i] = (Math.random() * 256) | 0;
        pixels.data[i + 1] = (Math.random() * 256) | 0;
        pixels.data[i + 2] = (Math.random() * 256) | 0;
        pixels.data[i + 3] = 255;
      }
      ctx.putImageData(pixels, 0, 0);
      document.getElementById("noise").src = canvas.toDataURL("image/png");
    </script>
  </main></body></html>`;
}

function route(url) {
  const path = new URL(url, "https://chatgpt.com").pathname;
  if (path === `/inner/${IFRAME}`) {
    return pageHtml({ title: "inner", classic: false, user: USER, assistant: ASST });
  }
  if (path === `/inner-img/${FRAME_IMG}`) return frameImageInner();
  if (path === `/c/${IMG}`) {
    return selectorImagePage(`
      <img id="same" alt="ridge" src="/red.png" width="96" height="64">
      <button type="button"><img id="light" alt="ridge button" src="/blue.png" width="120" height="80"></button>
      <button type="button"><img id="cross" alt="cross ridge" src="https://files.oaiusercontent.com/gen.png" width="96" height="64"></button>`);
  }
  if (path === `/c/${BIG}`) return noisePage();
  if (path === `/c/${HEUR_IMG}`) return heuristicImagePage();
  if (path === `/c/${SHADOW_IMG}`) return shadowImagePage("open");
  if (path === `/c/${CLOSED_IMG}`) return shadowImagePage("closed");
  if (path === `/c/${FRAME_IMG}`) return frameImagePage();
  if (path === `/c/${LAZY}`) return lazyImagePage();
  if (path === `/c/${HEUR}`) {
    return pageHtml({ title: "Heuristic habitat", classic: false, user: USER, assistant: ASST });
  }
  if (path === `/c/${CLASSIC}`) {
    return pageHtml({
      title: "Classic habitat",
      classic: true,
      user: "classic user line about the pangolin habitat",
      assistant: "The pangolin rolls tightly.",
    });
  }
  if (path === `/c/${IFRAME}`) return iframePage();
  if (path === `/c/${SHADOW}`) return shadowPage("open");
  if (path === `/c/${CLOSED}`) return shadowPage("closed");
  if (path === `/c/${EMPTY}`) return emptyPage();
  if (path === `/c/${TITLE}`) {
    return phase.titleBody
      ? pageHtml({ title: "Seeded habitat title", classic: false, user: USER, assistant: ASST })
      : titleOnlyPage();
  }
  if (path === `/g/${GIZMO_DECOY}/c/${GIZMO}`) {
    return pageHtml({ title: "Gizmo habitat", classic: true, user: USER, assistant: ASST });
  }
  if (path === `/g/g-p-proj/c/${PROJECT}`) {
    return pageHtml({ title: "Project habitat", classic: true, user: USER, assistant: ASST });
  }
  return `<!DOCTYPE html><html><head><title>ChatGPT</title></head><body><main><p>Welcome back</p></main></body></html>`;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

async function readDb(worker) {
  return worker.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("chatseek");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const names = ["conversations", "messages", "meta"];
    if (db.objectStoreNames.contains("images")) names.push("images");
    const tx = db.transaction(names, "readonly");
    const all = (store) => new Promise((resolve, reject) => {
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    const convs = await all("conversations");
    const msgs = await all("messages");
    const meta = await all("meta");
    const images = names.includes("images") ? await all("images") : [];
    const health = meta.find((row) => row && row.key === "health:chatgpt") || null;
    return {
      convs: convs.map((row) => ({
        id: row.id,
        title: row.title,
        messageCount: row.messageCount,
        url: row.url,
        updatedAt: row.updatedAt,
        updatedAtSource: row.updatedAtSource,
      })),
      msgs: msgs.map((row) => ({
        id: row.id,
        conversationId: row.conversationId,
        role: row.role,
        body: row.body,
      })),
      health,
      images: images.map((row) => ({
        messageId: row.messageId,
        index: row.index,
        status: row.status,
        bytes: Number(row.bytes) || 0,
      })),
    };
  });
}

function shotsOf(db, id) {
  const prefix = `chatgpt:${id}:`;
  return (db.images || []).filter((row) => String(row.messageId || "").startsWith(prefix));
}

function convOf(db, id) {
  return (db.convs || []).find((row) => row.id === `chatgpt:${id}`) || null;
}

function msgsOf(db, id) {
  return (db.msgs || []).filter((row) => row.conversationId === `chatgpt:${id}`);
}

async function waitForServiceWorker(browser) {
  const target = await browser.waitForTarget(
    (item) => item.type() === "service_worker" && item.url().includes("background.js"),
    { timeout: 20000 },
  );
  const worker = await target.worker();
  assert(worker, "service worker has no worker handle");
  return worker;
}

async function silenceContentPing(page) {
  const client = await page.createCDPSession();
  const contexts = [];
  client.on("Runtime.executionContextCreated", (event) => contexts.push(event.context));
  await client.send("Runtime.enable");
  await sleep(400);
  let removed = 0;
  for (const ctx of contexts) {
    if (ctx.auxData?.isDefault !== false) continue;
    try {
      const result = await client.send("Runtime.evaluate", {
        contextId: ctx.id,
        expression: `(() => {
          const listener = globalThis.__chatseekPingListener;
          if (!listener || !chrome.runtime?.onMessage?.removeListener) return "absent";
          chrome.runtime.onMessage.removeListener(listener);
          globalThis.__chatseekPingListener = null;
          return "removed";
        })()`,
        returnByValue: true,
      });
      if (result.result?.value === "removed") removed += 1;
    } catch {
      // A frame without the extension world is expected.
    }
  }
  await client.detach().catch(() => {});
  assert(removed > 0, `content script did not drop its ping listener (${contexts.length} contexts)`);
}

async function topMisses(page) {
  return page.evaluate((sels) => {
    const hits = {};
    for (const sel of sels) hits[sel] = document.querySelectorAll(sel).length;
    return hits;
  }, TOP_SELECTORS);
}

async function main() {
  mkdirSync(docs, { recursive: true });
  const certDir = mkdtempSync(join(tmpdir(), "chatseek-cert-"));
  const cert = join(certDir, "cert.pem");
  const key = join(certDir, "key.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048",
    "-keyout", key, "-out", cert,
    "-days", "2", "-nodes",
    "-subj", "/CN=chatgpt.com",
    "-addext", "subjectAltName=DNS:chatgpt.com,DNS:chat.openai.com,DNS:files.oaiusercontent.com",
  ], { stdio: "ignore" });

  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const path = new URL(req.url || "/", "https://chatgpt.com").pathname;
    if (path === "/red.png" || path === "/blue.png" || path === "/gen.png" || path === "/hold.png") {
      const file = path === "/blue.png" ? PNG_BLUE : PNG_RED;
      const send = () => {
        if (res.writableEnded) return;
        res.writeHead(200, {
          "content-type": "image/png",
          "cache-control": "no-store",
          "content-length": String(file.length),
        });
        res.end(file);
      };
      if (path === "/hold.png") {
        slowGate.then(send);
        return;
      }
      send();
      return;
    }
    const body = route(req.url || "/");
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(body);
  });
  let port = 0;
  try {
    port = await listen(server, 0);
  } catch (err) {
    throw new Error(`fixture server failed: ${err}`);
  }

  const profile = mkdtempSync(join(tmpdir(), "chatseek-profile-"));
  const logs = [];
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: false,
      enableExtensions: true,
      dumpio: false,
      protocolTimeout: 60000,
      userDataDir: profile,
      args: [
        "--disable-gpu",
        "--no-sandbox",
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--disable-dev-shm-usage",
        "--ignore-certificate-errors",
        "--allow-insecure-localhost",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        `--host-resolver-rules=MAP chatgpt.com:443 127.0.0.1:${port}, MAP files.oaiusercontent.com:443 127.0.0.1:${port}, EXCLUDE localhost`,
        "--window-size=1280,900",
        `--disable-extensions-except=${root}`,
        `--load-extension=${root}`,
      ],
    });
    let worker = await waitForServiceWorker(browser);
    worker.on("console", (msg) => logs.push(`sw ${msg.text()}`));
    const extensionId = new URL(worker.url()).host;
    assert(extensionId, "missing extension id");

    // Read IndexedDB from an extension page. Opening it inside the service
    // worker interleaves with the worker's own connection and can stall the write.
    const probe = await browser.newPage();
    await probe.goto(`chrome-extension://${extensionId}/sidepanel/index.html`, { waitUntil: "domcontentloaded" });
    await until(async () => {
      const snap = await readDb(probe);
      return snap && Array.isArray(snap.msgs) ? snap : null;
    }, "extension database", 10000);

    const page = (await browser.pages()).find((item) => !item.url().startsWith("chrome-extension://")) || await browser.newPage();
    page.on("console", (msg) => logs.push(msg.text()));
    page.on("pageerror", (err) => logs.push(`pageerror ${err.message}`));
    await page.setViewport({ width: 1100, height: 800 });

    async function openChat(url) {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      const finalUrl = page.url();
      assert(finalUrl.startsWith("https://chatgpt.com/"), `fixture did not load as chatgpt.com: ${finalUrl} status=${response && response.status()}`);
      assert(!finalUrl.startsWith("chrome-error:"), finalUrl);
    }

    async function waitMsgs(id, min) {
      return until(async () => {
        const db = await readDb(probe);
        const rows = msgsOf(db, id);
        return rows.length >= min ? db : null;
      }, `messages for ${id}`, 20000);
    }

    await openChat(`https://chatgpt.com/c/${CLASSIC}?model=gpt-4o`);
    await until(async () => logs.some((line) => line.includes("[Chatseek] loaded v=1.6.5 platform=chatgpt")), "load banner", 10000);
    let db = await waitMsgs(CLASSIC, 2);
    const classic = convOf(db, CLASSIC);
    assert(classic && classic.messageCount === 2, `classic count ${classic && classic.messageCount}`);
    assert(classic.url === `https://chatgpt.com/c/${CLASSIC}`, classic.url);
    const classicMsgs = msgsOf(db, CLASSIC);
    assert(classicMsgs.some((row) => row.role === "user" && row.body.includes("classic user line")), "classic user missing");
    assert(classicMsgs.some((row) => row.role === "assistant" && row.body.includes("pangolin")), "classic assistant missing");

    await openChat(`https://chatgpt.com/c/${IFRAME}`);
    const iframeHits = await topMisses(page);
    assert(Object.values(iframeHits).every((n) => n === 0), `iframe top hits ${JSON.stringify(iframeHits)}`);
    db = await waitMsgs(IFRAME, 2);
    const iframeMsgs = msgsOf(db, IFRAME);
    assert(iframeMsgs.some((row) => row.body.includes("southern forest ridge")), "iframe body missing");
    assert(!iframeMsgs.some((row) => /must not be stored/.test(row.body)), "iframe composer was stored");
    await until(
      async () => logs.some((line) => line.includes("[Chatseek] diag") && line.includes("used=heuristic") && line.includes("frames=")),
      "iframe diag",
      10000,
    );

    await openChat(`https://chatgpt.com/c/${SHADOW}`);
    const shadowHits = await topMisses(page);
    assert(Object.values(shadowHits).every((n) => n === 0), `shadow top hits ${JSON.stringify(shadowHits)}`);
    db = await waitMsgs(SHADOW, 2);
    assert(msgsOf(db, SHADOW).some((row) => row.body.includes("southern forest ridge")), "open shadow body missing");
    await until(
      async () => logs.some((line) => line.includes("[Chatseek] diag") && line.includes("shadows=") && line.includes("shadow>")),
      "shadow diag",
      10000,
    );

    await openChat(`https://chatgpt.com/c/${CLOSED}`);
    const closedHits = await topMisses(page);
    assert(Object.values(closedHits).every((n) => n === 0), `closed top hits ${JSON.stringify(closedHits)}`);
    db = await waitMsgs(CLOSED, 1);
    assert(msgsOf(db, CLOSED).some((row) => row.body.includes("rolls into a ball")), "closed shadow body missing");
    await until(
      async () => logs.some((line) => line.includes("div:closed") || line.includes(":closed")),
      "closed shadow diag",
      10000,
    );

    await openChat(`https://chatgpt.com/g/${GIZMO_DECOY}/c/${GIZMO}?model=gpt-4`);
    db = await waitMsgs(GIZMO, 1);
    assert(convOf(db, GIZMO), "gizmo conversation missing");
    assert(!convOf(db, GIZMO_DECOY), "gizmo uuid was stored as the conversation");
    assert(convOf(db, GIZMO).url === `https://chatgpt.com/c/${GIZMO}`, convOf(db, GIZMO).url);

    await openChat(`https://chatgpt.com/g/g-p-proj/c/${PROJECT}?model=gpt`);
    db = await waitMsgs(PROJECT, 1);
    assert(convOf(db, PROJECT).url === `https://chatgpt.com/c/${PROJECT}`, "project url key drifted");

    await openChat(`https://chatgpt.com/c/${TITLE}`);
    await until(async () => {
      const snap = await readDb(probe);
      const row = convOf(snap, TITLE);
      return row && !(Number(row.messageCount) > 0) ? snap : null;
    }, "title-only row", 15000);
    phase.titleBody = true;
    await openChat(`https://chatgpt.com/c/${TITLE}`);
    db = await waitMsgs(TITLE, 1);
    assert(convOf(db, TITLE).messageCount >= 1, "title-only row did not accept the body");
    assert(msgsOf(db, TITLE).some((row) => row.body.includes("southern forest ridge")), "title-only overwrite body missing");

    logs.length = 0;
    await openChat(`https://chatgpt.com/c/${EMPTY}`);
    const emptyHits = await topMisses(page);
    assert(Object.values(emptyHits).every((n) => n === 0), `empty top hits ${JSON.stringify(emptyHits)}`);
    db = await until(async () => {
      const snap = await readDb(probe);
      return snap.health && snap.health.warn && snap.health.messageCount === 0 ? snap : null;
    }, "sidebar health warning", 25000);
    const diag = String(db.health.diag || "");
    assert(diag.includes("[Chatseek] diag"), `stored diag missing: ${diag}`);
    assert(diag.includes("main="), diag);
    assert(diag.includes("frames="), diag);
    assert(diag.includes("shadows="), diag);
    assert(diag.includes("skeleton="), diag);
    assert(diag.includes("127.0.0.1:noscript"), `unreadable frame was not named: ${diag}`);
    assert(!/pangolin|southern forest|Welcome back|11111111/i.test(diag), `diag leaked text: ${diag}`);
    assert(logs.some((line) => line.includes("[Chatseek] chatgpt: 0 messages on /c/ page, selectors tried:")), `console warning missing: ${logs.join(" | ").slice(0, 800)}`);
    assert(logs.some((line) => line.includes("[Chatseek] diag") && line.includes("skeleton=")), "console diag missing the skeleton");

    const panel = await browser.newPage();
    await panel.setViewport({ width: 420, height: 860 });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`, { waitUntil: "domcontentloaded" });
    await panel.bringToFront();
    await until(async () => {
      const text = await panel.$eval("#health", (el) => el.innerText).catch(() => "");
      return /0/.test(text) && /ChatGPT|改版|可能|página|page|Seite|ページ|페이지/i.test(text) ? text : "";
    }, "panel health warning text", 10000);
    const healthText = await panel.$eval("#health", (el) => el.innerText);
    assert(/health-warn/.test(await panel.$eval("#health", (el) => el.innerHTML)), "health warning is not marked");
    await panel.screenshot({ path: join(docs, "panel-1.6.2-empty-warn.png"), fullPage: true });

    const counts = await panel.$eval("#counts", (el) => el.textContent || "");
    assert(/\d/.test(counts) && !/0 chats · 0 messages|0 則對話 · 0 則訊息|0 条对话 · 0 条消息/.test(counts), `panel counts stayed empty: ${counts}`);
    const listText = await panel.$eval("#list", (el) => el.innerText);
    assert(listText.includes("Classic habitat"), "panel list is missing the captured chat");
    assert(/pangolin|classic user/.test(listText), "panel preview is missing the message text");
    const titlePreview = await panel.$eval(`[data-id="chatgpt:${TITLE}"] .item-preview`, (el) => el.textContent).catch(() => "");
    assert(titlePreview && /pangolin|southern|forest|ridge/i.test(titlePreview), `title-only preview was not overwritten: ${titlePreview}`);

    await panel.evaluate(() => {
      if (navigator.clipboard) navigator.clipboard.writeText = () => Promise.reject(new Error("denied"));
    });
    await panel.click("#copyDiagBtn");
    await panel.waitForSelector("#diagBox:not([hidden])", { timeout: 5000 });
    const diagBox = await panel.$eval("#diagBox", (el) => el.value);
    assert(diagBox.includes("skeleton="), diagBox);
    assert(diagBox.includes("frames=") && diagBox.includes("shadows=") && diagBox.includes("main="), diagBox);
    assert(/imgs=\d+\/\d+\/\d+ fail=tainted:\d+,too-big:\d+,timeout:\d+,not-loaded:\d+/.test(diagBox), diagBox);
    assert(!/pangolin|Welcome back|https?:\/\//i.test(diagBox), `panel diag leaked text: ${diagBox}`);
    await panel.screenshot({ path: join(docs, "panel-1.6.2-skeleton-diag.png"), fullPage: true });

    const zeroCache = await until(async () => {
      const text = await panel.$eval("#imageCache", (el) => el.textContent || "").catch(() => "");
      const disabled = await panel.$eval("#clearImagesBtn", (el) => el.disabled).catch(() => false);
      return /0 KB/.test(text) && disabled ? text : "";
    }, "image cache reads 0 KB", 10000);
    assert(/cache|快取|缓存|キャッシュ|캐시|Caché|Cache|Bild/i.test(zeroCache), zeroCache);
    await panel.evaluate(() => document.querySelector(".foot")?.scrollIntoView({ block: "end" }));
    await panel.screenshot({ path: join(docs, "panel-1.6.3-image-cache-zero.png"), fullPage: true });

    async function waitShots(id, pred, label) {
      return until(async () => {
        const snap = await readDb(probe);
        const rows = shotsOf(snap, id);
        if (pred(rows)) return rows;
        const sample = (snap.images || []).slice(0, 8).map((row) => `${row.status}:${row.bytes}:${row.messageId}`).join(" || ");
        throw new Error(`matched=${rows.length} stored=${(snap.images || []).length} ${sample}`);
      }, label, 20000);
    }

    await openChat(`https://chatgpt.com/c/${IMG}`);
    const selectorShots = await waitShots(IMG, (rows) => {
      const cached = rows.filter((row) => row.status === "cached" && row.bytes > 0).length;
      const tainted = rows.filter((row) => row.status === "uncached").length;
      return cached >= 2 && tainted >= 1 && rows.length >= 3;
    }, "selector thumbnails and cross-origin placeholder");
    await until(async () => logs.some((line) => /imgs=\d+\/[1-9]\d*\/\d+ fail=tainted:[1-9]/.test(line)), "image diag counts", 15000);
    const imageDiag = logs.filter((line) => line.includes("imgs=")).pop() || "";
    assert(!/https?:\/\/|oaiusercontent|red\.png|alt=/i.test(imageDiag), `image diag leaked: ${imageDiag}`);

    await panel.bringToFront();
    await panel.evaluate(() => {
      if (navigator.clipboard) navigator.clipboard.writeText = () => Promise.reject(new Error("denied"));
    });
    const imageDiagBox = await until(async () => {
      await panel.evaluate(() => {
        if (navigator.clipboard) navigator.clipboard.writeText = () => Promise.reject(new Error("denied"));
      });
      await panel.click("#copyDiagBtn");
      await sleep(400);
      const text = await panel.$eval("#diagBox", (el) => (el.hidden ? "" : el.value)).catch(() => "");
      return /imgs=\d+\/[1-9]\d*\/\d+ fail=tainted:[1-9]/.test(text) ? text : "";
    }, "copied image diag", 15000);
    assert(!/https?:\/\/|oaiusercontent|pangolin|southern forest/i.test(imageDiagBox), imageDiagBox);
    await panel.screenshot({ path: join(docs, "panel-1.6.3-diag-imgs.png"), fullPage: true });
    const usedCache = await until(async () => {
      const text = await panel.$eval("#imageCache", (el) => el.textContent || "").catch(() => "");
      const disabled = await panel.$eval("#clearImagesBtn", (el) => el.disabled).catch(() => true);
      return /[1-9]\d*(?:\.\d+)? (?:KB|MB)/.test(text) && !disabled ? text : "";
    }, "image cache above zero", 10000);
    await panel.evaluate(() => document.querySelector(".foot")?.scrollIntoView({ block: "end" }));
    await panel.screenshot({ path: join(docs, "panel-1.6.3-image-cache.png"), fullPage: true });

    const hook = `(() => {
      const proto = HTMLCanvasElement && HTMLCanvasElement.prototype;
      if (!proto || proto.__chatseekCap) return "armed";
      const orig = proto.toBlob;
      proto.toBlob = function(cb, type, quality) {
        if (this.width >= 400 && this.height >= 400) {
          const bytes = new Uint8Array(160 * 1024);
          bytes[0] = 82;
          cb(new Blob([bytes], { type: "image/webp" }));
          return;
        }
        return orig.apply(this, arguments);
      };
      proto.__chatseekCap = true;
      return "armed";
    })()`;
    const bigClient = await page.createCDPSession();
    bigClient.on("Runtime.executionContextCreated", (event) => {
      const ctx = event.context;
      if (ctx.auxData?.isDefault !== false) return;
      bigClient.send("Runtime.evaluate", { contextId: ctx.id, expression: hook, returnByValue: true }).catch(() => {});
    });
    await bigClient.send("Runtime.enable");
    await openChat(`https://chatgpt.com/c/${BIG}`);
    let bigShots = await waitShots(BIG, (rows) => rows.some((row) => row.status === "oversized" || row.status === "cached"), "large image first pass");
    if (!bigShots.some((row) => row.status === "oversized")) {
      await openChat(`https://chatgpt.com/c/${BIG}`);
      bigShots = await waitShots(BIG, (rows) => rows.some((row) => row.status === "oversized"), "large image placeholder");
    }
    assert(bigShots.some((row) => row.status === "oversized"), `expected an oversized placeholder, got ${JSON.stringify(bigShots)}`);
    await bigClient.detach().catch(() => {});

    await openChat(`https://chatgpt.com/c/${HEUR_IMG}`);
    const heurShots = await waitShots(HEUR_IMG, (rows) => rows.some((row) => row.status === "cached" && row.bytes > 0), "heuristic image");
    assert(heurShots.some((row) => row.status === "cached"), "heuristic path did not cache the sibling image");

    await openChat(`https://chatgpt.com/c/${SHADOW_IMG}`);
    assert((await waitShots(SHADOW_IMG, (rows) => rows.some((row) => row.status === "cached" && row.bytes > 0), "open shadow image")).some((row) => row.status === "cached"), "open shadow image missing");

    await openChat(`https://chatgpt.com/c/${CLOSED_IMG}`);
    assert((await waitShots(CLOSED_IMG, (rows) => rows.some((row) => row.status === "cached" && row.bytes > 0), "closed shadow image")).some((row) => row.status === "cached"), "closed shadow image missing");

    await openChat(`https://chatgpt.com/c/${FRAME_IMG}`);
    assert((await waitShots(FRAME_IMG, (rows) => rows.some((row) => row.status === "cached" && row.bytes > 0), "iframe image")).some((row) => row.status === "cached"), "same-origin iframe image missing");

    await openChat(`https://chatgpt.com/c/${LAZY}`);
    const lazyHold = await waitShots(LAZY, (rows) => rows.some((row) => row.status === "not-loaded"), "lazy image placeholder");
    assert(lazyHold.some((row) => row.status === "not-loaded"), "a late image did not leave a not-loaded placeholder");
    releaseSlow();
    const lazyDone = await waitShots(LAZY, (rows) => rows.some((row) => row.status === "cached" && row.bytes > 0), "lazy image filled in");
    assert(lazyDone.some((row) => row.status === "cached"), "a late image was not filled in after it loaded");

    const reader = await browser.newPage();
    await reader.setViewport({ width: 900, height: 900 });
    await reader.goto(`chrome-extension://${extensionId}/reader/index.html?id=${encodeURIComponent(`chatgpt:${IMG}`)}`, {
      waitUntil: "domcontentloaded",
    });
    await until(async () => {
      const thumbs = await reader.$$eval(".cached-thumb", (nodes) => nodes.length).catch(() => 0);
      const site = await reader.$$eval("[data-reason='site']", (nodes) => nodes.length).catch(() => 0);
      return thumbs >= 1 && site >= 1;
    }, "reader thumbnails and site placeholder", 10000);
    await reader.goto(`chrome-extension://${extensionId}/reader/index.html?id=${encodeURIComponent(`chatgpt:${BIG}`)}`, {
      waitUntil: "domcontentloaded",
    });
    await until(async () => {
      const text = await reader.$eval("#app", (el) => el.innerText).catch(() => "");
      const reason = await reader.$eval("[data-reason='oversized']", (el) => el.getAttribute("data-reason")).catch(() => "");
      return reason === "oversized" && /too large|檔案過大|文件过大|大きすぎ|너무 큼|demasiado grande|trop volumineux|zu groß|grande demais/i.test(text);
    }, "reader oversized placeholder", 10000);
    await reader.screenshot({ path: join(docs, "reader-1.6.3-images.png"), fullPage: true });
    await reader.goto(`chrome-extension://${extensionId}/reader/index.html?id=${encodeURIComponent(`chatgpt:${IMG}`)}`, {
      waitUntil: "domcontentloaded",
    });
    await until(async () => {
      const thumbs = await reader.$$eval(".cached-thumb", (nodes) => nodes.length).catch(() => 0);
      const site = await reader.$$eval("[data-reason='site']", (nodes) => nodes.length).catch(() => 0);
      return thumbs >= 1 && site >= 1;
    }, "reader mixed image states", 10000);
    await reader.screenshot({ path: join(docs, "reader-1.6.3-placeholders.png"), fullPage: true });

    await panel.setViewport({ width: 320, height: 720 });
    await panel.bringToFront();
    await panel.click("#filterImages");
    await until(async () => {
      const srcs = await panel.$$eval(".shot-img", (nodes) => nodes.map((node) => node.getAttribute("src") || "")).catch(() => []);
      const missing = await panel.$$eval(".shot-missing", (nodes) => nodes.length).catch(() => 0);
      return srcs.length >= 1 && missing === 0 && srcs.every((src) => src.startsWith("data:image/")) ? srcs.length : 0;
    }, "image tab cached thumbs", 15000);
    const gridText = await panel.$eval("#imageGrid", (el) => el.innerText || "");
    assert(!/https?:\/\/|oaiusercontent/i.test(gridText), `image grid leaked ${gridText.slice(0, 200)}`);
    await panel.screenshot({ path: join(docs, "panel-1.6.5-e2e-images-320.png") });
    await panel.click("#showUncached");
    await until(async () => {
      const reason = await panel.$eval(".shot-missing", (el) => el.dataset.reason || "").catch(() => "");
      return reason ? reason : "";
    }, "image tab placeholders", 10000);
    await panel.screenshot({ path: join(docs, "panel-1.6.5-e2e-uncached.png") });
    const opened = await panel.evaluate(async () => {
      const urls = [];
      const originalSend = chrome.runtime.sendMessage;
      const originalCreate = chrome.tabs.create;
      chrome.runtime.sendMessage = async () => ({ focused: false });
      chrome.tabs.create = async (opts) => {
        urls.push(opts?.url || "");
        return { id: 9 };
      };
      document.querySelector(".shot-site")?.click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const site = urls[0] || "";
      urls.length = 0;
      const btn = document.querySelector(".shot-img")?.closest(".shot-open") || document.querySelector(".shot-open");
      btn?.click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const readerUrl = urls[0] || "";
      chrome.runtime.sendMessage = originalSend;
      chrome.tabs.create = originalCreate;
      return { site, readerUrl };
    });
    assert(/chatgpt\.com|claude\.ai|grok\.com|gemini\.google\.com/.test(opened.site), `site icon opened ${opened.site}`);
    assert(!/oaiusercontent|\.png|\.webp/i.test(opened.site), `site icon opened an image ${opened.site}`);
    assert(opened.readerUrl.includes("/reader/index.html") && opened.readerUrl.includes("m=") && /(?:^|[?&])i=\d+/.test(opened.readerUrl), `reader target ${opened.readerUrl}`);
    assert(!/oaiusercontent|\.png|\.webp/i.test(opened.readerUrl), `reader opened an image ${opened.readerUrl}`);
    await reader.goto(opened.readerUrl, { waitUntil: "domcontentloaded" });
    await until(async () => {
      const hit = await reader.$eval(".image-slot.is-target", (el) => el.getAttribute("data-image-index") || "0").catch(() => "");
      return hit !== "" ? hit : "";
    }, "reader highlights the image", 10000);
    await reader.screenshot({ path: join(docs, "reader-1.6.5-e2e-scrolled.png") });
    await panel.setViewport({ width: 420, height: 860 });
    await panel.evaluate(() => document.querySelector("#filterActive")?.click());

    await reader.setViewport({ width: 900, height: 800 });
    await reader.goto(`chrome-extension://${extensionId}/reader/index.html?id=${encodeURIComponent(`chatgpt:${CLASSIC}`)}`, {
      waitUntil: "domcontentloaded",
    });
    await until(async () => {
      const text = await reader.$eval("#app", (el) => el.innerText).catch(() => "");
      return text.includes("pangolin") && text.includes("classic user line") ? text : "";
    }, "reader markdown", 10000);

    const NEW_TAIL = "NEW_TAIL_TOKEN The pangolin asked what the ridge looks like after rain.";

    async function clockOf(id) {
      const snap = await readDb(probe);
      return convOf(snap, id);
    }

    async function appendTail(mode) {
      await page.evaluate((mode, text) => {
        function prose(root) {
          const wrap = document.createElement("div");
          const heading = document.createElement("h2");
          heading.textContent = "You";
          const paragraph = document.createElement("p");
          paragraph.textContent = text;
          wrap.append(heading, paragraph);
          root.append(wrap);
        }
        function classicTurn(root) {
          for (const node of root.querySelectorAll("[data-message-id]")) node.removeAttribute("data-message-id");
          const div = document.createElement("div");
          div.setAttribute("data-message-author-role", "user");
          const body = document.createElement("div");
          body.className = "whitespace-pre-wrap";
          body.textContent = text;
          div.append(body);
          root.append(div);
        }
        if (mode === "classic") classicTurn(document.querySelector("main"));
        else if (mode === "heuristic") prose(document.querySelector("main"));
        else if (mode === "iframe") prose(document.querySelector("iframe").contentDocument.querySelector("main"));
        else if (mode === "shadow") prose(document.querySelector("#host").shadowRoot.querySelector("main"));
      }, mode, NEW_TAIL);
    }

    async function exerciseClock(id, url, mode, { first = false } = {}) {
      await openChat(url);
      await waitMsgs(id, first ? 2 : 1);
      const opened = await clockOf(id);
      assert(opened && opened.updatedAtSource !== "observed", `${mode} first open ${opened && opened.updatedAtSource}`);
      const frozenAt = opened.updatedAt;
      const frozenSource = opened.updatedAtSource;
      const frozenCount = opened.messageCount;
      await sleep(400);
      await openChat(url);
      await sleep(2200);
      const reopened = await clockOf(id);
      assert(reopened.updatedAt === frozenAt, `${mode} reopen moved ${frozenAt} -> ${reopened.updatedAt}`);
      assert(reopened.updatedAtSource === frozenSource, `${mode} reopen source ${reopened.updatedAtSource}`);
      await appendTail(mode);
      const next = await until(async () => {
        const row = await clockOf(id);
        return row && row.updatedAtSource === "observed" && row.updatedAt > frozenAt && row.messageCount > frozenCount ? row : null;
      }, `${mode} new tail observed`, 20000);
      assert(next.messageCount > frozenCount, `${mode} count ${frozenCount} -> ${next.messageCount}`);
    }

    await exerciseClock(CLASSIC, `https://chatgpt.com/c/${CLASSIC}`, "classic");
    await exerciseClock(HEUR, `https://chatgpt.com/c/${HEUR}`, "heuristic", { first: true });
    await exerciseClock(IFRAME, `https://chatgpt.com/c/${IFRAME}`, "iframe");
    const closedBefore = await clockOf(CLOSED);
    await openChat(`https://chatgpt.com/c/${CLOSED}`);
    await sleep(2200);
    const closedAfter = await clockOf(CLOSED);
    assert(closedAfter.updatedAt === closedBefore.updatedAt, `closed reopen moved ${closedBefore.updatedAt} -> ${closedAfter.updatedAt}`);
    assert(closedAfter.updatedAtSource !== "observed", `closed reopen ${closedAfter.updatedAtSource}`);
    await exerciseClock(SHADOW, `https://chatgpt.com/c/${SHADOW}`, "shadow");

    await panel.evaluate(() => localStorage.setItem("chatseek.uiLocale", "zh-TW"));
    await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`, { waitUntil: "domcontentloaded" });
    await panel.bringToFront();
    const top = await until(async () => {
      const item = await panel.$eval("#list .item", (el) => ({
        id: el.dataset.id || "",
        title: el.querySelector(".item-title")?.textContent || "",
        time: el.querySelector("time")?.textContent || "",
      })).catch(() => null);
      return item && item.time === "剛剛" ? item : null;
    }, "sidebar just now", 10000);
    assert(top.id === `chatgpt:${SHADOW}`, `sidebar top ${JSON.stringify(top)}`);
    assert(/open shadow/i.test(top.title), top.title);
    const closedLabel = await panel.$eval(`[data-id="chatgpt:${CLOSED}"] time`, (el) => el.textContent || "");
    assert(closedLabel !== "剛剛", `closed label ${closedLabel}`);
    await panel.screenshot({ path: join(docs, "panel-1.6.4-just-now.png"), fullPage: true });

    await reader.goto(`chrome-extension://${extensionId}/reader/index.html?id=${encodeURIComponent(`chatgpt:${SHADOW}`)}`, {
      waitUntil: "domcontentloaded",
    });
    await until(async () => {
      const text = await reader.$eval("#readerDate", (el) => el.textContent || "").catch(() => "");
      return text === "剛剛" ? text : "";
    }, "reader just now", 10000);
    const readerTitle = await reader.$eval("#readerTitle", (el) => el.textContent || "");
    assert(/open shadow/i.test(readerTitle), readerTitle);
    await reader.screenshot({ path: join(docs, "reader-1.6.4-just-now.png"), fullPage: true });

    await panel.evaluate(() => localStorage.removeItem("chatseek.uiLocale"));
    await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`, { waitUntil: "domcontentloaded" });

    const emptyTab = page;
    await reader.close().catch(() => {});
    await silenceContentPing(emptyTab);
    await panel.bringToFront();
    await emptyTab.bringToFront();
    const panelAgain = panel;
    await until(async () => {
      const hidden = await panelAgain.$eval("#injectWarn", (el) => el.hidden).catch(() => true);
      const text = await panelAgain.$eval("#injectWarn", (el) => el.textContent || "").catch(() => "");
      return !hidden && text.includes("Chatseek") ? text : "";
    }, "inject warning", 8000);
    await panelAgain.evaluate((chatUrl) => {
      chrome.tabs.query = async () => [{ id: 1, url: chatUrl, active: true }];
      chrome.tabs.sendMessage = async () => null;
    }, emptyTab.url());
    await panelAgain.bringToFront();
    await panelAgain.screenshot({
      path: join(docs, "panel-1.6.2-inject-warn.png"),
      clip: { x: 0, y: 0, width: 420, height: 860 },
    });

    const leaked = logs.join("\n");
    assert(!/southern forest ridge today/.test(leaked), "console diag included message text");
    assert(!leaked.includes("NEW_TAIL_TOKEN"), "console diag included the new tail");
    writeFileSync("/tmp/chatseek-e2e-console.txt", logs.join("\n"));
    writeFileSync("/tmp/chatseek-e2e-health.txt", diag);
    console.log("e2e chatgpt ok", {
      extensionId,
      port,
      classic: classicMsgs.length,
      health: healthText.replace(/\s+/g, " ").slice(0, 180),
      diag: diag.slice(0, 400),
    });
  } finally {
    writeFileSync("/tmp/chatseek-e2e-console.txt", logs.join("\n"));
    if (browser) await browser.close().catch(() => {});
    server.close();
    rmSync(profile, { recursive: true, force: true });
    rmSync(certDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
