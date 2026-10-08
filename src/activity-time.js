/**
 * Last-activity time for a conversation.
 *
 * Sources, highest confidence first. A lower source must not overwrite a
 * higher one. page-exact and observed are one high tier: the newer stamp wins,
 * so a message we just saw can move a clock that already had an exact page time.
 * Keep these ranks in sync with Chatseek.timeSourceRank in content/shared.js.
 *
 *   page-exact    row datetime, update_time, "3 hours ago", "Last message …"
 *   observed      a new tail message on a conversation that already had messages
 *   page-bucket   Today / Previous 7 Days and other coarse groups
 *   sidebar-rank  sort key only, interpolated from sidebar order. The label is
 *                 "before" the nearest exact/observed time above, not that key.
 *   first-seen    capture time only — not a conversation date
 *   legacy        rows saved before updatedAtSource existed (same rank as first-seen)
 *
 * A new platform adapter should set updatedAtSource to page-exact or page-bucket
 * and sidebarIndex (0 = most recently active). This module does the merge,
 * the sidebar estimate, and the side-panel label. Do not invent a per-platform copy.
 */

export const MIN_PAGE_MS = 1577836800000;

export const TIME_SOURCE_RANK = {
  "page-exact": 50,
  observed: 40,
  "page-bucket": 30,
  "sidebar-rank": 20,
  "first-seen": 10,
  legacy: 10,
};

const HIGH = new Set(["page-exact", "observed"]);

export function sourceRank(source) {
  return TIME_SOURCE_RANK[source] || 0;
}

export function isValidPageMs(ts) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return false;
  return ts >= MIN_PAGE_MS && ts <= Date.now() + 86400000 * 366;
}

function clampToNow(ms, now) {
  if (ms > now) return now;
  return ms;
}

/**
 * Bare updatedAt with no source is page-exact. That keeps pre-1.1.0 callers,
 * which only knew about a page timestamp, on the high tier.
 */
export function normalizeIncomingSource(incoming) {
  if (!incoming) return null;
  const named = incoming.updatedAtSource;
  if (named && TIME_SOURCE_RANK[named]) return named;
  if (isValidPageMs(incoming.updatedAt)) return "page-exact";
  return null;
}

/**
 * Merge one observation onto a stored row. Does not interpolate sidebar order;
 * call applySidebarEstimates on the whole sidebar batch after merging.
 */
export function mergeActivityTime(existing, incoming, now = Date.now()) {
  const incomingSource = normalizeIncomingSource(incoming);
  const incomingMs = isValidPageMs(incoming?.updatedAt)
    ? clampToNow(Math.floor(incoming.updatedAt), now)
    : null;
  const firstSeenAt = isValidPageMs(existing?.firstSeenAt)
    ? existing.firstSeenAt
    : now;

  if (!existing) {
    if (incomingSource && incomingMs && sourceRank(incomingSource) >= sourceRank("page-bucket")) {
      return {
        updatedAt: incomingMs,
        updatedAtSource: incomingSource,
        firstSeenAt,
      };
    }
    // No page time yet. Keep the sort key under real dates; the label uses firstSeenAt.
    return {
      updatedAt: MIN_PAGE_MS + 1,
      updatedAtSource: "first-seen",
      firstSeenAt,
    };
  }

  const existingSource = existing.updatedAtSource || "legacy";
  const existingMs = isValidPageMs(existing.updatedAt)
    ? Math.floor(existing.updatedAt)
    : null;

  if (!existingMs) {
    if (incomingSource && incomingMs && sourceRank(incomingSource) >= sourceRank("page-bucket")) {
      return {
        updatedAt: incomingMs,
        updatedAtSource: incomingSource,
        firstSeenAt,
      };
    }
    return {
      updatedAt: now,
      updatedAtSource: "first-seen",
      firstSeenAt,
    };
  }

  if (!incomingSource || !incomingMs) {
    if (existingSource === "legacy") {
      return {
        updatedAt: existingMs,
        updatedAtSource: "first-seen",
        firstSeenAt,
      };
    }
    return {
      updatedAt: existingMs,
      updatedAtSource: existingSource,
      firstSeenAt,
    };
  }

  if (HIGH.has(incomingSource) && HIGH.has(existingSource)) {
    if (incomingMs >= existingMs) {
      return { updatedAt: incomingMs, updatedAtSource: incomingSource, firstSeenAt };
    }
    return { updatedAt: existingMs, updatedAtSource: existingSource, firstSeenAt };
  }

  const inRank = sourceRank(incomingSource);
  const exRank = sourceRank(existingSource);
  if (inRank > exRank) {
    return { updatedAt: incomingMs, updatedAtSource: incomingSource, firstSeenAt };
  }
  if (inRank < exRank) {
    return { updatedAt: existingMs, updatedAtSource: existingSource, firstSeenAt };
  }

  if (incomingSource === "page-bucket" || incomingSource === "page-exact" || incomingSource === "observed") {
    if (incomingMs >= existingMs) {
      return { updatedAt: incomingMs, updatedAtSource: incomingSource, firstSeenAt };
    }
    return { updatedAt: existingMs, updatedAtSource: existingSource, firstSeenAt };
  }

  // sidebar-rank / first-seen must not refresh the clock to "now".
  return { updatedAt: existingMs, updatedAtSource: existingSource, firstSeenAt };
}

