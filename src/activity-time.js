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

import { fill, intlTag, resolveLocale, text } from "./i18n.js";

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

/**
 * Comparable prefix of a turn. Markdown markers the DOM walker adds are
 * ignored so a re-key of the same sentence still matches the stored tail.
 * Only the first 180 characters are used; a stable id plus tailBodyChanged
 * covers growth past that.
 */
export function activityKey(body) {
  const raw = String(body || "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (!raw) return "";
  return raw
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[*_`#[\]()>~]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

/**
 * The page turn is the stored tail, or a short trim of it.
 * A longer page turn that merely begins with a short tail is not: that would
 * mark an old window as "just now" when the real ending is not on screen.
 */
export function tailTextSeen(storedBody, pageBody) {
  const storedKey = activityKey(storedBody);
  const pageKey = activityKey(pageBody);
  if (!storedKey || !pageKey) return false;
  if (storedKey === pageKey) return true;
  return storedKey.startsWith(pageKey) &&
    pageKey.length >= Math.min(storedKey.length, 80) &&
    pageKey.length >= storedKey.length * 0.8;
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

/**
 * The page ends later than the tail we already stored.
 * A new ending is high-confidence activity: the caller stamps "observed" at
 * now, and mergeActivityTime keeps the newer of that and an exact page time.
 * The same ending, a shorter repaint, scrollback, or the first ingest is not.
 *
 * pageBodies are this chunk only. sawStoredTail is set when an earlier chunk
 * of the same capture already showed the stored tail text (ids were re-keyed).
 */
export function pageShowsNewActivity({
  baselineCount = 0,
  baselineTail = "",
  baselineTailBody = "",
  pageIds = [],
  pageBodies = [],
  tailBodyChanged = false,
  sawStoredTail = false,
} = {}) {
  if (!(Number(baselineCount) > 0) || !pageIds?.length) return false;
  const pageTail = pageIds[pageIds.length - 1];
  const byId = new Map();
  for (const row of pageBodies || []) {
    if (row?.id) byId.set(row.id, String(row.body || ""));
  }
  const hasEnding = byId.has(pageTail);
  const ending = hasEnding ? String(byId.get(pageTail) || "") : "";
  const storedKey = activityKey(baselineTailBody);
  const endingKey = activityKey(ending);

  if (baselineTail && pageIds.includes(baselineTail)) {
    if (pageTail === baselineTail) return !!tailBodyChanged;
    // The tail id moved. Wait for the chunk that actually carries the ending
    // so a shorter repaint is not treated as a new message.
    if (!hasEnding) return false;
    if (storedKey && endingKey && (endingKey === storedKey ||
      (storedKey.startsWith(endingKey) && endingKey.length < storedKey.length))) {
      return false;
    }
    return true;
  }

  // The stored tail id is gone (hash, heuristic, shadow, iframe). Match text.
  if (!storedKey || !hasEnding || !endingKey) return false;
  if (endingKey === storedKey) return false;
  if (storedKey.startsWith(endingKey) && endingKey.length < storedKey.length) return false;
  if (endingKey.startsWith(storedKey) && endingKey.length > storedKey.length) return true;

  let seen = !!sawStoredTail;
  if (!seen) {
    for (const id of pageIds) {
      if (id === pageTail || !byId.has(id)) continue;
      if (tailTextSeen(baselineTailBody, byId.get(id))) {
        seen = true;
        break;
      }
    }
  }
  return seen;
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
 * source stays first-seen so the UI can label the actual capture time.
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

function intlFormat(ts, locale, options) {
  return new Intl.DateTimeFormat(intlTag(locale), options).format(new Date(ts));
}

const TIME_OPTS = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
const DAY_OPTS = { year: "numeric", month: "2-digit", day: "2-digit" };

/** Calendar day in the local timezone, for tests that check which day a group is. */
export function calendarDay(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Locale date, via Intl. Group labels use this and never a clock time. */
export function formatDayStamp(ts, locale = "en") {
  return intlFormat(ts, locale, DAY_OPTS);
}

/** Locale date and time, via Intl. The before-bound uses this absolute form. */
export function formatAbsoluteStamp(ts, locale = "en") {
  return intlFormat(ts, locale, { ...DAY_OPTS, ...TIME_OPTS });
}

function formatClock(ts, now, locale) {
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  const options = sameYear ? { month: "2-digit", day: "2-digit", ...TIME_OPTS } : { ...DAY_OPTS, ...TIME_OPTS };
  return intlFormat(ts, locale, options);
}

function formatHm(ts, locale) {
  return intlFormat(ts, locale, TIME_OPTS);
}

/**
 * Words live in src/i18n.js (and _locales). A sidebar-rank row under a
 * page-exact or observed anchor says 「早於 <absolute>」. A page-bucket group
 * says 「約 <day>」: its stored instant is a made-up point inside the group
 * (Today is the midpoint of the day so far), so no clock time is shown.
 * No clock above → 「收錄於 …」（不是網站活動時間）. The anchor stamp is an Intl
 * absolute time for that locale, so the words do not drift into another
 * relative guess as time passes.
 *
 * labelLocale stays the old three-way tag for callers that only branched
 * on script. formatActivityLabel resolves the full catalog (ja, fr, …).
 */
export function labelLocale(locale) {
  const code = resolveLocale(locale);
  if (code === "zh-TW") return "zh-Hant";
  if (code === "zh-CN") return "zh-Hans";
  return "en";
}

function stringsFor(locale) {
  const say = (key, ...args) => fill(text(locale, key), ...args);
  return {
    noDate: say("noDate"),
    justNow: say("justNow"),
    minutes: (n) => say("minutes", n),
    hours: (n) => say("hours", n),
    days: (n) => say("days", n),
    approx: (when) => say("approx", when),
    before: (stamp) => say("before", stamp),
    beforeTitle: (stamp) => say("beforeTitle", stamp),
    unknown: say("unknown"),
    unknownSaved: (stamp) => say("unknownSaved", stamp),
    saved: (stamp) => say("saved", stamp),
    fromGroup: say("fromGroup"),
    temporary: (name) => say("temporary", name),
    warn: (name, hhmm) => say("warn", name, hhmm),
    thread: (name, hhmm, n) => say("thread", name, hhmm, n),
    sidebar: (name, hhmm, n) => say("sidebarHealth", name, hhmm, n),
  };
}

function relativeLabel(ts, now, s, locale) {
  if (!isValidPageMs(ts)) return s.noDate;
  const delta = now - ts;
  const m = Math.floor(delta / 60000);
  if (m < 1) return s.justNow;
  if (m < 60) return s.minutes(m);
  const h = Math.floor(m / 60);
  if (h < 48) return s.hours(h);
  const days = Math.floor(h / 24);
  if (days >= 7) return formatDayStamp(ts, locale);
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
    const stamp = saved ? formatClock(saved, now, locale) : "";
    return {
      text: stamp ? s.saved(stamp) : s.unknown,
      title: stamp ? s.saved(stamp) : s.unknown,
      source,
      approx: false,
      unknown: true,
    };
  }

  if (source === "sidebar-rank") {
    if (isValidPageMs(conv.olderThanAt)) {
      const stamp = formatAbsoluteStamp(conv.olderThanAt, locale);
      return {
        text: s.before(stamp),
        title: s.beforeTitle(stamp),
        source,
        approx: false,
        unknown: false,
        before: true,
      };
    }
    const stamp = saved ? formatClock(saved, now, locale) : "";
    return {
      text: stamp ? s.saved(stamp) : s.unknown,
      title: stamp ? s.saved(stamp) : s.unknown,
      source,
      approx: false,
      unknown: true,
      before: false,
    };
  }

  const when = relativeLabel(conv.updatedAt, now, s, locale);
  if (source === "page-bucket") {
    const day = isValidPageMs(conv.updatedAt) ? formatDayStamp(conv.updatedAt, locale) : "";
    return {
      text: s.approx(day || when),
      title: day ? `${s.fromGroup} · ${day}` : s.fromGroup,
      source,
      approx: true,
      unknown: false,
      before: false,
    };
  }

  return {
    text: when,
    title: isValidPageMs(conv.updatedAt) ? formatAbsoluteStamp(conv.updatedAt, locale) : when,
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
    const hhmm = formatHm(row.at || now, locale);
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
