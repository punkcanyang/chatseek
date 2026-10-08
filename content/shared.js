/* Isolated-world helpers. Read the DOM only — no fetch/XHR hooks. */
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
        }, scheduleRetry)
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
    let href = location.href;
    poll = setInterval(() => {
      if (!alive()) return;
      if (location.href !== href) {
        href = location.href;
        announce();
        run();
      }
    }, 1200);
    document.addEventListener("visibilitychange", onVisible);
    announce();
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
  pageTimesFromDocument() {
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
    const scripts = document.querySelectorAll(
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
    for (const script of document.scripts) {
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
  async runCapture(state, { platform, sidebar, conversation, messages, health }) {
    let ok = true;
    const list = sidebar || [];
    const msgs = (messages || []).filter((m) => m && m.id && m.body);
    // A thread is empty for a moment after SPA navigation while it loads.
    // Report 0 messages only once it stays empty; returning false makes
    // observe() look again in a few seconds even if the DOM goes quiet.
    let settling = false;
    if (health) {
      const now = Date.now();
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
    }
    if (settling) {
      ok = false;
    } else if (health) {
      const report = Chatseek.buildHealthReport({
        platform,
        pathKind: health.pathKind,
        sidebarCount: list.length,
        messageCount: msgs.length,
        selector: health.selector,
        selectorsTried: health.selectorsTried,
      });
      const healthFp = [
        report.pathKind,
        report.sidebarCount,
        report.messageCount,
        report.selector,
        report.warn ? "1" : "0",
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
      list.map((c) =>
        c.id + ":" + c.title + ":" + (c.updatedAt || "") + ":" + (c.updatedAtSource || "")
      ),
    );
    if (listFp && listFp !== state.lastListFp) {
      if (await Chatseek.sendConversations(platform, list)) {
        state.lastListFp = listFp;
      } else {
        ok = false;
      }
    }

    if (!conversation) return ok;

    const inSidebar = list.some((c) => c.platformId === conversation.platformId);
    if (!msgs.length) {
      if (!inSidebar) {
        const res = await Chatseek.send({
          type: "CAPTURE_CONVERSATIONS",
          platform,
          conversations: [conversation],
        });
        if (!res || !res.ok) ok = false;
      }
      return ok;
    }

    // SPA navigation changes the URL before the thread re-renders. If every
    // message on screen belongs to the thread we just stored, wait for the
    // next mutation instead of filing them under the new conversation id.
    const prefix = `${platform}:${conversation.platformId}:`;
    const keys = msgs.map((m) =>
      m.id.startsWith(prefix) ? m.id.slice(prefix.length) : m.id
    );
    if (
      state.lastMsgConvId &&
      state.lastMsgConvId !== conversation.id &&
      state.lastMsgKeys &&
      keys.every((k) => state.lastMsgKeys.has(k))
    ) {
      return ok;
    }

    const msgFp = Chatseek.fingerprint([
      conversation.id,
      conversation.title,
      conversation.updatedAt || "",
      ...msgs.map((m) => m.id + ":" + m.body.length + ":" + m.body.slice(-80)),
    ]);
    if (msgFp === state.lastMsgFp) return ok;

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
    for (const chunk of Chatseek.chunkMessages(msgs)) {
      const res = await Chatseek.send({
        type: "CAPTURE_MESSAGES",
        platform,
        conversation,
        messages: chunk,
        pageMessageIds,
        captureId,
      });
      if (!res || !res.ok) return false;
      if (res.observed) observed = true;
    }
    state.lastMsgFp = msgFp;
    state.lastMsgConvId = conversation.id;
    state.lastMsgKeys = new Set(keys);
    // The sidebar was written before this anchor existed. Rewrite it now so
    // its neighbours are estimated from the new time, even if the order did not move.
    if (observed && inSidebar) {
      if (await Chatseek.sendConversations(platform, list)) state.lastListFp = listFp;
      else ok = false;
    }
    return ok;
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
    const stack = [doc];
    let seen = 0;
    while (stack.length && roots.length < 20 && seen < 4000) {
      const root = stack.pop();
      const all = root?.querySelectorAll?.("*");
      if (!all) continue;
      for (const el of all) {
        seen += 1;
        if (seen > 4000) break;
        if (el.shadowRoot) {
          roots.push(el.shadowRoot);
          stack.push(el.shadowRoot);
        }
      }
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
  buildHealthReport({ platform, pathKind, sidebarCount, messageCount, selector, selectorsTried }) {
    const tried = selectorsTried || [];
    const warn = pathKind === "conversation" && !messageCount;
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
      warn,
    };
  },
};
