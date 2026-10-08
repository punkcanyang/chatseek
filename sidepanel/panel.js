import {
  searchConversations,
  stats,
  clearAll,
  readCaptureHealth,
} from "../src/db.js";
import { formatActivityLabel, formatHealthEntries, labelLocale } from "../src/activity-time.js";

const locale = labelLocale(navigator.language);

const t = locale === "zh-Hant"
  ? {
      tag: "只留在這台瀏覽器裡",
      search: "搜尋標題和訊息全文",
      placeholder: "搜尋對話…",
      all: "全部",
      empty:
        "還沒有收錄任何對話。打開 ChatGPT、Claude 或 Grok 分頁並瀏覽對話列表或進入對話後，標題和可見訊息會寫入本機索引。",
      none: "沒有符合的對話。",
      loading: "正在搜尋…",
      booting: "正在讀取本機索引…",
      hint: "只收錄你目前打開的 ChatGPT / Claude / Grok 分頁裡已經出現在頁面上的對話，不會掃描磁碟或上傳內容。剛更新擴充功能後請重新整理對話頁；某一頁收不到訊息時，底部會提示。",
      counts: (c, m) => `${c} 則對話 · ${m} 則訊息`,
      clear: "清除本機索引",
      confirm: "刪除本機 IndexedDB 中的全部對話和訊息？此操作無法復原。",
      error: "無法讀取本機索引。",
      chatgpt: "ChatGPT",
      claude: "Claude",
      grok: "Grok",
    }
  : locale === "zh-Hans"
  ? {
      tag: "只留在这台浏览器里",
      search: "搜索标题和消息全文",
      placeholder: "搜索对话…",
      all: "全部",
      empty:
        "还没有收录任何对话。打开 ChatGPT、Claude 或 Grok 标签页并浏览会话列表或进入对话后，标题和可见消息会写入本地索引。",
      none: "没有匹配的对话。",
      loading: "正在搜索…",
      booting: "正在读取本地索引…",
      hint: "只收录你当前打开的 ChatGPT / Claude / Grok 标签页里已经出现在页面上的对话，不会扫描磁盘或上传内容。刚更新扩展后请刷新对话页；某一页收不到消息时，底部会提示。",
      counts: (c, m) => `${c} 条对话 · ${m} 条消息`,
      clear: "清除本地索引",
      confirm: "删除本机 IndexedDB 中的全部对话和消息？此操作不可恢复。",
      error: "无法读取本地索引。",
      chatgpt: "ChatGPT",
      claude: "Claude",
      grok: "Grok",
    }
  : {
      tag: "Stays in this browser",
      search: "Search titles and full message text",
      placeholder: "Search conversations…",
      all: "All",
      empty:
        "Nothing indexed yet. Open a ChatGPT, Claude, or Grok tab and browse the sidebar or a thread. Titles and visible messages are stored locally.",
      none: "No matching conversations.",
      loading: "Searching…",
      booting: "Reading the local index…",
      hint: "Chats are captured only while a ChatGPT, Claude, or Grok tab is open. This extension does not scan your disk or upload conversations. After an update, reload those tabs. A footer note appears if a thread page yields no messages.",
      counts: (c, m) => `${c} chats · ${m} messages`,
      clear: "Clear local index",
      confirm:
        "Delete every conversation and message in this browser’s IndexedDB? This cannot be undone.",
      error: "Could not read the local index.",
      chatgpt: "ChatGPT",
      claude: "Claude",
      grok: "Grok",
    };

const qEl = document.getElementById("q");
const listEl = document.getElementById("list");
const statusEl = document.getElementById("status");
const countsEl = document.getElementById("counts");
const hintEl = document.getElementById("hint");
const tagEl = document.getElementById("tag");
const clearBtn = document.getElementById("clearBtn");
const healthEl = document.getElementById("health");
const searchLabel = document.getElementById("searchLabel");
const filterAll = document.getElementById("filterAll");

document.documentElement.lang = locale === "zh-Hant" ? "zh-TW" : locale === "zh-Hans" ? "zh-CN" : "en";
tagEl.textContent = t.tag;
qEl.placeholder = t.placeholder;
searchLabel.textContent = t.search;
hintEl.textContent = t.hint;
clearBtn.textContent = t.clear;
filterAll.textContent = t.all;

