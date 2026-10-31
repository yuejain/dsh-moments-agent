import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../../client/web/app.js',import.meta.url),'utf8');
const body=source.slice(source.indexOf('  function openPublishModal('),source.indexOf('  function openCancelModal('));
test('direct publish holds a per-task lock and displays progress until response',async()=>{
 let done; let calls=0; let refreshed=0;
 const button={textContent:'直接发表',disabled:false};
 const ctx={state:{config:{publishMode:'POLICY_AUTONOMOUS'}},publishingTasks:new Set(),document:{querySelectorAll:()=>[button]},toast:()=>{},refreshCurrent:()=>{refreshed++},api:{publish:()=>{calls++;return new Promise(r=>{done=r})}}};
 vm.createContext(ctx);vm.runInContext(body+'\nthis.open=openPublishModal;',ctx);
 ctx.open('test');ctx.open('test');assert.equal(calls,1);assert.equal(button.disabled,true);assert.equal(button.textContent,'正在发表…');
 done({message:'ok'});await new Promise(r=>setImmediate(r));assert.equal(ctx.publishingTasks.size,0);assert.equal(refreshed,1);
});