function isAnchor(item) {
  return isValidPageMs(item?.updatedAt) && sourceRank(item.updatedAtSource) >= sourceRank("page-bucket");
}

/** page-exact and observed only. A page-bucket instant is a point inside a range, so it is not a hard "before" bound. */
function isClockAnchor(item) {
  return isValidPageMs(item?.updatedAt) && HIGH.has(item.updatedAtSource);
}

/** latestFrom[k] = the latest anchor time at index k or below. */
function latestAnchorFrom(list) {
  const latestFrom = new Array(list.length + 1).fill(-Infinity);
  for (let k = list.length - 1; k >= 0; k--) {
    const own = isAnchor(list[k]) ? list[k].updatedAt : -Infinity;
    latestFrom[k] = Math.max(own, latestFrom[k + 1]);
  }
  return latestFrom;
}

/**
 * A stored clock is only a lower bound on that chat's activity (it may have had
 * activity we never saw). If any row below it carries a later time, the clock
 * is stale and must not be shown as an upper bound.
 */
function clockAboveAt(list, index, latestFrom) {
  for (let j = index - 1; j >= 0; j--) {
    if (isClockAnchor(list[j]) && list[j].updatedAt >= latestFrom[j + 1]) {
      return list[j].updatedAt;
    }
  }
  return null;
}

function setOlderThan(item, list, index, latestFrom) {
  const bound = clockAboveAt(list, index, latestFrom);
  if (bound) item.olderThanAt = bound;
  else delete item.olderThanAt;
}

function clearOlderThan(item) {
  delete item.olderThanAt;
}

/**
 * Sidebar order is index 0 = most recently active (pinned rows already removed).
 * Anchors are page-exact / observed / page-bucket. Everyone else is interpolated
 * between the nearest anchors. With no anchors at all, order is kept but the
 * source stays first-seen so the UI can say the date is unknown.
 *
 * olderThanAt is display-only: the nearest page-exact or observed time above
 * this row that no lower anchor contradicts. It is not a sort key. A
 * page-bucket above does not set it, but a later page-bucket below does veto it.
 */