let platform = "";
let searchTimer = 0;
let requestSeq = 0;
let loadedOnce = false;
let composing = false;

// 2020-01-01; older values are parse artifacts from pre-1.0.2 builds.
const MIN_DATE_MS = 1577836800000;

function hasDate(ts) {
  return typeof ts === "number" && Number.isFinite(ts) && ts >= MIN_DATE_MS;
}

function platformLabel(id) {
  if (id === "claude") return t.claude;
  if (id === "grok") return t.grok;
  return t.chatgpt;
}

function render(items, { emptyKind, error }) {
  listEl.replaceChildren();
  if (error) {
    const p = document.createElement("p");
    p.className = "error";
    p.textContent = t.error;
    listEl.append(p);
    return;
  }
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = emptyKind === "search" ? t.none : t.empty;
    listEl.append(p);
    return;
  }
  for (const conv of items) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "item";
    btn.addEventListener("click", () => openChat(conv.url));

    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = conv.title || conv.platformId;

    const meta = document.createElement("div");
    meta.className = "item-meta";
    const plat = document.createElement("span");
    plat.className = `plat ${conv.platform}`;
    plat.textContent = platformLabel(conv.platform);
    const time = document.createElement("time");
    const label = formatActivityLabel(conv, Date.now(), locale);
    time.textContent = label.text;
    time.title = label.title;
    if (label.source) time.dataset.source = label.source;
    if (label.approx) time.classList.add("is-approx");
    if (label.unknown) time.classList.add("is-unknown");
    if (!label.unknown && hasDate(conv.updatedAt)) {
      time.dateTime = new Date(conv.updatedAt).toISOString();
    }
    meta.append(plat, time);
    btn.append(title, meta);
    li.append(btn);
    listEl.append(li);
  }
}

async function openChat(url) {
  if (!url || !chrome.tabs?.create) return;
  try {
    const existing = await chrome.tabs.query({ url });
    if (existing[0]) {
      await chrome.tabs.update(existing[0].id, { active: true });
      return;
    }
  } catch {
    // host permissions cover ChatGPT/Claude/Grok URLs; fall through to create
  }
  await chrome.tabs.create({ url });
}

async function renderHealth() {
  if (!healthEl) return;
  const health = await readCaptureHealth();
  const lines = formatHealthEntries(health, Date.now(), locale);
  healthEl.replaceChildren();
  healthEl.hidden = !lines.length;
  for (const line of lines) {
    const p = document.createElement("p");
    p.className = line.warn ? "health-warn" : "health-line";
    p.textContent = line.text;
    healthEl.append(p);
  }
}

async function refresh() {
  const seq = ++requestSeq;
  const query = qEl.value;
  const showStatus = !loadedOnce || !!query.trim();
  statusEl.hidden = !showStatus;
  statusEl.textContent = !loadedOnce && !query.trim() ? t.booting : t.loading;
  try {
    const items = await searchConversations({
      query,
      platform,
      limit: 80,
    });
    if (seq !== requestSeq) return;
    loadedOnce = true;
    statusEl.hidden = true;
    render(items, { emptyKind: query.trim() ? "search" : "idle" });
    const s = await stats();
    if (seq !== requestSeq) return;
    countsEl.textContent = t.counts(s.conversations, s.messages);
    await renderHealth();
  } catch {
    if (seq !== requestSeq) return;
    statusEl.hidden = true;
    render([], { error: true });
    if (!loadedOnce) countsEl.textContent = t.error;
  }
}

function scheduleRefresh() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refresh, 180);
}

qEl.addEventListener("compositionstart", () => {
  composing = true;
});
qEl.addEventListener("compositionend", () => {
  composing = false;
  scheduleRefresh();
});
qEl.addEventListener("input", () => {
  if (!composing) scheduleRefresh();
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach((c) => c.classList.remove("is-on"));
    chip.classList.add("is-on");
    platform = chip.dataset.platform || "";
    refresh();
  });
});

clearBtn.addEventListener("click", async () => {
  if (!confirm(t.confirm)) return;
  try {
    await clearAll();
  } catch {
    render([], { error: true });
    return;
  }
  listEl.replaceChildren();
  countsEl.textContent = t.counts(0, 0);
  refresh();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});

if (chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "INDEX_UPDATED") scheduleRefresh();
  });
}

refresh();
