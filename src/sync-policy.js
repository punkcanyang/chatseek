/**
 * Manual sync decisions. No Chrome, no network, no timers.
 * The side panel advances this machine by timestamp; a sleeping service
 * worker resumes from the saved state or leaves it paused.
 *
 * Production pace is fixed below. Tests pass a smaller override object.
 * Nothing here reads the environment, so a page cannot shorten the pace.
 */

import { conversationFromUrl } from "./conversation-url.js";

export const SYNC_GAP_MIN_MS = 20000;
export const SYNC_GAP_MAX_MS = 40000;
export const SYNC_BATCH_SIZE = 30;
export const SYNC_REST_MS = 10 * 60 * 1000;
export const SYNC_EMPTY_LIMIT = 3;
export const SYNC_SETTLE_MS = 8000;
export const SYNC_REPORT_MS = 20000;

const PLATFORMS = ["chatgpt", "claude", "grok", "gemini"];

const HOSTS = {
  chatgpt: ["chatgpt.com", "chat.openai.com"],
  claude: ["claude.ai"],
  grok: ["grok.com", "www.grok.com", "grok.x.com", "x.ai"],
  gemini: ["gemini.google.com"],
};

export function productionSyncLimits() {
  return {
    gapMin: SYNC_GAP_MIN_MS,
    gapMax: SYNC_GAP_MAX_MS,
    batch: SYNC_BATCH_SIZE,
    rest: SYNC_REST_MS,
    emptyLimit: SYNC_EMPTY_LIMIT,
    settle: SYNC_SETTLE_MS,
    report: SYNC_REPORT_MS,
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Smaller numbers are for tests. They cannot exceed the production pace.
 * An absent override is the production pace.
 */
export function activeSyncLimits(override) {
  const base = productionSyncLimits();
  if (!override || typeof override !== "object") return base;
  const gapMin = clampInt(override.gapMin, 0, base.gapMin, base.gapMin);
  const gapMax = clampInt(override.gapMax, gapMin, base.gapMax, base.gapMax);
  return {
    gapMin,
    gapMax,
    batch: clampInt(override.batch, 1, base.batch, base.batch),
    rest: clampInt(override.rest, 0, base.rest, base.rest),
    emptyLimit: clampInt(override.emptyLimit, 1, base.emptyLimit, base.emptyLimit),
    settle: clampInt(override.settle, 0, base.settle, base.settle),
    report: clampInt(override.report, 0, base.report, base.report),
  };
}

export function readTestSyncLimits() {
  const extra = typeof globalThis !== "undefined" ? globalThis.__CHATSEEK_SYNC_LIMITS : null;
  return activeSyncLimits(extra && typeof extra === "object" ? extra : null);
}

export function gapDelay(limits, random = Math.random) {
  const min = limits.gapMin;
  const max = Math.max(min, limits.gapMax);
  const span = max - min;
  const roll = Number(typeof random === "function" ? random() : random);
  const unit = Number.isFinite(roll) ? Math.min(1, Math.max(0, roll)) : 0;
  if (!span) return min;
  return min + Math.min(span, Math.floor(unit * (span + 1)));
}

export function knownSyncPlatform(platform) {
  return PLATFORMS.includes(platform);
}

function hostMatches(hostname, platform) {
  const host = String(hostname || "").toLowerCase();
  return (HOSTS[platform] || []).includes(host);
}

export function homeUrl(platform) {
  if (platform === "chatgpt") return "https://chatgpt.com/";
  if (platform === "claude") return "https://claude.ai/new";
  if (platform === "grok") return "https://grok.com/";
  if (platform === "gemini") return "https://gemini.google.com/app";
  return "";
}

export function isHomeUrl(raw, platform) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (!hostMatches(url.hostname, platform)) return false;
  if (conversationFromUrl(url.toString())) return false;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (platform === "chatgpt") return path === "/";
  if (platform === "claude") return path === "/" || path === "/new" || path === "/recents" || path === "/chats";
  if (platform === "grok") return path === "/" || path === "/chat" || path === "/c";
  if (platform === "gemini") return path === "/" || path === "/app" || /^\/u\/\d+\/app$/.test(path);
  return false;
}

/** Conversation URL for this platform, query and hash removed. Empty when unsafe. */
export function navigableConversationUrl(raw, platform) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return "";
  }
  if (url.protocol !== "https:") return "";
  if (!hostMatches(url.hostname, platform)) return "";
  const parsed = conversationFromUrl(url.toString());
  if (!parsed || parsed.platform !== platform) return "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

