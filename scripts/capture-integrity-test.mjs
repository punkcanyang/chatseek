// Regression cases from the 1.7.2.1 audit. Real adapters/background/IndexedDB,
// sample DOM only: never navigate to or log into an external site.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import * as db from '../src/db.js';
import { planCloneDrops } from '../src/message-identity.js';

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

await check('partial repeated native exchanges and thumbnails survive', async () => {
  const c = conv();
  const rows = Array.from({ length: 4 }, (_, i) => ({
    id: `${c.id}:native-${i}`, role: i % 2 ? 'assistant' : 'user', body: i % 2 ? NEW : OLD,
  }));
  await db.upsertMessages(c, rows, { pageMessageIds: rows.map(m => m.id), captureId: 'initial' });
  await db.saveImageRecords(c.id, [{ messageId: rows[0].id, index: 0, status: 'cached', mime: 'image/webp', bytes: [1, 2], width: 1, height: 1 }]);
  for (const completePage of [false, true]) {
    await db.upsertMessages(c, rows.slice(2), { pageMessageIds: rows.slice(2).map(m => m.id), captureId: `window-${completePage}`, identityVerified: true, completePage });
    assert.equal((await db.readConversation(c.id)).messages.length, 4);
    assert.equal((await db.readImageBytes(rows[0].id, 0)).blob.byteLength, 2);
  }
});

await check('a quoted user prompt must not become the assistant answer', async () => {
  const c = conv();
  const user = { id: `${c.id}:native-user`, role: 'user', body: OLD };
  const answer = { id: `${c.id}:native-answer`, role: 'assistant', body: `${OLD} Here is my answer.` };
  await db.upsertMessages(c, [user], { pageMessageIds: [user.id] });
  await db.upsertMessages(c, [answer], { pageMessageIds: [answer.id] });
  const rows = (await db.readConversation(c.id)).messages;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(m => m.role), ['user', 'assistant']);
  assert.equal(rows[0].body, OLD);
});

await check('different stable turns with a common prefix stay separate', async () => {
  const c = conv();
  const old = { id: `${c.id}:old`, turnId: 'old-native-turn', role: 'assistant', body: OLD };
  const fresh = { id: `${c.id}:new`, turnId: 'new-native-turn', role: 'assistant', body: `${OLD} Another reply.` };
  await db.upsertMessages(c, [old], { pageMessageIds: [old.id] });
  await db.upsertMessages(c, [fresh], { pageMessageIds: [fresh.id] });
  assert.equal((await db.readConversation(c.id)).messages.length, 2);
});

await check('confirmed same-turn growth preserves a cached image', async () => {
  const c = conv();
  const old = { id: `${c.id}:native-old`, turnId: 'same-turn', role: 'assistant', body: OLD };
  const next = { ...old, id: `${c.id}:native-rekey`, body: `${OLD} Continued streamed text.` };
  await db.upsertMessages(c, [old], { pageMessageIds: [old.id] });
  await db.saveImageRecords(c.id, [{ messageId: old.id, index: 0, status: 'cached', mime: 'image/webp', bytes: [8, 9], width: 2, height: 1 }]);
  await db.upsertMessages(c, [next], { pageMessageIds: [next.id] });
  const rows = (await db.readConversation(c.id)).messages;
  assert.equal(rows.length, 1); assert.equal(rows[0].body, next.body);
  assert.equal((await db.readImageBytes(next.id, 0)).blob.byteLength, 2);
});

await check('clone cleanup requires full-page and shared-turn proof and protects native IDs', async () => {
  const c = conv();
  const rows = [
    { id: `${c.id}:dead:dom1`, role: 'user', body: OLD, turnId: 'q' },
    { id: `${c.id}:feed:dom2`, role: 'assistant', body: NEW, turnId: 'a' },
    { id: `${c.id}:native-q`, role: 'user', body: OLD, turnId: 'q' },
    { id: `${c.id}:native-a`, role: 'assistant', body: NEW, turnId: 'a' },
  ];
  const page = rows.slice(2), ids = page.map(m => m.id);
  assert.equal(planCloneDrops(rows, ids, page, { completePage: true }).length, 2);
  assert.equal(planCloneDrops(rows, ids, page).length, 0);
  assert.equal(planCloneDrops(rows.map((m, i) => ({ ...m, turnId: `different-${i}` })), ids, page, { completePage: true }).length, 0);
  assert.equal(planCloneDrops(rows.map((m, i) => i === 0 ? { ...m, id: `${c.id}:native:dead:dom1` } : m), ids, page, { completePage: true }).length, 0);
});

