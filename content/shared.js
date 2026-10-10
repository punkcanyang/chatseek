/* Isolated-world helpers. Read the DOM only — no fetch/XHR hooks. */
(function chatseekAnnounce() {
  // Once per tab, from the top frame only. A cross-origin frame cannot read
  // window.top; that frame stays quiet and the top frame owns the line.
  try {
    if (typeof window !== "undefined" && window.top && window.top !== window) return;
  } catch {
    return;
  }
  try {
    if (globalThis.__chatseekLoaded) return;
    globalThis.__chatseekLoaded = true;
    let host = "";
    try {
      if (typeof location !== "undefined" && location && location.hostname) {
        host = String(location.hostname).toLowerCase();
      }
    } catch {
      host = "";
    }
    let platform = "other";
    if (host === "chatgpt.com" || host === "chat.openai.com") platform = "chatgpt";
    else if (host === "claude.ai") platform = "claude";
    else if (host === "grok.com" || host === "www.grok.com" || host === "grok.x.com" || host === "x.ai") platform = "grok";
    else if (host === "gemini.google.com") platform = "gemini";
    let version = "";
    try { version = chrome.runtime.getManifest().version; } catch { version = ""; }
    if (typeof console !== "undefined" && typeof console.log === "function") {
      console.log(`[Chatseek] loaded v=${version || "?"} platform=${platform}`);
    }
  } catch {
    // A log failure must not stop capture.
  }
})();
try {
  if (!globalThis.__chatseekPing && typeof chrome !== "undefined" && chrome.runtime?.onMessage?.addListener) {
    globalThis.__chatseekPing = true;
    const onPing = (msg, _sender, sendResponse) => {
      if (!msg || msg.type !== "CHATSEEK_PING") return;
      try { sendResponse({ ok: true, loaded: true }); } catch { /* orphaned after an extension reload */ }
    };
    globalThis.__chatseekPingListener = onPing;
    chrome.runtime.onMessage.addListener(onPing);
  }
} catch {
  // The page can still be captured if messaging is unavailable.
}
const Chatseek = {
  UUID:
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,

  debounce(fn, ms) {
    let timer = 0;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  },

  uuidFrom(hrefOrPath) {
    const match = String(hrefOrPath || "").match(Chatseek.UUID);
    return match ? match[0].toLowerCase() : null;
  },

  /**
   * Conversation id is the UUID after /c/, not an earlier UUID in /g/<gpt>/c/.
   * Query strings and hashes are ignored. Null when the path has no /c/<uuid>.
   */
  conversationIdFromPath(hrefOrPath) {
    const raw = String(hrefOrPath || "");
    let path = raw;
    try {
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) path = new URL(raw).pathname;
      else path = raw.split(/[?#]/)[0];
    } catch {
      path = raw.split(/[?#]/)[0];
    }
    const match = path.match(/\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return match ? match[1].toLowerCase() : null;
  },

  textOf(el) {
    if (!el) return "";
    return (el.innerText || el.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  },

  cleanClone(el) {
    const clone = el.cloneNode(true);
    clone
      .querySelectorAll("button, svg, nav, [role='button'], textarea, input")
      .forEach((node) => node.remove());
    return Chatseek.textOf(clone);
  },

  send(payload) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (res) => {
        if (done) return;
        done = true;
        resolve(res || null);
      };
      try {
        chrome.runtime.sendMessage(payload, (res) => {
          void chrome.runtime.lastError;
          finish(res);
        });
      } catch {
        finish(null);
      }
      // If the service worker dies mid-write the callback never fires.
      setTimeout(() => finish(null), 15000);
    });
  },

  /**
   * One capture at a time. A mutation during an in-flight capture queues
   * a single follow-up so a stale DOM snapshot cannot overwrite a newer one.
   */
  observe(handler) {
    let running = false;
    let queued = false;
    let retryTimer = 0;
    let retryDelay = 0;
    let mo = null;
    let poll = 0;
    const announce = () => {
      // URL only. The side panel matches it to a stored id; no message text.
      Chatseek.send({ type: "ACTIVE_LOCATION", url: location.href });
    };
    const onVisible = () => {
      if (!document.hidden) {
        announce();
        run();
      }
    };
    // After an extension reload this script is orphaned: every send fails
    // and nothing would ever stop the DOM scans.
    const alive = () => {
      if (globalThis.chrome?.runtime?.id) return true;
      mo?.disconnect();
      clearInterval(poll);
      clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisible);
      return false;
    };
    const scheduleRetry = () => {
      retryDelay = Math.min(retryDelay ? retryDelay * 2 : 3000, 60000);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(run, retryDelay);
    };
    const invoke = () => {
      if (!alive()) return;
      if (running) {
        queued = true;
        return;
      }
      running = true;
      queued = false;
      Promise.resolve()
        .then(() => handler())
        .then((ok) => {
          if (ok === false) {
            scheduleRetry();
          } else {
            retryDelay = 0;
            clearTimeout(retryTimer);
          }
        }, (err) => {
          Chatseek.rememberError(err);
          Chatseek.publishDiag(Chatseek.diagFields({
            platform: Chatseek._diagPlatform || "",
            pathKind: "error",
            healthState: "error",
            at: Date.now(),
          }));
          scheduleRetry();
        })
        .finally(() => {
          running = false;
          if (queued) {
            queued = false;
            run();
          }
        });
    };
    const run = Chatseek.debounce(invoke, 800);
    const root = document.documentElement || document.body;
    if (!root) return;
    mo = new MutationObserver(run);
    mo.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const deepSeen = new WeakSet();
    const bindDeep = () => {
      // Claude, Gemini, and Grok do not opt in. Their observers stay on the light DOM.
      if (Chatseek.watchEmbedded !== true) return;
      try { Chatseek.observeDeep(document, run, deepSeen); } catch { /* deep roots are optional */ }
    };
    let emptyWatch = false;
    let emptyTimer = 0;
    let emptyAttempt = 0;
    const armEmpty = () => {
      clearTimeout(emptyTimer);
      emptyTimer = 0;
      if (!emptyWatch) {
        emptyAttempt = 0;
        return;
      }
      // Shadow and iframe documents do not notify the top light-DOM observer.
      // Look again with a capped backoff, and do not schedule while the tab is hidden.
      const delay = Chatseek.emptyRescanDelay(emptyAttempt, !!document.hidden);
      if (!delay) return;
      emptyAttempt += 1;
      emptyTimer = setTimeout(() => {
        if (!alive() || !emptyWatch || document.hidden) return;
        bindDeep();
        run();
        armEmpty();
      }, delay);
    };
    Chatseek.noteEmptyConversation = (empty) => {
      emptyWatch = !!empty;
      armEmpty();
    };
    Chatseek.requestRescan = () => {
      if (!alive() || document.hidden) return;
      bindDeep();
      run();
    };
    const onFrame = (event) => {
      const data = event?.data;
      if (!data || data.source !== "chatseek-frame") return;
      let frames = [];
      try { frames = document.querySelectorAll("iframe"); } catch { frames = []; }
      for (const frame of frames) {
        try {
          if (frame.contentWindow !== event.source) continue;
        } catch {
          continue;
        }
        if (!Chatseek._scriptedFrames) Chatseek._scriptedFrames = new WeakMap();
        Chatseek._scriptedFrames.set(frame, true);
        Chatseek.requestRescan();
        return;
      }
    };
    if (Chatseek.watchEmbedded === true) window.addEventListener("message", onFrame);
    let href = location.href;
    poll = setInterval(() => {
      if (!alive()) return;
      if (location.href !== href) {
        href = location.href;
        emptyAttempt = 0;
        bindDeep();
        announce();
        run();
      }
    }, 1200);
    document.addEventListener("visibilitychange", () => {
      armEmpty();
      onVisible();
    });
    announce();
    bindDeep();
    run();
  },

  fingerprint(parts) {
    return parts.join("|");
  },

  hash(text) {
    let h = 2166136261;
    const str = String(text || "");
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  },

  // 2020-01-01. No indexed chat predates this; V8 turns "Top 10" into 2001.
  MIN_MS: 1577836800000,

  HEALTH_GRACE_MS: 8000,

  /**
   * Keep in sync with TIME_SOURCE_RANK in src/activity-time.js.
   * Adapters only set page-exact or page-bucket; the database ranks the rest.
   */
  timeSourceRank(source) {
    return {
      "page-exact": 50,
      observed: 40,
      "page-bucket": 30,
      "sidebar-rank": 20,
      "first-seen": 10,
      legacy: 10,
    }[source] || 0;
  },

  minuteFloor(now) {
    return Math.floor(Number(now) / 60000) * 60000;
  },

  /** "Last message 3 hours ago" / "上次訊息 3 小時前" → the relative phrase. */
  stripRelativePrefix(raw) {
    return String(raw || "").replace(
      /^(?:last\s+message|last\s+active|上次(?:的)?(?:訊息|消息)|最後(?:一則)?訊息|最后(?:一条)?消息)\s*[:：\-–—]?\s*/i,
      "",
    ).trim();
  },

  /** True for a plausible millisecond epoch (not unix seconds). */
  isValidMs(ts) {
    if (typeof ts !== "number" || !Number.isFinite(ts)) return false;
    return ts >= Chatseek.MIN_MS && ts <= Date.now() + 86400000 * 366;
  },

  /**
   * Date.parse accepts "Chapter 3" or "Step 1". Only let through strings made
   * of month/weekday names, digits and separators, or a d/m/y triple.
   */
  looksLikeDate(s) {
    if (/^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}(?:[ ,T]|$)/.test(s)) return true;
    let hasMonth = false;
    const rest = s.toLowerCase()
      .replace(
        /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b\.?/g,
        () => {
          hasMonth = true;
          return " ";
        },
      )
      .replace(
        /\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day)?\b\.?|\b(?:wednesday|saturday)\b|\b(?:at|am|pm|utc|gmt)\b/g,
        " ",
      );
    return hasMonth && /\d/.test(rest) && !/[a-z\u00c0-\uffff]/.test(rest);
  },

  /**
   * Parse a page-facing time into ms epoch.
   * Accepts ISO strings, unix sec/ms numbers, Date, and common relative labels
   * (EN + ZH): Today, Yesterday, 2 days ago, 昨天, Previous 7 Days, Mar 2025, etc.
   */
  parsePageTime(raw, now = Date.now()) {
    if (raw == null || raw === "") return null;
    if (typeof raw === "number") {
      if (Chatseek.isValidMs(raw)) return Math.floor(raw);
      // unix seconds
      if (raw >= 1e9 && raw < 1e11) {
        const ms = Math.floor(raw * 1000);
        return Chatseek.isValidMs(ms) ? ms : null;
      }
      return null;
    }
    if (raw instanceof Date) {
      const ms = raw.getTime();
      return Chatseek.isValidMs(ms) ? ms : null;
    }

    const s = String(raw).trim();
    if (!s) return null;

    // Pure digits: unix sec or ms
    if (/^\d{10,13}$/.test(s)) {
      return Chatseek.parsePageTime(Number(s), now);
    }

    // ISO / RFC-ish
    if (
      /^\d{4}-\d{2}-\d{2}/.test(s) ||
      /^\d{4}\/\d{1,2}\/\d{1,2}/.test(s) ||
      /T\d{2}:\d{2}/.test(s)
    ) {
      const ms = Date.parse(s);
      return Chatseek.isValidMs(ms) ? ms : null;
    }

    const body = Chatseek.stripRelativePrefix(s);
    if (!body) return null;
    const lower = body.toLowerCase();
    const startOfLocalDay = (d) => {
      const x = new Date(d);
      x.setHours(0, 0, 0, 0);
      return x.getTime();
    };
    const dayMs = 86400000;
    const todayStart = startOfLocalDay(now);
    const minuteNow = Chatseek.minuteFloor(now);

    // "Today" is the group [start of day, now]. Noon would sit in the future
    // during the morning and sort above chats that actually just happened.
    // Minute-floored so the sidebar fingerprint does not change on every scan.
    if (
      /^(today|今天|今日)$/i.test(body) ||
      lower === "today"
    ) {
      const end = Math.min(minuteNow, todayStart + dayMs - 1);
      if (end <= todayStart) return todayStart;
      return todayStart + Math.floor((end - todayStart) / 2);
    }
    if (/^(yesterday|昨天|昨日)$/i.test(body)) {
      return todayStart - dayMs + 12 * 3600000;
    }

    // "Previous 7 Days" / "Past 7 Days" / "最近 7 天" → midpoint ~4 days ago
    let m = body.match(
      /^(?:previous|past|last)\s+(\d+)\s+days?$/i,
    ) || body.match(/^最近\s*(\d+)\s*天/) || body.match(/^(?:过去|過去)\s*(\d+)\s*天/);
    if (m) {
      const n = Number(m[1]);
      if (n > 0 && n <= 90) {
        return todayStart - Math.floor(n / 2) * dayMs + 12 * 3600000;
      }
    }
    // "N days ago" / "N天前" / "N 天前"
    m = lower.match(/^(\d+)\s*(?:days?|d)\s*ago$/) ||
      body.match(/^(\d+)\s*天前$/);
    if (m) {
      const n = Number(m[1]);
      if (n >= 0 && n <= 3660) {
        return todayStart - n * dayMs + 12 * 3600000;
      }
    }

    // "N hours ago" / "N小时前" / "N 小時前". Floored so a sidebar scan
    // inside the same minute does not look like a brand-new timestamp.
    m = lower.match(/^(\d+)\s*(?:hours?|hrs?|h)\s*ago$/) ||
      body.match(/^(\d+)\s*(?:小时|小時|个小时|個小時)\s*前$/);
    if (m) {
      const n = Number(m[1]);
      if (n >= 0 && n <= 24 * 60) return minuteNow - n * 3600000;
    }

    // "N minutes ago" / "N分钟前" / "N 分鐘前"
    m = lower.match(/^(\d+)\s*(?:minutes?|mins?|m)\s*ago$/) ||
      body.match(/^(\d+)\s*(?:分钟|分鐘)\s*前$/);
    if (m) {
      const n = Number(m[1]);
      if (n >= 0 && n <= 24 * 60) return minuteNow - n * 60000;
    }

    // "N weeks ago" / "N周前" / "N 週前"
    m = lower.match(/^(\d+)\s*weeks?\s*ago$/) ||
      body.match(/^(\d+)\s*(?:周|週|星期|个星期|個星期)\s*前$/);
    if (m) {
      const n = Number(m[1]);
      if (n >= 0 && n <= 520) return todayStart - n * 7 * dayMs + 12 * 3600000;
    }

    // Compact row labels (Grok): "2h", "3d". Bare "5m" is too easy to false-hit.
    m = lower.match(/^(\d+)\s*h(?:rs?)?$/);
    if (m) {
      const n = Number(m[1]);
      if (n >= 0 && n <= 24 * 14) return minuteNow - n * 3600000;
    }
    m = lower.match(/^(\d+)\s*d$/);
    if (m) {
      const n = Number(m[1]);
      if (n >= 0 && n <= 3660) return todayStart - n * dayMs + 12 * 3600000;
    }

    if (/^(this week|本周|这周|本週|這周|這週)$/i.test(body)) {
      return todayStart - 3 * dayMs + 12 * 3600000;
    }
    if (/^(last week|上周|上週)$/i.test(body)) {
      return todayStart - 10 * dayMs + 12 * 3600000;
    }
    if (/^(this month|本月|这个月|這個月)$/i.test(body)) {
      const d = new Date(now);
      const ms = new Date(d.getFullYear(), d.getMonth(), 15, 12, 0, 0, 0).getTime();
      return ms > now ? todayStart : ms;
    }
    if (/^(last month|上月|上个月|上個月)$/i.test(body)) {
      const d = new Date(now);
      const ms = new Date(d.getFullYear(), d.getMonth() - 1, 15, 12, 0, 0, 0).getTime();
      return Chatseek.isValidMs(ms) ? ms : null;
    }

    // "just now" / "刚刚" — same minute so the sidebar fingerprint can sit still.
    if (/^(just\s*now|刚刚|剛才|刚才)$/i.test(body)) return minuteNow;

    // Month name heading: "March", "Mar 2025", "2025年3月", "三月"
    const months = {
      january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
      april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
      august: 7, aug: 7, september: 8, sep: 8, sept: 8,
      october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
      "一月": 0, "二月": 1, "三月": 2, "四月": 3, "五月": 4, "六月": 5,
      "七月": 6, "八月": 7, "九月": 8, "十月": 9, "十一月": 10, "十二月": 11,
    };
    m = lower.match(
      /^(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(?:\s+(\d{4}))?$/,
    );
    if (m) {
      const month = months[m[1]];
      const year = m[2] ? Number(m[2]) : new Date(now).getFullYear();
      const ms = new Date(year, month, 15, 12, 0, 0, 0).getTime();
      // If bare month is in the future relative to now, assume previous year
      if (!m[2] && ms > now + dayMs) {
        return new Date(year - 1, month, 15, 12, 0, 0, 0).getTime();
      }
      return Chatseek.isValidMs(ms) ? ms : null;
    }
    m = s.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月/);
    if (m) {
      const ms = new Date(Number(m[1]), Number(m[2]) - 1, 15, 12, 0, 0, 0).getTime();
      return Chatseek.isValidMs(ms) ? ms : null;
    }
    m = s.match(/^(一月|二月|三月|四月|五月|六月|七月|八月|九月|十月|十一月|十二月)$/);
    if (m) {
      const month = months[m[1]];
      const year = new Date(now).getFullYear();
      let ms = new Date(year, month, 15, 12, 0, 0, 0).getTime();
      if (ms > now + dayMs) ms = new Date(year - 1, month, 15, 12, 0, 0, 0).getTime();
      return ms;
    }

    // Last resort: Date.parse for things like "Sep 12, 2025"
    if (!Chatseek.looksLikeDate(s)) return null;
    if (!/\d{4}/.test(s)) {
      // V8 fills a missing year with 2001.
      const year = new Date(now).getFullYear();
      let ms = Date.parse(`${s} ${year}`);
      if (ms > now + dayMs) ms = Date.parse(`${s} ${year - 1}`);
      return Chatseek.isValidMs(ms) ? ms : null;
    }
    const parsed = Date.parse(s);
    if (Chatseek.isValidMs(parsed)) return parsed;
    return null;
  },

  /**
   * page-exact is a point in time (datetime, "3 hours ago", "2h").
   * page-bucket is a day or coarser group ("Today", "3d", "Previous 7 Days").
   */
  classifyPageTime(raw) {
    const text = Chatseek.stripRelativePrefix(String(raw ?? "")).trim();
    if (!text) return null;
    const ms = Chatseek.parsePageTime(raw);
    if (!ms) return null;
    const dayish = /^(?:today|yesterday|今天|今日|昨天|昨日)$/i.test(text) ||
      /(?:^|\s)(?:days?|weeks?)\s*ago$/i.test(text) ||
      /(?:天|周|週|星期)前$/.test(text) ||
      /^\d+\s*d$/i.test(text) ||
      /^(?:previous|past|last)\s+\d+\s+days?$/i.test(text) ||
      /^(?:this|last)\s+(?:week|month)$/i.test(text) ||
      /^(?:本周|这周|本週|這周|這週|上周|上週|本月|这个月|這個月|上月|上个月|上個月|最近|过去|過去)/.test(text);
    if (
      /^\d{10,13}$/.test(text) ||
      /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(text) ||
      /T\d{2}:\d{2}/.test(text)
    ) {
      return { ms, source: "page-exact" };
    }
    if (dayish) return { ms, source: "page-bucket" };
    return { ms, source: "page-exact" };
  },

  _HEADING:
    /^(today|yesterday|previous\s+\d+\s+days?|past\s+\d+\s+days?|last\s+\d+\s+days?|this week|last week|this month|last month|今天|昨天|昨日|今日|本周|这周|上周|本月|这个月|上月|上个月|最近\s*\d+\s*天|过去\s*\d+\s*天|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(\s+\d{4})?$|^\d{4}\s*年\s*\d{1,2}\s*月$|^(一月|二月|三月|四月|五月|六月|七月|八月|九月|十月|十一月|十二月)$/i,

  headingTime(text) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    if (!t || t.length > 40) return null;
    if (!Chatseek._HEADING.test(t)) return null;
    return Chatseek.parsePageTime(t);
  },

  isConvAnchor(el) {
    if (!el || el.nodeType !== 1 || el.tagName !== "A") return false;
    const href = el.getAttribute("href") || "";
    return /\/(?:c|chat)\//i.test(href);
  },

  /** True when this node is another conversation row, not a date header. */
  isConvRow(el) {
    if (!el || el.nodeType !== 1) return false;
    if (Chatseek.isConvAnchor(el)) return true;
    const a = el.querySelector?.('a[href*="/c/"], a[href*="/chat/"]');
    return !!(a && Chatseek.isConvAnchor(a));
  },

  /**
   * Walk ancestors / previous siblings looking for a date-group heading
   * (ChatGPT/Grok sticky "Today" / "Yesterday" / "Previous 7 Days" headers).
   * Long groups need more than a dozen previous siblings.
   */
  findSectionTime(el) {
    if (!el || el.nodeType !== 1) return null;

    const headingFrom = (sib) => {
      if (!sib || sib.nodeType !== 1 || Chatseek.isConvRow(sib)) return null;
      const direct = Chatseek.headingTime(sib.textContent);
      if (direct) return direct;
      if (sib.querySelector?.('a[href*="/c/"], a[href*="/chat/"]')) return null;
      const inner = sib.querySelector?.(
        "h2, h3, h4, [class*='sticky'], [class*='time'], time",
      );
      if (!inner) return null;
      return Chatseek.headingTime(inner.getAttribute?.("datetime") || inner.textContent);
    };

    let node = el;
    for (let depth = 0; depth < 10 && node; depth++) {
      let sib = node.previousElementSibling;
      let steps = 0;
      while (sib && steps < 250) {
        const hit = headingFrom(sib);
        if (hit) return hit;
        sib = sib.previousElementSibling;
        steps += 1;
      }
      node = node.parentElement;
    }
    return null;
  },

  /**
   * Find a timestamp on the conversation row itself (not the section bucket).
   * Prefers time[datetime], data-*-time attrs, then a short relative label.
   */
  findTimeNear(el) {
    if (!el || el.nodeType !== 1) return null;

    const attrNames = [
      "datetime",
      "data-time",
      "data-timestamp",
      "data-updated-at",
      "data-updatedat",
      "data-update-time",
      "data-created-at",
      "data-createdat",
      "data-create-time",
      "data-date",
      "title",
    ];

    const fromAttrs = (node) => {
      if (!node || node.nodeType !== 1) return null;
      for (const name of attrNames) {
        const raw = node.getAttribute?.(name);
        if (!raw) continue;
        // title often holds non-date text; only accept if parseable as time-ish
        if (name === "title" && !/(\d{4}|ago|yesterday|today|昨天|今天|分钟|分鐘|小时|小時|天|last message|上次)/i.test(raw)) {
          continue;
        }
        const hit = name === "datetime"
          ? (() => {
            const ms = Chatseek.parsePageTime(raw);
            return ms ? { ms, source: "page-exact" } : null;
          })()
          : Chatseek.classifyPageTime(raw);
        if (hit) return hit;
      }
      // data-* wildcards
      if (node.dataset) {
        for (const [key, val] of Object.entries(node.dataset)) {
          if (!/time|date|updated|created|modify/i.test(key)) continue;
          const hit = Chatseek.classifyPageTime(val);
          if (hit) return hit;
        }
      }
      return null;
    };

    // Row-local only. A multi-chat parent would make the "Today" header
    // look like every conversation's own timestamp.
    const scopes = [el];
    const next = el.nextElementSibling;
    if (next && !Chatseek.isConvRow(next)) scopes.push(next);
    const parent = el.parentElement;
    if (parent) {
      const links = parent.querySelectorAll?.('a[href*="/c/"], a[href*="/chat/"]');
      if (!links || links.length <= 1) scopes.push(parent);
    }
    const row = el.closest?.("li, [role='listitem'], tr");
    if (row && !scopes.includes(row)) {
      const links = row.querySelectorAll?.('a[href*="/c/"], a[href*="/chat/"]');
      if (!links || links.length <= 1) scopes.push(row);
    }

    for (const scope of scopes) {
      const times = scope.querySelectorAll?.("time[datetime], time");
      if (times) {
        for (const t of times) {
          const fromTime = fromAttrs(t) || Chatseek.classifyPageTime(t.textContent);
          if (fromTime) return fromTime;
        }
      }
      const fromScope = fromAttrs(scope);
      if (fromScope) return fromScope;
      // Short relative label as its own child (not the whole title)
      const kids = scope.querySelectorAll?.("span, div, p, time");
      if (kids) {
        for (const kid of kids) {
          if (kid === el || el.contains?.(kid) && kid !== el && Chatseek.textOf(kid) === Chatseek.textOf(el)) {
            // skip the title text itself when it equals the link text
          }
          const text = (kid.textContent || "").replace(/\s+/g, " ").trim();
          if (!text || text.length > 48) continue;
          if (text === Chatseek.textOf(el)) continue;
          const parsed = Chatseek.classifyPageTime(text);
          if (parsed) return parsed;
        }
      }
    }

    return null;
  },

  /**
   * Scan already-in-document script/JSON text for update_time / updated_at /
   * modifyTime keyed by conversation UUID. No network — static page content only.
   * Returns Map<uuidLower, ms>.
   */
  pageTimesFromDocument(doc = document) {
    const map = new Map();
    const put = (id, raw) => {
      if (!id) return;
      const ms = Chatseek.parsePageTime(raw);
      if (!ms) return;
      const key = id.toLowerCase();
      const prev = map.get(key);
      // Prefer the newer timestamp when multiple appear
      if (!prev || ms > prev) map.set(key, ms);
    };

    const absorbObject = (obj, depth = 0) => {
      if (!obj || depth > 6) return;
      if (Array.isArray(obj)) {
        for (const item of obj) absorbObject(item, depth + 1);
        return;
      }
      if (typeof obj !== "object") return;
      const id =
        obj.id || obj.conversation_id || obj.conversationId ||
        obj.uuid || obj.chat_id || obj.chatId;
      const idStr = typeof id === "string" ? Chatseek.uuidFrom(id) : null;
      const updated =
        obj.update_time ?? obj.updated_at ?? obj.updatedAt ??
        obj.modifyTime ?? obj.modify_time ?? obj.last_updated ??
        obj.create_time ?? obj.created_at ?? obj.createdAt;
      if (idStr && updated != null) put(idStr, updated);
      for (const v of Object.values(obj)) {
        if (v && typeof v === "object") absorbObject(v, depth + 1);
      }
    };

    // Inline JSON / application/json / __NEXT_DATA__ style scripts
    const scripts = doc.querySelectorAll(
      'script[type="application/json"], script[type="application/ld+json"], script#__NEXT_DATA__',
    );
    for (const script of scripts) {
      const text = script.textContent || "";
      if (text.length < 20 || text.length > 5_000_000) continue;
      try {
        absorbObject(JSON.parse(text));
      } catch {
        // fall through to regex scan
      }
    }

    // Light regex over a capped slice of body/scripts for embedded conversation blobs
    const chunks = [];
    for (const script of doc.scripts) {
      const text = script.textContent || "";
      if (text.length < 40) continue;
      if (text.length > 2_000_000) continue;
      if (!/update_time|updated_at|modifyTime|create_time/i.test(text)) continue;
      chunks.push(text.slice(0, 1_500_000));
      if (chunks.length >= 8) break;
    }
    const blob = chunks.join("\n");
    if (blob) {
      // React Router streams often escape quotes. Scan the raw text and a
      // de-escaped copy; still no network, still capped to scripts already on the page.
      const copies = [blob];
      if (blob.includes('\\"')) copies.push(blob.replace(/\\"/g, '"'));
      for (const text of copies) {
        const re =
          /"(?:id|conversation_id|uuid)"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"[\s\S]{0,400}?"(?:update_time|updated_at|modifyTime|modify_time|create_time|created_at)"\s*:\s*("?(?:[\d.]+|[^"]+)"?)/gi;
        let match;
        while ((match = re.exec(text))) {
          let raw = match[2];
          if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
          put(match[1], /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw);
        }
        const re2 =
          /"(?:update_time|updated_at|modifyTime|modify_time)"\s*:\s*("?(?:[\d.]+|[^"]+)"?)[\s\S]{0,400}?"(?:id|conversation_id|uuid)"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi;
        while ((match = re2.exec(text))) {
          let raw = match[1];
          if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
          put(match[2], /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw);
        }
      }
    }

    return map;
  },

  /** Nav/aside that actually holds the history links. Never the whole document. */
  historyRoot(links) {
    const counts = new Map();
    for (const link of links) {
      const box = link.closest?.("nav, aside, [role='navigation']");
      if (!box) continue;
      counts.set(box, (counts.get(box) || 0) + 1);
    }
    let best = null;
    let n = 0;
    for (const [box, count] of counts) {
      if (count > n) {
        best = box;
        n = count;
      }
    }
    if (best && n >= Math.min(2, links.length)) return best;
    return null;
  },

  _insideConvAnchor(node, root) {
    let p = node;
    while (p && p !== root) {
      if (Chatseek.isConvAnchor(p)) return true;
      p = p.parentElement;
    }
    return false;
  },

  /**
   * Assign the current date-group heading to each conversation link.
   * Walks only the history nav so a header covers every following row.
   */
  sectionTimesFor(links) {
    const result = new Map();
    if (!links || !links.length || typeof document === "undefined") return result;
    if (typeof document.createTreeWalker !== "function") return result;
    const root = Chatseek.historyRoot(links);
    if (!root) return result;
    const wanted = new Set(links);
    let current = null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      const tag = node.tagName || "";
      if (!/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|INPUT)$/.test(tag) &&
          !Chatseek._insideConvAnchor(node, root)) {
        const cls = typeof node.className === "string" ? node.className : "";
        const sticky = /sticky|section-header|date-header|time-header/i.test(cls);
        const leafish = node.childElementCount === 0 || /^(H1|H2|H3|H4|TIME)$/.test(tag);
        if (leafish || sticky) {
          const heading = Chatseek.headingTime(
            node.getAttribute?.("datetime") || node.textContent,
          );
          if (heading) current = heading;
        }
      }
      if (wanted.has(node) && current) result.set(node, current);
      node = walker.nextNode();
    }
    return result;
  },

  /** Drop trailing " - ChatGPT" / " | Grok" site names; never cut mid-title. */
  stripTitleSuffix(title, names) {
    const re = new RegExp(`\\s*[|·—–-]\\s*(?:${names.join("|")})\\s*$`, "i");
    let t = String(title || "").trim();
    let prev;
    do {
      prev = t;
      t = t.replace(re, "").trim();
    } while (t && t !== prev);
    return t;
  },

  isGenericTitle(title) {
    const t = (title || "").trim();
    if (!t) return true;
    return /^(new chat|chatgpt|claude|grok|gemini|google gemini|untitled|无标题|新对话|新對話|新聊天)$/i.test(t);
  },

  /** Keep one row per id: newer page date wins, but a real title beats "ChatGPT". */
  rememberConv(byId, conv) {
    if (!conv?.platformId) return;
    const prev = byId.get(conv.platformId);
    if (!prev) {
      byId.set(conv.platformId, conv);
      return;
    }
    const prevGeneric = Chatseek.isGenericTitle(prev.title);
    const nextGeneric = Chatseek.isGenericTitle(conv.title);
    const prevRank = Chatseek.timeSourceRank(prev.updatedAtSource);
    const nextRank = Chatseek.timeSourceRank(conv.updatedAtSource);
    const takeNextTime = nextRank > prevRank ||
      (nextRank === prevRank && (conv.updatedAt || 0) > (prev.updatedAt || 0)) ||
      (!prev.updatedAt && conv.updatedAt);
    let chosen = prev;
    if (takeNextTime) {
      chosen = { ...prev, ...conv };
      if (nextGeneric && !prevGeneric) chosen.title = prev.title;
    } else if (prevGeneric && !nextGeneric) {
      chosen = { ...prev, title: conv.title, url: conv.url || prev.url };
    }
    if (!chosen.updatedAt && conv.updatedAt) {
      chosen.updatedAt = conv.updatedAt;
      chosen.updatedAtSource = conv.updatedAtSource;
    }
    if (!chosen.createdAt && (conv.createdAt || conv.updatedAt)) {
      chosen.createdAt = conv.createdAt || conv.updatedAt;
    }
    byId.set(conv.platformId, chosen);
  },

  isUiNoise(body) {
    const t = String(body || "").replace(/\s+/g, " ").trim();
    if (!t) return true;
    return /^(copy|copied|retry|regenerate|share|edit|more|like|dislike|复制|已复制|重试|重新生成|分享|编辑|更多)$/i.test(t);
  },

  chunkMessages(messages) {
    const chunks = [];
    let cur = [];
    let size = 0;
    const maxChars = 350000;
    const maxCount = 20;
    for (const msg of messages || []) {
      const n = (msg?.body || "").length + 80;
      if (cur.length && (cur.length >= maxCount || size + n > maxChars)) {
        chunks.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(msg);
      size += n;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  },

  async sendConversations(platform, list) {
    // Sidebar-order estimates interpolate inside one write. Splitting the
    // sidebar would make rows near a split guess from the wrong neighbours.
    const batch = 1000;
    for (let i = 0; i < list.length; i += batch) {
      const res = await Chatseek.send({
        type: "CAPTURE_CONVERSATIONS",
        platform,
        conversations: list.slice(i, i + batch),
      });
      if (!res || !res.ok) return false;
    }
    return true;
  },

  /**
   * Index the sidebar and the open thread. Fingerprints advance only after
   * the service worker acks, so a failed write is retried on the next pass.
   * Empty threads do not lock the message fingerprint.
   * Resolves false when a write failed so the caller can retry.
   *
   * health is optional so a new adapter can opt in:
   *   { pathKind, selector, selectorsTried }
   * pathKind "conversation" + 0 messages raises the side-panel warning.
   */
  // Body-only transcript signature. IDs and roles can change on heuristic
  // extraction; JSON boundaries prevent concatenation ambiguities.
  transcriptHash(messages) {
    return Chatseek.hash(JSON.stringify(messages.map(m => String(m.body || ""))));
  },

  nativeTurnKeys(conversationId, messages) {
    const prefix = conversationId + ":";
    return messages.map(m => m.id?.startsWith(prefix) ? m.id.slice(prefix.length) : "")
      .filter(id => id && !/^[0-9a-f]{1,8}:dom\d+$/.test(id));
  },

  bodyTurnKeys(messages, fallbackOnly = false) {
    return messages.filter(m => !fallbackOnly || /^(?:chatgpt|claude|grok|gemini):[^:]+:[0-9a-f]{1,8}:dom\d+$/.test(m.id || ""))
      .flatMap(m => [40, 80, 160].filter(length => (m.body || "").length >= length)
        .map(length => `${m.role}:${length}:${Chatseek.transcriptHash([{ body: m.body.slice(0, length) }])}`));
  },

  ownershipParent(node) {
    if (node.parentElement) return node.parentElement;
    const host = node.getRootNode?.().host;
    if (host) return host;
    try { return node.ownerDocument?.defaultView?.frameElement || null; }
    catch { return null; }
  },

  // A DOM node, rather than its wording or its window-local position, owns
  // a fallback identity. The session salt prevents collisions after reloads.
  createTurnIdentity(platform) {
    const turns = new WeakMap();
    const session = String(Math.floor(Math.random() * 1e12));
    let sequence = 0;
    return (node, conversationId, role, body, nativeId) => {
      const scope = `${conversationId}:${role}`;
      const previous = turns.get(node);
      if (previous?.scope === scope && (!nativeId || !previous.nativeId || previous.nativeId === nativeId)) {
        // A native id may arrive mid-stream; it does not create another turn.
        if (nativeId) previous.nativeId = nativeId;
        return previous.id;
      }
      const id = nativeId ? `${platform}:${conversationId}:${nativeId}`
        : `${platform}:${conversationId}:${Chatseek.hash(role + ":" + body)}:dom${session}${++sequence}`;
      turns.set(node, { scope, id, nativeId });
      return id;
    };
  },

  // A successful observation, not a successful write, owns this baseline.
  // Keep all pre-switch nodes weakly, including across rapid B -> C switches.
  pageIdentity(state, doc, href, platformId, extracted, resolveId = Chatseek.conversationIdFromPath,
    normalizeId = id => Chatseek.UUID.test(id) ? id.toLowerCase() : id) {
    const nodes = extracted.nodes || [];
    const hash = Chatseek.transcriptHash(extracted.messages);
    let page = state.pageIdentity;
    if (!page) {
      page = state.pageIdentity = {
        href, baselineHref: href, nodes: new WeakSet(nodes), baselineNodes: new WeakSet(nodes),
        observedNodes: nodes, hash, pending: false,
      };
    } else if (page.href !== href) {
      // A held mixed A/B screen still belongs to B's observation. If the URL
      // advances to C, its B nodes must become residual too, even though B
      // was never accepted or stored. Add only the PREVIOUS observation.
      for (const node of page.observedNodes || []) page.nodes.add(node);
      page.href = href;
      page.pending = true;
    }
    page.observedNodes = nodes;
    const readMarkers = () => {
      const ids = [];
      for (const root of Chatseek.readScopes(doc).map(scope => scope.node)) {
        for (const el of root.querySelectorAll(
          'a[aria-current="page"], a[aria-current="true"], a[data-active="true"], ' +
          '[data-active="true"] a[href], link[rel="canonical"], meta[property="og:url"]')) {
          const id = resolveId(el.getAttribute("href") || el.getAttribute("content"));
          if (id) ids.push(id);
        }
      }
      for (const node of nodes) {
        for (let el = node; el; el = Chatseek.ownershipParent(el)) {
          const id = el.getAttribute?.("data-conversation-id");
          if (id && /^[A-Za-z0-9_-]{8,128}$/.test(id)) ids.push(normalizeId(id));
        }
      }
      return ids;
    };
    const check = () => {
      if (doc.location?.href !== href || resolveId(href) !== platformId) return false;
      const markers = readMarkers();
      if (markers.some(id => id !== platformId)) return false;
      if (!nodes.length || nodes.some(n => !n.isConnected)) return false;
      if (page.pending && !(href === page.baselineHref && hash === page.hash && nodes.every(n => page.baselineNodes.has(n)))) {
        // Even an updated sidebar/canonical link cannot authorize residual
        // old turns. Mixed old/new DOM also stays held.
        if (nodes.some(n => page.nodes.has(n))) return false;
        // Replaced message nodes prove a DOM transition even for two genuine
        // identical transcripts. The independent five-second hash gates below
        // still hold them briefly; equal wording must not hold them forever.
      }
      return true;
    };
    const accept = () => {
      page.baselineHref = href;
      page.nodes = new WeakSet(nodes);
      page.baselineNodes = new WeakSet(nodes);
      page.hash = hash;
      page.pending = false;
    };
    return { check, accept, hash };
  },

  // Only explicit total/position evidence can authorize absence-based repair.
  // A composer, visible first turn, or scroll height does not prove that a
  // virtualized long chat rendered its ending.
  completeTranscript(doc, extracted, platformId) {
    const nodes = extracted.nodes || [];
    const unstable = '[data-is-streaming="true"], [aria-busy="true"], [data-virtualized="true"]';
    if (!nodes.length || extracted.messages.some(m => m.progress) ||
        nodes.some(n => n.closest?.(unstable)) || doc.querySelector(unstable)) return false;
    const sizes = nodes.map(n => Number(n.getAttribute("aria-setsize")));
    const positions = nodes.map(n => Number(n.getAttribute("aria-posinset")));
    if (sizes.every(n => n === nodes.length) && positions.every((n, index) => n === index + 1)) return true;
    return Chatseek.mappedTranscript(doc, extracted, platformId);
  },

  mappedTranscript(doc, extracted, platformId) {
    if (!extracted.messages?.length) return false;
    // ChatGPT may embed its exported conversation mapping in JSON. Only the
    // selected current_node ancestry counts (branches are not visible turns).
    // Exact text coverage proves both boundaries without guessing scroll size.
    const normalize = body => String(body || "").replace(/\s+/g, " ").trim();
    const visible = extracted.messages.map(m => normalize(m.body));
    let bytes = 0;
    let visited = 0;
    const proof = (data, depth) => {
      if (!data || typeof data !== "object" || depth > 12 || ++visited > 20000) return false;
      if ((data.conversation_id || data.id) === platformId && data.mapping && data.current_node) {
        const chain = [];
        const seen = new Set();
        let id = data.current_node;
        while (id && !seen.has(id) && seen.size < 5000) {
          seen.add(id);
          const row = data.mapping[id];
          if (!row) return false;
          const msg = row.message;
          const role = msg?.author?.role;
          if (role === "assistant" || role === "user") {
            if (msg.content?.content_type !== "text" || !msg.content.parts?.every(p => typeof p === "string")) return false;
            const body = normalize(msg.content.parts.join("\n"));
            if (body) chain.unshift(body);
          }
          id = row.parent;
        }
        if (!id && chain.length === visible.length && chain.every((body, i) => body === visible[i])) return true;
      }
      for (const value of Object.values(data)) if (proof(value, depth + 1)) return true;
      return false;
    };
    for (const script of doc.querySelectorAll('script[type="application/json"]')) {
      const raw = script.textContent || "";
      bytes += raw.length;
      if (bytes > 2000000) break;
      try { if (proof(JSON.parse(raw), 0)) return true; } catch { /* not a proof */ }
    }
    return false;
  },

  async runCapture(state, { platform, sidebar, archivedRows, conversation, messages, health, restoreOnNewMessages, identity, completePage = false }) {
    const captureHref = typeof location !== "undefined" ? location.href : "";
    const stillHere = () => (!captureHref || location.href === captureHref) && (!identity || identity.check());
    const hold = () => { state.spaHeld = (state.spaHeld || 0) + 1; return false; };
    if (!stillHere()) return hold();
    let ok = true;
    const list = sidebar || [];
    // An archive-list row is explicit. A sidebar row does not cancel it.
    const archivedOnly = (archivedRows || []).filter((row) => row && row.id);
    const combined = list.concat(archivedOnly);
    const allMsgs = (messages || []).filter((m) => m && m.id && m.body);
    // A live image-generation status turn is rewritten on every percentage
    // change. Keeping it off disk stops one bubble from becoming a dozen
    // near-identical stored messages. It is written once it settles.
    const progressSkipped = allMsgs.filter((m) => m.progress === true).length;
    const msgs = allMsgs.filter((m) => m.progress !== true);
    // A thread is empty for a moment after SPA navigation while it loads.
    // Report 0 messages only once it stays empty; returning false makes
    // observe() look again in a few seconds even if the DOM goes quiet.
    let settling = false;
    const now = Date.now();
    const bodyHash = Chatseek.transcriptHash(msgs);
    const recent = state.recentTranscripts || (state.recentTranscripts = new Map());
    for (const [hash, row] of recent) if (now - row.at >= 5000) recent.delete(hash);
    const duplicate = recent.get(bodyHash);
    if (msgs.length && duplicate && duplicate.convId !== conversation?.id) {
      state.spaDupe = (state.spaDupe || 0) + 1;
      return false;
    }
    if (health) {
      const zeroKey = health.pathKind === "conversation" && !msgs.length
        ? (conversation?.id || "conversation")
        : "";
      if (!zeroKey) {
        state.zeroKey = "";
      } else if (state.zeroKey !== zeroKey) {
        state.zeroKey = zeroKey;
        state.zeroSince = now;
      }
      settling = !!zeroKey && now - (state.zeroSince || 0) < Chatseek.HEALTH_GRACE_MS;
      // A turn that only paints image-generation progress is not an empty
      // thread; treat it as settling so the 0-message warning stays disarmed.
      if (progressSkipped && !msgs.length) settling = true;
    }
    const selectorHits = health?.selectorHits && typeof health.selectorHits === "object"
      ? health.selectorHits
      : null;
    const anySelectorHit = !!selectorHits && Object.values(selectorHits).some((n) => Number(n) > 0);
    // Shells during the grace period are still painting. A generic title with
    // no message nodes is a new chat, not a broken selector. A conversation
    // that stays empty after the grace period still warns, shells included.
    const newChat = !!(
      health &&
      health.pathKind === "conversation" &&
      !msgs.length &&
      health.untitled &&
      !anySelectorHit
    );
    if (settling && !newChat) {
      ok = false;
      const remain = Chatseek.HEALTH_GRACE_MS - (now - (state.zeroSince || now));
      // Only progress text on screen: the grace window may already be over,
      // but keep polling so the settling write happens on a later rescan.
      const delay = remain > 0 ? remain - 760 : (progressSkipped ? 1200 : 0);
      if (delay > 0 && typeof Chatseek.requestRescan === "function") {
        clearTimeout(Chatseek._graceTimer);
        Chatseek._graceTimer = setTimeout(() => {
          try { Chatseek.requestRescan(); } catch { /* rescan is best-effort */ }
        }, delay);
      }
      Chatseek.publishDiag(Chatseek.diagFields({
        platform,
        pathKind: health.pathKind,
        selector: health.selector,
        selectorHits,
        userCount: health.userCount,
        assistantCount: health.assistantCount,
        charCount: health.charCount,
        structure: health.structure || null,
        archiveBanner: health.archiveBanner,
        archiveList: health.archiveList,
        progressSkipped,
        healthState: progressSkipped && !msgs.length ? "progress" : "settling",
        warn: false,
        at: Date.now(),
      }));
    } else if (health) {
      const report = Chatseek.buildHealthReport({
        platform,
        pathKind: health.pathKind,
        sidebarCount: list.length,
        messageCount: msgs.length,
        selector: health.selector,
        selectorsTried: health.selectorsTried,
        selectorHits,
        userCount: health.userCount,
        assistantCount: health.assistantCount,
        charCount: health.charCount,
        suppressWarn: newChat,
      });
      const diag = Chatseek.publishDiag(Chatseek.diagFields({
        platform,
        pathKind: report.pathKind,
        selector: report.selector,
        selectorHits: report.selectorHits,
        userCount: report.userCount,
        assistantCount: report.assistantCount,
        charCount: report.charCount,
        structure: health.structure || null,
        archiveBanner: health.archiveBanner,
        archiveList: health.archiveList,
        progressSkipped,
        healthState: report.warn ? "warn" : "ok",
        warn: report.warn,
        at: report.at,
      }));
      report.diag = diag;
      Chatseek._lastHealthSend = report;
      const healthFp = [
        report.pathKind,
        report.sidebarCount,
        report.messageCount,
        report.selector,
        report.warn ? "1" : "0",
        report.userCount || 0,
        report.assistantCount || 0,
        health.archiveBanner || 0,
        health.archiveList || 0,
      ].join("|");
      const now = Date.now();
      if (healthFp !== state.lastHealthFp || now - (state.lastHealthAt || 0) >= 60000) {
        const res = await Chatseek.send({
          type: "CAPTURE_HEALTH",
          platform,
          health: report,
        });
        if (!res || !res.ok) ok = false;
        else {
          state.lastHealthFp = healthFp;
          state.lastHealthAt = now;
        }
      }
    }

    const listFp = Chatseek.fingerprint(
      combined.map((c) =>
        c.id + ":" + c.title + ":" + (c.updatedAt || "") + ":" + (c.updatedAtSource || "") +
        ":" + (c.archived === true ? "1" : c.archived === false ? "0" : "")
      ),
    );
    if (listFp && listFp !== state.lastListFp) {
      if (await Chatseek.sendConversations(platform, combined)) {
        state.lastListFp = listFp;
      } else {
        ok = false;
      }
    }

    if (!conversation) return ok;

    const inSidebar = combined.some((c) => c.platformId === conversation.platformId);
    if (!msgs.length) {
      if (!inSidebar || conversation.archived === true) {
        const res = await Chatseek.send({
          type: "CAPTURE_CONVERSATIONS",
          platform,
          conversations: [conversation],
        });
        if (!res || !res.ok) ok = false;
      }
      return ok;
    }

    const canRestore = () => typeof restoreOnNewMessages === "function"
      ? restoreOnNewMessages()
      : !!restoreOnNewMessages;
    const restorePending = async () => {
      if (state.pendingRestoreId !== conversation.id) return true;
      if (!canRestore()) {
        state.pendingRestoreId = "";
        return true;
      }
      const res = await Chatseek.send({
        type: "CAPTURE_CONVERSATIONS",
        platform,
        conversations: [{
          id: conversation.id,
          platform: conversation.platform,
          platformId: conversation.platformId,
          title: conversation.title,
          url: conversation.url,
          archived: false,
          archiveSource: "chatgpt:new-messages",
        }],
      });
      if (!res || !res.ok) return false;
      state.pendingRestoreId = "";
      return true;
    };
    const chunks = Chatseek.chunkMessages(msgs);
    const completeNow = chunks.length === 1 && (typeof completePage === "function" ? completePage() : !!completePage);
    const msgFp = Chatseek.fingerprint([
      completeNow ? "complete" : "partial",
      conversation.id,
      conversation.title,
      conversation.updatedAt || "",
      conversation.archived === true ? "1" : conversation.archived === false ? "0" : "",
      conversation.archiveSource || "",
      ...msgs.map((m) => m.id + ":" + m.body.length + ":" + m.body.slice(-80)),
    ]);
    if (msgFp === state.lastMsgFp && state.lastMsgBodies &&
        (!completeNow || state.lastCaptureComplete === true) && msgs.every((m) => state.lastMsgBodies.get(m.id) === m.body)) {
      if (!stillHere()) return hold();
      identity?.accept();
      Chatseek.noteSyncStored(conversation.id, msgs.length);
      const restored = await restorePending();
      return ok && restored;
    }

    if (!inSidebar) {
      const res = await Chatseek.send({
        type: "CAPTURE_CONVERSATIONS",
        platform,
        conversations: [conversation],
      });
      if (!res || !res.ok) return false;
    }

    const captureId = `${conversation.id}:${msgs.length}:${msgs[msgs.length - 1]?.id || ""}:${Date.now()}`;
    const pageMessageIds = msgs.map((m) => m.id);
    let observed = false;
    let completeSent = false;
    for (const chunk of chunks) {
      if (!stillHere()) return hold();
      completeSent = chunks.length === 1 && (typeof completePage === "function" ? completePage() : !!completePage);
      const res = await Chatseek.send({
        type: "CAPTURE_MESSAGES",
        platform,
        conversation,
        messages: chunk,
        pageMessageIds,
        captureId,
        bodyHash,
        identityVerified: !!identity,
        guardTranscript: identity?.guardTranscript === true,
        ownershipVerified: identity?.ownershipVerified?.() === true,
        completePage: completeSent,
      });
      if (!res || !res.ok) return false;
      if (res.held) { state.spaDupe = (state.spaDupe || 0) + 1; return false; }
      recent.set(bodyHash, { convId: conversation.id, at: Date.now() });
      if (res.observed) observed = true;
    }
    state.lastCaptureComplete = completeSent;
    state.lastMsgFp = msgFp;
    // A stable turn id can also rewrite the beginning at the same length.
    // Keep string references so a matching length/tail fingerprint alone
    // cannot hide that edit; these entries keep the existing string references.
    state.lastMsgBodies = new Map(msgs.map((m) => [m.id, m.body]));
    state.lastMsgConvId = conversation.id;
    identity?.accept();
    Chatseek.noteSyncStored(conversation.id, msgs.length);
    // The sidebar was written before this anchor existed. Rewrite it now so
    // its neighbours are estimated from the new time, even if the order did not move.
    if (observed && inSidebar) {
      if (await Chatseek.sendConversations(platform, combined)) state.lastListFp = listFp;
      else ok = false;
    }
    // A new tail on a page we already checked for a banner is the only
    // capture-side restore. Opening the page, a sync visit, or a sidebar
    // row does not reach this branch.
    if (observed && canRestore()) state.pendingRestoreId = conversation.id;
    // Retain the observed evidence if the restore write fails, but always
    // recheck the page before retrying even when the messages are unchanged.
    if (!await restorePending()) ok = false;
    return ok;
  },

  /**
   * Explicit archive evidence only. Disappearing from a sidebar is not a signal.
   * ChatGPT: a dialog/region titled like "Archived chats" (localized), or a short
   * banner / Unarchive control on the open /c/ page outside the transcript,
   * nav, and menus. The same checks run in same-origin iframes and shadow
   * roots. Claude chats, Grok, and Gemini have no such surface, so they return
   * supported:false and the caller must not change archived.
   *
   * opts.closed false skips chrome.dom closed-shadow probes. Capture checks
   * closed roots too: a light-DOM message does not locate the archive banner.
   */
  readArchiveSignals(doc, _loc, platform, opts) {
    const empty = {
      supported: false,
      archiveRoot: null,
      archiveRoots: [],
      banner: false,
      composer: false,
      bannerHits: 0,
      listHits: 0,
    };
    if (platform !== "chatgpt" || !doc?.querySelectorAll) return empty;
    const scopes = [doc];
    for (const node of Chatseek.archiveScopes(doc, opts)) scopes.push(node);
    const archiveRoots = [];
    let bannerHits = 0;
    let composer = false;
    const seenRoots = new Set();
    for (const scope of scopes) {
      const root = Chatseek._archiveListRoot(scope);
      if (root && !seenRoots.has(root)) {
        seenRoots.add(root);
        archiveRoots.push(root);
      }
      bannerHits += Chatseek._archiveBannerHits(scope, root);
      if (!composer && Chatseek._hasComposer(scope, root)) composer = true;
    }
    const listIds = new Set();
    for (const root of archiveRoots) {
      for (const id of Chatseek._archiveListIds(root)) listIds.add(id);
    }
    bannerHits = Math.max(0, Math.min(40, bannerHits));
    return {
      supported: true,
      archiveRoot: archiveRoots[0] || null,
      archiveRoots,
      banner: bannerHits > 0,
      composer,
      bannerHits,
      listHits: listIds.size,
    };
  },

  /**
   * Same-origin documents the archive scan can read. Open shadow roots and
   * iframes are always included. Closed roots are probed only when opts.closed
   * is not false, and only through chrome.dom (no extra permission).
   */
  archiveScopes(doc, opts) {
    const out = [];
    const seen = new Set([doc]);
    if (!doc) return out;
    const closed = opts?.closed !== false;
    const pending = [doc];
    const add = (node) => {
      if (!node || seen.has(node) || out.length >= 40) return;
      seen.add(node);
      out.push(node);
      pending.push(node);
    };
    while (pending.length) {
      const root = pending.shift();
      // shadowHosts already visits nested shadows; queued shadow scopes only
      // need their iframe scan, rather than probing the same hosts again.
      if (root.nodeType !== 11) {
        for (const entry of Chatseek.shadowHosts(root, { closed })) {
          add(entry?.root);
        }
      }
      let frames = [];
      try { frames = root.querySelectorAll ? [...root.querySelectorAll("iframe")] : []; } catch { frames = []; }
      for (const frame of frames) {
        let child = null;
        try { child = frame.contentDocument; } catch { child = null; }
        add(child);
      }
    }
    return out;
  },

  _normText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  },

  // ChatGPT image-generation progress text. A turn is rewritten with short
  // status strings plus a percentage while the image paints; those must not
  // become one stored message each. Kept in sync with src/image-progress.js
  // (scripts/verify.mjs cross-checks the two phrase lists). Conservative:
  // exact phrase match after a percentage token is stripped, so ordinary
  // prose with "%" survives.
  PROGRESS_PHRASES: [
    // zh_TW
    "正在建立圖像", "正在建立影像", "正在勾勒草圖", "正在生成初稿", "正在打磨細節",
    "正在生成圖片", "正在繪製", "正在生成圖像", "正在修飾細節",
    "正在創建圖像", "正在創建影像", "正在創建圖片", "正在描繪",
    // zh_CN
    "正在创建图像", "正在创建影像", "正在勾勒草图", "正在生成初稿", "正在打磨细节",
    "正在生成图片", "正在绘制", "正在生成图像", "正在修饰细节",
    "正在创建图片", "正在描绘",
    // en
    "creating image", "creating your image", "creating an image",
    "sketching", "adding details", "generating image", "generating an image",
    "refining details", "drawing", "painting", "generating draft",
    "starting image generation", "creating the image",
    // ja
    "画像を作成しています", "画像を生成しています", "スケッチを作成しています",
    "詳細を追加しています", "下書きを生成しています", "画像を描いています",
    "画像を作成中", "画像を生成中", "スケッチ中", "詳細を追加中",
    // ko
    "이미지 생성 중", "이미지를 생성하는 중", "이미지 만들기 중", "이미지를 만드는 중",
    "스케치 중", "스케치하는 중", "세부 사항 추가 중", "세부 정보 추가 중",
    "초안 생성 중", "초안을 생성하는 중", "이미지 그리는 중",
    // es
    "creando imagen", "generando imagen", "dibujando", "agregando detalles",
    "añadiendo detalles", "creando la imagen", "generando la imagen",
    "creando borrador", "perfeccionando detalles",
    // fr
    "création de l'image", "génération de l'image", "esquisse en cours",
    "ajout des détails", "ajout de détails", "création d'image",
    "génération d'image", "affinage des détails", "dessin en cours",
    // de
    "bild wird erstellt", "bild wird generiert", "skizze wird erstellt",
    "details werden hinzugefügt", "bild erstellen", "bild generieren",
    "entwurf wird erstellt", "details werden verfeinert",
    // pt_BR
    "criando imagem", "gerando imagem", "esboçando", "adicionando detalhes",
    "criando a imagem", "gerando a imagem", "criando rascunho",
    "refinando detalhes",
  ],

  progressCore(raw) {
    let text = String(raw ?? "").replace(/[\u3000\u00a0]/g, " ");
    text = text.replace(/\s+/g, " ").trim();
    text = text.replace(/^[\s\-–—_•·*※…‥.。]+/, "");
    text = text.replace(/\d{1,3}\s*[%％]/g, " ");
    text = text.replace(/\s+\d{1,3}\s*$/, "");
    text = text.replace(/[\s\-–—_•·*※…‥.。!！?？~～、,，:：;；]+$/g, "");
    return text.replace(/\s+/g, " ").trim().toLowerCase();
  },

  isProgressText(body) {
    const core = Chatseek.progressCore(body);
    if (!core) return false;
    if (/^(drawing|painting|sketching|dibujando|esboçando)$/.test(core) &&
        !/\d{1,3}\s*[%％]/.test(String(body))) return false;
    if (!Chatseek._progressPhraseSet) {
      Chatseek._progressPhraseSet = new Set(Chatseek.PROGRESS_PHRASES);
    }
    return Chatseek._progressPhraseSet.has(core);
  },

  isProgressNode(node) {
    if (!node || typeof node.querySelector !== "function") return false;
    try {
      if (node.matches?.("[data-is-streaming='true'], [role='progressbar'], progress")) {
        return true;
      }
      return !!node.querySelector(
        "[role='progressbar'], progress," +
        "[data-is-streaming='true'], [data-testid*='progress' i], [data-testid*='streaming' i]"
      );
    } catch {
      return false;
    }
  },

  _hasContentImage(node) {
    if (!node || typeof node.querySelectorAll !== "function") return false;
    try {
      for (const img of node.querySelectorAll("img")) {
        const src = String(img.getAttribute?.("src") || img.currentSrc || "");
        const width = Number(img.getAttribute?.("width") || img.naturalWidth || 0);
        const height = Number(img.getAttribute?.("height") || img.naturalHeight || 0);
        if ((width && width <= 32) || (height && height <= 32)) continue;
        if (src && (!src.startsWith("data:") || (width > 32 && height > 32))) return true;
      }
    } catch {
      return false;
    }
    return false;
  },

  _isShortStatusLine(body) {
    const core = Chatseek.progressCore(body);
    if (!core || core.length > 48) return false;
    const raw = String(body ?? "").replace(/\s+/g, " ").trim();
    return !/[.。!！?？\n\r]/.test(raw) &&
      /^(正在(?:準備|准备|生成|建立|繪製|绘制|創建|创建|思考)|準備中|准备中|thinking|loading|generating|creating|preparing|drawing|painting|sketching)(?:\b|[\u4e00-\u9fff])/i.test(core);
  },

  isProgressMessage(body, node) {
    if (node && Chatseek._hasContentImage(node)) return false;
    if (Chatseek.isProgressText(body)) return true;
    if (node && Chatseek.isProgressNode(node) && Chatseek._isShortStatusLine(body)) return true;
    return false;
  },

  _TRANSCRIPT_SELECTOR:
    "[data-message-author-role], [data-turn], [data-message-id], article, " +
    "[data-turn-id], [data-turn-id-container], [data-message-content], " +
    "[class*='conversation-turn'], .markdown, .prose, " +
    "[data-testid*='conversation-turn'], [data-testid='user-message'], " +
    "[data-testid='human-message'], [data-testid='assistant-message'], [data-testid='ai-message']",

  // closest() alone stops at a shadow boundary or an iframe document.
  _archiveClosest(el, selector) {
    let node = el;
    const seen = new Set();
    while (node && !seen.has(node)) {
      seen.add(node);
      const hit = node.closest?.(selector);
      if (hit) return hit;
      try {
        node = node.getRootNode?.()?.host || node.ownerDocument?.defaultView?.frameElement;
      } catch { node = null; }
    }
    return null;
  },

  _inTranscript(el) {
    if (Chatseek._archiveClosest(el, Chatseek._TRANSCRIPT_SELECTOR)) return true;
    // Density fallback turns can have only a speaker heading and prose.
    let node = el;
    while (node?.nodeType === 1) {
      if (node.matches("div, section")) {
        const heading = [...node.children].find((child) => child.matches("h1, h2, h3, h4, h5, h6"));
        if (heading && /^(you|user|chatgpt|assistant)$/i.test(Chatseek._normText(heading.textContent))) return true;
      }
      node = node.parentElement || node.getRootNode?.()?.host;
    }
    return false;
  },

  /**
   * A /c/ link the user can see in the live chat list: inside the sidebar
   * navigation, not in a dialog, a menu, or a message. Only these rows count
   * as "seen while not archived"; links anywhere else leave the stored state alone.
   */
  inLiveSidebar(el, archiveRoot) {
    if (!el || el.nodeType !== 1) return false;
    if (archiveRoot && archiveRoot.contains(el)) return false;
    if (!el.closest("nav, [role='navigation'], aside, #history")) return false;
    if (el.closest("[role='dialog'], [role='alertdialog'], [aria-modal='true'], [role='menu']")) return false;
    return !Chatseek._inTranscript(el);
  },

  _matchesArchiveHeading(value) {
    const text = Chatseek._normText(value).toLowerCase();
    if (!text || text.length > 80) return false;
    const phrases = [
      "view archived chats",
      "archived chats",
      "archived conversations",
      "archived",
      "已封存的聊天",
      "已封存聊天",
      "已封存",
      "已封存的對話",
      "已封存對話",
      "封存的聊天",
      "已归档的聊天",
      "已归档聊天",
      "已归档",
      "已歸檔的聊天",
      "已歸檔聊天",
      "已歸檔對話",
      "已歸檔",
      "归档的聊天",
      "アーカイブしたチャット",
      "アーカイブ済みチャット",
      "アーカイブ済みのチャット",
      "보관된 채팅",
      "보관된 대화",
      "chats archivados",
      "conversaciones archivadas",
      "chats archivées",
      "conversations archivées",
      "discussions archivées",
      "archivierte chats",
      "archivierte unterhaltungen",
      "conversas arquivadas",
      "chats arquivados",
    ];
    // The heading may carry a count, e.g. "Archived chats (12)", and nothing else.
    return phrases.some((phrase) => {
      if (!text.startsWith(phrase)) return false;
      return /^\s*(?:[(（]\s*\d+\s*[)）]|\d+)?$/.test(text.slice(phrase.length));
    });
  },

  _archiveListRoot(doc) {
    let marked = null;
    try {
      marked = doc.querySelector(
        "[data-testid='archived-chats'], [data-testid='archived-conversations'], [data-testid*='archived-chat' i]",
      );
    } catch {
      marked = null;
    }
    if (marked && !Chatseek._inTranscript(marked) && !marked.querySelector(Chatseek._TRANSCRIPT_SELECTOR)) {
      return marked;
    }
    const regions = doc.querySelectorAll("[role='dialog'], [role='region'], [role='alertdialog'], [aria-modal='true']");
    for (const el of regions) {
      if (Chatseek._inTranscript(el) || el.querySelector(Chatseek._TRANSCRIPT_SELECTOR)) continue;
      if (el.querySelector("nav, [role='navigation']")) continue;
      const label = el.getAttribute("aria-label") || "";
      if (Chatseek._matchesArchiveHeading(label)) return el;
      const headings = el.querySelectorAll("h1, h2, h3, h4, [role='heading']");
      for (const heading of headings) {
        if (!Chatseek._matchesArchiveHeading(heading.textContent || "")) continue;
        const section = heading.closest("section, [role='region'], [role='group']");
        if (
          section &&
          section !== el &&
          el.contains(section) &&
          !Chatseek._inTranscript(section) &&
          !section.querySelector(Chatseek._TRANSCRIPT_SELECTOR) &&
          !section.querySelector("nav, [role='navigation']")
        ) {
          return section;
        }
        return el;
      }
    }
    // A heading that is not the dialog's first title (Settings → Archived chats).
    const headings = doc.querySelectorAll("h1, h2, h3, h4, [role='heading']");
    for (const heading of headings) {
      if (Chatseek._inTranscript(heading) || heading.closest("nav, [role='navigation'], [role='menu']")) continue;
      if (!Chatseek._matchesArchiveHeading(heading.textContent || "")) continue;
      const section = heading.closest("section, [role='dialog'], [role='region'], [role='alertdialog'], [aria-modal='true']");
      if (!section || Chatseek._inTranscript(section) || section.querySelector(Chatseek._TRANSCRIPT_SELECTOR)) continue;
      if (section.querySelector("nav, [role='navigation']")) continue;
      return section;
    }
    return null;
  },

  _archiveListIds(root) {
    const ids = [];
    if (!root?.querySelectorAll) return ids;
    let anchors = [];
    try { anchors = root.querySelectorAll('a[href*="/c/"]'); } catch { anchors = []; }
    const seen = new Set();
    anchors.forEach((a) => {
      const id = Chatseek.conversationIdFromPath(a.getAttribute("href") || a.href);
      if (!id || seen.has(id)) return;
      seen.add(id);
      ids.push(id);
    });
    return ids;
  },

  _inArchiveChrome(el, archiveRoot) {
    if (!el || el.nodeType !== 1) return true;
    if (archiveRoot && archiveRoot.contains(el)) return true;
    if (Chatseek._archiveClosest(el, Chatseek._ARCHIVE_CHROME_SELECTOR + ", [hidden], [aria-hidden='true']")) return true;
    return Chatseek._inTranscript(el);
  },

  _ARCHIVE_CHROME_SELECTOR:
    "nav, aside, #history, [role='navigation'], [role='menu'], [role='menuitem'], " +
    "[role='dialog'], [role='alertdialog'], [aria-modal='true']",

  _ARCHIVE_EDITOR_SELECTOR: "form, textarea, input, [contenteditable='true']",

  /**
   * An archived ChatGPT thread shows the banner where the composer would be.
   * A composer outside dialogs and the transcript is the positive sign that
   * the open chat is not archived; without one the open view says nothing.
   */
  _hasComposer(doc, archiveRoot) {
    let fields = [];
    try {
      fields = doc.querySelectorAll(
        "#prompt-textarea, form textarea, form [contenteditable='true'], " +
        "[data-testid*='composer' i] textarea, [data-testid*='composer' i] [contenteditable='true']",
      );
    } catch {
      fields = [];
    }
    for (const el of fields) {
      if (!Chatseek._inArchiveChrome(el, archiveRoot)) return true;
    }
    return false;
  },

  _archiveBanner(doc, archiveRoot) {
    return Chatseek._archiveBannerHits(doc, archiveRoot) > 0;
  },

  _archiveBannerHits(doc, archiveRoot) {
    const phrases = [
      "this conversation is archived",
      "this chat is archived",
      "this conversation has been archived",
      "this chat has been archived",
      "conversation is archived",
      "chat is archived",
      "此對話已封存",
      "此对话已归档",
      "此對話已歸檔",
      "此聊天已封存",
      "此聊天已归档",
      "此聊天已歸檔",
      "本對話已封存",
      "本对话已归档",
      "對話已封存",
      "对话已归档",
      "對話已歸檔",
      "この会話はアーカイブされています",
      "この会話はアーカイブされました",
      "このチャットはアーカイブされています",
      "このチャットはアーカイブされました",
      "이 대화는 보관되었습니다",
      "이 채팅은 보관되었습니다",
      "esta conversación está archivada",
      "este chat está archivado",
      "cette conversation est archivée",
      "cette discussion est archivée",
      "diese unterhaltung ist archiviert",
      "dieser chat ist archiviert",
      "esta conversa está arquivada",
    ];
    const whole = new Set([
      "archived",
      "已封存",
      "已归档",
      "已歸檔",
      "アーカイブ済み",
      "보관됨",
      "archivada",
      "archivado",
      "archivée",
      "archiviert",
      "arquivada",
      "arquivado",
    ]);
    const unarchive = new Set([
      "unarchive",
      "unarchive chat",
      "unarchive conversation",
      "unarchive this chat",
      "unarchive this conversation",
      "取消封存",
      "解除封存",
      "取消归档",
      "解除归档",
      "取消歸檔",
      "取消封存聊天",
      "取消封存對話",
      "解除封存對話",
      "取消归档对话",
      "アーカイブ解除",
      "アーカイブを解除",
      "보관 해제",
      "보관 취소",
      "desarchivar",
      "desarchivar chat",
      "désarchiver",
      "archivierung aufheben",
      "desarquivar",
    ]);
    let nodes = [];
    try {
      // Selectors from 1.4.0, plus plain blocks so a banner without
      // role/testid still counts. The text has to match; we never click.
      nodes = [...doc.querySelectorAll(
        "[role='status'], [role='note'], [role='alert'], [role='button'], [data-testid*='archive' i], [data-testid*='banner' i], button, a, p, h1, h2, h3, h4, span, div, section",
      )];
    } catch {
      nodes = [];
    }
    const matched = [];
    for (const el of nodes) {
      if (matched.length >= 40) break;
      if (Chatseek._inArchiveChrome(el, archiveRoot)) continue;
      if (Chatseek._archiveClosest(el, Chatseek._ARCHIVE_EDITOR_SELECTOR)) continue;
      // Do not match a page wrapper using text aggregated from messages,
      // sidebar titles, editors or dialogs. Sibling banner blocks still match.
      if (el.querySelector(Chatseek._TRANSCRIPT_SELECTOR + ", " + Chatseek._ARCHIVE_CHROME_SELECTOR + ", " + Chatseek._ARCHIVE_EDITOR_SELECTOR)) continue;
      // Decorative aria-hidden SVG icons have no text and must not suppress
      // an otherwise valid banner or Unarchive control.
      if ([...el.querySelectorAll("[hidden], [aria-hidden='true']")].some((node) => Chatseek._normText(node.textContent))) continue;
      const raw = Chatseek._normText(el.innerText || el.textContent || "");
      if (!raw || raw.length > 320) continue;
      const lower = raw.toLowerCase();
      const wholeKey = lower.replace(/[.。!！]+$/g, "");
      const phraseHit = phrases.some((phrase) => wholeKey === phrase ||
        (lower.startsWith(phrase) && /^[.。!！]/.test(lower.slice(phrase.length)))) || whole.has(wholeKey);
      const tag = (el.tagName || "").toUpperCase();
      const role = (el.getAttribute("role") || "").toLowerCase();
      const buttonHit = (tag === "BUTTON" || tag === "A" || role === "button") && unarchive.has(lower);
      if (phraseHit || buttonHit) matched.push(el);
    }
    return matched.filter((el) => !matched.some((other) => other !== el && el.contains(other))).length;
  },

  /**
   * Attach the best available page date onto a conversation object (mutates).
   * Precise row/JSON times beat coarse section buckets ("Previous 7 Days").
   */
  attachPageTime(conv, linkEl, jsonTimes, sectionMap) {
    if (!conv) return conv;
    const apply = (ms, source) => {
      if (!ms || !Chatseek.isValidMs(ms)) return false;
      const stamped = ms > Date.now() ? Date.now() : ms;
      conv.updatedAt = stamped;
      conv.updatedAtSource = source;
      if (!conv.createdAt) conv.createdAt = stamped;
      return true;
    };
    const near = linkEl ? Chatseek.findTimeNear(linkEl) : null;
    if (near?.source === "page-exact" && apply(near.ms, "page-exact")) return conv;
    if (jsonTimes && conv.platformId) {
      const ms = jsonTimes.get(String(conv.platformId).toLowerCase()) || null;
      if (ms && apply(ms, "page-exact")) return conv;
    }
    if (near?.source === "page-bucket" && apply(near.ms, "page-bucket")) return conv;
    const section = (sectionMap && linkEl && sectionMap.get(linkEl)) ||
      (linkEl ? Chatseek.findSectionTime(linkEl) : null);
    if (section && apply(section, "page-bucket")) return conv;
    return conv;
  },

  /** Copy a sidebar row's ranked time, else JSON on the open thread. */
  applyStoredTime(conv, fromSidebar, jsonTimes) {
    if (!conv) return conv;
    if (fromSidebar?.updatedAt && fromSidebar.updatedAtSource) {
      conv.updatedAt = fromSidebar.updatedAt;
      conv.updatedAtSource = fromSidebar.updatedAtSource;
      conv.createdAt = fromSidebar.createdAt || fromSidebar.updatedAt;
      return conv;
    }
    return Chatseek.attachPageTime(conv, null, jsonTimes);
  },

  /**
   * conversation = open thread. temporary-chat is not a thread we index.
   * home = pathname / . other = anything else. Adapters pass hasThread.
   */
  pageKind(loc, hasThread) {
    const search = String(loc?.search || "");
    if (/[?&]temporary-chat=true(?:&|$)/.test(search)) return "temporary";
    if (hasThread) return "conversation";
    const path = String(loc?.pathname || "/");
    if (path === "/" || path === "") return "home";
    return "other";
  },

  /**
   * First matching layer wins. Open shadow roots are checked only when the
   * light DOM misses every layer, so the common path stays a few querySelectors.
   * A new adapter passes its own layer list; it does not need a private walker.
   */
  queryLayers(doc, layers) {
    const tried = [];
    const light = Chatseek._matchLayers(doc, layers, tried);
    if (light) return { name: light.name, nodes: light.nodes, tried, shadow: false };
    for (const root of Chatseek.openShadowRoots(doc)) {
      const hit = Chatseek._matchLayers(root, layers, null);
      if (hit) return { name: hit.name, nodes: hit.nodes, tried, shadow: true };
    }
    return { name: null, nodes: [], tried, shadow: false };
  },

  _matchLayers(root, layers, tried) {
    if (!root?.querySelectorAll) return null;
    for (const layer of layers || []) {
      if (tried) tried.push(layer.name);
      let nodes = [];
      try {
        nodes = [...root.querySelectorAll(layer.selector)];
      } catch {
        nodes = [];
      }
      if (nodes.length) return { name: layer.name, nodes };
    }
    return null;
  },

  openShadowRoots(doc) {
    const roots = [];
    for (const entry of Chatseek.shadowHosts(doc)) {
      if (entry?.root && entry.mode === "open") roots.push(entry.root);
    }
    return roots;
  },

  /**
   * Skip the history nav and the composer. A form that also wraps the
   * transcript is the thread, not chrome — dropping it used to store titles only.
   */
  isMessageChrome(node) {
    if (!node || node.nodeType !== 1) return true;
    if (node.closest("nav, [role='navigation']")) return true;
    if (node.closest("textarea, input, select")) return true;
    const form = node.closest("form");
    if (!form) return false;
    const hasField = form.querySelector("textarea, input, [contenteditable='true']");
    if (!hasField) return false;
    const hasTurn = form.querySelector(
      "[data-message-author-role], [data-turn], [data-message-id], [data-testid*='conversation-turn']",
    );
    return !hasTurn;
  },

  /** data-message-author-role, then data-turn. Empty string if neither is set. */
  messageRole(node) {
    if (!node || node.nodeType !== 1) return "";
    const author = (
      node.getAttribute("data-message-author-role") ||
      node.querySelector("[data-message-author-role]")?.getAttribute("data-message-author-role") ||
      ""
    ).toLowerCase();
    if (author === "assistant" || author === "user" || author === "system" || author === "tool") {
      return author;
    }
    const turn = (
      node.getAttribute("data-turn") ||
      node.closest("[data-turn]")?.getAttribute("data-turn") ||
      ""
    ).toLowerCase();
    if (turn === "assistant" || turn === "ai" || turn === "model") return "assistant";
    if (turn === "user" || turn === "human") return "user";
    if (turn === "system" || turn === "tool") return turn;
    return "";
  },

  /**
   * Pinned rows stay out of sidebar-rank interpolation. Without a Pinned /
   * 置頂 heading, every link stays in DOM order (top = most recent).
   */
  partitionSidebar(links) {
    const pinned = new Set();
    const ordered = [];
    if (!links?.length) return { ordered, pinned };
    const root = Chatseek.historyRoot(links);
    if (!root || typeof document === "undefined" || typeof document.createTreeWalker !== "function") {
      return { ordered: [...links], pinned };
    }
    const wanted = new Set(links);
    let inPinned = false;
    const pinnedRe = /^(pinned|starred|置顶|置頂|已置顶|已置頂|已固定)$/i;
    const recentRe = /^(recents?|chats?|history|最近|对话|對話|聊天)$/i;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      const tag = node.tagName || "";
      if (!/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|INPUT)$/.test(tag) &&
          !Chatseek._insideConvAnchor(node, root)) {
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        const leaf = node.childElementCount === 0 || /^(H1|H2|H3|H4)$/.test(tag);
        if (leaf && text && text.length <= 24) {
          if (pinnedRe.test(text)) inPinned = true;
          else if (recentRe.test(text) || Chatseek.headingTime(text)) inPinned = false;
        }
      }
      if (wanted.has(node)) {
        if (inPinned) pinned.add(node);
        else ordered.push(node);
      }
      node = walker.nextNode();
    }
    for (const link of links) {
      if (!pinned.has(link) && !ordered.includes(link)) ordered.push(link);
    }
    return { ordered, pinned };
  },

  /** DOM order with sidebarIndex. Pinned rows have a null index so they are not interpolated. */
  sidebarSlots(anchors) {
    const { ordered, pinned } = Chatseek.partitionSidebar(anchors);
    return [
      ...ordered.map((el, sidebarIndex) => ({ el, sidebarIndex })),
      ...[...pinned].map((el) => ({ el, sidebarIndex: null })),
    ];
  },

  /**
   * Counts only — never message text. Warns once per selector set when a
   * conversation page produced zero messages.
   */
  buildHealthReport({
    platform,
    pathKind,
    sidebarCount,
    messageCount,
    selector,
    selectorsTried,
    selectorHits,
    userCount,
    assistantCount,
    charCount,
    suppressWarn,
  }) {
    const tried = selectorsTried || [];
    const hits = Chatseek.compactHits(selectorHits);
    // 0 messages on a conversation page is the warning. runCapture waits out
    // the loading grace before calling this, and a new chat passes suppressWarn.
    const warn = !suppressWarn && pathKind === "conversation" && !messageCount;
    const where = platform === "chatgpt" ? "/c/ page" : "conversation page";
    if (warn) {
      const key = `${platform}:${where}:${tried.join(",")}`;
      if (Chatseek._healthWarned !== key) {
        Chatseek._healthWarned = key;
        const line = `[Chatseek] ${platform}: 0 messages on ${where}, selectors tried: ${tried.join(", ")}`;
        try { console.warn(line); } catch { /* console may be missing in tests */ }
      }
    } else if (messageCount > 0) {
      Chatseek._healthWarned = "";
    }
    return {
      at: Date.now(),
      pathKind: pathKind || "other",
      sidebarCount: sidebarCount || 0,
      messageCount: messageCount || 0,
      selector: selector || "none",
      selectorsTried: tried,
      selectorHits: hits,
      userCount: Number(userCount) || 0,
      assistantCount: Number(assistantCount) || 0,
      charCount: Number(charCount) || 0,
      warn,
    };
  },
};

