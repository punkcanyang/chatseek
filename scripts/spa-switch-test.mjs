import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const git = promisify(execFile);
const baselineSources = new Map();
async function fromMain(path) {
  if (!baselineSources.has(path)) baselineSources.set(path, (await git('git', ['show', `213dde2:${path}`], {encoding:'utf8'})).stdout);
  return baselineSources.get(path);
}
await fromMain('content/shared.js'); await fromMain('content/chatgpt.js');
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { createContext, runInContext } from 'node:vm';
import * as db from '../src/db.js';
import { formatActivityLabel } from '../src/activity-time.js';
const ids = ['a','b','c'].map(c => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`);
const url = n => `https://chatgpt.com/c/${ids[n]}`;
const body = n => `Sample conversation ${n}: ${['maple forest and quiet tea garden','ocean creatures beneath a silver moon','a telescope on the mountain'][n]}.`;
function paint(dom, n, heuristic = false) {
  dom.window.document.body.innerHTML = `<main>${heuristic ? `<section><p>${body(n)}</p></section>` : `<div data-turn="user"><div class="markdown">${body(n)}</div></div>`}</main>`;
}
function api(dom, database, baseline = false) {
  const sent = [];
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const ctx = createContext({ window: dom.window, document: dom.window.document, location: dom.window.location,
    Date: Clock, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, URL, console: { log() {}, warn() {} },
    setTimeout: (f, ms) => { const t = setTimeout(f, ms); t.unref(); return t; }, clearTimeout, setInterval, clearInterval,
    chrome: { runtime: { id: 'test', sendMessage: (p, cb) => {
      sent.push(p);
      const run = async () => {
        if (p.type === 'CAPTURE_MESSAGES') return {ok:true, ...await database.upsertMessages(p.conversation,p.messages,p)};
        if (p.type === 'CAPTURE_CONVERSATIONS') await database.upsertConversations(p.conversations);
        return {ok:true};
      }; run().then(cb, e => { console.error(e); cb({ok:false}); });
    } } } });
  const source = path => baseline ? baselineSources.get(path) : readFileSync(path,'utf8');
  runInContext(`${source('content/shared.js')}\nChatseek.autoStart=false; Chatseek.safeScheduleImages=()=>{};\n${source('content/chatgpt.js')}\nglobalThis.api=Chatseek;`,ctx);
  ctx.api.sent = sent;
  ctx.api.advance = ms => { now += ms; };
  return ctx.api;
}
// Execute the actual 1.7.2 capture and DB, including its dynamic DOM ids.
const dir = mkdtempSync(join(tmpdir(),'chatseek-spa-baseline-'));
try {
  writeFileSync(join(dir,'package.json'),'{"type":"module"}');
  const loaded = new Set();
  async function load(file) {
    if (loaded.has(file)) return; loaded.add(file);
    let s = await fromMain(`src/${file}`);
    for (const m of s.matchAll(/from "\.\/([^"\n]+)"/g)) await load(m[1]);
    if (file==='db.js') s=s.replace('const DB_NAME = "chatseek"','const DB_NAME = "chatseek-spa-baseline"');
    writeFileSync(join(dir,file),s);
  }
  await load('db.js'); const oldDb=await import(`file://${dir}/db.js`);
  for (const heuristic of [false,true]) {
    await oldDb.clearAll();
    const dom=new JSDOM('',{url:url(0)}); paint(dom,0,heuristic);
    const a=api(dom,oldDb,true); await a.platforms.chatgpt.capture();
    dom.window.history.pushState({},'',url(1)); await a.platforms.chatgpt.capture();
    const b=await oldDb.readConversation(`chatgpt:${ids[1]}`);
    assert(b.messages.some(m=>m.body===body(0)), 'actual baseline must reproduce A written into B');
    console.log(`baseline 213dde2 ${heuristic?'heuristic':'selector'}: BUG reproduced, A body stored in B`);
    dom.window.close();
  }
  {
    await oldDb.clearAll();
    const dom=new JSDOM('',{url:url(0)});paint(dom,0);const a=api(dom,oldDb,true);await a.platforms.chatgpt.capture();
    dom.window.history.pushState({},'',url(1));paint(dom,1);
    const script=dom.window.document.createElement('script');script.type='application/json';
    script.textContent=JSON.stringify({conversation_id:ids[1],update_time:(Date.now()-86400000)/1000});dom.window.document.head.append(script);
    await a.platforms.chatgpt.capture();
    const snapshot=await oldDb.readConversation(`chatgpt:${ids[1]}`);
    assert(snapshot.messages.some(m=>m.body===body(1)),'old date reproduction must actually capture repainted B');
    assert.equal(snapshot.conversation.updatedAtSource,'first-seen','old 15-second cache misses newly painted B JSON date');
    console.log('baseline 213dde2 date: B JSON time missed by cross-URL 15-second cache');
    dom.window.close();
  }
  (await oldDb.openDb()).close();
} finally { rmSync(dir,{recursive:true,force:true}); }
if (process.argv.includes('--baseline-only')) process.exit(0);
async function capture(a) { await a.platforms.chatgpt.capture(); a.advance(1000); return a.platforms.chatgpt.capture(); }
async function rows(n) { return (await db.readConversation(`chatgpt:${ids[n]}`))?.messages || []; }
async function reset() { await db.clearAll(); }
for (const heuristic of [false,true]) {
  await reset();
  const dom = new JSDOM('', {url:url(0)}); paint(dom,0,heuristic);
  const a=api(dom,db);
  const wrong=dom.window.document.createElement('link'); wrong.rel='canonical'; wrong.href=url(1); dom.window.document.head.append(wrong);
  assert.equal(await a.platforms.chatgpt.capture(),false,'mismatching initial page held before any write');
  wrong.remove();
  // A has not been written: switch still must compare its DOM.
  dom.window.history.pushState({},'',url(1));
  assert.equal(await a.platforms.chatgpt.capture(),false);
  assert.equal((await rows(1)).length,0);
  dom.window.history.pushState({},'',url(2));
  assert.equal(await a.platforms.chatgpt.capture(),false,'rapid B -> C retains A baseline');
  paint(dom,2,heuristic); await capture(a);
  assert.deepEqual((await rows(2)).map(m=>m.body),[body(2)]);
  const undated=(await db.readConversation(`chatgpt:${ids[2]}`)).conversation;
  assert.equal(undated.updatedAtSource,'first-seen','no page/JSON/bucket date keeps capture-only source');
  assert(formatActivityLabel(undated,Date.now(),'zh-TW').text.startsWith('收錄於 '),'capture date explicitly labelled');
  dom.window.history.pushState({},'',url(0)); paint(dom,0,heuristic); await capture(a);
  dom.window.history.pushState({},'',url(1));
  await a.platforms.chatgpt.capture(); assert.equal((await rows(1)).length,0,'A residue must not become B');
  // Even an updated sidebar marker is not permission to write old nodes.
  const link=dom.window.document.createElement('a'); link.href=url(1); link.setAttribute('aria-current','page'); dom.window.document.body.append(link);
  assert.equal(await a.platforms.chatgpt.capture(),false);
  const mixed=dom.window.document.createElement(heuristic?'section':'div');
  if(!heuristic) mixed.setAttribute('data-turn','user');
  const p=dom.window.document.createElement('p');p.textContent=body(1);mixed.append(p);dom.window.document.querySelector('main').append(mixed);
  assert.equal(await a.platforms.chatgpt.capture(),false,'mixed old A and new B turns must remain held');
  assert.equal((await rows(1)).length,0);
  paint(dom,1,heuristic); await capture(a);
  assert.deepEqual((await rows(1)).map(m=>m.body),[body(1)]);
  await new Promise(resolve => { dom.window.addEventListener('popstate',resolve,{once:true}); dom.window.history.back(); });
  assert.equal(dom.window.location.href,url(0));
  assert.equal(await a.platforms.chatgpt.capture(),false,'back keeps B DOM until repaint');
  paint(dom,0,heuristic); await capture(a);
  assert.deepEqual((await rows(0)).map(m=>m.body),[body(0)]);
  console.log(`fixed ${heuristic?'heuristic':'selector'}: delayed repaint, no prior write, rapid switches, popstate/back ok`);
  dom.window.close();
}
// Each marker has a matching and mismatching fixture; all pass through capture.
for (const kind of ['current','active','active-parent','canonical','og','ancestor']) {
  await reset(); const dom=new JSDOM('',{url:url(0)}); paint(dom,0);
  const mark=(n)=>{
    const doc=dom.window.document;
    if(kind==='ancestor') { doc.querySelector('main').setAttribute('data-conversation-id',ids[n]); return; }
    const el=doc.createElement(kind==='canonical'?'link':kind==='og'?'meta':'a');
    if(kind==='canonical') el.rel='canonical';
    if(kind==='og') { el.setAttribute('property','og:url'); el.setAttribute('content',url(n)); }
    else el.setAttribute('href',url(n));
    if(kind==='current') el.setAttribute('aria-current','page');
    if(kind==='active') el.setAttribute('data-active','true');
    if(kind==='active-parent') { const p=doc.createElement('nav'); p.setAttribute('data-active','true'); p.append(el); doc.body.append(p); }
    else (kind==='og'||kind==='canonical'?doc.head:doc.body).append(el);
  };
  mark(1); const a=api(dom,db); assert.equal(await capture(a),false,`${kind} mismatch`);
  assert.equal((await rows(0)).length,0);
  dom.window.document.querySelectorAll('link,meta,a,nav').forEach(n=>n.remove()); mark(0);
  assert.equal(await capture(a),true,`${kind} match`); assert.equal((await rows(0)).length,1);
  dom.window.close();
}
console.log('marker mismatch/match fixtures ok');
// Same transcript after DOM replacement is held by content, even when a marker
// matches the new URL. DB's independent persisted gate covers separate tabs.
await reset();
{
  const dom=new JSDOM('',{url:url(0)}); paint(dom,0); const a=api(dom,db); await capture(a);
  dom.window.history.pushState({},'',url(1)); paint(dom,0);
  const main=dom.window.document.querySelector('main'); main.setAttribute('data-conversation-id',ids[1]);
  assert.equal(await a.platforms.chatgpt.capture(),false); assert.equal((await rows(1)).length,0);
  const c=n=>({id:`chatgpt:${ids[n]}`,platform:'chatgpt',platformId:ids[n],url:url(n),title:'Sample'});
  const m=n=>[{id:`${c(n).id}:native`,role:'user',body:body(0)}];
  const hash=a.transcriptHash(m(1));
  assert.equal((await db.upsertMessages(c(1),m(1),{bodyHash:hash})).held,true,'background blocks another tab');
  // Persistent gate expiry without a slow wall-clock sleep.
  const database=await db.openDb(); const tx=database.transaction('meta','readwrite');
  tx.objectStore('meta').put({key:'spa:recent',rows:[{convId:c(0).id,hash,at:Date.now()-5001}]});
  await new Promise((res,rej)=>{tx.oncomplete=res;tx.onerror=()=>rej(tx.error);});
  a.advance(5001); assert.equal(await a.platforms.chatgpt.capture(),true,'after 5 seconds the identical legitimate transcript is eligible');
  assert.equal((await rows(1)).length,1);
  dom.window.close();
}
console.log('content + persisted multi-tab 5-second hash gates and expiry ok');
// Location changes during an await: abandon before any message send.
await reset();
{
  const dom=new JSDOM('',{url:url(0)}); paint(dom,0); const a=api(dom,db);
  a.advance(1000); const original=a.structureDiagLight; a.structureDiagLight=()=>{dom.window.history.pushState({},'',url(1)); return {};};
  assert.equal(await a.platforms.chatgpt.capture(),false); assert.equal((await rows(0)).length,0); assert.equal((await rows(1)).length,0);
  a.structureDiagLight=original; dom.window.close();
}
console.log('changed location after extraction discarded');
// Repair only with complete, non-streaming position evidence. Stable native
// messages and absent dom messages in a partial window are preserved.
for (const partial of [false,true]) {
  await reset();
  const c={id:`chatgpt:${ids[1]}`,platform:'chatgpt',platformId:ids[1],url:url(1),title:'Correct B'};
  const stale={id:`${c.id}:dead:dom999`,role:'user',body:body(0)};
  const stable={id:`${c.id}:dom123`,role:'user',body:'A legitimate older stable native message.'};
  await db.upsertMessages(c,[stale,stable],{});
  await db.saveImageRecords(c.id, [{messageId:stale.id,index:0,status:'cached',mime:'image/webp',bytes:[1,2],width:1,height:1},
    {messageId:stable.id,index:0,status:'cached',mime:'image/webp',bytes:[3],width:1,height:1}]);
  const dom=new JSDOM('',{url:url(1)}); paint(dom,1);
  const node=dom.window.document.querySelector('[data-turn]');
  if(!partial) {node.setAttribute('aria-setsize','1');node.setAttribute('aria-posinset','1');}
  const a=api(dom,db); await capture(a);
  const stored=await rows(1);
  assert.equal(stored.some(m=>m.id===stale.id),partial,'missing dom id removed only for complete capture');
  assert(stored.some(m=>m.id===stable.id),'stable native data must survive');
  assert(stored.some(m=>m.body===body(1)),'correct B content stored');
  const snap=await db.readConversation(c.id); assert.equal(snap.conversation.messageCount,stored.length);
  if(!partial) assert(!snap.conversation.firstUserPreview.includes(body(0)),'contaminated preview cleared');
  const tx=(await db.openDb()).transaction('tokenMap','readonly');
  const tokens=await new Promise((res,rej)=>{const r=tx.objectStore('tokenMap').getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});
  if(!partial) assert(!tokens.some(r=>r.source===stale.id),'stale search tokens deleted');
  assert.equal((await db.readImagesForMessages([stale.id])).length,partial?1:0,'stale thumbnail removed with row');
  assert.equal((await db.readImagesForMessages([stable.id])).length,1,'normal thumbnail survives');
  assert.equal(await db.imageCacheUsage(),partial?3:1,'repair decrements only the deleted thumbnail bytes');
  if(!partial) assert.equal(await db.readImageBytes(stale.id,0),null,'deleted thumbnail blob cannot be read');
  assert.equal((await db.readImageBytes(stable.id,0)).blob.byteLength,1,'native image bytes retained');
  dom.window.close();
}
console.log('complete repair clears wrong dom rows/tokens/previews; partial + stable rows preserved');
// Even an identical whole transcript can be a legitimate native-id branch.
for (const full of [false,true]) {
  await reset();
  const c=n=>({id:`chatgpt:${ids[n]}`,platform:'chatgpt',platformId:ids[n],url:url(n),title:'Sample'});
  const old=n=>[{id:`${c(n).id}:u-native`,role:'user',body:body(0)},
    {id:`${c(n).id}:a-native`,role:'assistant',body:'An identical full assistant answer describing maple trees.'}];
  await db.upsertMessages(c(0),old(0)); await db.upsertMessages(c(1),old(1));
  const dom=new JSDOM('',{url:url(1)}); paint(dom,1);
  if(full) { const n=dom.window.document.querySelector('[data-turn]'); n.setAttribute('aria-setsize','1');n.setAttribute('aria-posinset','1'); }
  const a=api(dom,db); await capture(a);
  const stored=await rows(1);
  assert(stored.some(m=>m.body===body(0)),'native cross-copy preserved even after full page proof');
  assert.deepEqual((await rows(0)).map(m=>m.body),old(0).map(m=>m.body),'source conversation untouched');
  dom.window.close();
}
console.log('native identical transcripts and source retained');
// Full-page evidence from exported JSON ancestry: never accept missing turns,
// branches, wrong conversation, streaming, or virtualized windows.
{
  const dom=new JSDOM('',{url:url(1)}); paint(dom,1); const a=api(dom,db);
  const extracted=a.platforms.chatgpt.extractMessages(ids[1],dom.window.document,false);
  const data={conversation_id:ids[1],current_node:'tail',mapping:{root:{parent:null},tail:{parent:'root',message:{author:{role:'user'},content:{content_type:'text',parts:[body(1)]}}},
    branch:{parent:'root',message:{author:{role:'assistant'},content:{content_type:'text',parts:['another branch']}}}}};
  const script=dom.window.document.createElement('script');script.type='application/json';script.textContent=JSON.stringify(data);dom.window.document.head.append(script);
  assert(a.completeTranscript(dom.window.document,extracted,ids[1]),'exact selected JSON ancestry proves completeness');
  assert(!a.completeTranscript(dom.window.document,extracted,ids[0]),'other conversation JSON does not prove this page');
  const main=dom.window.document.querySelector('main');
  for(const attr of ['data-is-streaming','aria-busy','data-virtualized']) {main.setAttribute(attr,'true');assert(!a.completeTranscript(dom.window.document,extracted,ids[1]));main.removeAttribute(attr);}
  data.mapping.root.message={author:{role:'user'},content:{content_type:'text',parts:['unrendered earlier turn']}};
  script.textContent=JSON.stringify(data); assert(!a.completeTranscript(dom.window.document,extracted,ids[1]),'unrendered older turn makes the snapshot partial');
  dom.window.close();
}
console.log('JSON full-transcript proof; partial/streaming/virtualized/other-chat evidence rejected');
await reset();
{
  const dom=new JSDOM('',{url:url(0)});paint(dom,0);const a=api(dom,db);await capture(a);
  dom.window.history.pushState({},'',url(1));dom.window.document.querySelector('main').replaceChildren();
  const before=a.sent.length;
  assert.equal(await a.platforms.chatgpt.capture(),false);
  a.advance(20000); assert.equal(await a.platforms.chatgpt.capture(),false);
  assert(!a.sent.slice(before).some(p=>p.type==='CAPTURE_HEALTH' && p.health.warn),'held empty switch must not trigger zero-message warning');
  paint(dom,1); assert.equal(await a.platforms.chatgpt.capture(),true);
  dom.window.close();
}
console.log('empty DOM during switch held without zero-message warning');
await reset();
{
  const dom=new JSDOM('',{url:url(0)});paint(dom,0);const a=api(dom,db);await capture(a);
  paint(dom,0);dom.window.document.querySelector('p, .markdown').textContent=body(0)+' Updated on the same page before a failed write.';
  const send=a.send;a.send=payload=>payload.type==='CAPTURE_MESSAGES'?Promise.resolve(null):send(payload);
  assert.equal(await a.platforms.chatgpt.capture(),false,'simulate a failed A write');
  a.send=send;dom.window.history.pushState({},'',url(1));
  assert.equal(await a.platforms.chatgpt.capture(),false,'latest observed A nodes must stay protected even when their write failed');
  assert.equal((await rows(1)).length,0);
  dom.window.close();
}
console.log('latest safe observation retained across failed write');
await reset();
{
  const c={id:`chatgpt:${ids[1]}`,platform:'chatgpt',platformId:ids[1],url:url(1),title:'Sample'};
  const stale={id:`${c.id}:badcafe:dom555`,role:'user',body:body(0)};
  await db.upsertMessages(c,[stale]);
  const dom=new JSDOM('',{url:url(1)});paint(dom,1);
  const node=dom.window.document.querySelector('[data-turn]');node.setAttribute('aria-setsize','1');node.setAttribute('aria-posinset','1');
  const a=api(dom,db),send=a.send;
  a.send=p=>{if(p.type==='CAPTURE_HEALTH') node.setAttribute('aria-busy','true'); return send(p);};
  await a.platforms.chatgpt.capture();
  assert((await rows(1)).some(m=>m.id===stale.id),'completeness lost during health await must cancel repair');
  a.send=send;node.removeAttribute('aria-busy'); await a.platforms.chatgpt.capture();
  assert(!(await rows(1)).some(m=>m.id===stale.id),'partial -> full must retry repair even with unchanged bodies/ids');
  dom.window.close();
}
console.log('completeness revalidated at send; partial -> full repairs unchanged transcript');
await reset();
{
  const dom=new JSDOM('',{url:url(0)});paint(dom,0);const a=api(dom,db);await capture(a);
  dom.window.history.pushState({},'',url(1));paint(dom,1);
  const script=dom.window.document.createElement('script');script.type='application/json';
  const stamp=Date.now()-86400000;script.textContent=JSON.stringify({conversation_id:ids[1],update_time:stamp/1000});dom.window.document.head.append(script);
  await a.platforms.chatgpt.capture();
  const c=(await db.readConversation(`chatgpt:${ids[1]}`)).conversation;
  assert.equal(c.updatedAtSource,'page-exact','SPA cache must reread B JSON within 15 seconds');
  assert.equal(c.updatedAt,stamp,'B JSON timestamp preserved exactly');
  dom.window.close();
}
console.log('date source fallback explicit; SPA JSON time cache invalidated');
console.log('spa-switch ok');