for (const platform of ['claude', 'grok', 'gemini']) {
  await check(`${platform}: residual DOM stays held beyond five seconds; replacement is captured`, async () => {
    const dom = new JSDOM('', { url: url(platform, 'a') });
    try {
      paint(dom, platform, [OLD]); const h = harness(dom, platform);
      assert.equal(await h.capture(), true);
      dom.window.history.pushState({}, '', url(platform, 'b'));
      h.advance(6000); await expireGate();
      h.scheduled.length = 0;
      assert.equal(await h.capture(), false);
      assert.equal((await db.readConversation(conv(platform, 'b').id))?.messages.length || 0, 0);
      assert.equal(h.scheduled.length, 0, 'held content must not enqueue images');
      paint(dom, platform, [NEW]);
      assert.equal(await h.capture(), true);
      assert.equal((await db.readConversation(conv(platform, 'b').id)).messages[0].body, NEW);
    } finally { dom.window.close(); }
  });

  await check(`${platform}: navigation during first extraction cannot bypass the baseline`, async () => {
    const dom = new JSDOM('', { url: url(platform, 'a') });
    try {
      paint(dom, platform, [OLD]); const h = harness(dom, platform);
      const pace = h.api.paceDom; let changed = false;
      h.api.paceDom = async () => {
        if (!changed) { changed = true; dom.window.history.pushState({}, '', url(platform, 'b')); }
        await pace();
      };
      assert.equal(await h.capture(), false);
      h.api.paceDom = pace; h.advance(6000); await expireGate();
      assert.equal(await h.capture(), false);
      assert.equal((await db.readConversation(conv(platform, 'b').id))?.messages.length || 0, 0);
      paint(dom, platform, [NEW]); assert.equal(await h.capture(), true);
    } finally { dom.window.close(); }
  });

  await check(`${platform}: mixed intermediate DOM cannot leak into a third conversation`, async () => {
    const dom = new JSDOM('', { url: url(platform, 'a') });
    try {
      paint(dom, platform, [OLD]); const h = harness(dom, platform);
      assert.equal(await h.capture(), true);
      const oldNode = dom.window.document.querySelector('main').firstElementChild;
      dom.window.history.pushState({}, '', url(platform, 'b'));
      const intermediate = oldNode.cloneNode(true); intermediate.querySelector('p').textContent = NEW;
      oldNode.after(intermediate);
      assert.equal(await h.capture(), false);
      dom.window.history.pushState({}, '', url(platform, 'c')); oldNode.remove();
      h.advance(6000); await expireGate();
      assert.equal(await h.capture(), false);
      assert.equal((await db.readConversation(conv(platform, 'c').id))?.messages.length || 0, 0);
    } finally { dom.window.close(); }
  });

  await check(`${platform}: a later extraction preserves its baseline before yielding`, async () => {
    const dom = new JSDOM('', { url: url(platform, 'a') });
    try {
      paint(dom, platform, [OLD]); const h = harness(dom, platform);
      assert.equal(await h.capture(), true);
      dom.window.history.pushState({}, '', url(platform, 'b')); paint(dom, platform, [NEW]);
      const pace = h.api.paceDom; let changed = false;
      h.api.paceDom = async () => {
        if (!changed) { changed = true; dom.window.history.pushState({}, '', url(platform, 'c')); }
        await pace();
      };
      assert.equal(await h.capture(), false);
      h.api.paceDom = pace; h.advance(6000); await expireGate();
      assert.equal(await h.capture(), false);
      assert.equal((await db.readConversation(conv(platform, 'c').id))?.messages.length || 0, 0);
    } finally { dom.window.close(); }
  });
}

for (const platform of ['claude', 'grok']) {
  await check(`${platform}: same-prefix fallback messages remain distinct across a partial window`, async () => {
    const dom = new JSDOM('', { url: url(platform, 'a') });
    try {
      const prefix = 'Please explain the forest path and the quiet garden. '.repeat(4).trim();
      const bodies = [`${prefix} First ending.`, `${prefix} Second ending.`];
      paint(dom, platform, bodies); const h = harness(dom, platform);
      assert.equal(await h.capture(), true);
      let rows = (await db.readConversation(conv(platform).id)).messages;
      assert.equal(rows.length, 2);
      assert.equal(new Set(rows.map(m => m.id)).size, 2);
      dom.window.document.querySelector('main').firstElementChild.remove();
      assert.equal(await h.capture(), true);
      rows = (await db.readConversation(conv(platform).id)).messages;
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map(m => m.body), bodies);
    } finally { dom.window.close(); }
  });

  await check(`${platform}: a late native ID keeps the same streamed DOM turn`, async () => {
    const dom = new JSDOM('', { url: url(platform, 'a') });
    try {
      paint(dom, platform, [OLD]); const h = harness(dom, platform);
      assert.equal(await h.capture(), true);
      const node = dom.window.document.querySelector('main').firstElementChild;
      node.setAttribute('data-message-id', 'settled-native-turn');
      node.querySelector('p').textContent = `${OLD} Continued streaming text.`;
      assert.equal(await h.capture(), true);
      let rows = (await db.readConversation(conv(platform).id)).messages;
      assert.equal(rows.length, 1); assert.equal(rows[0].body, node.textContent);
      node.setAttribute('data-message-id', 'another-native-turn');
      node.querySelector('p').textContent = NEW;
      assert.equal(await h.capture(), true);
      rows = (await db.readConversation(conv(platform).id)).messages;
      assert.equal(rows.length, 2, 'a reused node with a different native turn must stay separate');
    } finally { dom.window.close(); }
  });
}

await check('ChatGPT heuristic keeps repeated messages at different positions', async () => {
  const dom = new JSDOM('', { url: url('chatgpt', 'a') });
  try {
    const doc = dom.window.document; const main = doc.createElement('main');
    for (let i = 0; i < 2; i++) {
      const turn = doc.createElement('section'); const h = doc.createElement('h2');
      h.textContent = 'You'; const p = doc.createElement('p'); p.textContent = OLD;
      turn.append(h, p); main.append(turn);
    }
    const article = doc.createElement('article'); article.append(main);
    doc.body.append(article); const h = harness(dom, 'chatgpt');
    assert.equal(await h.capture(), true);
    const rows = (await db.readConversation(conv().id)).messages;
    assert.equal(rows.length, 2); assert.equal(new Set(rows.map(m => m.id)).size, 2);
  } finally { dom.window.close(); }
});

assert.deepEqual(failures, [], `Capture integrity regressions: ${failures.join(', ')}`);
console.log('capture-integrity ok');
