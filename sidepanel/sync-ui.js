import { fill, text } from "../src/i18n.js";

const TOKEN_KEY = "chatseek.syncPanel";
const REASONS = {
  captcha: "syncReasonCaptcha",
  login: "syncReasonLogin",
  error: "syncReasonError",
  rate: "syncReasonRate",
  empty: "syncReasonEmpty",
  "tab-closed": "syncReasonTab",
  panel: "syncReasonPanel",
  user: "syncReasonUser",
  uncertain: "syncReasonUncertain",
  startup: "syncReasonStartup",
};

let locale = "en";
let view = { status: "idle", reason: "", platform: "", phase: "idle", n: 0, total: 0, captured: 0, skipped: 0, failed: 0, etaMs: 0 };
let timer = 0;
let leaving = false;

function say(key, ...args) {
  return fill(text(locale, key), ...args);
}

function panelToken() {
  try {
    let token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) {
      token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem(TOKEN_KEY, token);
    }
    return token;
  } catch {
    return "chatseek-panel";
  }
}

function send(type, extra) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, token: panelToken(), ...extra }, (res) => {
        void chrome.runtime.lastError;
        resolve(res && typeof res === "object" ? res : null);
      });
    } catch {
      resolve(null);
    }
  });
}

function etaLabel(ms) {
  const min = Math.ceil((Number(ms) || 0) / 60000);
  if (min <= 1) return say("syncEtaSoon");
  return say("syncEtaMin", min);
}

function reasonLabel(reason) {
  const key = REASONS[reason];
  return key ? say(key) : say("syncReasonUncertain");
}

function statusLabel() {
  if (view.status === "running" && (view.phase === "gap" || view.phase === "harvest")) return say("syncWaiting");
  if (view.status === "running") return say("syncRunning");
  if (view.status === "resting") return say("syncResting");
  if (view.status === "paused") return say("syncPaused");
  if (view.status === "done" && view.reason === "none") return say("syncNothing");
  if (view.status === "done") return say("syncDone");
  if (view.status === "stopped") return say("syncStopped", reasonLabel(view.reason));
  return say("syncIdle");
}

function paint() {
  const platformEl = document.getElementById("syncPlatform");
  const start = document.getElementById("syncStart");
  const pause = document.getElementById("syncPause");
  const resume = document.getElementById("syncResume");
  const stop = document.getElementById("syncStop");
  const status = document.getElementById("syncStatus");
  const progress = document.getElementById("syncProgress");
  const hint = document.getElementById("syncHint");
  const label = document.getElementById("syncPlatformLabel");
  if (!start || !status) return;
  if (label) label.textContent = say("syncPlatform");
  start.textContent = say("syncStart");
  pause.textContent = say("syncPause");
  resume.textContent = say("syncResume");
  stop.textContent = say("syncStop");
  if (hint) hint.textContent = say("syncHint");
  status.textContent = statusLabel();
  const active = view.status === "running" || view.status === "resting" || view.status === "paused";
  if (view.status === "idle") progress.textContent = "";
  else {
    const tail = active ? etaLabel(view.etaMs) : say("syncEtaSoon");
    progress.textContent = say("syncProgress", view.n || 0, view.total || 0, view.captured || 0, view.skipped || 0, view.failed || 0, active ? tail : "—");
  }
  const busy = view.status === "running" || view.status === "resting";
  start.hidden = busy || view.status === "paused";
  pause.hidden = !busy;
  resume.hidden = view.status !== "paused";
  stop.hidden = !active;
  if (platformEl) platformEl.disabled = active;
}

function arm() {
  clearTimeout(timer);
  if (document.visibilityState !== "visible") return;
  if (view.status !== "running" && view.status !== "resting") return;
  timer = setTimeout(async () => {
    const next = await send("SYNC_TICK");
    if (next) view = next;
    paint();
    arm();
  }, 250);
}

async function refresh() {
  const next = await send("SYNC_TICK");
  if (next) view = next;
  paint();
  arm();
}

function leave() {
  clearTimeout(timer);
  if (leaving) return;
  if (view.status !== "running" && view.status !== "resting") return;
  leaving = true;
  send("SYNC_PAUSE").then((next) => {
    leaving = false;
    if (next) view = next;
    paint();
  });
}

export function setSyncLocale(code) {
  locale = code || "en";
  paint();
}

export function initSync() {
  const start = document.getElementById("syncStart");
  const pause = document.getElementById("syncPause");
  const resume = document.getElementById("syncResume");
  const stop = document.getElementById("syncStop");
  const platformEl = document.getElementById("syncPlatform");
  if (!start) return;
  start.addEventListener("click", async () => {
    const platform = platformEl?.value || "chatgpt";
    const next = await send("SYNC_START", { platform });
    if (next) view = next;
    paint();
    arm();
  });
  pause.addEventListener("click", async () => {
    const next = await send("SYNC_PAUSE");
    if (next) view = next;
    paint();
  });
  resume.addEventListener("click", async () => {
    const next = await send("SYNC_RESUME");
    if (next) view = next;
    paint();
    arm();
  });
  stop.addEventListener("click", async () => {
    const next = await send("SYNC_STOP");
    if (next) view = next;
    paint();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") arm();
    else leave();
  });
  window.addEventListener("pagehide", leave);
  paint();
  refresh();
}