const CAPTCHA_URL = /challenges\.cloudflare\.com|\/cdn-cgi\/challenge|\/cdn-cgi\/l\/chk_|__cf_chl|cf-turnstile/i;
const LOGIN_URL = /accounts\.google\.com|auth\.openai\.com|accounts\.x\.com|\/auth\/login|\/login(?:\/|$|\?)|\/signin(?:\/|$|\?)|\/sign-in(?:\/|$|\?)|\/sign_in(?:\/|$|\?)/i;
const RATE_URL = /\/429(?:\/|$|\?)|too-many-requests|rate-limit/i;
const ERROR_URL = /\/(?:404|403|500|error)(?:\/|$|\?)/i;
const CAPTCHA_TITLE = /just a moment|attention required|verify you are human|checking your browser|cf-browser-verification/i;
const LOGIN_TITLE = /^(log in|sign in|登录|登入|ログイン|로그인|connexion|anmelden|entrar)\b/i;
const RATE_TITLE = /too many requests|rate limit|^429\b/i;
const ERROR_TITLE = /something went wrong|access denied|page not found|^404\b|^403\b|this page isn.t available/i;

/**
 * URL shape plus DOM flags gathered on the page. Returns only a reason code.
 * Anything that is not clearly a chat or the platform home is "uncertain".
 */
