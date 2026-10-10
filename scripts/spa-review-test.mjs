// Independent review: try to lose legitimate data, rather than only repair pollution.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import * as db from '../src/db.js';

const ids = ['a', 'b'].map(c => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`);
const conv = n => ({id:`chatgpt:${ids[n]}`, platform:'chatgpt', platformId:ids[n],
  url:`https://chatgpt.com/c/${ids[n]}`, title:'Review sample'});
const text = 'Legitimate conversation about maple trees and a quiet garden.';
function paint(dom, body = text, native = '') {
  const doc = dom.window.document, main = doc.createElement('main'), turn = doc.createElement('div');
  turn.setAttribute('data-turn', 'user');
  turn.setAttribute('aria-setsize', '1'); turn.setAttribute('aria-posinset', '1');
  if (native) turn.setAttribute('data-message-id', native);
  const p = doc.createElement('p'); p.textContent = body; turn.append(p); main.append(turn);
  doc.body.replaceChildren(main);
}
function api(dom) {
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const ctx = createContext({window:dom.window, document:dom.window.document, location:dom.window.location,
    Date:Clock, Node:dom.window.Node, NodeFilter:dom.window.NodeFilter, URL,
    console:{log(){},warn(){}}, setTimeout, clearTimeout, setInterval, clearInterval,
    chrome:{runtime:{id:'review', sendMessage(p, cb) {
      const run = async () => {
        if (p.type === 'CAPTURE_MESSAGES') return {ok:true, ...await db.upsertMessages(p.conversation,p.messages,p)};
        if (p.type === 'CAPTURE_CONVERSATIONS') await db.upsertConversations(p.conversations);
        return {ok:true};
      };
      run().then(cb, error => cb({ok:false,error:String(error)}));
    }}}});
  runInContext(`${readFileSync('content/shared.js','utf8')}\nChatseek.autoStart=false; Chatseek.safeScheduleImages=()=>{};\n${readFileSync('content/chatgpt.js','utf8')}\nglobalThis.api=Chatseek;`,ctx);
  ctx.api.advance = ms => { now += ms; };
  return ctx.api;
}
async function meta(key) {
  const tx = (await db.openDb()).transaction('meta','readonly');
  return new Promise((resolve,reject) => {
    const request = tx.objectStore('meta').get(key);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function expireGate() {
  const tx = (await db.openDb()).transaction('meta','readwrite'); tx.objectStore('meta').delete('spa:recent');
  await new Promise((resolve,reject) => {tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
}
const failures = [];
async function test(name, run) {
  await db.clearAll();
  try { await run(); console.log(`review PASS: ${name}`); }
  catch (error) { failures.push(name); console.error(`review FAIL: ${name}: ${error.message}`); }
}

await test('native id with extra colon must not look synthetic', async () => {
  const row = {id:`${conv(1).id}:native:dead:dom999`,role:'user',body:text};
  await db.upsertMessages(conv(1),[row]);
  await db.saveImageRecords(conv(1).id,[{messageId:row.id,index:0,status:'cached',mime:'image/webp',bytes:[1,2],width:1,height:1}]);
  const dom = new JSDOM('',{url:conv(1).url});
  try {
    paint(dom,'A different full page about ocean creatures beneath the moon.'); await api(dom).platforms.chatgpt.capture();
    assert((await db.readConversation(conv(1).id)).messages.some(m=>m.id===row.id),'legitimate native row deleted');
    assert.equal((await db.readImagesForMessages([row.id])).length,1);
    assert.equal((await db.readImageBytes(row.id,0)).blob.byteLength,2);
  } finally { dom.window.close(); }
});

await test('legitimate identical conversations survive later branch changes', async () => {
  const rows = n => [{id:`${conv(n).id}:native-user-${n}`,role:'user',body:text},
    {id:`${conv(n).id}:native-assistant-${n}`,role:'assistant',body:'A legitimate answer about a forest trail.'}];
  await db.upsertMessages(conv(0),rows(0)); await db.upsertMessages(conv(1),rows(1));
  const old = rows(1)[1];
  await db.saveImageRecords(conv(1).id,[{messageId:old.id,index:0,status:'cached',mime:'image/webp',bytes:[3],width:1,height:1}]);
  const dom = new JSDOM('',{url:conv(1).url});
  try {
    paint(dom,'A new selected branch about enormous sea creatures.'); await api(dom).platforms.chatgpt.capture();
    const stored = (await db.readConversation(conv(1).id)).messages;
    assert(stored.some(m=>m.id===old.id),'matching another legitimate transcript is not pollution evidence');
    assert.deepEqual((await db.readConversation(conv(0).id)).messages.map(m=>m.body),rows(0).map(m=>m.body));
    assert.equal((await db.readImagesForMessages([old.id])).length,1);
  } finally { dom.window.close(); }
});

await test('complete growing synthetic turn rekeys without losing image bytes', async () => {
  const old = {id:`${conv(1).id}:dead:dom1`,role:'user',body:text};
  await db.upsertMessages(conv(1),[old]);
  await db.saveImageRecords(conv(1).id,[{messageId:old.id,index:0,status:'cached',mime:'image/webp',bytes:[4,5],width:1,height:1}]);
  const before = await meta('imageBytes');
  const dom = new JSDOM('',{url:conv(1).url});
  try {
    paint(dom,text+' Continued with a normal longer update.'); await api(dom).platforms.chatgpt.capture();
    const stored = (await db.readConversation(conv(1).id)).messages;
    assert.equal(stored.length,1);
    const image = (await db.readImagesForMessages([stored[0].id]))[0];
    assert(image,'absence-based pruning must follow normal turn alignment');
    assert.equal((await db.readImageBytes(stored[0].id,0)).blob.byteLength,2);
    assert.deepEqual(await meta('imageBytes'),before,'cached byte counter unchanged by rekey');
    const order = await meta(`order:${conv(1).id}`);
    assert(!order?.ids.includes(old.id),'old id must not survive in order');
  } finally { dom.window.close(); }
});

await test('identical replacement body needs content ownership after five seconds', async () => {
  const dom = new JSDOM('',{url:conv(0).url});
  try {
    paint(dom); const a=api(dom); await a.platforms.chatgpt.capture();
    dom.window.history.pushState({},'',conv(1).url);
    assert.equal(await a.platforms.chatgpt.capture(),false,'unchanged old nodes always held');
    a.advance(6000); await expireGate();
    assert.equal(await a.platforms.chatgpt.capture(),false,'expiry cannot authorize residual old nodes');
    paint(dom);
    assert.equal(await a.platforms.chatgpt.capture(),false,'fresh nodes alone cannot authorize known foreign text');
    dom.window.document.querySelector('main').setAttribute('data-conversation-id',ids[1]);
    assert.equal(await a.platforms.chatgpt.capture(),true,'content-owned identical conversations must survive');
    assert.equal((await db.readConversation(conv(1).id)).messages.length,1);
    paint(dom,text+' Normal update in the same conversation.');
    assert.equal(await a.platforms.chatgpt.capture(),true,'same-conversation update must not be hash-blocked');
  } finally { dom.window.close(); }
});

await test('long complete page split over chunks never prunes unseen rows', async () => {
  const old = {id:`${conv(1).id}:dead:dom99`,role:'user',body:'Earlier legitimate message about distant hills.'};
  await db.upsertMessages(conv(1),[old]);
  const dom = new JSDOM('',{url:conv(1).url});
  try {
    const doc=dom.window.document, main=doc.createElement('main');
    for (let i=0;i<25;i++) {
      const turn=doc.createElement('div');turn.setAttribute('data-turn','user');
      turn.setAttribute('aria-setsize','25');turn.setAttribute('aria-posinset',String(i+1));
      turn.textContent=`Long conversation window message ${i} about a forest and a river.`;main.append(turn);
    }
    doc.body.append(main);await api(dom).platforms.chatgpt.capture();
    assert((await db.readConversation(conv(1).id)).messages.some(m=>m.id===old.id));
  } finally {dom.window.close();}
});

await test('verified full native body replaces a longer polluted prefix', async () => {
  const old = {id:`${conv(1).id}:native-shared`,role:'user',body:text+' Incorrect extra material from an earlier conversation.'};
  await db.upsertMessages(conv(1),[old]);
  const dom = new JSDOM('',{url:conv(1).url});
  try {
    paint(dom,text,'native-shared'); await api(dom).platforms.chatgpt.capture();
    const stored = await db.readConversation(conv(1).id);
    assert.equal(stored.messages[0].body,text,'verified complete text must overwrite the polluted longer body');
    assert(!stored.conversation.firstUserPreview.includes('Incorrect extra material'),'polluted preview must not survive replacement');
    assert.equal(stored.conversation.updatedAtSource,'first-seen','repair is not new observed activity');
  } finally { dom.window.close(); }
});

await test('URL changes while awaiting health cannot send either transcript', async () => {
  for (const heuristic of [false,true]) {
    await db.clearAll();
    const dom = new JSDOM('',{url:conv(0).url});
    try {
      paint(dom);
      if (heuristic) dom.window.document.querySelector('[data-turn]').removeAttribute('data-turn');
      const a=api(dom), send=a.send;
      a.send=p=>{
        if (p.type==='CAPTURE_HEALTH') dom.window.history.pushState({},'',conv(1).url);
        return send(p);
      };
      assert.equal(await a.platforms.chatgpt.capture(),false);
      for (const n of [0,1]) assert.equal((await db.readConversation(conv(n).id))?.messages.length || 0,0);
    } finally { dom.window.close(); }
  }
});

await test('real background checks sender URL, hashes legacy messages, and persists gate', async () => {
  let listener;
  const notices=[];
  globalThis.chrome={runtime:{id:'review',onInstalled:{addListener(){}},onStartup:{addListener(){}},
    onMessage:{addListener(fn){listener=fn;}},sendMessage(p){notices.push(p);return Promise.resolve();}},
    sidePanel:{setPanelBehavior:()=>Promise.resolve()}};
  await import('../background.js');
  const payload=n=>({type:'CAPTURE_MESSAGES',platform:'chatgpt',conversation:conv(n),
    messages:[{id:`${conv(n).id}:native`,role:'user',body:text}]});
  const send=(msg,n)=>new Promise(resolve=>listener(msg,{tab:{url:conv(n).url,id:n+1},url:conv(n).url},resolve));
  assert((await send(payload(1),0)).held,'browser sender URL mismatch must hold');
  assert.equal((await db.readConversation(conv(1).id))?.messages.length || 0,0);
  assert.equal((await send(payload(0),0)).held,false);
  const count=notices.length;
  assert((await send(payload(1),1)).held,'legacy message without supplied hash is independently guarded');
  assert.equal(notices.length,count,'held capture must not notify INDEX_UPDATED');
  await import('../background.js?review-restart');
  assert((await send(payload(1),1)).held,'rebooted worker must use persisted hash gate');
  await expireGate();
  assert.equal((await send(payload(1),1)).held,false);
  const update=payload(1);update.messages[0].body=text+' Same conversation normal update.';
  assert.equal((await send(update,1)).held,false);
  assert.equal((await db.readConversation(conv(1).id)).messages[0].body,update.messages[0].body);
});
assert.deepEqual(failures,[],`Independent SPA review failed: ${failures.join(', ')}`);
console.log('spa-review ok');
