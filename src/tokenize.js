/** Stopwords skipped only when the query still has other tokens. */
const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "in",
  "is",
  "it",
  "for",
  "on",
  "you",
  "that",
  "this",
  "with",
  "be",
  "as",
  "at",
  "by",
  "from",
  "are",
  "was",
  "were",
  "not",
  "but",
  "if",
  "we",
  "they",
  "me",
  "my",
  "your",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "can",
  "will",
  "just",
  "so",
  "than",
  "then",
  "too",
  "very",
  "about",
  "into",
  "over",
  "after",
  "also",
  "its",
  "our",
  "out",
  "up",
  "what",
  "when",
  "which",
  "who",
  "how",
  "的",
  "了",
  "在",
  "是",
  "我",
  "你",
  "他",
  "她",
  "它",
  "这",
  "那",
  "和",
  "与",
  "或",
  "也",
  "就",
  "都",
  "而",
  "及",
  "为",
  "以",
  "把",
  "被",
  "让",
  "向",
  "对",
  "从",
  "跟",
  "给",
  "到",
  "着",
  "过",
  "呢",
  "吗",
  "吧",
  "啊",
]);

const CJK =
  /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af\u3005]/;

/**
 * Token spans in NFKC-lowercased text. Latin words (len>=2), numbers, CJK
 * unigrams, and adjacent CJK bigrams. `start` is a UTF-16 index so two
 * spans from one query can be checked for the same gap in a message.
 * Does not truncate input.
 */
export function tokenSpans(text) {
  if (!text) return [];
  const lower = String(text).toLowerCase().normalize("NFKC");
  const spans = [];

  for (const match of lower.matchAll(/[a-z][a-z0-9]{1,47}/g)) {
    spans.push({ token: match[0], start: match.index });
  }
  for (const match of lower.matchAll(/[0-9]{2,24}/g)) {
    spans.push({ token: match[0], start: match.index });
  }

  const run = [];
  const flush = () => {
    if (!run.length) return;
    for (const item of run) spans.push({ token: item.ch, start: item.start });
    for (let i = 0; i < run.length - 1; i++) {
      spans.push({ token: run[i].ch + run[i + 1].ch, start: run[i].start });
    }
    run.length = 0;
  };

  let index = 0;
  for (const ch of lower) {
    if (CJK.test(ch)) run.push({ ch, start: index });
    else flush();
    index += ch.length;
  }
  flush();

  return spans;
}

/** Unique tokens, same set the inverted index has always stored. */
export function tokenize(text) {
  return [...new Set(tokenSpans(text).map((span) => span.token))];
}

export function queryTokens(text) {
  const all = tokenize(text);
  const filtered = all.filter((t) => !STOP.has(t));
  return filtered.length ? filtered : all;
}

/** Spans that survive stopword filtering, with the original start indexes kept. */
export function querySpans(text) {
  const kept = new Set(queryTokens(text));
  return tokenSpans(text).filter((span) => kept.has(span.token));
}

/**
 * Title match used by search. CJK is a substring. Latin must be a whole
 * token so "star" does not hit "starship" and "not" does not hit "notes".
 */
export function titleContainsQuery(title, needle) {
  const hay = (title || "").toLowerCase().normalize("NFKC");
  const query = (needle || "").toLowerCase().normalize("NFKC");
  if (!query || !hay.includes(query)) return false;
  if (/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/.test(query)) {
    return true;
  }
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i").test(hay);
}

export { STOP };
