/**
 * Real Chrome for Testing load of the extension against a local HTTPS fixture
 * that the browser treats as https://chatgpt.com. No extra host permission.
 *
 *   npm run test:e2e
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docs = join(root, "docs");
const chromePath = process.env.CHROME_PATH || "/tmp/chrome-for-testing/chrome-linux64/chrome";
const CLASSIC = "11111111-1111-4111-8111-111111111111";
const IFRAME = "22222222-2222-4222-8222-222222222222";
const SHADOW = "33333333-3333-4333-8333-333333333333";
const CLOSED = "44444444-4444-4444-8444-444444444444";
const EMPTY = "55555555-5555-4555-8555-555555555555";
const GIZMO_DECOY = "77777777-7777-4777-8777-777777777777";
const GIZMO = "66666666-6666-4666-8666-666666666666";
const PROJECT = "88888888-8888-4888-8888-888888888888";
const TITLE = "99999999-9999-4999-8999-999999999999";
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

function route(url) {
  const path = new URL(url, "https://chatgpt.com").pathname;
  if (path === `/inner/${IFRAME}`) {
    return pageHtml({ title: "inner", classic: false, user: USER, assistant: ASST });
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
    const tx = db.transaction(["conversations", "messages", "meta"], "readonly");
    const all = (store) => new Promise((resolve, reject) => {
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    const convs = await all("conversations");
    const msgs = await all("messages");
    const meta = await all("meta");
    const health = meta.find((row) => row && row.key === "health:chatgpt") || null;
    return {
      convs: convs.map((row) => ({
        id: row.id,
        title: row.title,
        messageCount: row.messageCount,
        url: row.url,
      })),
      msgs: msgs.map((row) => ({
        id: row.id,
        conversationId: row.conversationId,
        role: row.role,
        body: row.body,
      })),
      health,
    };
  });
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
    "-addext", "subjectAltName=DNS:chatgpt.com,DNS:chat.openai.com",
  ], { stdio: "ignore" });

  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
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
      protocolTimeout: 12000,
      userDataDir: profile,
      args: [
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--ignore-certificate-errors",
        "--allow-insecure-localhost",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        `--host-resolver-rules=MAP chatgpt.com:443 127.0.0.1:${port}, EXCLUDE localhost`,
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
    await until(async () => logs.some((line) => line.includes("[Chatseek] loaded v=1.6.2 platform=chatgpt")), "load banner", 10000);
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
    assert(!/pangolin|Welcome back/i.test(diagBox), `panel diag leaked text: ${diagBox}`);
    await panel.screenshot({ path: join(docs, "panel-1.6.2-skeleton-diag.png"), fullPage: true });

    const reader = await browser.newPage();
    await reader.setViewport({ width: 900, height: 800 });
    await reader.goto(`chrome-extension://${extensionId}/reader/index.html?id=${encodeURIComponent(`chatgpt:${CLASSIC}`)}`, {
      waitUntil: "domcontentloaded",
    });
    await until(async () => {
      const text = await reader.$eval("#app", (el) => el.innerText).catch(() => "");
      return text.includes("pangolin") && text.includes("classic user line") ? text : "";
    }, "reader markdown", 10000);

    const emptyTab = page;
    await silenceContentPing(emptyTab);
    await panel.bringToFront();
    await emptyTab.bringToFront();
    const panelAgain = panel;
    await until(async () => {
      const hidden = await panelAgain.$eval("#injectWarn", (el) => el.hidden).catch(() => true);
      const text = await panelAgain.$eval("#injectWarn", (el) => el.textContent || "").catch(() => "");
      return !hidden && text.includes("Chatseek") ? text : "";
    }, "inject warning", 8000);
    await panelAgain.screenshot({ path: join(docs, "panel-1.6.2-inject-warn.png"), fullPage: true });

    const leaked = logs.join("\n");
    assert(!/southern forest ridge today/.test(leaked), "console diag included message text");
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
