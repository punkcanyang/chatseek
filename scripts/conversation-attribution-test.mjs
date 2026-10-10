// ChatGPT conversation ownership regressions. Real adapter/background/DB,
// artificial sample DOM only; browser e2e covers actual Navigation API events.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import * as db from '../src/db.js';

let listener;
globalThis.chrome = {
  runtime: {
    id: 'integrity-test', onInstalled: { addListener() {} }, onStartup: { addListener() {} },
    onMessage: { addListener(fn) { listener = fn; } }, sendMessage: () => Promise.resolve(),
  },
  sidePanel: { setPanelBehavior: () => Promise.resolve() },
  action: { setBadgeText: () => Promise.resolve(), setBadgeBackgroundColor: () => Promise.resolve() },
};
await import('../background.js');

const uuid = c => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const platformId = (platform, c) => platform === 'gemini' ? c.repeat(16) : uuid(c);
const url = (platform, c) => {
  const id = platformId(platform, c);
  if (platform === 'claude') return `https://claude.ai/chat/${id}`;
  if (platform === 'gemini') return `https://gemini.google.com/u/1/app/${id}`;
  return `https://${platform}.com/c/${id}`;
};
const conv = (platform = 'chatgpt', c = 'a') => ({
  id: `${platform}:${platformId(platform, c)}`, platform, platformId: platformId(platform, c),
  url: url(platform, c), title: 'Integrity sample',
});
const OLD = 'Sample A: maple trees stand beside the quiet garden.';
const NEW = 'Sample B: ocean creatures swim beneath the silver moon.';
const shared = readFileSync(new URL('../content/shared.js', import.meta.url), 'utf8');

function paint(dom, platform, bodies, native = false) {
  const doc = dom.window.document;
  const main = doc.createElement('main');
  for (const [i, body] of bodies.entries()) {
    const node = doc.createElement(platform === 'gemini' ? 'user-query' : 'div');
    if (platform === 'claude') node.setAttribute('data-testid', 'user-message');
    else if (platform === 'grok') node.setAttribute('data-message-author-role', 'user');
    else if (platform === 'chatgpt') node.setAttribute('data-turn', 'user');
    if (native) node.setAttribute('data-message-id', `message-${i}`);
    const p = doc.createElement('p');
    if (platform === 'gemini') p.className = 'query-text query-text-line';
    p.textContent = body;
    node.append(p); main.append(node);
  }
  doc.body.replaceChildren(main);
}

function harness(dom, platform) {
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const scheduled = [];
  const payloads = [];
  const ctx = createContext({
    window: dom.window, document: dom.window.document, location: dom.window.location,
    Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, URL, Date: Clock,
    console: { log() {}, warn() {} },
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); return timer; },
    clearTimeout, setInterval, clearInterval,
    chrome: { runtime: { id: 'integrity-test', sendMessage(payload, cb) {
      payloads.push(payload);
      const pending = listener(payload, { tab: { url: dom.window.location.href }, url: dom.window.location.href }, cb);
      if (pending !== true) cb?.(undefined);
    } } },
  });
  const adapter = readFileSync(new URL(`../content/${platform}.js`, import.meta.url), 'utf8');
  runInContext(`${shared}\nChatseek.autoStart=false; Chatseek.observe=fn=>globalThis.capture=fn;\n${adapter}\nglobalThis.api=Chatseek;`, ctx);
  ctx.api.safeScheduleImages = job => scheduled.push(job);
  return {
    api: ctx.api, payloads, scheduled, advance(ms) { now += ms; },
    capture: () => platform === 'gemini' || platform === 'chatgpt'
      ? ctx.api.platforms[platform].capture() : ctx.capture(),
  };
}

async function expireGate() {
  const tx = (await db.openDb()).transaction('meta', 'readwrite');
  tx.objectStore('meta').delete('spa:recent');
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
}

