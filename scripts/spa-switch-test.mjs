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
const ids = ['a','b','c'].map(c => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`);
const url = n => `https://chatgpt.com/c/${ids[n]}`;
const body = n => `Sample conversation ${n}: ${['maple forest and quiet tea garden','ocean creatures beneath a silver moon','a telescope on the mountain'][n]}.`;
function paint(dom, n, heuristic = false) {
  dom.window.document.body.innerHTML = `<main>${heuristic ? `<section><p>${body(n)}</p></section>` : `<div data-turn="user"><div class="markdown">${body(n)}</div></div>`}</main>`;
}
function api(dom, database, baseline = false) {
  const ctx = createContext({ window: dom.window, document: dom.window.document, location: dom.window.location,
    Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, URL, console: { log() {}, warn() {} },
    setTimeout: (f, ms) => { const t = setTimeout(f, ms); t.unref(); return t; }, clearTimeout, setInterval, clearInterval,
    chrome: { runtime: { id: 'test', sendMessage: (p, cb) => {
      const run = async () => {
        if (p.type === 'CAPTURE_MESSAGES') return {ok:true, ...await database.upsertMessages(p.conversation,p.messages,p)};
        if (p.type === 'CAPTURE_CONVERSATIONS') await database.upsertConversations(p.conversations);
        return {ok:true};
      }; run().then(cb, e => { console.error(e); cb({ok:false}); });
    } } } });
  const source = path => baseline ? baselineSources.get(path) : readFileSync(path,'utf8');
  runInContext(`${source('content/shared.js')}\nChatseek.autoStart=false; Chatseek.safeScheduleImages=()=>{};\n${source('content/chatgpt.js')}\nglobalThis.api=Chatseek;`,ctx);
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
    const dom=new JSDOM('',{url:url(0)}); paint(dom,0,heuristic);
    const a=api(dom,oldDb,true); await a.platforms.chatgpt.capture();
    dom.window.history.pushState({},'',url(1)); await a.platforms.chatgpt.capture();
    const b=await oldDb.readConversation(`chatgpt:${ids[1]}`);
    assert(b.messages.some(m=>m.body===body(0)), 'actual baseline must reproduce A written into B');
    console.log(`baseline 213dde2 ${heuristic?'heuristic':'selector'}: BUG reproduced, A body stored in B`);
    dom.window.close();
  }
  (await oldDb.openDb()).close();
} finally { rmSync(dir,{recursive:true,force:true}); }
if (process.argv.includes('--baseline-only')) process.exit(0);
console.log('spa baseline ok');
