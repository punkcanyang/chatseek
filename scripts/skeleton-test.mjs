/**
 * 1.7.2 P0: the "copy page structure" diagnostic must expose structure only.
 *
 * Part A  the generator keeps tags / roles / enum attribute values
 * Part B  an attack fixture (urls, uuid, email, prose, aria-label, title, alt,
 *         href/src, data-message-id uuid, hash classes, iframe srcdoc text,
 *         open + closed shadow text) leaks none of it
 * Part C  cross-origin / same-origin frames and open/closed shadow are marked
 * Part D  isomorphic siblings collapse to "×N"; node and depth caps truncate
 * Part E  the content-script listener answers a COPY_PAGE_SKELETON message
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sharedSrc = readFileSync(join(root, "content/shared.js"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function loadSkeleton(dom, chromeExtra = {}, collect) {
  for (const key of ["__chatseekLoaded", "__chatseekPing", "__chatseekPingListener", "__chatseekSkeleton", "__chatseekSyncInspect"]) {
    delete globalThis[key];
  }
  const chrome = {
    runtime: { id: "test", sendMessage() {}, onMessage: { addListener: (fn) => { if (collect) collect.push(fn); } } },
    ...chromeExtra,
  };
  const fn = new Function(
    "document", "location", "window", "Node", "NodeFilter", "console", "chrome",
    sharedSrc + "\nChatseek.autoStart = false;\nreturn Chatseek;",
  );
  return fn(
    dom.window.document,
    dom.window.location,
    dom.window,
    dom.window.Node,
    dom.window.NodeFilter,
    { warn() {}, log() {} },
    chrome,
  );
}

const UUID = "11111111-1111-4111-8111-111111111111";
const PAGE_URL = "https://chatgpt.com/c/" + UUID;
const SECRETS = [
  UUID,
  PAGE_URL,
  "https://evil.example/path/SECRETBODYURL",
  "SECRETBODYURL",
  "SECRETBODY",
  "SKELETONTITLESECRET",
  "user@example.com",
  "這是一段很長的機密內容不該外洩",
  "aria label sentence should not leak",
  "tooltip title secret",
  "alt text secret",
  "placeholder secret",
  "srcdoc inner secret",
  "shadow inner secret",
  "closed shadow inner secret",
  "abcdef1234567890abcdef12",
];

// ---------------------------------------------------------------- Part A/B/C
{
  const html = "<!DOCTYPE html><html><head><title>SKELETONTITLESECRET</title></head><body>" +
    '<div id="root" role="main" data-message-author-role="assistant" data-turn="user"' +
    ' data-message-id="' + UUID + '" data-testid="message-turn" data-analytics="abcdef1234567890abcdef12"' +
    ' aria-label="aria label sentence should not leak" title="tooltip title secret"' +
    ' class="plainword abcdef1234567890abcdef12 hashy-abcdef1234567890abcdef1234567890">' +
    "<p>SECRETBODY user@example.com</p>" +
    '<a href="' + PAGE_URL + '">SECRETBODY LINK</a>' +
    '<img alt="alt text secret" src="https://evil.example/path/SECRETBODYURL">' +
    '<input placeholder="placeholder secret" value="' + UUID + '">' +
    '<iframe id="same"></iframe>' +
    '<iframe id="cross" src="https://evil.example/path/SECRETBODYURL"></iframe>' +
    '<div id="openHost" data-kind="open"></div><div id="closedHost" data-kind="closed"></div>' +
    '<iframe srcdoc="&lt;p&gt;srcdoc inner secret&lt;/p&gt;"></iframe>' +
    "</div></body></html>";
  const dom = new JSDOM(html, { url: PAGE_URL });
  const doc = dom.window.document;
  doc.getElementById("same").contentDocument.body.textContent = "這是一段很長的機密內容不該外洩";
  doc.getElementById("openHost").attachShadow({ mode: "open" }).innerHTML = "<span>shadow inner secret</span>";
  const closedHost = doc.getElementById("closedHost");
  const closedRoot = closedHost.attachShadow({ mode: "closed" });
  closedRoot.innerHTML = "<span>closed shadow inner secret</span>";
  const chromeExtra = { dom: { openOrClosedShadowRoot: (el) => (el === closedHost ? closedRoot : null) } };

  const Chatseek = loadSkeleton(dom, chromeExtra);
  assert(typeof Chatseek.buildPageSkeleton === "function", "buildPageSkeleton exists");
  const out = Chatseek.buildPageSkeleton(doc);
  const text = out.text;

  for (const secret of SECRETS) {
    assert(!text.includes(secret), "skeleton leaked: " + secret);
  }
  assert(!text.includes("://"), "skeleton must not contain a scheme separator");
  assert(!text.includes("evil.example/path"), "the url path must be dropped");

  // Structure survives.
  assert(/^# chatseek page skeleton v1 nodes=\d+ depth<=60 truncated=false$/.test(text.split("\n")[0]), "header line");
  assert(text.includes("role=main"), "role=main kept");
  assert(text.includes("data-message-author-role=assistant"), "author role kept");
  assert(text.includes("data-turn=user"), "data-turn kept");
  assert(text.includes("data-message-id=x"), "data-message-id masked");
  assert(text.includes("data-testid=message-turn"), "an enum testid is kept");
  assert(text.includes("data-x=x"), "unknown attribute names and values are masked");
  assert(text.includes("class=x.h.h"), "unknown class words masked, hashes -> h");
  assert(text.includes(" href=x") || text.includes(" href=x "), "href masked");
  assert(text.includes(" alt=x"), "alt masked");
  assert(text.includes(" src=x"), "src masked");
  assert(text.includes(" placeholder=x"), "placeholder masked");
  assert(text.includes(" aria-label=x"), "aria-label masked");
  assert(text.includes(" title=x"), "title masked");
  assert(text.includes(" srcdoc=x"), "srcdoc masked");
  assert(text.includes("#text("), "text nodes are counts");
  assert(text.includes("div"), "tag names kept");
  assert(text.includes("input"), "input tag kept");
  assert(text.includes("iframe"), "iframe tag kept");
  assert(text.includes("img"), "img tag kept");

  // Frames and shadow roots are marked.
  assert(text.includes("#same-origin-frame"), "same-origin frame marked");
  assert(text.includes("#cross-origin"), "cross-origin frame marked");
  assert(text.includes("host=evil.example"), "cross-origin host kept");
  assert(text.includes("#shadow"), "a closed shadow root is marked");
  assert(text.includes("data-kind=open") && text.includes("data-kind=closed"), "distinct hosts are both walked");

  assert(out.chars === text.length, "chars matches text length");
  const headerNodes = Number(text.split("\n")[0].match(/nodes=(\d+)/)[1]);
  assert(headerNodes === out.nodes, "header node count matches result");
  console.log("Part A/B/C  nodes=" + out.nodes + " chars=" + out.chars + " truncated=" + out.truncated);
}

// ---------------------------------------------------------------- Part D
{
  // Isomorphic siblings collapse to one line; nothing is truncated.
  const dom = new JSDOM("<!DOCTYPE html><html><body><div id=\"d\"><p>one</p><p>two</p></div></body></html>");
  const Chatseek = loadSkeleton(dom);
  const out = Chatseek.buildPageSkeleton(dom.window.document);
  assert(out.truncated === false, "a small page is not truncated");
  assert(out.text.includes("×2"), "isomorphic siblings collapse, got: " + out.text);
  assert(out.nodes < 20, "small page has few nodes, got " + out.nodes);
  console.log("Part D  collapse nodes=" + out.nodes);
}

{
  // The node cap stops the walk and flags the truncation.
  let many = "";
  for (let i = 0; i < 7000; i += 1) many += '<i data-i="' + i + '"></i>';
  const dom = new JSDOM("<!DOCTYPE html><html><body><div id=\"m\">" + many + "</div></body></html>");
  const Chatseek = loadSkeleton(dom);
  const out = Chatseek.buildPageSkeleton(dom.window.document);
  assert(out.truncated === true, "7000 nodes truncates");
  assert(out.nodes <= 6000, "node count is capped, got " + out.nodes);
  assert(out.text.split("\n")[0].includes("truncated=true"), "header reports truncation");
  console.log("Part D  node cap nodes=" + out.nodes + " truncated=" + out.truncated);
}

{
  // The depth cap stops the descent.
  let deep = "x";
  for (let i = 0; i < 200; i += 1) deep = "<span>" + deep + "</span>";
  const dom = new JSDOM("<!DOCTYPE html><html><body><div>" + deep + "</div></body></html>");
  const Chatseek = loadSkeleton(dom);
  const out = Chatseek.buildPageSkeleton(dom.window.document);
  assert(out.truncated === true, "deeper than 60 truncates");
  assert(out.text.includes("span"), "tags still emitted");
  assert(out.nodes < 80, "depth cap keeps the walk shallow, got " + out.nodes);
  console.log("Part D  depth cap nodes=" + out.nodes + " truncated=" + out.truncated);
}

// ---------------------------------------------------------------- Part E
{
  const listeners = [];
  const dom = new JSDOM(
    "<!DOCTYPE html><html><body><div role=\"main\" data-message-author-role=\"assistant\"><p>SECRETBODY</p></div></body></html>",
    { url: PAGE_URL },
  );
  const Chatseek = loadSkeleton(dom, {}, listeners);
  assert(listeners.length > 0, "the content script registered a message listener");

  let response = null;
  for (const fn of listeners) {
    response = null;
    fn({ type: "COPY_PAGE_SKELETON" }, {}, (r) => { response = r; });
    if (response) break;
  }
  assert(response && response.ok === true, "COPY_PAGE_SKELETON answered ok");
  assert(typeof response.text === "string" && response.text.startsWith("# chatseek page skeleton v1"), "skeleton text returned");
  assert(response.chars === response.text.length, "chars matches returned text");
  assert(response.text.includes("role=main"), "structure returned to the panel");
  assert(response.text.includes("data-message-author-role=assistant"), "author role returned");
  assert(!response.text.includes("SECRETBODY"), "no body text in the response");
  assert(typeof response.nodes === "number" && response.nodes > 0, "node count returned");

  // An unrelated message is ignored, not answered.
  for (const fn of listeners) {
    let other = null;
    fn({ type: "NOT_A_CHATSEEK_MESSAGE" }, {}, (r) => { other = r; });
    assert(other === null, "an unrelated message is not answered by this listener");
  }
  console.log("Part E  listener chars=" + response.chars + " nodes=" + response.nodes);
}

console.log("skeleton ok");