const failures = [];
async function check(name, run) {
  await db.clearAll();
  try { await run(); console.log(`integrity PASS: ${name}`); }
  catch (error) { failures.push(name); console.error(`integrity FAIL: ${name}: ${error.message}`); }
}


async function rows(c) { return (await db.readConversation(conv('chatgpt', c).id))?.messages || []; }
function move(h, dom, c) {
  // JSDOM does not implement Navigation API. Deliver its synchronous pre-
  // navigation notification explicitly; browser e2e checks actual events.
  h.api.platforms.chatgpt.beforeNavigation?.();
  dom.window.history.pushState({}, '', url('chatgpt', c));
}
function own(dom, c) { dom.window.document.querySelector('main').setAttribute('data-conversation-id', platformId('chatgpt', c)); }

await check('ChatGPT cloned residual text never gains ownership by waiting', async () => {
  const dom = new JSDOM('', { url: url('chatgpt', 'a') });
  try {
    paint(dom, 'chatgpt', [OLD]); const h = harness(dom, 'chatgpt'); assert.equal(await h.capture(), true);
    move(h, dom, 'b'); paint(dom, 'chatgpt', [OLD]); h.advance(6000); await expireGate();
    const canonical = dom.window.document.createElement('link'); canonical.rel = 'canonical'; canonical.href = url('chatgpt', 'b'); dom.window.document.head.append(canonical);
    for (let i = 0; i < 3; i++) { assert.equal(await h.capture(), false); h.advance(60000); }
    assert.equal((await rows('b')).length, 0);
    paint(dom, 'chatgpt', [NEW]); assert.equal(await h.capture(), true);
    assert.deepEqual((await rows('b')).map(m => m.body), [NEW]);
  } finally { dom.window.close(); }
});

await check('ChatGPT fast uncollected A-B-A rejects the intermediate B screen', async () => {
  const dom = new JSDOM('', { url: url('chatgpt', 'a') });
  try {
    paint(dom, 'chatgpt', [OLD]); const h = harness(dom, 'chatgpt'); assert.equal(await h.capture(), true);
    move(h, dom, 'b'); paint(dom, 'chatgpt', [NEW]); move(h, dom, 'a');
    assert.equal(await h.capture(), false); h.advance(6000); await expireGate();
    assert.equal(await h.capture(), false);
    assert.deepEqual((await rows('a')).map(m => m.body), [OLD]); assert.equal((await rows('b')).length, 0);
    paint(dom, 'chatgpt', [OLD]); assert.equal(await h.capture(), true);
    assert.deepEqual((await rows('a')).map(m => m.body), [OLD]);
  } finally { dom.window.close(); }
});

await check('ChatGPT restart at A with known B text is held after the short gate expires', async () => {
  const b = new JSDOM('', { url: url('chatgpt', 'b') });
  try { paint(b, 'chatgpt', [NEW]); assert.equal(await harness(b, 'chatgpt').capture(), true); }
  finally { b.window.close(); }
  await expireGate();
  const a = new JSDOM('', { url: url('chatgpt', 'a') });
  try {
    paint(a, 'chatgpt', [NEW]); const h = harness(a, 'chatgpt'); h.advance(60000);
    assert.equal(await h.capture(), false); assert.equal((await rows('a')).length, 0);
    assert.deepEqual((await rows('b')).map(m => m.body), [NEW]);
    paint(a, 'chatgpt', [OLD]); assert.equal(await h.capture(), true);
    assert.deepEqual((await rows('a')).map(m => m.body), [OLD]);
  } finally { a.window.close(); }
});

