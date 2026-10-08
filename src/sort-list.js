/**
 * Side-panel list order. Sorts conversation records only — never message bodies.
 *
 * Last-activity keeps uncertain dates from pretending to be exact clocks.
 * Confident rows (page-exact / observed) stay first in both directions.
 * Then 約 (page-bucket), 早於 (sidebar-rank with an anchor), and 日期未知.
 * Direction flips order inside a tier, not the tier order. 早於 keeps the
 * interpolated updatedAt key that applySidebarEstimates already stored.
 */

import { isValidPageMs } from "./activity-time.js";
import { intlTag } from "./i18n.js";
import { querySpans, queryTokens, titleContainsQuery } from "./tokenize.js";

export const SORT_KEY = "chatseek.listSort";

export const BROWSE_FIELDS = ["activity", "title", "captured", "count"];
export const SEARCH_FIELDS = ["relevance", ...BROWSE_FIELDS];

const DEFAULT_DIRS = {
  activity: "desc",
  title: "asc",
  captured: "desc",
  count: "desc",
  relevance: "desc",
};

export function defaultSortPref() {
  return {
    field: "activity",
    dirs: { ...DEFAULT_DIRS },
    searchField: "relevance",
    searchDirs: { ...DEFAULT_DIRS },
  };
}

function copyDirs(raw, allowed) {
  const dirs = { ...DEFAULT_DIRS };
  if (!raw || typeof raw !== "object") return dirs;
  for (const field of allowed) {
    if (raw[field] === "asc" || raw[field] === "desc") dirs[field] = raw[field];
  }
  return dirs;
}

/** Read the saved browse sort and the separate search sort. Bad JSON falls back. */
export function parseSortPref(raw) {
  const base = defaultSortPref();
  if (!raw) return base;
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return base;
    }
  }
  if (!parsed || typeof parsed !== "object") return base;
  if (BROWSE_FIELDS.includes(parsed.field)) base.field = parsed.field;
  if (SEARCH_FIELDS.includes(parsed.searchField)) base.searchField = parsed.searchField;
  base.dirs = copyDirs(parsed.dirs, BROWSE_FIELDS);
  base.searchDirs = copyDirs(parsed.searchDirs, SEARCH_FIELDS);
  return base;
}

export function readSortPref(storage = globalThis.localStorage) {
  try {
    return parseSortPref(storage?.getItem?.(SORT_KEY));
  } catch {
    return defaultSortPref();
  }
}

export function writeSortPref(pref, storage = globalThis.localStorage) {
  try {
    storage?.setItem?.(SORT_KEY, JSON.stringify(parseSortPref(pref)));
  } catch {
    // The panel still sorts this view if storage is unavailable.
  }
}

/** 0 exact, 1 約, 2 早於, 3 日期未知. Missing source stays unknown, matching the label. */
export function activityTier(conv) {
  const source = conv?.updatedAtSource;
  if (source === "page-exact" || source === "observed") return 0;
  if (source === "page-bucket") return 1;
  if (source === "sidebar-rank" && isValidPageMs(conv?.olderThanAt)) return 2;
  return 3;
}

export function captureMs(conv) {
  if (isValidPageMs(conv?.firstSeenAt)) return conv.firstSeenAt;
  if (isValidPageMs(conv?.createdAt)) return conv.createdAt;
  return 0;
}

