// Exercise the real idle queue, load callbacks and post-encode guard.
// Images and canvas bytes are local samples; no requests or real accounts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { JSDOM } from 'jsdom';

const source = name => readFileSync(new URL(`../content/${name}.js`, import.meta.url), 'utf8');
const id = c => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const url = c => `https://claude.ai/chat/${id(c)}`;
const body = 'Sample upload about the quiet mountain forest.';

function harness(withImage = true) {
  const dom = new JSDOM('<main><div data-testid="user-message"><p></p></div></main>', { url: url('a') });
  const host = dom.window.document.querySelector('[data-testid]'); host.querySelector('p').textContent = body;
  let loaded = false, onEncode = () => {};
  const timers = [], sent = [];
  function addImage(src = '/sample-upload') {
    const img = dom.window.document.createElement('img'); img.setAttribute('src', src); img.alt = 'Sample picture';
    for (const [key, read] of Object.entries({ complete: () => loaded, naturalWidth: () => loaded ? 200 : 0,
      naturalHeight: () => loaded ? 100 : 0, currentSrc: () => loaded ? new URL(img.getAttribute('src'), dom.window.location.href).href : '' })) {
      Object.defineProperty(img, key, { get: read });
    }
    host.append(img); return img;
  }
  const img = withImage ? addImage() : null;
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {}, getImageData() { return {}; } });
  dom.window.HTMLCanvasElement.prototype.toBlob = callback => {
    onEncode(); callback({ size: 4, arrayBuffer: async () => new Uint8Array([1, 3, 5, 7]).buffer });
  };
  const ctx = createContext({ window: dom.window, document: dom.window.document, location: dom.window.location,
    Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, URL, ArrayBuffer, Uint8Array,
    console: { log() {}, warn() {} },
    setTimeout(fn, ms) { const timer = { fn, ms, active: true }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.active = false; }, setInterval() {}, clearInterval() {},
    chrome: { runtime: { id: 'image-integrity', sendMessage(payload, callback) {
      sent.push(payload); callback({ ok: true, saved: 1 });
    } } },
  });
  runInContext(`${source('shared')}\nChatseek.autoStart=false;\n${source('images')}\nglobalThis.api=Chatseek;`, ctx);
  const identity = ctx.api.pageIdentity({}, dom.window.document, url('a'), id('a'),
    { messages: [{ body }], nodes: [host] }, raw => ctx.api.uuidFrom(raw)); identity.accept();
  return { dom, img, host, addImage,
    navigate(c) { dom.window.history.pushState({}, '', url(c)); },
    loaded(value = true) { loaded = value; }, onEncode(fn) { onEncode = fn; },
    schedule(c = 'a') { const conversationId = `claude:${id(c)}`;
      ctx.api.scheduleMessageImages({ conversationId, isCurrent: c === 'a' ? identity.check : undefined,
        items: [{ el: host, messageId: `${conversationId}:sample`, role: 'user', body }] });
    },
    captures: () => sent.filter(payload => payload.type === 'CAPTURE_IMAGES'),
    async flush() {
      for (let i = 0; i < 100; i++) {
        const timer = timers.find(t => t.active && t.ms === 0);
        if (timer) { timer.active = false; timer.fn(); }
        await Promise.resolve();
      }
    },
  };
}

async function check(name, run, withImage = true) {
  const h = harness(withImage);
  try { await run(h); console.log(`image-integrity PASS: ${name}`); }
  finally { h.dom.window.close(); }
}

await check('ordinary navigation cancels the queued image', async h => {
  h.schedule(); h.navigate('b'); await h.flush(); assert.equal(h.captures().length, 0);
});
await check('same-text A-B-A cannot claim a new B picture; a valid B job still stores it', async h => {
  h.schedule(); h.navigate('b'); h.addImage(); h.navigate('a'); await h.flush();
  assert.equal(h.captures().length, 0);
  h.navigate('b'); h.schedule('b'); await h.flush();
  assert.equal(h.captures().length, 1); assert.equal(h.captures()[0].conversationId, `claude:${id('b')}`);
}, false);
await check('same image node with a replaced source is rejected after returning', async h => {
  h.schedule(); h.navigate('b'); h.img.setAttribute('src', '/another-upload'); h.navigate('a');
  await h.flush(); assert.equal(h.captures().length, 0);
});
await check('navigation during canvas encoding cannot send the old image', async h => {
  h.loaded(); h.onEncode(() => h.navigate('b')); h.schedule(); await h.flush();
  assert.equal(h.captures().length, 0);
});
await check('a late load callback after navigation cannot requeue the image', async h => {
  h.schedule(); await h.flush(); assert.equal(h.captures().length, 1);
  h.navigate('b'); h.loaded(); h.img.dispatchEvent(new h.dom.window.Event('load')); await h.flush();
  assert.equal(h.captures().length, 1);
});
await check('a normal pending image becomes a cached WebP for the original message', async h => {
  h.schedule(); await h.flush(); assert.equal(h.captures()[0].images[0].status, 'not-loaded');
  h.loaded(); h.img.dispatchEvent(new h.dom.window.Event('load')); await h.flush();
  assert.equal(h.captures().length, 2);
  const capture = h.captures()[1]; const image = capture.images[0];
  assert.equal(capture.conversationId, `claude:${id('a')}`);
  assert.equal(image.messageId, `claude:${id('a')}:sample`);
  assert.equal(image.status, 'cached'); assert.equal(image.mime, 'image/webp');
  assert.deepEqual(Array.from(image.bytes), [1, 3, 5, 7]);
  assert.equal('src' in image || 'url' in image, false);
});
console.log('image-integrity ok');
