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
 * Tokenize for the inverted index. Latin words (len>=2) plus CJK unigrams
 * and adjacent bigrams. Does not truncate input.
 */
export function tokenize(text) {
  if (!text) return [];
  const tokens = new Set();
  const lower = String(text).toLowerCase().normalize("NFKC");

  for (const match of lower.matchAll(/[a-z][a-z0-9]{1,47}/g)) {
    tokens.add(match[0]);
  }
  for (const match of lower.matchAll(/[0-9]{2,24}/g)) {
    tokens.add(match[0]);
  }

  const run = [];
  const flush = () => {
    if (!run.length) return;
    for (const ch of run) tokens.add(ch);
    for (let i = 0; i < run.length - 1; i++) {
      tokens.add(run[i] + run[i + 1]);
    }
    run.length = 0;
  };

  for (const ch of lower) {
    if (CJK.test(ch)) run.push(ch);
    else flush();
  }
  flush();

  return [...tokens];
}

export function queryTokens(text) {
  const all = tokenize(text);
  const filtered = all.filter((t) => !STOP.has(t));
  return filtered.length ? filtered : all;
}

export { STOP };
