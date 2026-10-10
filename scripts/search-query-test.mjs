import { performance } from "node:perf_hooks";
import { JSDOM } from "jsdom";
import { parseSearchQuery, globMatches, syntaxRanges, syntaxBodyRanges, clauseMatchesText, QUERY_LIMITS } from "../src/search-query.js";
import { buildPreview, fillHighlight, findMatchRanges } from "../src/preview.js";
import { collectHits, mountReader } from "../src/reader-view.js";
import { titleContainsQuery } from "../src/tokenize.js";

let checks = 0;
function assert(value, label) { checks++; if (!value) throw new Error(label); }
const syntax = (query) => parseSearchQuery(query);
const slices = (text, query, field) => syntaxRanges(text, query, field).map(([start, end]) => text.slice(start, end));

for (const raw of ["", "orchid", "音乐 京都", '"unclosed', 'orchid "unclosed', "-", "*", "***", "title:", "-title:", 'title:""', '-""', "-draft", '-"blue orchid"', "-title:draft", '"blue"orchid', "chat* title:", "--draft", 'title:foo"bar']) {
  assert(syntax(raw).mode === "plain", `fallback: ${raw}`);
}
const combined = syntax('title:"old camera" chat* -draft -"red orchid" -title:archive');
assert(combined.mode === "syntax" && combined.clauses.length === 5, "five composable clauses");
assert(combined.clauses.filter((clause) => clause.exclude).length === 3, "three exclusions");
assert(syntax('orchid -draft').clauses[0].tokens.join() === "orchid", "operator is not an index token");
assert(syntax('the orchid -draft').clauses[0].tokens.join() === "orchid", "ordinary stopwords still filtered");
assert(syntax('title:the').clauses[0].tokens.join() === "the", "explicit title stopword can be searched");
assert(slices("Blue orchid, blue  orchid", '"blue orchid"').join() === "Blue orchid", "whole exact phrase with literal spacing");
assert(slices("Chat chatseek chatter achat", "chat*").join() === "Chat,chatseek,chatter", "wildcard paints actual whole words");
assert(slices("chatseek checkout chat", "ch*t").join() === "checkout,chat", "infix wildcard anchors both ends");
assert(slices("hat chatseek chat", "*hat").join() === "hat,chat", "leading wildcard");
assert(slices("舊相機新相機", "相*機").length === 0, "CJK glob anchors the entire CJK run");
assert(slices("舊相機 新相機", "*相機").join() === "舊相機,新相機", "CJK wildcard uses character runs");
assert(slices("ＣＨＡＴＳＥＥＫ blue ﬂower", 'chat* "blue flower"').join() === "ＣＨＡＴＳＥＥＫ,blue ﬂower", "NFKC retains source offsets");
assert(slices("가", '"가"').join() === "가", "decomposed Hangul maps to the complete grapheme");
assert(slices("가", "title:가", "title").join() === "가", "Korean title highlights agree with token normalization");
assert(slices("ΟΣ", '"ΟΣ"').join() === "ΟΣ", "whole-string lowercase preserves contextual sigma matching");
assert(slices("draft camera chatting", "chat* -draft -title:camera").join() === "chatting", "exclusions never highlighted");
assert(slices("old camera", 'title:"old camera"').length === 0, "title clause never paints body");
assert(slices("old camera", 'title:"old camera"', "title").join() === "old camera", "title phrase paints full title");
assert(clauseMatchesText("starship", syntax("title:star").clauses[0]) === false, "Latin title word remains exact");
assert(clauseMatchesText("旧相机笔记", syntax("title:相机").clauses[0]), "CJK title substring");
for (const [word, pattern, want] of [["chat", "chat*", true], ["chat", "ch*t", true], ["aa", "a*a", true], ["a", "a*a", false], ["abc", "a**b*c", true], ["abc", "a*c*b", false], ["abcdef", "*b*d*f", true]]) {
  assert(globMatches(word, pattern) === want, `glob ${word} / ${pattern}`);
}
const start = performance.now();
for (const raw of ['"' + "x".repeat(200_000), "a*".repeat(20_000) + "z", "word ".repeat(5000), "a" + "*".repeat(10_000)]) {
  assert(syntax(raw).mode === "plain", "long input falls back intact");
  assert(syntax(raw).raw === raw.trim(), "fallback does not truncate the ordinary query");
  assert(collectHits("notes", [{ id: "m", body: "quiet garden" }], raw).length === 0, "fallback reader never compiles huge regexes");
  assert(buildPreview({ title: "Notes", messageCount: 1 }, raw, ["quiet garden"]).ranges.length === 0, "fallback preview never compiles huge regexes");
}
const hugeLiteral = '"' + "x".repeat(200_000);
assert(titleContainsQuery(hugeLiteral, hugeLiteral), "huge literal title lookup never throws");
assert(syntax("title:x ".repeat(QUERY_LIMITS.clauses + 1)).mode === "plain", "clause cap falls back");
assert(globMatches("a".repeat(100_000), "a*".repeat(60) + "z") === false, "hostile stars finish without backtracking");
assert(findMatchRanges("啊".repeat(160_000), ["啊"])[0]?.[1] === 160_000, "dense ordinary matches cannot exceed the call argument limit");
assert(performance.now() - start < 2000, "attack samples finish in bounded time");
const payload = "(a+)+$ [x] ^foo$ \\ <script>";
for (const term of payload.split(" ")) {
  assert(slices("before " + term + " after", '"' + term + '"').join() === term, `regex characters literal: ${term}`);
}