export function applySidebarEstimates(items, now = Date.now()) {
  const list = items.map((item) => ({ ...item }));
  const anchors = [];
  list.forEach((item, index) => {
    if (isAnchor(item)) anchors.push(index);
  });

  if (!anchors.length) {
    list.forEach((item, index) => {
      if (isAnchor(item)) {
        clearOlderThan(item);
        return;
      }
      if (sourceRank(item.updatedAtSource) > sourceRank("first-seen")) {
        clearOlderThan(item);
        return;
      }
      item.updatedAtSource = "first-seen";
      item.firstSeenAt = item.firstSeenAt || now;
      item.updatedAt = MIN_PAGE_MS + (list.length - index) * 1000;
      clearOlderThan(item);
    });
    return list;
  }

  const latestFrom = latestAnchorFrom(list);
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (isAnchor(item)) {
      clearOlderThan(item);
      continue;
    }
    if (sourceRank(item.updatedAtSource) >= sourceRank("page-bucket")) {
      clearOlderThan(item);
      continue;
    }

    let above = -1;
    let below = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (isAnchor(list[j])) {
        above = j;
        break;
      }
    }
    for (let j = i + 1; j < list.length; j++) {
      if (isAnchor(list[j])) {
        below = j;
        break;
      }
    }

    let ms;
    if (above >= 0 && below >= 0) {
      const newer = list[above].updatedAt;
      const older = list[below].updatedAt;
      const span = below - above;
      const pos = i - above;
      ms = Math.round(newer - ((newer - older) * pos) / span);
      const hi = Math.max(newer, older) - 1;
      const lo = Math.min(newer, older) + 1;
      if (hi > lo) ms = Math.min(hi, Math.max(lo, ms));
    } else if (below >= 0) {
      const anchor = list[below].updatedAt;
      const gap = below - i;
      const room = Math.max(now - anchor, below);
      const step = room / (below + 1);
      ms = Math.round(anchor + step * gap);
      if (ms > now) ms = now - i;
      if (ms <= anchor) ms = Math.min(now, anchor + gap);
    } else if (above >= 0) {
      const anchor = list[above].updatedAt;
      const gap = i - above;
      ms = anchor - gap * 3600000;
      if (ms >= anchor) ms = anchor - gap * 1000;
    } else {
      item.updatedAtSource = "first-seen";
      item.firstSeenAt = item.firstSeenAt || now;
      item.updatedAt = MIN_PAGE_MS + (list.length - i) * 1000;
      clearOlderThan(item);
      continue;
    }

    ms = clampToNow(ms, now);
    if (!isValidPageMs(ms)) ms = MIN_PAGE_MS + (list.length - i) * 1000;
    item.updatedAt = ms;
    item.updatedAtSource = "sidebar-rank";
    item.firstSeenAt = item.firstSeenAt || now;
    setOlderThan(item, list, i, latestFrom);
  }
  return list;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatClock(ts, now) {
  const d = new Date(ts);
  const day = `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.getFullYear() === new Date(now).getFullYear() ? day : `${d.getFullYear()}/${day}`;
}

function formatAbsolute(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatHm(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * zh-Hant carries the owner's strings verbatim.
 * A sidebar-rank row under a page-exact or observed anchor says 「早於 <absolute>」.
 * 「約」 remains only for a page-bucket group. No clock above → 「日期未知（收錄於 …）」.
 * zh-Hans matches the rest of the Simplified side panel so one label never mixes scripts.
 * The anchor stamp is YYYY-MM-DD HH:mm (the same absolute form as the tooltip),
 * so the words do not drift into another relative guess as time passes.
 */
const STRINGS = {
  en: {
    noDate: "no date",
    justNow: "just now",
    minutes: (n) => `${n}m ago`,
    hours: (n) => `${n}h ago`,
    days: (n) => `${n}d ago`,
    approx: (when) => `~ ${when}`,
    before: (stamp) => `before ${stamp}`,
    beforeTitle: (stamp) => `Older than the nearest exact time above · ${stamp}`,
    unknown: "Unknown date",
    unknownSaved: (stamp) => `Unknown date (saved ${stamp})`,
    saved: (stamp) => `Saved ${stamp}`,
    fromGroup: "Estimated from the sidebar group",
    temporary: (name) => `${name}: temporary chats are not saved`,
    warn: (name, hhmm) => `${name} page may have changed — please report (last capture ${hhmm}, 0 messages)`,
    thread: (name, hhmm, n) => `${name}: last capture ${hhmm}, ${n} messages`,
    sidebar: (name, hhmm, n) => `${name}: last capture ${hhmm}, ${n} sidebar chats`,
  },
  "zh-Hant": {
    noDate: "無日期",
    justNow: "剛剛",
    minutes: (n) => `${n} 分鐘前`,
    hours: (n) => `${n} 小時前`,
    days: (n) => `${n} 天前`,
    approx: (when) => `約 ${when}`,
    before: (stamp) => `早於 ${stamp}`,
    beforeTitle: (stamp) => `比上方最近一則確切時間更早 · ${stamp}`,
    unknown: "日期未知",
    unknownSaved: (stamp) => `日期未知（收錄於 ${stamp}）`,
    saved: (stamp) => `收錄於 ${stamp}`,
    fromGroup: "推估：依側欄分組",
    temporary: (name) => `${name} 臨時聊天不會收錄`,
    warn: (name, hhmm) => `${name} 頁面可能改版，請回報（最後收錄 ${hhmm}，0 則訊息）`,
    thread: (name, hhmm, n) => `${name}：最後收錄 ${hhmm}，${n} 則訊息`,
    sidebar: (name, hhmm, n) => `${name}：最後收錄 ${hhmm}，側欄 ${n} 條`,
  },
  "zh-Hans": {
    noDate: "无日期",
    justNow: "刚刚",
    minutes: (n) => `${n} 分钟前`,
    hours: (n) => `${n} 小时前`,
    days: (n) => `${n} 天前`,
    approx: (when) => `约 ${when}`,
    before: (stamp) => `早于 ${stamp}`,
    beforeTitle: (stamp) => `比上方最近一则确切时间更早 · ${stamp}`,
    unknown: "日期未知",
    unknownSaved: (stamp) => `日期未知（收录于 ${stamp}）`,
    saved: (stamp) => `收录于 ${stamp}`,
    fromGroup: "推估：按侧栏分组",
    temporary: (name) => `${name} 临时聊天不会收录`,
    warn: (name, hhmm) => `${name} 页面可能改版，请回报（最后收录 ${hhmm}，0 则消息）`,
    thread: (name, hhmm, n) => `${name}：最后收录 ${hhmm}，${n} 则消息`,
    sidebar: (name, hhmm, n) => `${name}：最后收录 ${hhmm}，侧栏 ${n} 条`,
  },
};

/** "zh-TW" / "zh-HK" / "zh-MO" / "zh-Hant-*" → zh-Hant; any other zh → zh-Hans. */
export function labelLocale(locale) {
  const tag = String(locale || "").toLowerCase();
  if (!tag.startsWith("zh")) return "en";
  return /^zh(?:-hant|-tw|-hk|-mo)(?:-|$)/.test(tag) ? "zh-Hant" : "zh-Hans";
}

function stringsFor(locale) {
  return STRINGS[labelLocale(locale)];
}

function relativeLabel(ts, now, s) {
  if (!isValidPageMs(ts)) return s.noDate;
  const delta = now - ts;
  const m = Math.floor(delta / 60000);
  if (m < 1) return s.justNow;
  if (m < 60) return s.minutes(m);
  const h = Math.floor(m / 60);
  if (h < 48) return s.hours(h);
  const days = Math.floor(h / 24);
  if (days >= 7) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return s.days(days);
}

/** Side-panel label. page-exact and observed render as a normal last-activity time. */
export function formatActivityLabel(conv, now = Date.now(), locale = "en") {
  const s = stringsFor(locale);
  const source = conv?.updatedAtSource || "legacy";
  const saved = isValidPageMs(conv?.firstSeenAt)
    ? conv.firstSeenAt
    : isValidPageMs(conv?.createdAt)
      ? conv.createdAt
      : isValidPageMs(conv?.updatedAt)
        ? conv.updatedAt
        : null;

  if (source === "first-seen" || source === "legacy" || !conv?.updatedAtSource) {
    const stamp = saved ? formatClock(saved, now) : "";
    return {
      text: stamp ? s.unknownSaved(stamp) : s.unknown,
      title: stamp ? s.saved(stamp) : s.unknown,
      source,
      approx: false,
      unknown: true,
    };
  }

  if (source === "sidebar-rank") {
    if (isValidPageMs(conv.olderThanAt)) {
      const stamp = formatAbsolute(conv.olderThanAt);
      return {
        text: s.before(stamp),
        title: s.beforeTitle(stamp),
        source,
        approx: false,
        unknown: false,
        before: true,
      };
    }
    const stamp = saved ? formatClock(saved, now) : "";
    return {
      text: stamp ? s.unknownSaved(stamp) : s.unknown,
      title: stamp ? s.saved(stamp) : s.unknown,
      source,
      approx: false,
      unknown: true,
      before: false,
    };
  }

  const when = relativeLabel(conv.updatedAt, now, s);
  if (source === "page-bucket") {
    const absolute = isValidPageMs(conv.updatedAt) ? formatAbsolute(conv.updatedAt) : "";
    return {
      text: s.approx(when),
      title: absolute ? `${s.fromGroup} · ${absolute}` : s.fromGroup,
      source,
      approx: true,
      unknown: false,
      before: false,
    };
  }

  return {
    text: when,
    title: isValidPageMs(conv.updatedAt) ? formatAbsolute(conv.updatedAt) : when,
    source,
    approx: false,
    unknown: false,
    before: false,
  };
}

const PLATFORM_LABEL = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  grok: "Grok",
  gemini: "Gemini",
};

export function healthHasWarning(byPlatform) {
  return Object.values(byPlatform || {}).some((row) => row && row.warn);
}

/** One footer line per platform that has reported. Unknown ids still get a line. */
export function formatHealthEntries(byPlatform, now = Date.now(), locale = "en") {
  const s = stringsFor(locale);
  const lines = [];
  for (const [platform, row] of Object.entries(byPlatform || {})) {
    if (!row || typeof row !== "object") continue;
    const name = PLATFORM_LABEL[platform] || platform;
    const hhmm = formatHm(row.at || now);
    const count = Number(row.messageCount) || 0;
    const sidebarCount = Number(row.sidebarCount) || 0;
    let text;
    if (row.pathKind === "temporary") text = s.temporary(name);
    else if (row.warn) text = s.warn(name, hhmm);
    else if (row.pathKind === "conversation") text = s.thread(name, hhmm, count);
    else text = s.sidebar(name, hhmm, sidebarCount);
    lines.push({ platform, text, warn: !!row.warn });
  }
  return lines;
}
