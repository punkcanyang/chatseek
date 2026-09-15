import {
  searchConversations,
  stats,
  clearAll,
} from "../src/db.js";

const zh = (navigator.language || "").toLowerCase().startsWith("zh");

const t = zh
  ? {
      tag: "只留在这台浏览器里",
      search: "搜索标题和消息全文",
      placeholder: "搜索对话…",
      all: "全部",
      empty:
        "还没有收录任何对话。打开 ChatGPT、Claude 或 Grok 标签页并浏览会话列表或进入对话后，标题和可见消息会写入本地索引。",
      none: "没有匹配的对话。",
      loading: "正在搜索…",
      hint: "只收录你当前打开的 ChatGPT / Claude / Grok 标签页里已经出现在页面上的对话，不会扫描磁盘或上传内容。",
      counts: (c, m) => `${c} 条对话 · ${m} 条消息`,
      clear: "清除本地索引",
      confirm: "删除本机 IndexedDB 中的全部对话和消息？此操作不可恢复。",
      error: "无法读取本地索引。",
      chatgpt: "ChatGPT",
      claude: "Claude",
      grok: "Grok",
      justNow: "刚刚",
      minutes: (n) => `${n} 分钟前`,
      hours: (n) => `${n} 小时前`,
      days: (n) => `${n} 天前`,
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
      hint: "Chats are captured only while a ChatGPT, Claude, or Grok tab is open. This extension does not scan your disk or upload conversations.",
      counts: (c, m) => `${c} chats · ${m} messages`,
      clear: "Clear local index",
      confirm:
        "Delete every conversation and message in this browser’s IndexedDB? This cannot be undone.",
      error: "Could not read the local index.",
      chatgpt: "ChatGPT",
      claude: "Claude",
      grok: "Grok",
      justNow: "just now",
      minutes: (n) => `${n}m ago`,
      hours: (n) => `${n}h ago`,
      days: (n) => `${n}d ago`,
    };

const qEl = document.getElementById("q");
const listEl = document.getElementById("list");
const statusEl = document.getElementById("status");
const countsEl = document.getElementById("counts");
const hintEl = document.getElementById("hint");
const tagEl = document.getElementById("tag");
const clearBtn = document.getElementById("clearBtn");
const searchLabel = document.getElementById("searchLabel");
const filterAll = document.getElementById("filterAll");

tagEl.textContent = t.tag;
qEl.placeholder = t.placeholder;
searchLabel.textContent = t.search;
hintEl.textContent = t.hint;
clearBtn.textContent = t.clear;
filterAll.textContent = t.all;

let platform = "";
let searchTimer = 0;
let requestSeq = 0;

function relativeTime(ts) {
  if (!ts) return "";
  const delta = Date.now() - ts;
  const m = Math.floor(delta / 60000);
  if (m < 1) return t.justNow;
  if (m < 60) return t.minutes(m);
  const h = Math.floor(m / 60);
  if (h < 48) return t.hours(h);
  const days = Math.floor(h / 24);
  // Older than ~7 days: show absolute calendar date from the real timestamp.
  if (days >= 7) {
    const d = new Date(ts);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  return t.days(days);
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
    const time = document.createElement("span");
    time.textContent = relativeTime(conv.updatedAt);
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

async function refresh() {
  const seq = ++requestSeq;
  const query = qEl.value;
  statusEl.hidden = !query.trim();
  statusEl.textContent = t.loading;
  try {
    const items = await searchConversations({
      query,
      platform,
      limit: 80,
    });
    if (seq !== requestSeq) return;
    statusEl.hidden = true;
    render(items, { emptyKind: query.trim() ? "search" : "idle" });
    const s = await stats();
    if (seq !== requestSeq) return;
    countsEl.textContent = t.counts(s.conversations, s.messages);
  } catch {
    if (seq !== requestSeq) return;
    statusEl.hidden = true;
    render([], { error: true });
  }
}

function scheduleRefresh() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refresh, 180);
}

qEl.addEventListener("input", scheduleRefresh);

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
  await clearAll();
  refresh();
});

if (chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "INDEX_UPDATED") scheduleRefresh();
  });
}

refresh();