const body = 'Walk to **blue** orchid with `chatseek`; [blue orchid](https://example.com/hidden).';
const query = '"blue orchid" chat* -draft';
const ranges = syntaxBodyRanges(body, query);
assert(ranges.length === 3, "Markdown phrase crosses emphasis and link labels");
assert(body.slice(...ranges[0]).includes("blue** orchid"), "reader range uses original Markdown offsets");
assert(!syntaxBodyRanges(body, '"hidden"').length, "link destinations excluded");
assert(!syntaxBodyRanges('`https://example.com/hello`', '"example.com"').length, "code URL exclusion stays aligned with the old index");
const preview = buildPreview({ title: "Camera chatseek", messageCount: 1 }, query, [body]);
assert(preview.kind === "snippet" && preview.ranges.length === 3, "preview uses syntax and visible prose");
assert(preview.text.slice(...preview.ranges[0]) === "blue orchid", "preview paints whole phrase");
const spaced = buildPreview({ title: "Notes", messageCount: 1 }, '"blue  orchid"', ["before blue  orchid after"]);
assert(spaced.kind === "snippet" && spaced.text.slice(...spaced.ranges[0]) === "blue orchid", "preview matches before collapsing whitespace");
const unspaced = buildPreview({ title: "blue orchid", firstUserPreview: "blue  orchid", messageCount: 1 }, '"blue orchid"', ["blue  orchid"]);
assert(unspaced.ranges.length === 0, "preview cannot add a false phrase after collapsing whitespace");
const dom = new JSDOM("<!doctype html><body><div id='app'></div></body>");
const doc = dom.window.document;
const host = doc.getElementById("app");
fillHighlight(host, "<script>unsafe</script>", syntaxRanges("<script>unsafe</script>", '"<script>"'));
assert(!host.querySelector("script") && host.querySelector("mark").textContent === "<script>", "HTML search is text only");
const messages = Array.from({ length: 180 }, (_, i) => ({ id: `m${i}`, role: "user", body: i === 150 ? body : "quiet garden draft" }));
const hits = collectHits("Camera chatseek", messages, query);
assert(hits.length === 4 && hits.filter((hit) => hit.where === "message").every((hit) => hit.messageIndex === 150), "reader excludes negative terms from hits");
const view = mountReader(host, { conversation: { id: "chatgpt:sample", title: "Camera", platform: "chatgpt" }, messages, query, viewportHeight: 640 });
assert(view.hitCount() === 3, "reader counts syntax hits");
assert(host.querySelector('.msg[data-index="150"] mark.is-current'), "reader jumps to distant phrase");
view.next();
assert(host.querySelector("mark.is-current")?.textContent === "chatseek", "next hit jumps to wildcard word");
dom.window.close();
console.log("search-query-test ok", { checks });