const DOM_SKIP_TAG = {
  BUTTON: 1, SVG: 1, NAV: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1,
  SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, IFRAME: 1,
  "MODEL-THOUGHTS": 1, "MAT-ICON": 1, "COPY-BUTTON": 1, "SHARE-BUTTON": 1,
};

function domClassBlob(node) {
  if (!node || node.nodeType !== 1) return "";
  if (typeof node.className === "string") return node.className;
  return node.getAttribute?.("class") || "";
}

function domSkip(node) {
  if (!node || node.nodeType !== 1) return false;
  const tag = node.tagName || "";
  if (DOM_SKIP_TAG[tag]) return true;
  const role = (node.getAttribute?.("role") || "").toLowerCase();
  if (role === "button" || role === "navigation") return true;
  if (node.getAttribute?.("aria-hidden") === "true") return true;
  const blob = `${domClassBlob(node)} ${node.getAttribute?.("data-testid") || ""}`;
  if (/visually-hidden|sr-only|cdk-visually-hidden|thoughts-container|thoughts-content|model-thoughts|ql-editor/i.test(blob)) {
    return true;
  }
  return false;
}

function speakerLabel(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return /^(chatgpt|you|user|assistant|claude|grok|gemini|gpt-4o|gpt-4|gpt-5|o1|o3|4o)$/i.test(t);
}