for (const evidence of ['ancestor', 'mapping']) {
  await check(`ChatGPT legitimate identical conversations use ${evidence} content evidence`, async () => {
    const dom = new JSDOM('', { url: url('chatgpt', 'a') });
    try {
      paint(dom, 'chatgpt', [OLD]); const h = harness(dom, 'chatgpt'); assert.equal(await h.capture(), true);
      move(h, dom, 'b'); paint(dom, 'chatgpt', [OLD]); h.advance(6000); await expireGate();
      if (evidence === 'ancestor') own(dom, 'b');
      else {
        const script = dom.window.document.createElement('script'); script.type = 'application/json';
        script.textContent = JSON.stringify({ conversation_id: platformId('chatgpt', 'b'), current_node: 'q',
          mapping: { q: { parent: null, message: { author: { role: 'user' }, content: { content_type: 'text', parts: [OLD] } } } } });
        dom.window.document.head.append(script);
      }
      assert.equal(await h.capture(), true);
      assert.deepEqual((await rows('a')).map(m => m.body), [OLD]); assert.deepEqual((await rows('b')).map(m => m.body), [OLD]);
      assert.equal(h.payloads.filter(p => p.type === 'CAPTURE_MESSAGES').at(-1).ownershipVerified, true);
    } finally { dom.window.close(); }
  });
}

await check('ChatGPT snapshot is rechecked after a same-URL body/native-ID/role rewrite', async () => {
  for (const mutation of ['body', 'id', 'role']) {
    await db.clearAll();
    const dom = new JSDOM('', { url: url('chatgpt', 'a') });
    try {
      paint(dom, 'chatgpt', [OLD], true); const h = harness(dom, 'chatgpt');
      const send = h.api.send; let changed = false;
      h.api.send = async p => {
        const result = await send(p);
        if (!changed && p.type === 'CAPTURE_HEALTH') {
          changed = true; const node = dom.window.document.querySelector('[data-turn]');
          if (mutation === 'body') node.querySelector('p').textContent = NEW;
          if (mutation === 'id') node.setAttribute('data-message-id', 'different-native-id');
          if (mutation === 'role') node.setAttribute('data-turn', 'assistant');
        }
        return result;
      };
      assert.equal(await h.capture(), false); assert.equal(h.payloads.some(p => p.type === 'CAPTURE_MESSAGES'), false);
      assert.equal((await rows('a')).length, 0);
    } finally { dom.window.close(); }
  }
});

await check('ChatGPT navigation epoch invalidates an A-B-A snapshot during an await', async () => {
  const dom = new JSDOM('', { url: url('chatgpt', 'a') });
  try {
    paint(dom, 'chatgpt', [OLD]); const h = harness(dom, 'chatgpt');
    const send = h.api.send; let changed = false;
    h.api.send = async p => {
      const result = await send(p);
      if (!changed && p.type === 'CAPTURE_HEALTH') { changed = true; move(h, dom, 'b'); move(h, dom, 'a'); }
      return result;
    };
    assert.equal(await h.capture(), false); assert.equal((await rows('a')).length, 0);
    assert.equal(await h.capture(), true);
  } finally { dom.window.close(); }
});

await check('Review: cloned old streaming turn with a new token does not acquire B ownership', async () => {
  const dom = new JSDOM('', { url: url('chatgpt', 'a') });
  try {
    paint(dom, 'chatgpt', [OLD], true); const h = harness(dom, 'chatgpt'); assert.equal(await h.capture(), true);
    move(h, dom, 'b'); paint(dom, 'chatgpt', [OLD + ' Continued old stream token.'], true);
    h.advance(6000); await expireGate();
    const result = await h.capture();
    assert.equal((await rows('b')).length, 0, 'old native message clone must not enter B');
  } finally { dom.window.close(); }
});
await check('Review: remounted mixed old and new native turns do not acquire B ownership', async () => {
  const dom = new JSDOM('', { url: url('chatgpt', 'a') });
  try {
    paint(dom, 'chatgpt', [OLD], true); const h = harness(dom, 'chatgpt'); assert.equal(await h.capture(), true);
    move(h, dom, 'b'); paint(dom, 'chatgpt', [OLD, NEW], true);
    h.advance(6000); await expireGate();
    const result = await h.capture();
    assert.equal((await rows('b')).length, 0, 'mixed remounted old/new native messages must not enter B');
  } finally { dom.window.close(); }
});
await check('ChatGPT native owner survives script restart and changed text', async () => {
  const a = new JSDOM('', { url: url('chatgpt', 'a') });
  try { paint(a, 'chatgpt', [OLD], true); assert.equal(await harness(a, 'chatgpt').capture(), true); }
  finally { a.window.close(); }
  await expireGate();
  const b = new JSDOM('', { url: url('chatgpt', 'b') });
  try {
    paint(b, 'chatgpt', [OLD + ' Another token from the same old native turn.'], true);
    assert.equal(await harness(b, 'chatgpt').capture(), false); assert.equal((await rows('b')).length, 0);
    assert.deepEqual((await rows('a')).map(m => m.body), [OLD]);
  } finally { b.window.close(); }
});

