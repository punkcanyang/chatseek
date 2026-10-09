/**
 * Drives one background sync tab. The side panel calls in on a short tick.
 * Deadlines live in the saved session, so a sleeping worker does not need a
 * long timer, and nothing runs until the next tick from an open panel.
 */

import { listSyncCandidates, readSyncSession, writeSyncSession } from "./db.js";
import {
  emptySyncState,
  homeUrl,
  isHomeUrl,
  navigableConversationUrl,
  publicSyncView,
  readTestSyncLimits,
  stepSync,
} from "./sync-policy.js";

let chain = Promise.resolve();
let memory = null;

async function loadState() {
  if (memory) return memory;
  try {
    const saved = await readSyncSession();
    memory = saved && typeof saved.status === "string" ? saved : emptySyncState();
  } catch {
    memory = emptySyncState();
  }
  return memory;
}

async function commit(state) {
  memory = state;
  try {
    await writeSyncSession(state);
  } catch {
    // The in-memory copy still answers the panel. The next successful write catches up.
  }
}

function scrubReport(raw, platform) {
  if (!raw || raw.ok === false || typeof raw !== "object") return null;
  const links = [];
  const incoming = Array.isArray(raw.links) ? raw.links : [];
  for (const link of incoming) {
    if (links.length >= 500) break;
    const url = navigableConversationUrl(link?.url, platform);
    if (!url) continue;
    links.push({
      url,
      updatedAt: Number.isFinite(link.updatedAt) ? link.updatedAt : null,
      messageCount: Number.isFinite(link.messageCount) ? link.messageCount : null,
    });
  }
  return {
    href: typeof raw.href === "string" ? raw.href : "",
    title: typeof raw.title === "string" ? raw.title.slice(0, 180) : "",
    hasChallengeNode: !!raw.hasChallengeNode,
    hasPassword: !!raw.hasPassword,
    hasLoginForm: !!raw.hasLoginForm,
    hasRateBanner: !!raw.hasRateBanner,
    hasErrorBanner: !!raw.hasErrorBanner,
    messageCount: Math.max(0, Math.floor(Number(raw.messageCount) || 0)),
    storedCount: Number.isFinite(Number(raw.storedCount)) ? Math.max(0, Math.floor(Number(raw.storedCount))) : null,
    links,
  };
}

async function tabStatus(tabId) {
  if (!Number.isInteger(tabId) || typeof chrome.tabs?.get !== "function") return "missing";
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return "missing";
    return tab.status === "complete" ? "complete" : "loading";
  } catch {
    return "missing";
  }
}

async function inspectTab(tabId) {
  if (!Number.isInteger(tabId) || typeof chrome.tabs?.sendMessage !== "function") return null;
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "SYNC_INSPECT" });
  } catch {
    return null;
  }
}

function allowedTarget(url, platform) {
  if (!url || !platform) return false;
  if (url === homeUrl(platform) || isHomeUrl(url, platform)) return true;
  return !!navigableConversationUrl(url, platform);
}

async function applyEffect(state, effect, now, pace) {
  if (!effect || effect.op === "inspect") return state;
  if (!allowedTarget(effect.url, state.platform)) {
    const next = { ...state, status: "stopped", reason: "uncertain", phase: "idle", waitUntil: 0, remainMs: 0 };
    return next;
  }
  if (effect.op === "create") {
    if (typeof chrome.tabs?.create !== "function") {
      return { ...state, status: "stopped", reason: "uncertain", phase: "idle" };
    }
    try {
      const tab = await chrome.tabs.create({ url: effect.url, active: false });
      const id = tab?.id;
      if (!Number.isInteger(id)) {
        return { ...state, status: "stopped", reason: "uncertain", phase: "idle" };
      }
      return stepSync(state, { type: "tab", tabId: id }, now, pace).state;
    } catch {
      return { ...state, status: "stopped", reason: "uncertain", phase: "idle" };
    }
  }
  if (effect.op === "navigate") {
    if (!Number.isInteger(state.tabId) || typeof chrome.tabs?.update !== "function") {
      return stepSync(state, { type: "tab-closed" }, now, pace).state;
    }
    try {
      await chrome.tabs.update(state.tabId, { url: effect.url, active: false });
      return state;
    } catch {
      return stepSync(state, { type: "tab-closed" }, now, pace).state;
    }
  }
  return state;
}

async function dispatch(event) {
  const now = Date.now();
  const pace = readTestSyncLimits();
  let state = await loadState();
  let incoming = event;
  if (incoming.type === "start") {
    let stored = [];
    try {
      stored = await listSyncCandidates(incoming.platform);
    } catch {
      stored = [];
    }
    incoming = { ...incoming, stored };
  }
  if (incoming.type === "tab-removed-check") {
    if (state.tabId !== incoming.tabId) return publicSyncView(state, now, pace);
    incoming = { type: "tab-closed" };
  }
  if (incoming.type === "tick" && (state.status === "running" || state.status === "resting")) {
    let status = "";
    if (Number.isInteger(state.tabId)) {
      status = await tabStatus(state.tabId);
      if (status === "missing") {
        const closed = stepSync(state, { type: "tab-closed" }, now, pace);
        await commit(closed.state);
        return publicSyncView(closed.state, now, pace);
      }
    }
    let report = null;
    if ((state.phase === "harvest" || state.phase === "opening") && status === "complete") {
      report = scrubReport(await inspectTab(state.tabId), state.platform);
    }
    incoming = { ...incoming, tabStatus: status, report };
  }
  const result = stepSync(state, incoming, now, pace);
  let next = result.state;
  await commit(next);
  if (result.effect && result.effect.op !== "inspect") {
    next = await applyEffect(next, result.effect, now, pace);
    await commit(next);
  }
  return publicSyncView(next, now, pace);
}

function enqueue(event) {
  const run = chain.then(() => dispatch(event));
  chain = run.then(() => {}, () => {});
  return run;
}

export function handleSyncMessage(msg) {
  const token = typeof msg?.token === "string" ? msg.token.slice(0, 80) : "";
  if (msg?.type === "SYNC_START") {
    return enqueue({ type: "start", platform: msg.platform, token });
  }
  if (msg?.type === "SYNC_PAUSE") return enqueue({ type: "pause", token, reason: "panel" });
  if (msg?.type === "SYNC_RESUME") return enqueue({ type: "resume", token });
  if (msg?.type === "SYNC_STOP") return enqueue({ type: "stop" });
  if (msg?.type === "SYNC_TICK" || msg?.type === "SYNC_STATUS") return enqueue({ type: "tick", token });
  return Promise.resolve(null);
}

export function noteSyncTabClosed(tabId) {
  if (!Number.isInteger(tabId)) return;
  enqueue({ type: "tab-removed-check", tabId });
}

export function pauseSyncForStartup() {
  enqueue({ type: "startup" });
}
