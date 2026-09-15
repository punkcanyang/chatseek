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
      try {
        chrome.runtime.sendMessage(payload, (res) => {
          void chrome.runtime.lastError;
          resolve(res);
        });
      } catch {
        resolve(null);
      }
    });
  },

  observe(handler) {
    const run = Chatseek.debounce(handler, 800);
    const root = document.documentElement || document.body;
    if (!root) return;
    const mo = new MutationObserver(run);
    mo.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    let href = location.href;
    setInterval(() => {
      if (location.href !== href) {
        href = location.href;
        run();
      }
    }, 1200);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) run();
    });
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

  /** True for a plausible millisecond epoch (not unix seconds). */
  isValidMs(ts) {
    if (typeof ts !== "number" || !Number.isFinite(ts)) return false;
    // ~1973-03 … far future; rejects unix-seconds (~1.7e9).
    return ts >= 1e11 && ts <= Date.now() + 86400000 * 366;
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

    const lower = s.toLowerCase();
    const startOfLocalDay = (d) => {
      const x = new Date(d);
      x.setHours(0, 0, 0, 0);
      return x.getTime();
    };
    const dayMs = 86400000;
    const todayStart = startOfLocalDay(now);

    // Exact / near-exact relative buckets used by ChatGPT / Claude / Grok sidebars
    if (
      /^(today|今天|今日)$/i.test(s) ||
      lower === "today"
    ) {
      return todayStart + 12 * 3600000;
    }
    if (/^(yesterday|昨天|昨日)$/i.test(s)) {
      return todayStart - dayMs + 12 * 3600000;
    }

    // "Previous 7 Days" / "Past 7 Days" / "最近 7 天" → midpoint ~4 days ago
    let m = s.match(
      /^(?:previous|past|last)\s+(\d+)\s+days?$/i,
    ) || s.match(/^最近\s*(\d+)\s*天/) || s.match(/^过去\s*(\d+)\s*天/);
    if (m) {
      const n = Number(m[1]);
      if (n > 0 && n <= 90) {
        return todayStart - Math.floor(n / 2) * dayMs + 12 * 3600000;
      }
    }
    // "Previous 30 Days"
    m = s.match(/^(?:previous|past|last)\s+(\d+)\s+days?$/i);
    // already handled

    // "N days ago" / "N天前" / "N 天前"
    m = lower.match(/^(\d+)\s*(?:days?|d)\s*ago$/) ||
      s.match(/^(\d+)\s*天前$/);
    if (m) {
      const n = Number(m[1]);
      if (n >= 0 && n <= 3660) {
        return todayStart - n * dayMs + 12 * 3600000;
      }
    }

    // "N hours ago" / "N小时前"
    m = lower.match(/^(\d+)\s*(?:hours?|hrs?|h)\s*ago$/) ||
      s.match(/^(\d+)\s*小时前$/);
    if (m) {
      const n = Number(m[1]);
      if (n >= 0 && n <= 24 * 60) return now - n * 3600000;
    }

    // "N minutes ago" / "N分钟前"
    m = lower.match(/^(\d+)\s*(?:minutes?|mins?|m)\s*ago$/) ||
      s.match(/^(\d+)\s*分钟前$/);
    if (m) {
      const n = Number(m[1]);
      if (n >= 0 && n <= 24 * 60) return now - n * 60000;
    }

    // "just now" / "刚刚"
    if (/^(just\s*now|刚刚|剛才|刚才)$/i.test(s)) return now;

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
    const parsed = Date.parse(s);
    if (Chatseek.isValidMs(parsed)) return parsed;
    return null;
  },

  /**
   * Walk ancestors / previous siblings looking for a date-group heading
   * (ChatGPT/Grok sticky "Today" / "Yesterday" / "Previous 7 Days" headers).
   */
  findSectionTime(el) {
    if (!el || el.nodeType !== 1) return null;
    const headingRe =
      /^(today|yesterday|previous\s+\d+\s+days?|past\s+\d+\s+days?|last\s+\d+\s+days?|今天|昨天|昨日|今日|最近\s*\d+\s*天|过去\s*\d+\s*天|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(\s+\d{4})?$|^\d{4}\s*年\s*\d{1,2}\s*月|^(一月|二月|三月|四月|五月|六月|七月|八月|九月|十月|十一月|十二月)$/i;

    const tryText = (text) => {
      const t = String(text || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > 40) return null;
      if (!headingRe.test(t)) return null;
      return Chatseek.parsePageTime(t);
    };

    // Prefer previous sticky/time-header siblings within a short ancestor chain
    let node = el;
    for (let depth = 0; depth < 8 && node; depth++) {
      let sib = node.previousElementSibling;
      let steps = 0;
      while (sib && steps < 12) {
        const direct = tryText(sib.textContent);
        if (direct) return direct;
        // Grok: sticky header div with short label; ChatGPT: div/h* with bucket label
        const inner = sib.querySelector?.(
          "h2, h3, h4, [class*='sticky'], [class*='time'], time",
        );
        if (inner) {
          const t = tryText(inner.getAttribute?.("datetime") || inner.textContent);
          if (t) return t;
        }
        sib = sib.previousElementSibling;
        steps += 1;
      }
      node = node.parentElement;
    }
    return null;
  },

  /**
   * Find a timestamp near a conversation link/row.
   * Prefers time[datetime], data-*-time attrs, then relative text, then section header.
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
        if (name === "title" && !/(\d{4}|ago|yesterday|today|昨天|今天|分钟|小时|天)/i.test(raw)) {
          continue;
        }
        const ms = Chatseek.parsePageTime(raw);
        if (ms) return ms;
      }
      // data-* wildcards
      if (node.dataset) {
        for (const [key, val] of Object.entries(node.dataset)) {
          if (!/time|date|updated|created|modify/i.test(key)) continue;
          const ms = Chatseek.parsePageTime(val);
          if (ms) return ms;
        }
      }
      return null;
    };

    // 1) time element inside link or immediate row
    const scopes = [];
    scopes.push(el);
    if (el.parentElement) scopes.push(el.parentElement);
    const row = el.closest?.(
      "li, [role='listitem'], [data-testid], tr, [class*='conversation'], [class*='history']",
    );
    if (row && !scopes.includes(row)) scopes.push(row);

    for (const scope of scopes) {
      const times = scope.querySelectorAll?.("time[datetime], time");
      if (times) {
        for (const t of times) {
          const ms = fromAttrs(t) || Chatseek.parsePageTime(t.textContent);
          if (ms) return ms;
        }
      }
      const ms = fromAttrs(scope);
      if (ms) return ms;
      // Short relative label as its own child (not the whole title)
      const kids = scope.querySelectorAll?.("span, div, p, time");
      if (kids) {
        for (const kid of kids) {
          if (kid === el || el.contains?.(kid) && kid !== el && Chatseek.textOf(kid) === Chatseek.textOf(el)) {
            // skip the title text itself when it equals the link text
          }
          const text = (kid.textContent || "").replace(/\s+/g, " ").trim();
          if (!text || text.length > 28) continue;
          if (text === Chatseek.textOf(el)) continue;
          const parsed = Chatseek.parsePageTime(text);
          if (parsed) return parsed;
        }
      }
    }

    // 2) Section / sticky header buckets (ChatGPT, Grok)
    const section = Chatseek.findSectionTime(el);
    if (section) return section;

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
      const re =
        /"(?:id|conversation_id|uuid)"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"[\s\S]{0,400}?"(?:update_time|updated_at|modifyTime|modify_time|create_time|created_at)"\s*:\s*("?(?:[\d.]+|[^"]+)"?)/gi;
      let match;
      while ((match = re.exec(blob))) {
        let raw = match[2];
        if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
        put(match[1], /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw);
      }
      // Also reverse order: time fields before id (within a small window)
      const re2 =
        /"(?:update_time|updated_at|modifyTime|modify_time)"\s*:\s*("?(?:[\d.]+|[^"]+)"?)[\s\S]{0,400}?"(?:id|conversation_id|uuid)"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi;
      while ((match = re2.exec(blob))) {
        let raw = match[1];
        if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
        put(match[2], /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw);
      }
    }

    return map;
  },

  /** Attach the best available page date onto a conversation object (mutates). */
  attachPageTime(conv, linkEl, jsonTimes) {
    if (!conv) return conv;
    let ms = null;
    if (linkEl) ms = Chatseek.findTimeNear(linkEl);
    if (!ms && jsonTimes && conv.platformId) {
      ms = jsonTimes.get(String(conv.platformId).toLowerCase()) || null;
    }
    if (ms && Chatseek.isValidMs(ms)) {
      conv.updatedAt = ms;
      if (!conv.createdAt) conv.createdAt = ms;
    }
    return conv;
  },
};