export function classifySyncPage(signals) {
  const href = String(signals?.href || "");
  let url;
  try {
    url = new URL(href);
  } catch {
    return "uncertain";
  }
  if (url.protocol !== "https:") return "uncertain";
  const platform = signals?.platform || "";
  if (!knownSyncPlatform(platform) || !hostMatches(url.hostname, platform)) return "uncertain";
  const messages = Math.max(0, Math.floor(Number(signals?.messageCount) || 0));
  const title = String(signals?.title || "");
  const conversation = !!navigableConversationUrl(href, platform);
  const home = isHomeUrl(href, platform);
  const challenge = !!signals?.hasChallengeNode
    || CAPTCHA_URL.test(href)
    || (CAPTCHA_TITLE.test(title) && messages === 0);
  if (challenge) return "captcha";
  if (signals?.hasRateBanner || RATE_URL.test(href) || (RATE_TITLE.test(title) && messages === 0 && !conversation)) {
    return "rate";
  }
  if ((signals?.hasPassword || signals?.hasLoginForm) && messages > 0) return "uncertain";
  const login = LOGIN_URL.test(href)
    || ((signals?.hasPassword || signals?.hasLoginForm) && messages === 0)
    || (LOGIN_TITLE.test(title.trim()) && messages === 0 && !conversation);
  if (login) return "login";
  if (signals?.hasErrorBanner || ERROR_URL.test(url.pathname) || (ERROR_TITLE.test(title) && messages === 0 && !conversation)) {
    return "error";
  }
  if (conversation || home) return "ok";
  return "uncertain";
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Already stored, and the sidebar time or count is not newer.
 * No sidebar signal means we cannot tell, so we do not skip.
 */
export function shouldSkip(item) {
  if (!item || !(item.storedCount > 0)) return false;
  const timeKnown = Number.isFinite(item.sidebarUpdatedAt) && Number.isFinite(item.storedUpdatedAt);
  const countKnown = Number.isFinite(item.sidebarCount);
  if (!timeKnown && !countKnown) return false;
  if (timeKnown && item.sidebarUpdatedAt > item.storedUpdatedAt) return false;
  if (countKnown && item.sidebarCount > item.storedCount) return false;
  return true;
}

export function mergeQueue(stored, links, platform) {
  if (!knownSyncPlatform(platform)) return [];
  const items = [];
  const byId = new Map();
  const rows = [...(stored || [])].sort((a, b) => (Number(b?.updatedAt) || 0) - (Number(a?.updatedAt) || 0));
  for (const row of rows) {
    if (!row || row.id == null) continue;
    const url = navigableConversationUrl(row.url, platform);
    if (!url) continue;
    const parsed = conversationFromUrl(url);
    if (!parsed || parsed.id !== row.id) continue;
    if (byId.has(parsed.id)) continue;
    const item = {
      id: parsed.id,
      url,
      storedUpdatedAt: finiteOrNull(row.updatedAt),
      storedCount: Math.max(0, Math.floor(Number(row.messageCount) || 0)),
      sidebarUpdatedAt: null,
      sidebarCount: null,
      skip: false,
    };
    byId.set(item.id, item);
    items.push(item);
  }
  for (const link of (links || []).slice(0, 500)) {
    const url = navigableConversationUrl(link?.url, platform);
    if (!url) continue;
    const parsed = conversationFromUrl(url);
    if (!parsed) continue;
    let item = byId.get(parsed.id);
    if (!item) {
      item = {
        id: parsed.id,
        url,
        storedUpdatedAt: null,
        storedCount: 0,
        sidebarUpdatedAt: null,
        sidebarCount: null,
        skip: false,
      };
      byId.set(item.id, item);
      items.push(item);
    }
    const sideTime = finiteOrNull(link?.updatedAt);
    if (sideTime != null) item.sidebarUpdatedAt = sideTime;
    if (Number.isFinite(link?.messageCount) && link.messageCount >= 0) {
      item.sidebarCount = Math.floor(link.messageCount);
    }
  }
  for (const item of items) item.skip = shouldSkip(item);
  return items.slice(0, 5000);
}

export function emptySyncState() {
  return {
    status: "idle",
    reason: "",
    platform: "",
    tabId: null,
    queue: [],
    stored: [],
    index: 0,
    batchDone: 0,
    captured: 0,
    skipped: 0,
    failed: 0,
    emptyStreak: 0,
    phase: "idle",
    waitUntil: 0,
    remainMs: 0,
    openedAt: 0,
    token: "",
  };
}

function cloneState(state) {
  return {
    ...state,
    queue: state.queue || [],
    stored: state.stored || [],
  };
}

function stopped(state, reason) {
  const next = cloneState(state);
  next.status = "stopped";
  next.reason = reason;
  next.phase = "idle";
  next.waitUntil = 0;
  next.remainMs = 0;
  return { state: next, effect: null };
}

function paused(state, reason, now) {
  const next = cloneState(state);
  next.remainMs = Math.max(0, (next.waitUntil || 0) - now);
  next.status = "paused";
  next.reason = reason;
  next.waitUntil = 0;
  return { state: next, effect: null };
}

function skipRest(state) {
  const next = cloneState(state);
  while (next.index < next.queue.length && next.queue[next.index].skip) {
    next.skipped += 1;
    next.index += 1;
  }
  return next;
}

function openNext(state, now, limits) {
  let next = skipRest(state);
  while (next.index < next.queue.length) {
    if (next.batchDone >= limits.batch) {
      next.status = "resting";
      next.phase = "rest";
      next.batchDone = 0;
      next.waitUntil = now + limits.rest;
      next.remainMs = limits.rest;
      return { state: next, effect: null };
    }
    const url = navigableConversationUrl(next.queue[next.index].url, next.platform);
    if (!url) {
      next.failed += 1;
      next.index += 1;
      next = skipRest(next);
      continue;
    }
    next.status = "running";
    next.reason = "";
    next.phase = "opening";
    next.openedAt = now;
    next.waitUntil = 0;
    next.remainMs = 0;
    return { state: next, effect: { op: next.tabId == null ? "create" : "navigate", url } };
  }
  next.status = "done";
  next.reason = next.queue.length ? "" : "none";
  next.phase = "idle";
  next.waitUntil = 0;
  next.remainMs = 0;
  return { state: next, effect: null };
}

function afterSegment(state, now, limits, random) {
  let next = skipRest(state);
  if (next.index >= next.queue.length) {
    next.status = "done";
    next.reason = "";
    next.phase = "idle";
    next.waitUntil = 0;
    next.remainMs = 0;
    return { state: next, effect: null };
  }
  if (next.batchDone >= limits.batch) {
    next.status = "resting";
    next.phase = "rest";
    next.batchDone = 0;
    next.waitUntil = now + limits.rest;
    next.remainMs = limits.rest;
    return { state: next, effect: null };
  }
  const wait = gapDelay(limits, random);
  next.status = "running";
  next.reason = "";
  next.phase = "gap";
  next.waitUntil = now + wait;
  next.remainMs = wait;
  return { state: next, effect: null };
}

function applyReport(state, report, now, limits, random) {
  const kind = classifySyncPage({ ...report, platform: state.platform });
  if (state.phase === "harvest") {
    if (kind !== "ok") {
      const next = cloneState(state);
      next.failed += 1;
      return stopped(next, kind);
    }
    const age = now - (state.openedAt || now);
    const links = Array.isArray(report.links) ? report.links : [];
    if (!links.length && age < limits.settle) {
      return { state, effect: { op: "inspect" } };
    }
    const next = cloneState(state);
    next.queue = mergeQueue(next.stored, links, next.platform);
    next.stored = [];
    next.phase = "gap";
    const wait = gapDelay(limits, random);
    next.waitUntil = now + wait;
    next.remainMs = wait;
    next.status = "running";
    next.reason = "";
    if (!next.queue.length) {
      next.status = "done";
      next.reason = "none";
      next.phase = "idle";
      next.waitUntil = 0;
      next.remainMs = 0;
    }
    return { state: next, effect: null };
  }
  if (state.phase === "opening") {
    if (kind !== "ok") {
      const next = cloneState(state);
      next.failed += 1;
      return stopped(next, kind);
    }
    const count = Math.max(0, Math.floor(Number(report.messageCount) || 0));
    const age = now - (state.openedAt || now);
    // A missing storedCount means the caller already treated the page as saved
    // (unit tests). A real probe always sends the number the capture wrote.
    const awaitingStore = count > 0 && Number.isFinite(Number(report.storedCount)) &&
      Math.floor(Number(report.storedCount)) < count;
    if ((count <= 0 && age < limits.settle) || (awaitingStore && age < limits.report)) {
      return { state, effect: { op: "inspect" } };
    }
    if (awaitingStore) {
      const next = cloneState(state);
      next.failed += 1;
      return stopped(next, "uncertain");
    }
    const next = cloneState(state);
    if (count <= 0) {
      next.emptyStreak += 1;
      next.failed += 1;
      next.batchDone += 1;
      next.index += 1;
      if (next.emptyStreak >= limits.emptyLimit) return stopped(next, "empty");
      return afterSegment(next, now, limits, random);
    }
    next.captured += 1;
    next.emptyStreak = 0;
    next.batchDone += 1;
    next.index += 1;
    return afterSegment(next, now, limits, random);
  }
  return { state, effect: null };
}

/**
 * One transition. `now` is the panel clock. Effects are create / navigate / inspect.
 * A tick whose token does not match the run pauses it.
 */
export function stepSync(state, event, now, limits, random = Math.random) {
  const current = state && state.status ? state : emptySyncState();
  const pace = limits || productionSyncLimits();
  const type = event?.type;

  if (type === "startup") {
    if (current.status === "running" || current.status === "resting") {
      return paused(current, "startup", now);
    }
    return { state: current, effect: null };
  }

  if (type === "tab-closed") {
    if (!current.tabId || current.status === "idle" || current.status === "done" || current.status === "stopped") {
      return { state: current, effect: null };
    }
    const next = cloneState(current);
    next.tabId = null;
    return stopped(next, "tab-closed");
  }

  if (type === "stop") {
    if (current.status === "idle" || current.status === "stopped" || current.status === "done") {
      return { state: current, effect: null };
    }
    return stopped(current, "user");
  }

  if (type === "pause") {
    if (current.status !== "running" && current.status !== "resting") {
      return { state: current, effect: null };
    }
    if (event.token && current.token && event.token !== current.token) {
      return { state: current, effect: null };
    }
    return paused(current, event.reason || "panel", now);
  }

  if (type === "start") {
    if (current.status === "running" || current.status === "resting" || current.status === "paused") {
      return { state: current, effect: null };
    }
    if (!knownSyncPlatform(event.platform) || !event.token) return { state: current, effect: null };
    const home = homeUrl(event.platform);
    const next = emptySyncState();
    next.status = "running";
    next.phase = "harvest";
    next.platform = event.platform;
    next.token = String(event.token);
    next.stored = Array.isArray(event.stored) ? event.stored : [];
    next.openedAt = now;
    next.queue = mergeQueue(next.stored, [], event.platform);
    return { state: next, effect: { op: "create", url: home } };
  }

  if (type === "resume") {
    if (current.status !== "paused" || !event.token) return { state: current, effect: null };
    const next = cloneState(current);
    next.token = String(event.token);
    next.reason = "";
    if (next.phase === "rest") {
      next.status = "resting";
      next.waitUntil = now + (next.remainMs || 0);
      return { state: next, effect: null };
    }
    if (next.phase === "gap") {
      next.status = "running";
      next.waitUntil = now + (next.remainMs || 0);
      return { state: next, effect: null };
    }
    if (next.phase === "harvest") {
      next.status = "running";
      next.openedAt = now;
      const url = homeUrl(next.platform);
      return { state: next, effect: { op: next.tabId == null ? "create" : "navigate", url } };
    }
    if (next.phase === "opening") {
      next.status = "running";
      next.openedAt = now;
      const item = next.queue[next.index];
      const url = item ? navigableConversationUrl(item.url, next.platform) : "";
      if (!url) return stopped(next, "uncertain");
      return { state: next, effect: { op: next.tabId == null ? "create" : "navigate", url } };
    }
    next.status = "running";
    return openNext(next, now, pace);
  }

  if (type === "tab") {
    if (!Number.isInteger(event.tabId)) return { state: current, effect: null };
    const next = cloneState(current);
    next.tabId = event.tabId;
    return { state: next, effect: null };
  }

  if (type !== "tick") return { state: current, effect: null };
  if (current.status !== "running" && current.status !== "resting") {
    return { state: current, effect: null };
  }
  if (!event.token || event.token !== current.token) {
    return paused(current, "panel", now);
  }
  if (current.phase === "gap" || current.phase === "rest") {
    if (now < (current.waitUntil || 0)) return { state: current, effect: null };
    return openNext(current, now, pace);
  }
  if (current.phase === "harvest" || current.phase === "opening") {
    const age = now - (current.openedAt || now);
    if (!event.report) {
      if (event.tabStatus && event.tabStatus !== "complete" && age < pace.report) {
        return { state: current, effect: null };
      }
      if (age >= pace.report) return stopped(current, "uncertain");
      return { state: current, effect: event.tabStatus === "complete" ? { op: "inspect" } : null };
    }
    return applyReport(current, event.report, now, pace, random);
  }
  return { state: current, effect: null };
}

export function progressNumbers(state) {
  const total = state?.queue?.length || 0;
  if (!total) return { n: 0, total: 0 };
  if (state.status === "done") return { n: total, total };
  if (state.phase === "harvest") return { n: 0, total };
  if (state.status === "stopped") return { n: Math.min(total, state.index || 0), total };
  return { n: Math.min(total, (state.index || 0) + 1), total };
}

export function estimateRemaining(state, now, limits) {
  if (!state || state.status === "done" || state.status === "stopped" || state.status === "idle") return 0;
  const pace = limits || productionSyncLimits();
  const avg = (pace.gapMin + pace.gapMax) / 2;
  let left = 0;
  const queue = state.queue || [];
  for (let i = state.index || 0; i < queue.length; i += 1) {
    if (!queue[i].skip) left += 1;
  }
  let batch = state.phase === "rest" ? 0 : (state.batchDone || 0);
  let total = 0;
  if (state.phase === "rest") {
    total += state.status === "paused" ? (state.remainMs || 0) : Math.max(0, (state.waitUntil || 0) - now);
  } else if (state.phase === "gap") {
    total += state.status === "paused" ? (state.remainMs || 0) : Math.max(0, (state.waitUntil || 0) - now);
    left = Math.max(0, left - 1);
  } else if (state.phase === "harvest") {
    const elapsed = Math.max(0, now - (state.openedAt || now));
    total += state.status === "paused" ? (state.remainMs || 0) : Math.max(0, pace.report - elapsed);
  }
  while (left > 0) {
    if (batch >= pace.batch) {
      total += pace.rest;
      batch = 0;
    }
    const take = Math.min(pace.batch - batch, left);
    total += take * avg;
    batch += take;
    left -= take;
  }
  return Math.max(0, Math.round(total));
}

/** What the side panel may render. No urls, ids, or page text. */
export function publicSyncView(state, now, limits) {
  const pace = limits || productionSyncLimits();
  const pos = progressNumbers(state || emptySyncState());
  return {
    status: state?.status || "idle",
    reason: state?.reason || "",
    platform: state?.platform || "",
    phase: state?.phase || "idle",
    n: pos.n,
    total: pos.total,
    captured: state?.captured || 0,
    skipped: state?.skipped || 0,
    failed: state?.failed || 0,
    etaMs: estimateRemaining(state, now, pace),
  };
}
