/**
 * Manual sync against a local fixture Chrome treats as https://chatgpt.com.
 * Intervals come from the environment so the suite can finish; production
 * constants stay 20–40s / 30 / 10min and are checked by verify.mjs.
 *
 *   CHATSEEK_SYNC_GAP_MIN=250 CHATSEEK_SYNC_GAP_MAX=400 npm run test:e2e-sync
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docs = join(root, "docs");
const chromePath = process.env.CHROME_PATH || "/tmp/chrome-for-testing/chrome-linux64/chrome";

const ALPHA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const BETA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const SKIP = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
const CAPTCHA = "dddddddd-dddd-4ddd-8ddd-ddddddddddd4";
const LOGIN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5";
const E1 = "f1111111-1111-4111-8111-111111111111";
const E2 = "f2222222-2222-4222-8222-222222222222";
const E3 = "f3333333-3333-4333-8333-333333333333";
const E4 = "f4444444-4444-4444-8444-444444444444";
const USER = "abababab-abab-4aba-8aba-abababababab";
const P1 = "a1111111-1111-4111-8111-111111111111";
const P2 = "a2222222-2222-4222-8222-222222222222";
const P3 = "a3333333-3333-4333-8333-333333333333";

function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

const limits = {
  gapMin: envNum("CHATSEEK_SYNC_GAP_MIN", 250),
  gapMax: envNum("CHATSEEK_SYNC_GAP_MAX", 400),
  batch: envNum("CHATSEEK_SYNC_BATCH", 30),
  rest: envNum("CHATSEEK_SYNC_REST", 400),
  emptyLimit: 3,
  settle: envNum("CHATSEEK_SYNC_SETTLE", 400),
  report: envNum("CHATSEEK_SYNC_REPORT", 6000),
};

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
    await sleep(200);
  }
  throw new Error(`timed out: ${label}; last=${String(last).slice(0, 400)}`);
}

function link(id, title, iso) {
  return `<li><a href="/c/${id}">${title}<time datetime="${iso}">${iso.slice(0, 10)}</time></a></li>`;
}

function thread(title, user, assistant) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body>
    <main>
      <div data-message-author-role="user" data-message-id="u1"><div class="whitespace-pre-wrap">${user}</div></div>
      <div data-message-author-role="assistant" data-message-id="a1"><div class="markdown"><p>${assistant}</p></div></div>
    </main>
  </body></html>`;
}

function home(items) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ChatGPT</title></head><body>
    <nav aria-label="Chat history"><ul>${items.join("")}</ul></nav>
    <main><p>Welcome back</p></main>
  </body></html>`;
}

function captchaPage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Just a moment...</title></head><body>
    <form id="challenge-form" action="/cdn-cgi/challenge-platform"></form>
    <h1>Verify you are human</h1>
  </body></html>`;
}

function loginPage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Log in</title></head><body>
    <h1>Log in</h1>
    <form action="/login"><input type="password" name="password" /></form>
  </body></html>`;
}

function emptyPage(title) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body>
    <main><p>Welcome back</p></main>
  </body></html>`;
}

const mode = { name: "normal" };
const hits = [];

function sidebarFor(name) {
  if (name === "normal") {
    return [
      link(ALPHA, "Alpha habitat", "2024-05-01T00:00:00.000Z"),
      link(BETA, "Beta habitat", "2024-05-02T00:00:00.000Z"),
    ];
  }
  if (name === "skip") {
    return [
      link(SKIP, "Skip habitat", "2020-01-15T00:00:00.000Z"),
      link(BETA, "Beta habitat", "2024-06-02T00:00:00.000Z"),
    ];
  }
  if (name === "pause") {
    return [
      link(P1, "Pause one", "2024-07-01T00:00:00.000Z"),
      link(P2, "Pause two", "2024-07-02T00:00:00.000Z"),
      link(P3, "Pause three", "2024-07-03T00:00:00.000Z"),
    ];
  }
  if (name === "captcha") return [link(CAPTCHA, "Captcha habitat", "2024-08-01T00:00:00.000Z")];
  if (name === "login") return [link(LOGIN, "Login habitat", "2024-08-02T00:00:00.000Z")];
  if (name === "empty") {
    return [E1, E2, E3, E4].map((id, i) => link(id, `Empty ${i + 1}`, "2024-09-01T00:00:00.000Z"));
  }
  return [];
}

function route(url) {
  const path = new URL(url, "https://chatgpt.com").pathname;
  if (path === "/" || path === "") return home(sidebarFor(mode.name));
  if (path === `/c/${ALPHA}`) return thread("Alpha habitat", "sync alpha user line about the pangolin habitat", "Assistant kept the sync alpha note.");
  if (path === `/c/${BETA}`) return thread("Beta habitat", "sync beta user line about the river otter", "Assistant kept the sync beta note.");
  if (path === `/c/${SKIP}`) return thread("Skip habitat", "sync skip user line that must not be opened", "This skip page must not be stored again.");
  if (path === `/c/${CAPTCHA}`) return captchaPage();
  if (path === `/c/${LOGIN}`) return loginPage();
  if (path === `/c/${E1}` || path === `/c/${E2}` || path === `/c/${E3}` || path === `/c/${E4}`) return emptyPage("Empty notes");
  if (path === `/c/${P1}`) return thread("Pause one", "pause one user line about moss", "Assistant noted the moss.");
  if (path === `/c/${P2}`) return thread("Pause two", "pause two user line about ferns", "Assistant noted the ferns.");
  if (path === `/c/${P3}`) return thread("Pause three", "pause three user line about lichen", "Assistant noted the lichen.");
  if (path === `/c/${USER}`) return thread("User tab", "the user tab sentence about a heron", "This user tab must stay put.");
  return home(sidebarFor(mode.name));
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

async function waitForServiceWorker(browser) {
  const target = await browser.waitForTarget(
    (item) => item.type() === "service_worker" && item.url().includes("background.js"),
    { timeout: 20000 },
  );
  const worker = await target.worker();
  assert(worker, "service worker has no worker handle");
  return worker;
}

async function armLimits(browser) {
  const worker = await waitForServiceWorker(browser);
  await worker.evaluate((value) => {
    globalThis.__CHATSEEK_SYNC_LIMITS = value;
  }, limits);
  return worker;
}

async function readDb(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("chatseek");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const names = ["conversations", "messages", "meta"].filter((name) => db.objectStoreNames.contains(name));
    const tx = db.transaction(names, "readonly");
    const all = (store) => new Promise((resolve, reject) => {
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    const convs = names.includes("conversations") ? await all("conversations") : [];
    const msgs = names.includes("messages") ? await all("messages") : [];
    return {
      convs: convs.map((row) => ({ id: row.id, title: row.title, messageCount: row.messageCount })),
      msgs: msgs.map((row) => ({ conversationId: row.conversationId, body: row.body })),
    };
  });
}

async function resetDb(page) {
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("chatseek");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const names = ["conversations", "messages", "tokenMap", "meta", "images"].filter((name) => db.objectStoreNames.contains(name));
    const tx = db.transaction(names, "readwrite");
    for (const name of names) tx.objectStore(name).clear();
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  });
}

async function seedSkip(page) {
  await page.evaluate(async (row) => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("chatseek");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction("conversations", "readwrite");
    tx.objectStore("conversations").put(row);
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }, {
    id: `chatgpt:${SKIP}`,
    platform: "chatgpt",
    platformId: SKIP,
    title: "Skip habitat",
    url: `https://chatgpt.com/c/${SKIP}`,
    updatedAt: Date.now(),
    updatedAtSource: "page-exact",
    messageCount: 2,
    createdAt: Date.now() - 86_400_000,
    firstSeenAt: Date.now() - 86_400_000,
  });
}

async function main() {
  mkdirSync(docs, { recursive: true });
  const certDir = mkdtempSync(join(tmpdir(), "chatseek-sync-cert-"));
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
    const path = new URL(req.url || "/", "https://chatgpt.com").pathname;
    hits.push(path);
    const body = route(req.url || "/");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  });
  const port = await listen(server, 0);
  const profile = mkdtempSync(join(tmpdir(), "chatseek-sync-profile-"));
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: false,
      enableExtensions: true,
      protocolTimeout: 20000,
      userDataDir: profile,
      args: [
        "--disable-gpu",
        "--no-sandbox",
        "--no-proxy-server", // Fixture domains resolve to localhost, never the network proxy.
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
    let worker = await armLimits(browser);
    const extensionId = new URL(worker.url()).host;
    const probe = await browser.newPage();
    await probe.goto(`chrome-extension://${extensionId}/sidepanel/index.html`, { waitUntil: "domcontentloaded" });
    const panel = probe;
    await panel.setViewport({ width: 420, height: 900 });
    await until(async () => {
      const text = await panel.$eval("#syncStart", (el) => el.textContent || "").catch(() => "");
      return text ? text : "";
    }, "sync button");
    await panel.select("#lang", "zh-TW");
    await until(async () => {
      const text = await panel.$eval("#syncStart", (el) => el.textContent || "");
      return text.includes("開始同步") ? text : "";
    }, "zh-TW sync label");

    const userPage = (await browser.pages()).find((item) => item !== panel && !item.url().startsWith("chrome-extension://"))
      || await browser.newPage();
    await userPage.goto(`https://chatgpt.com/c/${USER}`, { waitUntil: "domcontentloaded", timeout: 20000 });
    const userUrl = userPage.url();
    assert(userUrl === `https://chatgpt.com/c/${USER}`, userUrl);
    await userPage.bringToFront();

    async function statusText() {
      return panel.$eval("#syncStatus", (el) => el.textContent || "").catch(() => "");
    }
    async function prepare(name, { seed = false, pace } = {}) {
      mode.name = name;
      hits.length = 0;
      if (pace) Object.assign(limits, pace);
      worker = await armLimits(browser);
      const stopVisible = await panel.$("#syncStop:not([hidden])");
      if (stopVisible) {
        await panel.evaluate(() => document.getElementById("syncStop").click());
        await sleep(200);
      }
      for (const page of await syncPages()) await page.close().catch(() => {});
      await resetDb(probe);
      if (seed) await seedSkip(probe);
    }
    async function startSync() {
      // The side panel document has to stay visible; that is what advances the clock.
      await panel.bringToFront();
      await panel.evaluate(() => document.getElementById("syncStart").click());
    }
    function syncPages() {
      return browser.pages().then((pages) => pages.filter((page) => {
        const url = page.url();
        return url.startsWith("https://chatgpt.com/") && page !== userPage;
      }));
    }

    await prepare("normal");
    await startSync();
    await until(async () => {
      const db = await readDb(probe);
      const alpha = db.msgs.filter((row) => row.conversationId === `chatgpt:${ALPHA}`);
      const beta = db.msgs.filter((row) => row.conversationId === `chatgpt:${BETA}`);
      return alpha.length >= 1 && beta.length >= 1 ? db : null;
    }, "normal sync stored both chats", 25000);
    assert(userPage.url() === userUrl, `user tab moved to ${userPage.url()}`);
    const opened = await syncPages();
    assert(opened.length >= 1, "sync did not open its own tab");
    const tabFlags = await worker.evaluate(async (userId) => {
      const tabs = await chrome.tabs.query({});
      return tabs.map((tab) => ({
        active: !!tab.active,
        url: typeof tab.url === "string" ? tab.url : "",
        user: typeof tab.url === "string" && tab.url.includes(userId),
      }));
    }, USER);
    const syncFlags = tabFlags.filter((tab) => tab.url.startsWith("https://chatgpt.com/") && !tab.user);
    assert(syncFlags.length >= 1 && syncFlags.every((tab) => tab.active === false), `sync tab took focus ${JSON.stringify(tabFlags)}`);
    const userFlag = tabFlags.find((tab) => tab.user);
    assert(userFlag && userFlag.active === false, `sync focused the user tab ${JSON.stringify(tabFlags)}`);
    const syncFocus = await opened[0].evaluate(() => document.hasFocus()).catch(() => true);
    assert(syncFocus === false, "sync tab document took focus");
    await until(async () => /同步完成/.test(await statusText()), "normal sync finished", 15000);
    const progress = await panel.$eval("#syncProgress", (el) => el.textContent || "");
    assert(/已收/.test(progress) && /跳過/.test(progress), progress);
    await panel.screenshot({ path: join(docs, "panel-1.7.0-sync.png"), fullPage: true });
    const listText = await panel.$eval("#list", (el) => el.innerText);
    assert(listText.includes("Alpha habitat") && listText.includes("pangolin"), "example rows missing");

    await prepare("skip", { seed: true });
    await startSync();
    await until(async () => hits.includes(`/c/${BETA}`), "skip run opened the new chat", 20000);
    await until(async () => /同步完成|沒有可同步/.test(await statusText()), "skip run finished", 15000);
    assert(!hits.includes(`/c/${SKIP}`), `skipped chat was opened: ${hits.join(",")}`);
    const skipDb = await readDb(probe);
    assert(skipDb.msgs.some((row) => row.conversationId === `chatgpt:${BETA}`), "beta was not stored");
    assert(!skipDb.msgs.some((row) => /must not be opened/.test(row.body || "")), "skip page body was stored");

    await prepare("pause", { pace: { gapMin: 1200, gapMax: 1600, settle: 300, report: 6000 } });
    await startSync();
    await until(async () => hits.includes(`/c/${P1}`), "pause run opened the first chat", 20000);
    await panel.click("#syncPause");
    await until(async () => /已暫停/.test(await statusText()), "paused", 8000);
    const pausedHits = hits.filter((path) => path.startsWith("/c/")).length;
    await sleep(2000);
    assert(hits.filter((path) => path.startsWith("/c/")).length === pausedHits, `pause kept navigating: ${hits.join(",")}`);
    await panel.click("#syncResume");
    await until(async () => hits.includes(`/c/${P2}`), "resume opened the next chat", 20000);
    await panel.click("#syncStop");
    await until(async () => /已停止/.test(await statusText()), "manual stop", 8000);
    await sleep(1500);
    assert(!hits.includes(`/c/${P3}`), `stop kept going: ${hits.join(",")}`);

    await prepare("normal");
    await startSync();
    const doomed = await until(async () => {
      const pages = await syncPages();
      return pages[0] || null;
    }, "sync tab to close", 15000);
    await doomed.close();
    await until(async () => /同步分頁已關閉/.test(await statusText()), "closed tab stops", 10000);

    await prepare("captcha");
    await startSync();
    await until(async () => /驗證碼|Cloudflare/.test(await statusText()), "captcha stop", 20000);
    const captchaPages = await syncPages();
    assert(captchaPages.length >= 1, "captcha left no tab for the user");
    await panel.screenshot({ path: join(docs, "panel-1.7.0-sync-stopped.png"), fullPage: true });

    await prepare("login");
    await startSync();
    await until(async () => /登入頁/.test(await statusText()), "login stop", 20000);
    assert((await syncPages()).length >= 1, "login stop closed the sync tab");

    await prepare("empty", { pace: { gapMin: 200, gapMax: 300, settle: 500, report: 6000, emptyLimit: 3 } });
    await startSync();
    await until(async () => /連續 3 段/.test(await statusText()), "three empty pages stop", 25000);
    assert(hits.includes(`/c/${E1}`) && hits.includes(`/c/${E2}`) && hits.includes(`/c/${E3}`), `missing empty hits ${hits.join(",")}`);
    assert(!hits.includes(`/c/${E4}`), `fourth empty page was opened: ${hits.join(",")}`);
    assert(userPage.url() === userUrl, `user tab moved after the run: ${userPage.url()}`);

    console.log("e2e sync ok", { port, limits, userStayed: userPage.url() === userUrl });
  } finally {
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