function codeLanguage(node) {
  const blob = [
    domClassBlob(node),
    domClassBlob(node?.parentElement),
    node?.getAttribute?.("data-language") || "",
    node?.parentElement?.getAttribute?.("data-language") || "",
  ].join(" ");
  const named = blob.match(/language-([A-Za-z0-9_+#-]{1,24})/i);
  if (named) return named[1].toLowerCase();
  const data = String(node?.getAttribute?.("data-language") || node?.parentElement?.getAttribute?.("data-language") || "").trim();
  if (/^[A-Za-z0-9_+#-]{1,24}$/.test(data)) return data.toLowerCase();
  return "";
}

function domState() {
  return { out: "", lineStart: true, quote: 0, offsets: new Map() };
}

function writeRaw(state, text) {
  if (!text) return;
  const prefix = state.quote ? "> ".repeat(state.quote) : "";
  const parts = String(text).split("\n");
  for (let i = 0; i < parts.length; i += 1) {
    if (i > 0) {
      state.out += "\n";
      state.lineStart = true;
    }
    const piece = parts[i];
    if (!piece) continue;
    if (state.lineStart && prefix) state.out += prefix;
    state.out += piece;
    state.lineStart = false;
  }
}

function ensureBreak(state, n) {
  if (!state.out) {
    state.lineStart = true;
    return;
  }
  let have = 0;
  for (let i = state.out.length - 1; i >= 0 && state.out[i] === "\n"; i -= 1) have += 1;
  const need = Math.min(n, 2) - have;
  if (need > 0) {
    state.out += "\n".repeat(need);
    state.lineStart = true;
  }
}

function pushInline(state, text, pre) {
  if (text == null || text === "") return;
  const value = String(text).replace(/\r\n?/g, "\n");
  if (pre) {
    writeRaw(state, value);
    return;
  }
  const collapsed = value.replace(/\s+/g, " ");
  if (!collapsed.trim()) {
    if (collapsed && state.out && !/[\n ]$/.test(state.out)) writeRaw(state, " ");
    return;
  }
  const piece = !state.out || /[\n ]$/.test(state.out) ? collapsed.replace(/^ /, "") : collapsed;
  if (piece) writeRaw(state, piece);
}

function closedShadowRoot(node) {
  if (!node || node.nodeType !== 1 || node.shadowRoot || node.tagName === "IFRAME") return null;
  try {
    const dom = typeof chrome !== "undefined" ? chrome.dom : null;
    return dom?.openOrClosedShadowRoot?.(node) || null;
  } catch {
    return null;
  }
}

// Record where a picture sits without copying its address or its chrome text.
function stampImageNodes(root, state) {
  if (!root || !state) return;
  const at = state.out.length;
  let images = [];
  try {
    if (root.tagName === "IMG") images = [root];
    else if (root.querySelectorAll) images = [...root.querySelectorAll("img")].slice(0, 24);
  } catch {
    images = [];
  }
  for (const img of images) {
    if (img && !state.offsets.has(img)) state.offsets.set(img, at);
  }
}

function stampSkippedImages(node, state) {
  if (!node || node.nodeType !== 1) return;
  const tag = node.tagName || "";
  const role = (node.getAttribute?.("role") || "").toLowerCase();
  if (tag === "IFRAME") {
    let doc = null;
    try { doc = node.contentDocument; } catch { doc = null; }
    const base = doc?.body || doc?.documentElement;
    if (base) stampImageNodes(base, state);
    return;
  }
  if (tag === "BUTTON" || role === "button") stampImageNodes(node, state);
}

function walkChildren(node, state, ctx) {
  const shadow = node?.shadowRoot;
  if (shadow && shadow.childNodes && shadow.childNodes.length) {
    for (const child of shadow.childNodes) walkNode(child, state, ctx);
    return;
  }
  const kids = node?.childNodes;
  if (kids) {
    for (const child of kids) walkNode(child, state, ctx);
  }
  const closed = closedShadowRoot(node);
  if (closed) stampImageNodes(closed, state);
}

function isSaidLine(node) {
  if (!node || node.nodeType !== 1) return false;
  if (node.querySelector?.("p, pre, ul, ol, table, blockquote")) return false;
  const text = (node.textContent || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 48) return false;
  if (speakerLabel(text)) return true;
  return /^(?:(?:chat\s*gpt|chatgpt|you|claude|gemini|grok|gpt-4o|gpt-5|o1|o3)\s+said|you\s+said)\s*:?$/i.test(text);
}

function nearPre(node) {
  let sib = node?.nextElementSibling;
  for (let i = 0; sib && i < 3; i += 1) {
    if (sib.tagName === "PRE" || sib.querySelector?.("pre")) return sib.tagName === "PRE" ? sib : sib.querySelector("pre");
    sib = sib.nextElementSibling;
  }
  return null;
}

function isCodeHeader(node) {
  if (!node || node.nodeType !== 1 || node.tagName === "PRE") return false;
  if (node.querySelector?.("pre, table, ul, ol, p, blockquote")) return false;
  const pre = nearPre(node);
  if (!pre) return false;
  const raw = node.textContent || "";
  if (raw.length > 80) return false;
  const clone = node.cloneNode(true);
  clone.querySelectorAll("button, svg, [role='button']").forEach((el) => el.remove());
  const text = (clone.textContent || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 32) return false;
  if (/^(?:copy|copy code|copied|复制代码|複製程式碼|コピー|コードをコピー)$/i.test(text)) return true;
  const lang = codeLanguage(pre.querySelector?.("code") || pre);
  if (lang && text.toLowerCase() === lang) return true;
  return /code-header|language-label|hljs-meta/i.test(domClassBlob(node));
}

function isArtifactChrome(node) {
  if (!node || node.nodeType !== 1) return false;
  if (node.tagName === "PRE" || node.tagName === "CODE") return false;
  const blob = `${domClassBlob(node)} ${node.getAttribute?.("data-testid") || ""}`;
  const parent = node.parentElement;
  const parentBlob = parent
    ? `${domClassBlob(parent)} ${parent.getAttribute?.("data-testid") || ""}`
    : "";
  if (!/artifact/i.test(`${blob} ${parentBlob}`)) return false;
  if (node.querySelector?.("pre, p, ul, ol, table, blockquote, h1, h2, h3")) return false;
  const text = (node.textContent || "").replace(/\s+/g, " ").trim();
  return text.length <= 80;
}

function isCitationCaption(node) {
  if (!node || node.nodeType !== 1) return false;
  const link = node.closest?.("a[href]");
  if (!link || link === node) return false;
  const href = link.getAttribute("href") || "";
  if (!/^https?:\/\//i.test(href)) return false;
  if (node.querySelector?.("a, p, pre, ul, ol")) return false;
  const text = (node.textContent || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 60) return false;
  let host = "";
  try { host = new URL(href).hostname.replace(/^www\./, "").toLowerCase(); } catch { return false; }
  const norm = text.toLowerCase().replace(/^www\./, "");
  if (norm === host || (norm.includes(".") && (host.endsWith(`.${norm}`) || norm.endsWith(`.${host}`)))) return true;
  const blob = domClassBlob(node);
  return /text-xs|caption|subtitle|citation|source-domain/i.test(blob) && norm === host;
}

function writeKatex(node, state) {
  if (!/\bkatex\b/.test(domClassBlob(node))) return false;
  if (/\bkatex-(?:html|mathml)\b/.test(domClassBlob(node))) return false;
  let tex = "";
  try { tex = node.querySelector("annotation")?.textContent || ""; } catch { tex = ""; }
  tex = String(tex).replace(/\s+/g, " ").trim();
  if (!tex) return false;
  const display = /\bkatex-display\b/.test(domClassBlob(node)) || !!node.closest?.(".katex-display");
  ensureBreak(state, display ? 2 : 1);
  writeRaw(state, display ? `$$\n${tex}\n$$` : `$${tex}$`);
  if (display) ensureBreak(state, 2);
  return true;
}

function fenceFor(text) {
  let n = 2;
  const re = /`+/g;
  let match;
  while ((match = re.exec(text))) if (match[0].length > n) n = match[0].length;
  return "`".repeat(n + 1);
}

function codePlain(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll(
    "[class*='line-number'], [class*='linenumber'], [class*='LineNumber'], [data-line-number], .hljs-ln-numbers",
  ).forEach((el) => el.remove());
  return String(clone.textContent || "").replace(/\r\n?/g, "\n").replace(/\n$/, "");
}

function renderList(node, ordered, depth, state, ctx) {
  if (depth > 8) return;
  if (depth === 0) ensureBreak(state, 2);
  let n = 1;
  for (const child of node.children || []) {
    if (!child || child.tagName !== "LI") continue;
    const indent = ctx.plain ? "" : "  ".repeat(depth);
    const marker = ctx.plain ? "" : (ordered ? `${n}. ` : "- ");
    n += 1;
    ensureBreak(state, 1);
    writeRaw(state, indent + marker);
    for (const kid of child.childNodes) {
      if (kid.nodeType === 1 && (kid.tagName === "UL" || kid.tagName === "OL")) {
        writeRaw(state, "\n");
        renderList(kid, kid.tagName === "OL", depth + 1, state, ctx);
      } else {
        walkNode(kid, state, ctx);
      }
    }
  }
  if (depth === 0) ensureBreak(state, 2);
}

function cellPlain(cell, ctx) {
  const state = domState();
  walkChildren(cell, state, { plain: true, pre: false, plainPre: false });
  return state.out.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

function renderTable(node, state, ctx) {
  const rows = [];
  const scan = (parent) => {
    for (const child of parent.children || []) {
      if (child.tagName === "TR") rows.push(child);
      else if (child.tagName === "THEAD" || child.tagName === "TBODY" || child.tagName === "TFOOT") scan(child);
    }
  };
  scan(node);
  if (!rows.length) return;
  const matrix = rows.map((tr) => [...tr.children]
    .filter((cell) => cell.tagName === "TH" || cell.tagName === "TD")
    .map((cell) => cellPlain(cell, ctx)));
  const width = matrix.reduce((max, row) => Math.max(max, row.length), 0);
  if (!width) return;
  const pad = (row) => {
    const next = row.slice();
    while (next.length < width) next.push("");
    return next;
  };
  ensureBreak(state, 2);
  if (ctx.plain) {
    for (const row of matrix) writeRaw(state, `${pad(row).join(" ")}\n`);
    return;
  }
  const header = pad(matrix[0]);
  writeRaw(state, `| ${header.join(" | ")} |\n`);
  writeRaw(state, `| ${header.map(() => "---").join(" | ")} |\n`);
  for (const row of matrix.slice(1)) writeRaw(state, `| ${pad(row).join(" | ")} |\n`);
}

function walkNode(node, state, ctx) {
  if (!node) return;
  if (node.nodeType === 3) {
    pushInline(state, node.nodeValue, ctx.pre || ctx.plainPre);
    return;
  }
  if (node.nodeType !== 1 || domSkip(node)) {
    stampSkippedImages(node, state);
    return;
  }
  if (isSaidLine(node) || isCodeHeader(node) || isArtifactChrome(node) || isCitationCaption(node)) return;
  if (!ctx.plain && writeKatex(node, state)) return;
  const tag = node.tagName;
  if (tag === "SLOT") {
    const assigned = typeof node.assignedNodes === "function" ? node.assignedNodes({ flatten: true }) : [];
    if (assigned.length) {
      for (const child of assigned) walkNode(child, state, ctx);
    } else {
      walkChildren(node, state, ctx);
    }
    return;
  }
  if (tag === "BR") {
    writeRaw(state, "\n");
    return;
  }
  if (tag === "IMG") {
    state.offsets.set(node, state.out.length);
    return;
  }
  if (tag === "HR") {
    ensureBreak(state, 2);
    if (!ctx.plain) writeRaw(state, "---");
    ensureBreak(state, 2);
    return;
  }
  if (/^H[1-6]$/.test(tag)) {
    if (speakerLabel(node.textContent || "")) return;
    ensureBreak(state, 2);
    if (!ctx.plain) writeRaw(state, `${"#".repeat(Number(tag[1]))} `);
    walkChildren(node, state, ctx);
    ensureBreak(state, 2);
    return;
  }
  if (tag === "PRE") {
    const code = [...(node.children || [])].find((el) => el.tagName === "CODE") || node;
    const lang = ctx.plain ? "" : codeLanguage(code);
    const text = codePlain(code);
    const saved = state.quote;
    state.quote = 0;
    ensureBreak(state, 2);
    if (ctx.plain) writeRaw(state, text);
    else {
      const fence = fenceFor(text);
      writeRaw(state, `${fence}${lang}\n${text}\n${fence}`);
    }
    ensureBreak(state, 2);
    state.quote = saved;
    return;
  }
  if (tag === "BLOCKQUOTE") {
    ensureBreak(state, 2);
    if (!ctx.plain) state.quote += 1;
    walkChildren(node, state, ctx);
    if (!ctx.plain) state.quote = Math.max(0, state.quote - 1);
    ensureBreak(state, 2);
    return;
  }
  if (tag === "UL" || tag === "OL") {
    renderList(node, tag === "OL", 0, state, ctx);
    return;
  }
  if (tag === "TABLE") {
    renderTable(node, state, ctx);
    return;
  }
  if (tag === "CODE") {
    const text = node.textContent || "";
    if (ctx.plain) pushInline(state, text, false);
    else writeRaw(state, `\`${String(text).replace(/`/g, "'")}\``);
    return;
  }
  if (!ctx.plain && (tag === "STRONG" || tag === "B")) {
    writeRaw(state, "**");
    walkChildren(node, state, ctx);
    writeRaw(state, "**");
    return;
  }
  if (!ctx.plain && (tag === "EM" || tag === "I")) {
    if (/icon/i.test(domClassBlob(node))) return;
    writeRaw(state, "*");
    walkChildren(node, state, ctx);
    writeRaw(state, "*");
    return;
  }
  if (tag === "A") {
    const href = node.getAttribute("href") || "";
    const safe = /^https?:\/\//i.test(href) ? href.replace(/[\s)]/g, "") : "";
    const linked = { ...ctx, inLink: true };
    if (ctx.plain || !safe) {
      walkChildren(node, state, linked);
      return;
    }
    writeRaw(state, "[");
    walkChildren(node, state, linked);
    writeRaw(state, `](${safe})`);
    return;
  }
  const block = !ctx.inLink && (/^(P|DIV|SECTION|ARTICLE|LI|HEADER|FIGURE|FIGCAPTION)$/.test(tag) || tag === "M" + "AIN");
  if (block) ensureBreak(state, 2);
  const next = ctx.plain && /whitespace-pre-wrap|pre-wrap/i.test(domClassBlob(node))
    ? { ...ctx, plainPre: true }
    : ctx;
  walkChildren(node, state, next);
  if (block) ensureBreak(state, 1);
}

function finishDom(state) {
  const raw = state.out;
  let lead = 0;
  while (lead < raw.length && (raw[lead] === "\n" || raw[lead] === " ")) lead += 1;
  let end = raw.length;
  while (end > lead && (raw[end - 1] === "\n" || raw[end - 1] === " ")) end -= 1;
  const text = raw.slice(lead, end);
  const offsets = new Map();
  for (const [img, pos] of state.offsets) {
    let at = pos - lead;
    if (at < 0) at = 0;
    if (at > text.length) at = text.length;
    offsets.set(img, at);
  }
  return { text, offsets };
}

function scrubDiag(value, max) {
  return String(value ?? "")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig, "[id]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, max);
}

Chatseek.imageDiagCounts = () => ({
  detected: 0,
  cached: 0,
  placeholder: 0,
  fail: { tainted: 0, tooBig: 0, timeout: 0, notLoaded: 0 },
});
Chatseek._lastError = null;
Chatseek._scriptedFrames = new WeakMap();
Chatseek._diagFields = null;
Chatseek._diagPlatform = "";
Chatseek._lastDiag = "";
Chatseek._diagTimer = 0;
Chatseek._diagLast = "";
Chatseek._diagPending = "";
Chatseek._diagArmed = false;
Chatseek._lastHealthSend = null;

Chatseek.extVersion = () => {
  try {
    return String(chrome.runtime?.getManifest?.().version || "").slice(0, 16);
  } catch {
    return "";
  }
};

Chatseek.compactHits = (hits) => {
  const out = {};
  if (!hits || typeof hits !== "object") return out;
  for (const [name, count] of Object.entries(hits)) {
    const key = String(name || "").replace(/\s+/g, " ").slice(0, 48);
    if (!key) continue;
    out[key] = Math.max(0, Math.floor(Number(count) || 0));
  }
  return out;
};

Chatseek.countSelectors = (root, layers) => {
  const counts = {};
  if (!root?.querySelectorAll) return counts;
  for (const layer of layers || []) {
    let n = 0;
    try {
      n = root.querySelectorAll(layer.selector).length;
    } catch {
      n = 0;
    }
    counts[layer.name] = n;
  }
  return counts;
};

Chatseek.messageStats = (messages) => {
  let userCount = 0;
  let assistantCount = 0;
  let charCount = 0;
  for (const msg of messages || []) {
    // A live image-generation progress turn is not a stored message.
    if (msg?.progress === true) continue;
    // Unknown heuristic turns are stored as assistant. Count them the same way.
    if (msg?.role === "assistant" || msg?.role === "unknown") assistantCount += 1;
    else userCount += 1;
    charCount += String(msg?.body || "").length;
  }
  return { userCount, assistantCount, charCount };
};

// Hidden tabs pause. After eight looks the observers are enough; do not poll forever.
Chatseek.emptyRescanDelay = (attempt, hidden) => {
  if (hidden) return 0;
  const n = Math.floor(Number(attempt) || 0);
  if (n < 0 || n >= 8) return 0;
  return Math.min(2000 * (2 ** n), 30000);
};

Chatseek.isSpeakerChrome = (body) => {
  const t = String(body || "").replace(/[#>*_`~[\]()]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (speakerLabel(t)) return true;
  return /^(?:(?:chatgpt|you|claude|gemini|grok)\s+said|you\s+said)\s*:?$/i.test(t);
};

Chatseek._paceAt = 0;
Chatseek.paceDom = async () => {
  const now = Date.now();
  if (!Chatseek._paceAt) Chatseek._paceAt = now;
  if (now - Chatseek._paceAt < 12) return;
  Chatseek._paceAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

Chatseek.isSubstantive = (body) => {
  if (!body || Chatseek.isUiNoise(body)) return false;
  return !Chatseek.isSpeakerChrome(body);
};

function oneWord(value) {
  const name = scrubDiag(value, 40);
  if (!name || name === "-" || /\s/.test(name) || name.length > 32) return "-";
  return name;
}

function scrubFrame(frame) {
  const cleaned = scrubDiag(frame, 180);
  const match = cleaned.match(/at\s+\S+(?:\s+\([^)]*\))?/);
  return match ? match[0].slice(0, 140) : "";
}

Chatseek.rememberError = (err) => {
  const stack = String(err?.stack || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const frame = stack.find((line) => line.startsWith("at ")) || "";
  let name = scrubDiag(err?.name || "Error", 40) || "Error";
  if (/\s/.test(name) || name.length > 32) name = "Error";
  Chatseek._lastError = {
    name,
    stack: scrubFrame(frame),
  };
};

function imageFailOf(images) {
  const fail = images?.fail || {};
  return {
    tainted: Number(fail.tainted) || 0,
    tooBig: Number(fail.tooBig) || 0,
    timeout: Number(fail.timeout) || 0,
    notLoaded: Number(fail.notLoaded) || 0,
  };
}

function imageCountsOf(images) {
  const cached = Number(images?.cached) || 0;
  const placeholder = Number(images?.placeholder) || 0;
  const detected = images?.detected == null ? cached + placeholder : (Number(images.detected) || 0);
  return { detected, cached, placeholder, fail: imageFailOf(images) };
}

Chatseek.diagFields = (fields) => {
  const images = imageCountsOf(Chatseek.imageDiagCounts());
  const err = Chatseek._lastError || {};
  const src = fields || {};
  return {
    version: Chatseek.extVersion(),
    platform: src.platform || Chatseek._diagPlatform || "",
    pathKind: src.pathKind || "other",
    selector: src.selector || "none",
    selectorHits: src.selectorHits || null,
    userCount: Number(src.userCount) || 0,
    assistantCount: Number(src.assistantCount) || 0,
    charCount: Number(src.charCount) || 0,
    imagesDetected: images.detected,
    imagesCached: images.cached,
    imagesPlaceholder: images.placeholder,
    imageFail: images.fail,
    healthState: src.healthState || (src.warn ? "warn" : "ok"),
    errorName: err.name || "",
    errorStack: err.stack || "",
    structure: src.structure || null,
    archiveBanner: Math.max(0, Math.min(40, Math.floor(Number(src.archiveBanner) || 0))),
    archiveList: Math.max(0, Math.min(500, Math.floor(Number(src.archiveList) || 0))),
    progressSkipped: Math.max(0, Math.min(9999, Math.floor(Number(src.progressSkipped) || 0))),
    at: Number(src.at) || Date.now(),
  };
};

function imageCountLine(src) {
  const saved = Number(src?.imagesCached) || 0;
  const hold = Number(src?.imagesPlaceholder) || 0;
  const detected = src?.imagesDetected == null ? saved + hold : (Number(src.imagesDetected) || 0);
  const fail = src?.imageFail || {};
  const tainted = Number(fail.tainted) || 0;
  const tooBig = Number(fail.tooBig) || 0;
  const timeout = Number(fail.timeout) || 0;
  const notLoaded = Number(fail.notLoaded) || 0;
  return `imgs=${detected}/${saved}/${hold} fail=tainted:${tainted},too-big:${tooBig},timeout:${timeout},not-loaded:${notLoaded}`;
}

Chatseek.formatDiag = (fields) => {
  const src = fields || {};
  const hits = Chatseek.compactHits(src.selectorHits);
  const hitText = Object.keys(hits).map((name) => `${name}:${hits[name]}`).join(",") || "none";
  const at = Number(src.at) || Date.now();
  let iso = String(at);
  try { iso = new Date(at).toISOString(); } catch { /* keep the number */ }
  const parts = [
    "[Chatseek] diag",
    `v=${scrubDiag(src.version, 16) || "?"}`,
    `platform=${scrubDiag(src.platform, 16) || "?"}`,
    `path=${scrubDiag(src.pathKind, 24) || "?"}`,
    `hits=${scrubDiag(hitText, 360)}`,
    `used=${scrubDiag(src.selector, 80) || "none"}`,
    `user=${Number(src.userCount) || 0}`,
    `assistant=${Number(src.assistantCount) || 0}`,
    `chars=${Number(src.charCount) || 0}`,
    `imgCache=${Number(src.imagesCached) || 0}`,
    `imgHold=${Number(src.imagesPlaceholder) || 0}`,
    imageCountLine(src),
    `archive=banner:${Math.max(0, Math.min(40, Math.floor(Number(src.archiveBanner) || 0)))},list:${Math.max(0, Math.min(500, Math.floor(Number(src.archiveList) || 0)))}`,
    `health=${scrubDiag(src.healthState, 16) || "ok"}`,
    `err=${oneWord(src.errorName)}`,
    `at=${iso}`,
  ];
  const structure = Chatseek.formatStructure(src.structure);
  if (structure) parts.push(structure);
  const stack = scrubFrame(src.errorStack);
  if (stack) parts.push(`stack=${stack}`);
  if (Number(src.progressSkipped) > 0) {
    parts.push(`progress=skipped:${Math.max(0, Math.min(9999, Math.floor(Number(src.progressSkipped))))}`);
  }
  return parts.join(" ");
};

function diagIdentity(line) {
  return String(line || "").replace(/\sat=[^\s]+/g, "");
}

Chatseek.noteDiag = (line, level) => {
  Chatseek._diagPending = String(line || "");
  Chatseek._diagPendingLevel = level === "warn" ? "warn" : "log";
  const flush = () => {
    Chatseek._diagTimer = 0;
    const next = Chatseek._diagPending;
    const warn = Chatseek._diagPendingLevel === "warn";
    // The timestamp changes on every pass. Repeat lines must not flood the console.
    if (!next || diagIdentity(next) === diagIdentity(Chatseek._diagLast)) return;
    Chatseek._diagLast = next;
    try {
      const write = warn && typeof console !== "undefined" && typeof console.warn === "function"
        ? console.warn.bind(console)
        : (typeof console !== "undefined" && typeof console.log === "function" ? console.log.bind(console) : null);
      if (write) write(next);
    } catch {
      // A missing console must not stop capture.
    }
  };
  if (!Chatseek._diagArmed) {
    Chatseek._diagArmed = true;
    flush();
    return;
  }
  if (!Chatseek._diagTimer) Chatseek._diagTimer = setTimeout(flush, 4000);
};

Chatseek.publishDiag = (fields) => {
  const stored = fields || Chatseek.diagFields();
  Chatseek._diagFields = stored;
  if (stored.platform) Chatseek._diagPlatform = stored.platform;
  const line = Chatseek.formatDiag(stored);
  Chatseek._lastDiag = line;
  Chatseek.noteDiag(line, stored.healthState === "warn" ? "warn" : "log");
  return line;
};

Chatseek.refreshImageDiag = () => {
  const prev = Chatseek._diagFields;
  if (!prev) return;
  const images = imageCountsOf(Chatseek.imageDiagCounts());
  const old = prev.imageFail || {};
  if (images.detected === (Number(prev.imagesDetected) || 0) &&
      images.cached === (Number(prev.imagesCached) || 0) &&
      images.placeholder === (Number(prev.imagesPlaceholder) || 0) &&
      images.fail.tainted === (Number(old.tainted) || 0) &&
      images.fail.tooBig === (Number(old.tooBig) || 0) &&
      images.fail.timeout === (Number(old.timeout) || 0) &&
      images.fail.notLoaded === (Number(old.notLoaded) || 0)) {
    return;
  }
  prev.imagesDetected = images.detected;
  prev.imagesCached = images.cached;
  prev.imagesPlaceholder = images.placeholder;
  prev.imageFail = images.fail;
  prev.at = Date.now();
  const line = Chatseek.formatDiag(prev);
  Chatseek._lastDiag = line;
  Chatseek.noteDiag(line);
  const report = Chatseek._lastHealthSend;
  if (!report || !Chatseek._diagPlatform) return;
  report.diag = line;
  report.at = prev.at;
  Chatseek.send({
    type: "CAPTURE_HEALTH",
    platform: Chatseek._diagPlatform,
    health: report,
  });
};

Chatseek.safeScheduleImages = (job) => {
  try {
    if (typeof Chatseek.scheduleMessageImages === "function") Chatseek.scheduleMessageImages(job);
  } catch (err) {
    Chatseek.rememberError(err);
  }
};

Chatseek.domText = (el, plain) => {
  if (!el || el.nodeType !== 1) return { text: "", offsets: new Map() };
  const state = domState();
  let ctx = { plain: !!plain, pre: false, plainPre: false };
  if (ctx.plain && /whitespace-pre-wrap|pre-wrap/i.test(domClassBlob(el))) {
    ctx = { ...ctx, plainPre: true };
  }
  const tag = el.tagName;
  if (tag === "PRE" || tag === "TABLE" || tag === "UL" || tag === "OL" || tag === "BLOCKQUOTE") {
    walkNode(el, state, ctx);
  } else {
    walkChildren(el, state, ctx);
  }
  return finishDom(state);
};

Chatseek.safeDomText = (el, plain) => {
  try {
    return Chatseek.domText(el, plain);
  } catch (err) {
    Chatseek.rememberError(err);
    let text = "";
    try { text = Chatseek.cleanClone(el); } catch { text = ""; }
    return { text, offsets: new Map() };
  }
};

function adoptedRoot(el, probeClosed) {
  if (!el || el.nodeType !== 1) return null;
  if (el.shadowRoot) return { root: el.shadowRoot, mode: "open" };
  if (!probeClosed) return null;
  try {
    const closed = typeof chrome !== "undefined" ? chrome.dom?.openOrClosedShadowRoot?.(el) : null;
    if (closed) return { root: closed, mode: "closed" };
  } catch {
    // Closed roots stay invisible when the extension API is missing.
  }
  return null;
}

Chatseek.shadowHosts = (doc, opts) => {
  const hosts = [];
  const stack = [doc];
  const seenRoots = new Set();
  const allowClosed = opts?.closed === true;
  let seen = 0;
  while (stack.length && hosts.length < 20) {
    const root = stack.pop();
    if (!root || seenRoots.has(root)) continue;
    seenRoots.add(root);
    let all = [];
    try { all = root.querySelectorAll ? [...root.querySelectorAll("*")] : []; } catch { all = []; }
    for (let index = 0; index < all.length; index += 1) {
      const el = all[index];
      seen += 1;
      if (seen > 2500 || hosts.length >= 20) break;
      const found = adoptedRoot(el, allowClosed && (index < 800 || String(el.tagName || "").includes("-")));
      if (!found) continue;
      hosts.push({
        el,
        root: found.root,
        mode: found.mode,
        tag: String(el.tagName || "div").toLowerCase(),
      });
      stack.push(found.root);
    }
  }
  return hosts;
};

Chatseek.readScopes = (doc) => {
  const scopes = [{ kind: "top", node: doc }];
  const pushShadows = (root, kind) => {
    for (const entry of Chatseek.shadowHosts(root, { closed: true })) {
      if (!entry.root) continue;
      scopes.push({ kind, node: entry.root, mode: entry.mode, tag: entry.tag });
    }
  };
  pushShadows(doc, "shadow");
  let frames = [];
  try { frames = doc.querySelectorAll ? [...doc.querySelectorAll("iframe")] : []; } catch { frames = []; }
  for (const frame of frames) {
    let child = null;
    try { child = frame.contentDocument; } catch { child = null; }
    if (!child) continue;
    scopes.push({ kind: "iframe", node: child, frame });
    pushShadows(child, "shadow");
  }
  return scopes;
};

async function pacedElements(root) {
  const nodes = [];
  let walker = null;
  try {
    const doc = root?.nodeType === 9 ? root : (root?.ownerDocument || null);
    const start = root?.nodeType === 9 ? (root.documentElement || root.body) : root;
    if (start && doc?.createTreeWalker) walker = doc.createTreeWalker(start, NodeFilter.SHOW_ELEMENT);
  } catch {
    walker = null;
  }
  if (!walker) {
    try { return root?.querySelectorAll ? [...root.querySelectorAll("*")].slice(0, 2500) : []; } catch { return []; }
  }
  let index = 0;
  let el = walker.currentNode;
  while (el && index < 2500) {
    if (el.nodeType === 1) nodes.push(el);
    index += 1;
    if ((index & 63) === 0) await Chatseek.paceDom();
    el = walker.nextNode();
  }
  return nodes;
}

Chatseek.shadowHostsPaced = async (doc) => {
  const hosts = [];
  const stack = [doc];
  const seenRoots = new Set();
  let seen = 0;
  while (stack.length && hosts.length < 20) {
    const root = stack.pop();
    if (!root || seenRoots.has(root)) continue;
    seenRoots.add(root);
    const all = await pacedElements(root);
    for (let index = 0; index < all.length; index += 1) {
      const el = all[index];
      seen += 1;
      if (seen > 2500 || hosts.length >= 20) break;
      const found = adoptedRoot(el, index < 800 || String(el.tagName || "").includes("-"));
      if (!found) continue;
      hosts.push({
        el,
        root: found.root,
        mode: found.mode,
        tag: String(el.tagName || "div").toLowerCase(),
      });
      stack.push(found.root);
    }
  }
  return hosts;
};

Chatseek.readEmbeddedPaced = async (doc) => {
  const scopes = [];
  const pushShadows = async (root) => {
    for (const entry of await Chatseek.shadowHostsPaced(root)) {
      if (!entry.root) continue;
      scopes.push({ kind: "shadow", node: entry.root, mode: entry.mode, tag: entry.tag });
      await Chatseek.paceDom();
    }
  };
  await pushShadows(doc);
  let frames = [];
  try { frames = doc.querySelectorAll ? [...doc.querySelectorAll("iframe")] : []; } catch { frames = []; }
  for (const frame of frames) {
    let child = null;
    try { child = frame.contentDocument; } catch { child = null; }
    if (!child) continue;
    scopes.push({ kind: "iframe", node: child, frame });
    await pushShadows(child);
    await Chatseek.paceDom();
  }
  return scopes;
};

Chatseek.observeDeep = (doc, run, seen) => {
  if (!doc || typeof run !== "function" || !seen) return;
  for (const entry of Chatseek.shadowHosts(doc, { closed: true })) {
    const root = entry?.root;
    if (!root || seen.has(root)) continue;
    seen.add(root);
    try {
      new MutationObserver(run).observe(root, { childList: true, subtree: true, characterData: true });
    } catch { /* a root can reject observe */ }
  }
  let frames = [];
  try { frames = [...doc.querySelectorAll("iframe")]; } catch { frames = []; }
  for (const frame of frames) {
    if (!seen.has(frame)) {
      seen.add(frame);
      frame.addEventListener("load", () => {
        try {
          const child = frame.contentDocument;
          if (child?.documentElement && !seen.has(child)) {
            seen.add(child);
            new MutationObserver(run).observe(child.documentElement, {
              childList: true,
              subtree: true,
              characterData: true,
            });
          }
        } catch { /* cross-origin frames have no document */ }
        run();
      });
    }
    try {
      const child = frame.contentDocument;
      if (child?.documentElement && !seen.has(child)) {
        seen.add(child);
        new MutationObserver(run).observe(child.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      }
    } catch { /* cross-origin */ }
  }
};

Chatseek.watchChildFrame = () => {
  const ping = () => {
    try {
      if (typeof document !== "undefined" && document.hidden) return;
      const origin = (typeof location !== "undefined" && location.origin && location.origin !== "null")
        ? location.origin
        : "*";
      window.parent.postMessage({ source: "chatseek-frame" }, origin);
    } catch { /* the parent may be gone */ }
  };
  ping();
  try {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) ping();
    });
  } catch { /* a hidden frame stays quiet */ }
  try {
    const root = document.documentElement || document.body;
    if (root) {
      new MutationObserver(ping).observe(root, { childList: true, subtree: true, characterData: true });
    }
  } catch { /* the frame can still be read by the parent when it is same-origin */ }
};

function plainLen(el) {
  return String(el?.textContent || "").replace(/\s+/g, " ").trim().length;
}

function bodyTextLen(body) {
  if (!body) return 0;
  let wide = false;
  try { wide = body.getElementsByTagName("*").length > 600; } catch { wide = false; }
  if (wide) return plainLen(body);
  let clone = body;
  try {
    clone = body.cloneNode(true);
    clone.querySelectorAll("script, style, noscript").forEach((node) => node.remove());
  } catch {
    clone = body;
  }
  return plainLen(clone);
}

function linkHeavy(el) {
  try {
    return el.querySelectorAll("a[href*='/c/']").length >= 3;
  } catch {
    return false;
  }
}

function chromeMarked(el) {
  let node = el;
  let guard = 0;
  while (node && node.nodeType === 1 && guard < 6) {
    const blob = `${node.id || ""} ${domClassBlob(node)} ${node.getAttribute?.("data-testid") || ""}`.toLowerCase();
    if (/(?:^|[^a-z])(cookie|consent|gdpr|onetrust|upgrade|upsell|paywall)(?:[^a-z]|$)/.test(blob)) return true;
    node = node.parentElement;
    guard += 1;
  }
  return false;
}

function hasEditor(el) {
  if (!el || el.nodeType !== 1) return false;
  try {
    if (el.matches?.("textarea, input, select, [contenteditable='true']")) return true;
    return !!el.querySelector?.("textarea, input, select, [contenteditable='true']");
  } catch {
    return false;
  }
}

function proseLen(el) {
  try {
    const clone = el.cloneNode(true);
    clone.querySelectorAll("button, [role='button'], svg, input, textarea, select, nav, footer, [contenteditable='true']").forEach((node) => node.remove());
    return plainLen(clone);
  } catch {
    return plainLen(el);
  }
}

Chatseek.isHeuristicChrome = (el) => {
  if (!el || el.nodeType !== 1) return true;
  const tag = el.tagName || "";
  if (/^(NAV|FOOTER|HEADER|ASIDE|TEXTAREA|INPUT|SELECT|SCRIPT|STYLE|NOSCRIPT|BUTTON|SVG)$/.test(tag)) return true;
  const role = (el.getAttribute?.("role") || "").toLowerCase();
  if (role === "navigation" || role === "contentinfo" || role === "banner" || role === "button" || role === "dialog" || role === "alertdialog") return true;
  try {
    if (el.closest("nav, footer, header, aside, [role='navigation'], [role='contentinfo'], [role='banner'], [role='dialog'], [role='alertdialog']")) return true;
  } catch { /* ignore */ }
  if (chromeMarked(el)) return true;
  return false;
};

function hintText(el) {
  const text = String(el?.textContent || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 180) return false;
  return /can make mistakes|check important info|we use cookies|upgrade to|subscribe to|accept all|privacy policy|僅供參考|可能出錯/i.test(text);
}

Chatseek.skipHeuristic = (el) => {
  if (!el || el.nodeType !== 1) return true;
  if (/^(P|H1|H2|H3|H4|H5|H6|SPAN|A|LABEL|BUTTON)$/.test(el.tagName || "")) return true;
  if (Chatseek.isHeuristicChrome(el) || linkHeavy(el) || hasEditor(el) || hintText(el)) return true;
  return proseLen(el) < 24;
};

function guessHeuristicRole(el) {
  const known = Chatseek.messageRole(el);
  if (known === "user" || known === "assistant") return known;
  let label = "";
  try {
    const heading = el.querySelector("h1, h2, h3, h4, h5, h6");
    label = String(heading?.textContent || "").replace(/\s+/g, " ").trim();
  } catch { label = ""; }
  if (/^(you|user)$/i.test(label) || /^(?:you|user)\s+said\b/i.test(label)) return "user";
  if (/^(chatgpt|assistant|gpt(?:-\d|\b))/i.test(label) || /^(?:chatgpt|assistant)\s+said\b/i.test(label)) return "assistant";
  return "unknown";
}

function bestHeuristicGroup(root) {
  const start = root?.nodeType === 9
    ? (root.querySelector?.("main") || root.body)
    : (root?.querySelector?.("main") || root);
  if (!start?.querySelectorAll) return null;
  const parents = [start];
  let nodes = [];
  try { nodes = [...start.querySelectorAll("div, section, article, ol, ul, main")]; } catch { nodes = []; }
  let seen = 0;
  for (const el of nodes) {
    if (seen++ > 500) break;
    if (!Chatseek.isHeuristicChrome(el)) parents.push(el);
  }
  let best = null;
  for (const parent of parents) {
    if (Chatseek.isHeuristicChrome(parent)) continue;
    let kids = [];
    try { kids = [...parent.children]; } catch { kids = []; }
    const textual = [];
    for (const el of kids) {
      if (!el || el.nodeType !== 1) continue;
      if (Chatseek.skipHeuristic(el)) continue;
      textual.push(el);
    }
    if (!textual.length) continue;
    const chars = textual.reduce((sum, el) => sum + plainLen(el), 0);
    const turnLike = textual.filter((el) => guessHeuristicRole(el) !== "unknown").length;
    const score = turnLike * 1000000 + textual.length * 100000 + Math.min(chars, 50000);
    if (!best || score > best.score) {
      best = {
        score,
        blocks: textual.map((el) => ({ el, role: guessHeuristicRole(el) })),
      };
    }
  }
  return best;
}

Chatseek.heuristicBlocks = (scopes) => {
  let best = null;
  for (const scope of scopes || []) {
    const group = bestHeuristicGroup(scope?.node);
    if (!group) continue;
    if (!best || group.score > best.score) best = group;
  }
  return best ? best.blocks : [];
};

Chatseek.heuristicBlocksPaced = async (scopes) => {
  let best = null;
  for (const scope of scopes || []) {
    const group = bestHeuristicGroup(scope?.node);
    await Chatseek.paceDom();
    if (!group) continue;
    if (!best || group.score > best.score) best = group;
  }
  return best ? best.blocks : [];
};

Chatseek.charBucket = (n) => {
  const value = Math.max(0, Math.floor(Number(n) || 0));
  if (value <= 0) return "0";
  if (value <= 40) return "1-40";
  if (value <= 160) return "41-160";
  if (value <= 640) return "161-640";
  if (value <= 2560) return "641-2560";
  return "2560+";
};

Chatseek.cleanClassToken = (raw) => {
  const out = [];
  for (const token of String(raw || "").slice(0, 256).split(/\s+/).filter(Boolean).slice(0, 3)) {
    if (SKELETON_ENUMS.get("data-testid").has(token)) out.push(token);
    else {
      const prefix = skeletonClasses(token);
      if (prefix && prefix !== "x" && prefix !== "h") out.push(prefix);
    }
  }
  return out;
};

function describeEl(el) {
  const tag = skeletonTagName(el?.tagName);
  const names = [];
  const attrs = el.attributes;
  for (let i = 0; i < Math.min(attrs?.length || 0, 64) && names.length < 4; i += 1) {
    const name = skeletonAttrName(attrs[i]?.name);
    if (/^(class|style|href|src|srcdoc|alt|title|value|placeholder)$/.test(name)) continue;
    names.push(name);
  }
  const tokens = [
    ...Chatseek.cleanClassToken(el.getAttribute?.("data-testid")),
    ...Chatseek.cleanClassToken(el.getAttribute?.("class")),
  ].slice(0, 3);
  let out = tag;
  if (names.length) out += `[${names.join(",")}]`;
  if (tokens.length) out += `{${tokens.join(".")}}`;
  return out;
}

function frameHostname(frame) {
  try {
    const src = frame.getAttribute?.("src") || "";
    if (!src || /^about:/i.test(src) || frame.hasAttribute?.("srcdoc")) return "about";
    let base = "https://chatgpt.com/";
    try {
      if (typeof location !== "undefined" && location.href) base = location.href;
    } catch { /* keep the fallback base */ }
    return skeletonHostname(String(new URL(src, base).hostname || "").toLowerCase());
  } catch {
    return "";
  }
}

function pathFor(el) {
  const bits = [];
  let node = el;
  let guard = 0;
  while (node && node.nodeType === 1 && guard < 6) {
    const bit = describeEl(node);
    if (bit) bits.push(bit);
    node = node.parentElement;
    guard += 1;
  }
  bits.reverse();
  return bits.join(">");
}

function scopeWhere(el) {
  try {
    const doc = el?.ownerDocument;
    if (doc?.defaultView?.frameElement) return "iframe";
  } catch { /* cross-origin frameElement throws; treat as top */ }
  try {
    let node = el;
    let guard = 0;
    while (node && guard < 10) {
      if (node.nodeType === 11) return "shadow";
      node = node.parentNode;
      guard += 1;
    }
  } catch { /* stay on top */ }
  return "top";
}

Chatseek.skeletonOf = (doc, preset) => {
  const ranked = [];
  const scopes = preset || Chatseek.readScopes(doc);
  for (const scope of scopes) {
    const start = scope.node?.nodeType === 9
      ? (scope.node.querySelector?.("main") || scope.node.body)
      : (scope.node?.querySelector?.("main") || scope.node);
    if (!start?.querySelectorAll) continue;
    let nodes = [];
    try {
      nodes = [start, ...start.querySelectorAll("article, div, section, p, li, pre, main, blockquote")];
    } catch { nodes = []; }
    let seen = 0;
    for (const el of nodes) {
      if (seen++ > 400) break;
      const tag = el.tagName || "";
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|INPUT)$/.test(tag)) continue;
      const n = plainLen(el);
      if (n < 12) continue;
      const kids = [...el.children].filter((kid) => kid.nodeType === 1);
      if (kids.length === 1 && plainLen(kids[0]) >= n * 0.8) continue;
      ranked.push({ el, n, where: scope.kind === "top" ? scopeWhere(el) : scope.kind });
    }
  }
  ranked.sort((a, b) => b.n - a.n);
  const picked = [];
  for (const block of ranked) {
    if (picked.some((item) => item.el === block.el || item.el.contains(block.el) || block.el.contains(item.el))) continue;
    picked.push(block);
    if (picked.length >= 3) break;
  }
  return picked.map((block) => {
    const prefix = block.where === "iframe" ? "iframe>" : block.where === "shadow" ? "shadow>" : "";
    return `${prefix}${pathFor(block.el)}~${Chatseek.charBucket(block.n)}`;
  }).join("|").slice(0, 220);
};

function rootHasMain(node) {
  try { return !!node?.querySelector?.("main"); } catch { return false; }
}

Chatseek.structureDiag = (doc) => {
  const top = doc?.nodeType === 9 ? doc : (doc?.ownerDocument || doc);
  if (!top?.querySelectorAll) {
    return { main: "none", top: 0, body: "0", frames: [], shadows: [], skeleton: "" };
  }
  const places = [];
  if (rootHasMain(top)) places.push("top");
  const shadowEntries = Chatseek.shadowHosts(top, { closed: true });
  const shadows = shadowEntries.map((entry) => ({
    tag: skeletonTagName(entry.tag || "div"),
    mode: entry.mode === "closed" ? "closed" : "open",
  }));
  if (shadowEntries.some((entry) => rootHasMain(entry.root))) places.push("shadow");
  let frameNodes = [];
  try { frameNodes = [...top.querySelectorAll("iframe")]; } catch { frameNodes = []; }
  const frames = [];
  let iframeMain = false;
  for (const frame of frameNodes) {
    const host = frameHostname(frame).replace(/[^a-z0-9.-]/g, "") || "unknown";
    const script = Chatseek._scriptedFrames?.get(frame) ? "script" : "noscript";
    frames.push(`${host}:${script}`);
    let child = null;
    try { child = frame.contentDocument; } catch { child = null; }
    if (child && rootHasMain(child)) iframeMain = true;
  }
  if (iframeMain) places.push("iframe");
  const bodyChars = bodyTextLen(top.body);
  return {
    main: places.join("+") || "none",
    top: top.body?.children?.length || 0,
    body: Chatseek.charBucket(bodyChars),
    frames: frames.slice(0, 6),
    shadows: shadows.slice(0, 6),
    skeleton: Chatseek.skeletonOf(top),
  };
};

Chatseek.structureDiagLight = (doc, charCount) => {
  const top = doc?.nodeType === 9 ? doc : (doc?.ownerDocument || doc);
  if (!top?.querySelectorAll) {
    return { main: "none", top: 0, body: "0", frames: [], shadows: [], skeleton: "" };
  }
  let frameNodes = [];
  try { frameNodes = [...top.querySelectorAll("iframe")]; } catch { frameNodes = []; }
  const frames = [];
  for (const frame of frameNodes) {
    const host = frameHostname(frame).replace(/[^a-z0-9.-]/g, "") || "unknown";
    const script = Chatseek._scriptedFrames?.get(frame) ? "script" : "noscript";
    frames.push(`${host}:${script}`);
    if (frames.length >= 6) break;
  }
  return {
    main: rootHasMain(top) ? "top" : "none",
    top: top.body?.children?.length || 0,
    body: Chatseek.charBucket(charCount),
    frames,
    shadows: [],
    skeleton: "",
  };
};

Chatseek.structureDiagPaced = async (doc) => {
  const top = doc?.nodeType === 9 ? doc : (doc?.ownerDocument || doc);
  if (!top?.querySelectorAll) {
    return { main: "none", top: 0, body: "0", frames: [], shadows: [], skeleton: "" };
  }
  await Chatseek.paceDom();
  const embedded = await Chatseek.readEmbeddedPaced(top);
  const places = [];
  if (rootHasMain(top)) places.push("top");
  const shadows = [];
  let iframeMain = false;
  for (const scope of embedded) {
    if (scope.kind === "shadow") {
      shadows.push({
        tag: skeletonTagName(scope.tag || "div"),
        mode: scope.mode === "closed" ? "closed" : "open",
      });
      if (rootHasMain(scope.node) && !places.includes("shadow")) places.push("shadow");
    } else if (scope.kind === "iframe") {
      if (rootHasMain(scope.node)) iframeMain = true;
    }
  }
  if (iframeMain) places.push("iframe");
  let frameNodes = [];
  try { frameNodes = [...top.querySelectorAll("iframe")]; } catch { frameNodes = []; }
  const frames = [];
  for (const frame of frameNodes) {
    const host = frameHostname(frame).replace(/[^a-z0-9.-]/g, "") || "unknown";
    const script = Chatseek._scriptedFrames?.get(frame) ? "script" : "noscript";
    frames.push(`${host}:${script}`);
    if (frames.length >= 6) break;
  }
  const skeleton = Chatseek.skeletonOf(top, [{ kind: "top", node: top }, ...embedded]);
  await Chatseek.paceDom();
  return {
    main: places.join("+") || "none",
    top: top.body?.children?.length || 0,
    body: Chatseek.charBucket(bodyTextLen(top.body)),
    frames,
    shadows: shadows.slice(0, 6),
    skeleton,
  };
};

function safeSkeleton(value) {
  const text = String(value || "");
  if (!text || text.length > 220) return "";
  if (!/^[a-z0-9>|\[\]{},~:.-]+$/i.test(text)) return "";
  if (/[0-9a-f]{8}-[0-9a-f]{4}/i.test(text)) return "";
  return text.toLowerCase();
}

Chatseek.formatStructure = (structure) => {
  if (!structure || typeof structure !== "object") return "";
  const main = /^(none|top|shadow|iframe)(\+(top|shadow|iframe))*$/.test(structure.main)
    ? structure.main
    : "none";
  const top = Math.max(0, Math.min(9999, Math.floor(Number(structure.top) || 0)));
  const body = /^(0|\d+-\d+|\d+\+)$/.test(structure.body) ? structure.body : "0";
  const frames = (Array.isArray(structure.frames) ? structure.frames : [])
    .map((item) => String(item || "").toLowerCase())
    .filter((item) => /^[a-z0-9.-]+:(script|noscript)$/.test(item))
    .map((item) => {
      const at = item.lastIndexOf(":");
      return skeletonHostname(item.slice(0, at)) + item.slice(at);
    })
    .slice(0, 6);
  const shadows = (Array.isArray(structure.shadows) ? structure.shadows : [])
    .map((item) => {
      if (typeof item === "string") {
        const match = item.toLowerCase().match(/^([a-z][a-z0-9-]*):(open|closed)$/);
        return match ? `${skeletonTagName(match[1])}:${match[2]}` : "";
      }
      const tag = String(item?.tag || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
      const mode = item?.mode === "closed" ? "closed" : "open";
      return tag ? `${skeletonTagName(tag)}:${mode}` : "";
    })
    .filter((item) => /^[a-z0-9-]+:(open|closed)$/.test(item))
    .slice(0, 6);
  const skeleton = safeSkeleton(structure.skeleton);
  return [
    `main=${main}`,
    `top=${top}`,
    `body=${body}`,
    `frames=${frames.length ? `${frames.length}:${frames.join(",")}` : "0"}`,
    `shadows=${shadows.length ? `${shadows.length}:${shadows.join(",")}` : "0"}`,
    `skeleton=${skeleton || "-"}`,
  ].join(" ");
};

const SYNC_TRANSCRIPT = [
  "[data-message-author-role]",
  "[data-testid='user-message']",
  "[data-testid='assistant-message']",
  "[data-testid='human-message']",
  "[data-testid='ai-message']",
  ".conversation-container",
  "article",
].join(", ");

function syncBanner(root, pattern) {
  if (!root?.querySelectorAll) return false;
  let nodes = [];
  try {
    nodes = [...root.querySelectorAll("h1, h2, [role='alert']")];
  } catch {
    return false;
  }
  for (const node of nodes) {
    try {
      if (node.closest?.(SYNC_TRANSCRIPT)) continue;
    } catch {
      continue;
    }
    const text = (node.textContent || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 240) continue;
    if (pattern.test(text)) return true;
  }
  return false;
}

/** DOM flags for the sync stop check. The caller keeps the enum, not this text. */
Chatseek.syncPageSignals = (doc, loc) => {
  const root = doc || (typeof document !== "undefined" ? document : null);
  const here = loc || (typeof location !== "undefined" ? location : null);
  const href = String(here?.href || "");
  const title = String(root?.title || "");
  let hasChallengeNode = false;
  let hasPassword = false;
  let hasLoginForm = false;
  try {
    hasChallengeNode = !!root?.querySelector?.(
      "#challenge-form, #cf-challenge-running, .cf-turnstile, iframe[src*='challenges.cloudflare']",
    );
    hasPassword = !!root?.querySelector?.("input[type='password']");
    hasLoginForm = !!root?.querySelector?.("form[action*='login' i], [data-testid='login-button']");
  } catch {
    hasChallengeNode = false;
  }
  return {
    href,
    title,
    hasChallengeNode,
    hasPassword,
    hasLoginForm,
    hasRateBanner: syncBanner(root, /too many requests|rate limit|try again later|^429\b/i),
    hasErrorBanner: syncBanner(root, /something went wrong|access denied|page not found|^404\b|^403\b/i),
  };
};

/** How many messages this document already wrote for one conversation. */
Chatseek.noteSyncStored = (id, count) => {
  if (!id) return;
  Chatseek._syncStoredId = String(id);
  Chatseek._syncStoredCount = Math.max(0, Math.floor(Number(count) || 0));
};

Chatseek.syncStoredCount = (id) => {
  if (!id || Chatseek._syncStoredId !== String(id)) return 0;
  return Chatseek._syncStoredCount || 0;
};

/** Sidebar links only. No message text. */
Chatseek.syncProbeResult = (signals, sidebar, messageCount, storedCount) => {
  const links = [];
  for (const row of sidebar || []) {
    if (links.length >= 500) break;
    if (!row?.url) continue;
    links.push({
      url: String(row.url),
      updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : null,
      messageCount: Number.isFinite(row.messageCount) ? row.messageCount : null,
    });
  }
  return {
    ok: true,
    href: signals?.href || "",
    title: signals?.title || "",
    hasChallengeNode: !!signals?.hasChallengeNode,
    hasPassword: !!signals?.hasPassword,
    hasLoginForm: !!signals?.hasLoginForm,
    hasRateBanner: !!signals?.hasRateBanner,
    hasErrorBanner: !!signals?.hasErrorBanner,
    messageCount: Math.max(0, Math.floor(Number(messageCount) || 0)),
    storedCount: Math.max(0, Math.floor(Number(storedCount) || 0)),
    links,
  };
};

function syncTopFrame() {
  try {
    return !window.top || window.top === window;
  } catch {
    return false;
  }
}

try {
  if (
    syncTopFrame() &&
    typeof chrome !== "undefined" &&
    chrome.runtime?.onMessage?.addListener &&
    !globalThis.__chatseekSyncInspect
  ) {
    globalThis.__chatseekSyncInspect = true;
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || msg.type !== "SYNC_INSPECT") return;
      const probe = Chatseek.syncProbe;
      if (typeof probe !== "function") {
        try { sendResponse({ ok: false }); } catch { /* the runner treats silence as uncertain */ }
        return;
      }
      Promise.resolve()
        .then(() => probe())
        .then((report) => {
          try { sendResponse(report || { ok: false }); } catch { /* channel closed */ }
        })
        .catch(() => {
          try { sendResponse({ ok: false }); } catch { /* channel closed */ }
        });
      return true;
    });
  }
} catch {
  // Capture still runs when messaging is unavailable.
}

/* ---------------------------------------------------------------- page skeleton
 * Diagnostic only. Reads the live DOM (top document, open/closed shadow roots,
 * same-origin iframes) and returns a structure-only outline the owner can paste
 * back when a selector stops matching. It never emits text, titles, urls,
 * conversation ids, or account data: every node is reduced to its tag name,
 * depth, child count and attribute names, and — only for a handful of short
 * enumerated attributes — a value that is itself a plain enum. Everything else
 * is `x`. Text nodes carry a character count, never their content.
 */
const SKELETON_NODES = 6000;
const SKELETON_DEPTH = 60;

function skeletonIndent(depth) {
  return "  ".repeat(Math.max(0, Math.min(depth, SKELETON_DEPTH)));
}

// Names can themselves contain private data. Only vocabulary known to describe
// DOM structure is emitted verbatim; unknown names/tags get fixed placeholders.
const SKELETON_TAGS = new Set((
  "html head body title meta link base style script noscript template slot main nav " +
  "header footer aside section article div span p a button input textarea select option " +
  "form label fieldset legend img picture source video audio canvas iframe frame " +
  "ul ol li dl dt dd table thead tbody tfoot tr th td caption col colgroup h1 h2 h3 h4 h5 h6 " +
  "pre code blockquote br hr b i u s em strong small sup sub details summary figure figcaption " +
  "time progress meter output dialog svg g path rect circle ellipse line polyline polygon " +
  "defs use symbol text tspan clipPath mask linearGradient radialGradient stop foreignObject " +
  "math mi mo mn ms mtext mrow annotation semantics"
).toLowerCase().split(/\s+/));
const SKELETON_ATTRS = new Set((
  "id class role title alt placeholder href src srcdoc style value name content type " +
  "width height hidden disabled checked selected multiple readonly required tabindex " +
  "contenteditable dir lang charset rel target loading decoding draggable slot part datetime " +
  "viewbox d fill stroke xmlns focusable data-testid data-turn data-message-author-role " +
  "data-message-id data-conversation-id data-is-streaming data-state data-kind " +
  "data-turn-id data-turn-id-container data-message-content data-message-author data-test-id " +
  "data-time data-timestamp data-updated-at data-updatedat data-role data-line-number " +
  "aria-label aria-labelledby aria-describedby aria-hidden aria-expanded aria-selected " +
  "aria-checked aria-busy aria-live aria-atomic aria-disabled aria-controls aria-current " +
  "aria-valuenow aria-valuemin aria-valuemax aria-valuetext"
).split(/\s+/));
const SKELETON_ENUMS = new Map([
  ["role", "main navigation complementary banner contentinfo article document list listitem " +
    "button textbox img status progressbar alert dialog tab tablist tabpanel region group presentation none"],
  ["data-message-author-role", "assistant user system tool"], ["data-turn", "assistant user system tool"],
  ["data-testid", "message-turn conversation-turn conversation-title conversation-list markdown"],
  ["data-kind", "open closed shadow-host"], ["data-state", "open closed loading complete idle streaming"],
  ["data-is-streaming", "true false"], ["contenteditable", "true false plaintext-only"],
  ["dir", "ltr rtl auto"], ["lang", "en zh zh-CN zh-TW ja ko es pt-BR fr de"],
  ["charset", "utf-8 UTF-8"], ["type", "button submit reset text password checkbox radio search number"],
  ["loading", "lazy eager"], ["decoding", "async sync auto"], ["aria-live", "off polite assertive"],
  ...["aria-hidden", "aria-expanded", "aria-selected", "aria-checked", "aria-busy", "aria-atomic",
    "aria-disabled", "draggable", "focusable"].map(name => [name, "true false mixed"]),
].map(([name, values]) => [name, new Set(values.split(" "))]));
const SKELETON_CLASSES = new Set((
  "prose markdown message conversation sidebar container group text whitespace truncate " +
  "flex grid block inline hidden relative absolute fixed sticky overflow items justify " +
  "rounded border bg font leading gap space p px py m mx my w h min max light dark archived"
).split(/\s+/));

function skeletonTagName(name) {
  const tag = String(name || "").toLowerCase();
  return SKELETON_TAGS.has(tag) ? tag : "element-x";
}

function skeletonHostname(host) {
  return String(host || "").split(".").map(label =>
    Chatseek.UUID.test(label) || /[0-9a-f]{16,}/i.test(label) || /^[A-Za-z0-9_-]{24,}$/.test(label) ? "x" : label
  ).join(".");
}

function skeletonAttrName(name) {
  const key = String(name || "").toLowerCase();
  return SKELETON_ATTRS.has(key) ? key : key.startsWith("data-") ? "data-x" : "attr-x";
}

function skeletonAttrValue(name, value) {
  // A character/length check alone cannot distinguish "alice" from an enum.
  const values = SKELETON_ENUMS.get(name);
  if (!values || typeof value !== "string" || value.length > 32 ||
      !/^[A-Za-z0-9_:-]+$/.test(value) || Chatseek.UUID.test(value)) return "x";
  return values.has(value) ? value : "x";
}

function skeletonClasses(value) {
  // Bound parsing as well as output. No arbitrary word may become a class hint.
  const tokens = String(value || "").slice(0, 256).split(/\s+/).filter(Boolean).slice(0, 3);
  return tokens.map(token => {
    if (/[0-9a-f]{10,}/i.test(token) || /^\d{5,}$/.test(token) ||
        (/^[A-Za-z0-9_-]{24,}$/.test(token))) return "h";
    const prefix = token.split(/[-_]/)[0];
    return prefix.length <= 20 && SKELETON_CLASSES.has(prefix) ? prefix : "x";
  }).join(".");
}

function skeletonElementLine(node, depth, childCount, note, state) {
  const tag = skeletonTagName(node.tagName);
  let line = `${skeletonIndent(depth)}${tag} d${depth} c${childCount}`;
  const attrs = node.attributes;
  // Even malicious elements with thousands of attribute names remain bounded.
  const length = Math.min(attrs?.length || 0, 64);
  for (let i = 0; i < length; i += 1) {
    const attr = attrs[i];
    const name = skeletonAttrName(attr.name);
    const shown = name === "class" ? skeletonClasses(attr.value) : skeletonAttrValue(name, attr.value);
    line += ` ${name}=${shown}`;
  }
  if ((attrs?.length || 0) > length) { state.truncated = true; line += " #attrs-truncated"; }
  return line + note;
}

function skeletonChildren(node) {
  const tag = String(node.tagName || "").toLowerCase();
  if (tag === "iframe" || tag === "frame") {
    let doc = null;
    try { doc = node.contentDocument; } catch { /* cross-origin */ }
    if (doc?.documentElement) return { children: [doc.documentElement], note: " #same-origin-frame" };
    let host = "";
    try {
      const src = node.getAttribute("src") || "";
      // Relative paths cannot tell us a domain without reading the page URL.
      // Do not manufacture x.invalid or copy the path into the output.
      if (/^(?:https?:)?\/\//i.test(src)) {
        const url = new URL(src.startsWith("//") ? "https:" + src : src);
        if (url.protocol === "http:" || url.protocol === "https:") host = skeletonHostname(url.hostname);
      }
    } catch { /* invalid URL */ }
    return { children: [], note: host ? ` #cross-origin host=${host}` : " #cross-origin" };
  }
  const adopted = adoptedRoot(node, true);
  // Preserve both trees: light DOM may contain slotted messages or a frame.
  return { children: node.childNodes || [], shadow: adopted?.root?.childNodes,
    note: adopted ? (adopted.mode === "open" ? " #open-shadow" : " #shadow") : "" };
}

function skeletonEmit(node, depth, state) {
  if (!node || state.nodes >= SKELETON_NODES || depth > SKELETON_DEPTH) {
    state.truncated = true; return [];
  }
  state.nodes += 1; // Count every visited node, including collapsed siblings.
  if (node.nodeType !== 1 && node.nodeType !== 3) return [];
  if (node.nodeType === 3) return [`${skeletonIndent(depth)}#text(${String(node.nodeValue || "").length})`];
  const { children, shadow, note } = skeletonChildren(node);
  const lines = [skeletonElementLine(node, depth, children.length + (shadow?.length || 0), note, state)];
  // Compare complete sanitized subtree outlines, not a shallow tag signature.
  // A collapsed group keeps its children's outline, so useful selectors remain.
  for (const siblings of [children, shadow || []]) {
    let previous = null;
    let count = 0;
    const flush = () => {
      if (previous) lines.push(previous[0] + (count > 1 ? ` ×${count}` : ""), ...previous.slice(1));
    };
    for (let i = 0; i < siblings.length; i += 1) {
      if (state.nodes >= SKELETON_NODES) { state.truncated = true; break; }
      const branch = skeletonEmit(siblings[i], depth + 1, state);
      if (!branch.length) continue;
      if (previous && branch.length === previous.length && branch.every((line, at) => line === previous[at])) count += 1;
      else { flush(); previous = branch; count = 1; }
    }
    flush();
  }
  return lines;
}

Chatseek.buildPageSkeleton = (doc) => {
  const target = doc || (typeof document !== "undefined" ? document : null);
  const state = { nodes: 0, truncated: false };
  const body = target?.documentElement ? skeletonEmit(target.documentElement, 0, state) : [];
  const head = `# chatseek page skeleton v1 nodes=${state.nodes} depth<=${SKELETON_DEPTH} truncated=${state.truncated ? "true" : "false"}`;
  const text = [head, ...body].join("\n");
  return { text, chars: text.length, nodes: state.nodes, truncated: state.truncated };
};

try {
  if (
    syncTopFrame() &&
    typeof chrome !== "undefined" &&
    chrome.runtime?.onMessage?.addListener &&
    !globalThis.__chatseekSkeleton
  ) {
    globalThis.__chatseekSkeleton = true;
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || msg.type !== "COPY_PAGE_SKELETON") return;
      try {
        const result = Chatseek.buildPageSkeleton(document);
        sendResponse({ ok: true, text: result.text, chars: result.chars, nodes: result.nodes, truncated: result.truncated });
      } catch {
        try { sendResponse({ ok: false, text: "", chars: 0 }); } catch { /* channel closed */ }
      }
    });
  }
} catch {
  // The panel shows the manual-copy fallback when the channel is closed.
}
