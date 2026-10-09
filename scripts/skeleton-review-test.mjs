import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

// Independent reviewer attacks. Also called by verify, so privacy regressions
// cannot pass the normal permission/network gate.
export function reviewSkeleton(shared) {
  const uuid = "12345678-1234-4234-8234-123456789abc";
  const secrets = [uuid, "PrivateAccount", "私人內容", "秘密の本文", "private@example.test",
    "PrivateTitle", "PrivateScript", "PrivateStyle", "PrivateNoScript", "PrivateQuery", "PrivateFragment",
    "PrivatePath", "RelativeSecret", "PrivateData", "privateelement", "privateclass", "privateattr"];
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: `https://chatgpt.com/c/${uuid}?PrivateQuery#PrivateFragment`,
  });
  const doc = dom.window.document;
  doc.body.className = "privateclass";
  const add = (tag, attrs = {}, text = "", parent = doc.body) => {
    const node = doc.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    node.textContent = text; parent.append(node); return node;
  };
  add("title", {}, "PrivateTitle", doc.head);
  for (const tag of ["p", "textarea", "script", "style", "noscript"]) {
    add(tag, {}, tag === "style" ? "/* PrivateStyle */" :
      `PrivateAccount 私人內容 秘密の本文 private@example.test PrivateScript PrivateNoScript`);
  }
  add("div", { contenteditable: "true", role: "PrivateAccount", "data-private": "PrivateData",
    "data-testid": "PrivateAccount", "data-turn": "PrivateAccount", "data-kind": "PrivateAccount",
    "aria-label": "PrivateTitle", title: "PrivateTitle", alt: "PrivateTitle", placeholder: "PrivateTitle",
    id: uuid, value: "PrivateAccount", style: "PrivateStyle", srcdoc: "PrivateScript",
    [`data-foo-${uuid}`]: "PrivateData", "data-privateattr": "PrivateData" }, "私人內容");
  add("privateelement-privateaccount", { class: "privateclass PrivateAccount 私人內容" });
  add("span", { class: "abcdef1234567890abcdef12 xYzABCDEFGHijkLMN0123456789 prose flex-col markdown" });
  add("a", { href: `/c/${uuid}?PrivateQuery#PrivateFragment`, "data-url": "/c/RelativeSecret" });
  add("input", { value: "PrivateAccount", name: "PrivateAccount" });
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg"); doc.body.append(svg);
  const title = doc.createElementNS(svg.namespaceURI, "title"); title.textContent = "PrivateTitle"; svg.append(title);
  const same = add("iframe"); add("p", {}, "私人內容", same.contentDocument.body);
  const cross = add("iframe", { src: `https://private@example.test/PrivatePath/${uuid}?PrivateQuery#PrivateFragment` });
  Object.defineProperty(cross, "contentDocument", { get() { throw new Error("cross-origin"); } });
  const opaqueHost = add("iframe", { src: `https://${uuid}.example.test/PrivatePath` });
  Object.defineProperty(opaqueHost, "contentDocument", { get() { return null; } });
  const relative = add("iframe", { src: `/c/${uuid}?PrivateQuery#PrivateFragment` });
  Object.defineProperty(relative, "contentDocument", { get() { return null; } });
  const closedHost = add("section"); const closed = closedHost.attachShadow({ mode: "closed" });
  add("b", { "data-private": "PrivateData" }, "秘密の本文", closed);
  const openHost = add("article"); const open = openHost.attachShadow({ mode: "open" });
  add("i", {}, "私人內容", open); add("u", {}, "private light DOM", openHost);
  // Equal shallow signatures must not hide distinct subtrees (or frames).
  const siblings = add("nav");
  add("b", {}, "one", add("div", {}, "", siblings));
  add("i", {}, "two", add("div", {}, "", siblings));
  const twins = add("footer");
  add("small", {}, "one", add("div", {}, "", twins));
  add("small", {}, "two", add("div", {}, "", twins));
  const keys = ["__chatseekLoaded", "__chatseekPing", "__chatseekPingListener", "__chatseekSkeleton", "__chatseekSyncInspect"];
  for (const key of keys) delete globalThis[key];
  const fn = new Function("document", "location", "window", "Node", "NodeFilter", "console", "chrome",
    shared + "\nChatseek.autoStart=false; return Chatseek;");
  const api = fn(doc, dom.window.location, dom.window, dom.window.Node, dom.window.NodeFilter,
    { log() {}, warn() {} }, { runtime: { id: "review", onMessage: { addListener() {} } },
      dom: { openOrClosedShadowRoot: node => node === closedHost ? closed : null } });
  try {
    const out = api.buildPageSkeleton(doc);
    const leaked = secrets.filter(secret => out.text.toLowerCase().includes(secret.toLowerCase()));
    assert.deepEqual(leaked, [], "private data leaked through structure metadata");
    assert(!/:\/\/|\/c\/|[?#](?:PrivateQuery|PrivateFragment)/.test(out.text));
    assert(out.text.includes("host=example.test"), "only the cross-origin domain survives");
    assert(!out.text.includes("host=x.invalid"), "relative URLs must not invent a domain");
    assert(out.text.includes("#same-origin-frame") && out.text.includes("#shadow"));
    assert(out.text.includes("u d"), "shadow roots must not hide the host's light DOM");
    assert(out.text.includes("b d4") && out.text.includes("i d4"), "distinct sibling subtrees survive");
    assert(out.text.includes("small d4") && out.text.includes("×2"), "identical subtrees retain their child outline");
    assert.equal(out.chars, out.text.length);
    const diag = api.formatDiag(api.diagFields({ structure: api.structureDiag(doc) }));
    assert.deepEqual(secrets.filter(secret => diag.toLowerCase().includes(secret.toLowerCase())), [],
      "legacy automatic diagnostics must not bypass metadata masking");
    // Many masked equal siblings and huge attributes still have bounded output
    // and work: count visits, not just printed representatives.
    doc.body.replaceChildren();
    for (let i = 0; i < 7000; i++) add("div", { "data-private": "PrivateAccount" });
    const capped = api.buildPageSkeleton(doc);
    assert(capped.truncated && capped.nodes <= 6000 && capped.text.length < 100000);
    doc.body.replaceChildren();
    add("div", { "data-private": "PrivateData".repeat(10000), class: "PrivateAccount".repeat(10000) });
    const huge = api.buildPageSkeleton(doc);
    assert(huge.text.length < 1000 && !huge.text.includes("Private"));
    doc.body.replaceChildren();
    for (let i = 0; i < 7000; i++) doc.body.append(doc.createComment("PrivateAccount"));
    const comments = api.buildPageSkeleton(doc);
    assert(comments.truncated && comments.nodes <= 6000 && !comments.text.includes("Private"),
      "ignored comments must also consume the visit budget");
    doc.body.replaceChildren();
    const manyAttrs = add("div");
    for (let i = 0; i < 200; i++) manyAttrs.setAttribute(`data-${uuid}-${i}`, "PrivateData");
    const attrs = api.buildPageSkeleton(doc);
    assert(attrs.truncated && attrs.text.includes("#attrs-truncated") && attrs.text.length < 2000);
    return { nodes: out.nodes, chars: out.chars, cap: capped.nodes };
  } finally {
    dom.window.close(); for (const key of keys) delete globalThis[key];
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log("skeleton-review ok", reviewSkeleton(readFileSync(new URL("../content/shared.js", import.meta.url), "utf8")));
}