await check('ChatGPT shared wording with distinct native turns remains legitimate', async () => {
  const dom = new JSDOM('', { url: url('chatgpt', 'a') });
  try {
    paint(dom, 'chatgpt', [OLD], true); const h = harness(dom, 'chatgpt'); assert.equal(await h.capture(), true);
    move(h, dom, 'b'); paint(dom, 'chatgpt', [OLD, NEW], true);
    [...dom.window.document.querySelectorAll('[data-message-id]')].forEach((node, i) => node.setAttribute('data-message-id', `b-native-${i}`));
    h.advance(6000); await expireGate(); assert.equal(await h.capture(), true);
    assert.deepEqual((await rows('b')).map(m => m.body), [OLD, NEW]);
    assert.deepEqual((await rows('a')).map(m => m.body), [OLD]);
  } finally { dom.window.close(); }
});

await check('ChatGPT legitimate branch may share native IDs with explicit content ownership', async () => {
  const dom = new JSDOM('', { url: url('chatgpt', 'a') });
  try {
    paint(dom, 'chatgpt', [OLD], true); const h = harness(dom, 'chatgpt'); assert.equal(await h.capture(), true);
    move(h, dom, 'b'); paint(dom, 'chatgpt', [OLD, NEW], true); own(dom, 'b');
    h.advance(6000); await expireGate(); assert.equal(await h.capture(), true);
    assert.deepEqual((await rows('b')).map(m => m.body), [OLD, NEW]);
    assert.deepEqual((await rows('a')).map(m => m.body), [OLD]);
  } finally { dom.window.close(); }
});

await check('Fallback: cloned old streaming turn with a new token does not acquire B ownership', async () => {
  const dom = new JSDOM('', { url: url('chatgpt', 'a') });
  try {
    paint(dom, 'chatgpt', [OLD], false); const h = harness(dom, 'chatgpt'); assert.equal(await h.capture(), true);
    move(h, dom, 'b'); paint(dom, 'chatgpt', [OLD + ' Continued old stream token.'], false);
    h.advance(6000); await expireGate();
    const result = await h.capture();
    assert.equal((await rows('b')).length, 0, 'old fallback message clone must not enter B');
  } finally { dom.window.close(); }
});
await check('Fallback: remounted mixed old and new fallback turns do not acquire B ownership', async () => {
  const dom = new JSDOM('', { url: url('chatgpt', 'a') });
  try {
    paint(dom, 'chatgpt', [OLD], false); const h = harness(dom, 'chatgpt'); assert.equal(await h.capture(), true);
    move(h, dom, 'b'); paint(dom, 'chatgpt', [OLD, NEW], false);
    h.advance(6000); await expireGate();
    const result = await h.capture();
    assert.equal((await rows('b')).length, 0, 'mixed remounted old/new fallback messages must not enter B');
  } finally { dom.window.close(); }
});
assert.deepEqual(failures, [], `Conversation attribution regressions: ${failures.join(', ')}`);
console.log('conversation-attribution ok');
