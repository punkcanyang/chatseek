import "fake-indexeddb/auto";
import { openDb, clearAll, upsertMessages, upsertConversations, searchConversations, attachPreviews } from "../src/db.js";
import { collectHits } from "../src/reader-view.js";

let checks = 0;
function assert(value, label) { checks++; if (!value) throw new Error(label); }
await clearAll();
const conv = (id, title, archived = false) => ({ id: `chatgpt:${id}`, platform: "chatgpt", platformId: id, title, archived, url: `https://chatgpt.com/c/${id}`, updatedAt: 1700000000000 });
async function put(id, title, bodies, role = "user", archived = false) {
  await upsertMessages(conv(id, title, archived), bodies.map((body, i) => ({ id: `${id}:m${i}`, role, body })), { captureId: id });
}
const ids = async (query, options = {}) => (await searchConversations({ query, limit: 100, ...options })).map((row) => row.id.replace("chatgpt:", "")).sort().join();
await put("title", "old camera blue orchid chatseek", ["quiet garden"]);
await put("body", "old camera field notes", ["Visit **blue** orchid with chatseek"]);
await put("split", "old camera diary", ["blue", "orchid chatseek"]);
await put("draft", "old camera draft", ["blue orchid chatseek"]);
await put("excluded", "old camera clean", ["blue orchid chatseek", "unfinished draft"]);
await put("assistant", "old camera reply", ["blue orchid chatseek"], "assistant");
await put("archive", "old camera archived", ["blue orchid chatseek"], "user", true);
await put("different", "new camera", ["blue orchid chatter"]);
await upsertConversations([conv("title-only", "old camera blue orchid chat")]);
assert(await ids('"blue orchid"') === "archive,assistant,body,different,draft,excluded,title,title-only", "exact phrase excludes split messages");
assert(await ids('title:"old camera" "blue orchid" chat* -draft') === "archive,assistant,body,title,title-only", "combined filters see all body messages and title exclusion");
assert(await ids('title:"old camera" "blue orchid" chat* -title:draft') === "archive,assistant,body,excluded,title,title-only", "title exclusion does not exclude body-only draft");
assert(await ids('"blue orchid" -"unfinished draft"') === "archive,assistant,body,different,draft,title,title-only", "negative phrase verifies a different message");
assert(await ids('title:"blue orchid"') === "title,title-only", "title phrase restricts body hits");
assert(await ids("chat*") === "archive,assistant,body,different,draft,excluded,split,title,title-only", "prefix wildcard uses token index");
assert(await ids("*seek") === "archive,assistant,body,draft,excluded,split,title", "suffix wildcard verifies bodies");
assert(await ids('title:camera "blue orchid"', { scope: "active" }) === "assistant,body,different,draft,excluded,title,title-only", "scope excludes archives");
assert(await ids('"blue orchid"', { platform: "gemini" }) === "", "platform scope preserved");
assert(await ids('blue orchid -title:draft') === "archive,assistant,body,different,excluded,split,title,title-only", "ordinary AND can match separate messages");
for (const invalid of ['"unclosed', "-", "*", "title:", "-draft", '-"blue orchid"', '-title:draft']) {
  const rows = await searchConversations({ query: invalid });
  assert(Array.isArray(rows), `invalid syntax never throws: ${invalid}`);
}
const plainDraft = await ids("draft");
assert(await ids("-draft") === plainDraft, "exclude-only falls back to ordinary indexed search");
await put("small", "short letters", ["a x abba"]);
assert(await ids("a*") === "archive,small", "one-letter wildcard is not lost by the old index");
await put("number", "numeric note", ["123abc"]);
assert(await ids("123a*") === "number", "digit-leading wildcard follows legacy split numeric indexing");
const withExclusion = await searchConversations({ query: "blue orchid -title:absent", sort: { field: "relevance", dir: "desc" } });
assert(withExclusion.find((row) => row.id === "chatgpt:body").relevance > withExclusion.find((row) => row.id === "chatgpt:split").relevance, "ordinary phrase relevance survives an exclusion clause");
await put("cjk", "旅行筆記", ["舊相機聊天紀錄 新相機"]);
assert(await ids('"舊相機"') === "cjk", "CJK exact phrase");
assert(await ids("*相機") === "cjk", "CJK wildcard uses complete runs");
await put("literal", "symbols", ["literal (a+)+$ and <script>unsafe</script>"]);
assert(await ids('"(a+)+$"') === "literal", "regex syntax remains literal");
assert(await ids('"<script>"') === "literal", "HTML snippet searchable as literal text");
const rows = await searchConversations({ query: 'title:"old camera" "blue orchid" chat* -draft', sort: { field: "relevance", dir: "desc" } });
assert(rows[0].id === "chatgpt:title" || rows[0].id === "chatgpt:title-only", "title matches outrank bodies");
assert(rows.find((row) => row.id === "chatgpt:body").relevance > rows.find((row) => row.id === "chatgpt:assistant").relevance, "user hit outranks assistant");
const negativeScore = await searchConversations({ query: '"blue orchid" chat* -title:absent', sort: { field: "relevance", dir: "desc" } });
const positiveScore = await searchConversations({ query: '"blue orchid" chat*', sort: { field: "relevance", dir: "desc" } });
assert(negativeScore.find((row) => row.id === "chatgpt:body").relevance === positiveScore.find((row) => row.id === "chatgpt:body").relevance, "exclusions do not earn relevance");
const shown = await attachPreviews(rows, 'title:"old camera" "blue orchid" chat* -draft');
const preview = shown.find((row) => row.id === "chatgpt:body").preview;
assert(preview.text.slice(...preview.ranges[0]) === "blue orchid" && preview.text.slice(...preview.ranges[1]) === "chatseek", "sidebar paints phrase and wildcard matches");
const titled = await attachPreviews(await searchConversations({ query: "title:camera" }), "title:camera");
assert(titled.every((row) => row.preview.ranges.length === 0), "title-only search never highlights bodies");
assert(collectHits("old camera", [{ id: "m", body: "old camera" }], 'title:"old camera"').length === 1, "title-only reader hits just the title");
await put("partial", "Notes", ["chatseek blue orchid"]);
for (const query of ['"chat"', '"hatseek"', '"blue orch"']) {
  assert((await ids(query)).split(",").includes("partial"), `substring phrase is not lost by indexed candidates: ${query}`);
}
assert(!(await ids('orchid -"lue"')).split(",").includes("partial"), "partial negative phrase excludes a body match");
await put("spacing", "blue orchid", ["blue  orchid"]);
const spacingQuery = '"blue  orchid"';
const spacingRows = await attachPreviews(await searchConversations({ query: spacingQuery }), spacingQuery);
const spacing = spacingRows.find((row) => row.id === "chatgpt:spacing").preview;
assert(spacing.text.slice(...spacing.ranges[0]) === "blue orchid", "exact double-space match maps to collapsed display");
const singleSpaceRows = await attachPreviews(await searchConversations({ query: '"blue orchid"' }), '"blue orchid"');
assert(singleSpaceRows.find((row) => row.id === "chatgpt:spacing").preview.ranges.length === 0, "collapsed whitespace cannot invent an exact body match");
assert(await ids('title:"field notes" chat*') === "body", "selective title plus broad wildcard preserves body matches");
assert(await ids('chat* title:"field notes"') === "body", "reversing positive conditions preserves results");
assert(await ids('title:"field notes" "blue orchid" chat*') === "body", "narrow candidate phrase still crosses Markdown emphasis");
assert(await ids('title:"field notes" chat* -"blue orchid"') === "", "negative phrase after a selective condition excludes the body match");
assert(await ids('-"blue orchid" title:"field notes" chat*') === "", "leading negative condition gives the same exclusion");
assert(await ids('title:"field notes" -"unfinished draft" chat*') === "body", "another conversation's exclusion never removes a narrow result");
const db = await openDb();
assert(db.version === 4, "no DB migration");
console.log("search-syntax-test ok", { checks });