/** Title-only rows and missing counts sort as zero messages. */
export function messageCountOf(conv) {
  const n = Number(conv?.messageCount);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function visibleTitle(conv) {
  return String(conv?.title || conv?.platformId || "");
}

const collators = new Map();

export function collatorFor(locale) {
  const tag = intlTag(locale || "en");
  let collator = collators.get(tag);
  if (!collator) {
    collator = new Intl.Collator(tag, { usage: "sort", sensitivity: "variant", numeric: true });
    collators.set(tag, collator);
  }
  return collator;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function byId(a, b) {
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

/**
 * @param {{ field?: string, dir?: "asc" | "desc", locale?: string }} sort
 * dir desc means larger / newer / Z first, except title where asc is A→Z.
 */
export function compareConversations(a, b, sort = {}) {
  const field = sort.field || "activity";
  const dir = sort.dir === "asc" || sort.dir === "desc"
    ? sort.dir
    : DEFAULT_DIRS[field] || "desc";
  let cmp = 0;
  if (field === "activity") {
    const tier = activityTier(a) - activityTier(b);
    if (tier) return tier;
    cmp = num(a?.updatedAt) - num(b?.updatedAt);
  } else if (field === "title") {
    cmp = collatorFor(sort.locale).compare(visibleTitle(a), visibleTitle(b));
  } else if (field === "captured") {
    cmp = captureMs(a) - captureMs(b);
  } else if (field === "count") {
    cmp = messageCountOf(a) - messageCountOf(b);
  } else if (field === "relevance") {
    cmp = num(a?.relevance) - num(b?.relevance);
  } else {
    cmp = num(a?.updatedAt) - num(b?.updatedAt);
  }
  if (dir !== "asc") cmp = -cmp;
  if (cmp) return cmp;
  // Equal relevance stays newer-first in both directions. Direction only
  // reverses rows whose scores differ.
  if (field === "relevance") {
    const newer = num(b?.updatedAt) - num(a?.updatedAt);
    if (newer) return newer;
  }
  return byId(a, b);
}

export function sortConversations(items, sort) {
  return items.slice().sort((a, b) => compareConversations(a, b, sort));
}

/**
 * Local additive relevance. No model and no embeddings.
 * Tune these together. The five sort rules stay true while:
 * TITLE > PHRASE + USER * HIT_CAP
 * PHRASE > USER * HIT_CAP
 * USER > ASSISTANT * HIT_CAP
 * POSITION_CAP is how many offsets one source keeps so a phrase can still
 * be recognized. It is not added to the score.
 */
export const RELEVANCE_WEIGHT = {
  TITLE: 10000,
  PHRASE: 1000,
  USER: 100,
  ASSISTANT: 10,
  HIT_CAP: 8,
  POSITION_CAP: 32,
};

function positionsAlign(spans, positionsByToken) {
  if (!spans.length) return false;
  const anchors = positionsByToken.get(spans[0].token);
  if (!anchors?.length) return false;
  for (const pos of anchors) {
    const delta = pos - spans[0].start;
    let ok = true;
    for (let i = 1; i < spans.length; i++) {
      const list = positionsByToken.get(spans[i].token);
      if (!list?.includes(spans[i].start + delta)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Score one conversation from its title and the token-index rows search
 * already read. Postings are { token, source, role, positions }. Title
 * rows are not body hits. A missing role counts as an assistant reply.
 * A missing positions list cannot prove a phrase.
 */
export function relevanceScore(conv, query, postings = []) {
  const { TITLE, PHRASE, USER, ASSISTANT, HIT_CAP } = RELEVANCE_WEIGHT;
  const q = String(query || "").trim();
  const tokens = queryTokens(q);
  const tokenSet = new Set(tokens);
  const title = String(conv?.title || "");
  let score = 0;
  const titleHit = tokens.some((token) => titleContainsQuery(title, token))
    || titleContainsQuery(title, q);
  if (titleHit) score += TITLE;

  const spans = querySpans(q);
  let phrase = titleContainsQuery(title, q);
  const sources = new Map();
  for (const row of postings) {
    if (!row || row.source == null || row.source === "title") continue;
    if (!tokenSet.has(row.token)) continue;
    let source = sources.get(row.source);
    if (!source) {
      source = { role: "assistant", positions: new Map() };
      sources.set(row.source, source);
    }
    if (row.role === "user") source.role = "user";
    if (Array.isArray(row.positions) && row.positions.length) {
      source.positions.set(row.token, row.positions);
    }
  }
  if (!phrase) {
    for (const source of sources.values()) {
      if (positionsAlign(spans, source.positions)) {
        phrase = true;
        break;
      }
    }
  }
  if (phrase) score += PHRASE;

  const ranked = [...sources.values()].sort((a, b) => {
    if (a.role === b.role) return 0;
    return a.role === "user" ? -1 : 1;
  });
  for (const source of ranked.slice(0, HIT_CAP)) {
    score += source.role === "user" ? USER : ASSISTANT;
  }
  return score;
}

export function activeSort(pref, { searching = false, locale = "en" } = {}) {
  const choice = parseSortPref(pref);
  const field = searching ? choice.searchField : choice.field;
  const dirs = searching ? choice.searchDirs : choice.dirs;
  return { field, dir: dirs[field] || DEFAULT_DIRS[field] || "desc", locale };
}

const LABEL_KEY = {
  activity: "sortActivity",
  title: "sortTitle",
  captured: "sortCaptured",
  count: "sortCount",
  relevance: "sortRelevance",
};

export function sortLabelKey(field) {
  return LABEL_KEY[field] || LABEL_KEY.activity;
}

export function directionLabelKey(field, dir) {
  if (field === "title") return dir === "asc" ? "sortDirAz" : "sortDirZa";
  if (field === "count" || field === "relevance") {
    return dir === "desc" ? "sortDirMore" : "sortDirFewer";
  }
  return dir === "desc" ? "sortDirNewest" : "sortDirOldest";
}
