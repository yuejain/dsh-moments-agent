import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../client/web/app.js', import.meta.url), 'utf8');
const refreshCode = source.slice(source.indexOf('  async function refreshCurrent('), source.indexOf('  async function loadCore('));
function context(overrides = {}) {
  const calls = [];
  const state = {exited:false,automationDirty:false,clientSettingsDirty:false,personaDirty:false,writingSkillsDirty:false,
    automationDraft:null,settingsForm:{baseUrl:'old'},personaDraft:null,create:{running:false}};
  const sandbox = {state,currentRoute:{name:'settings'},renderSeq:0,applying:false,refreshPromise:null,
    refreshAgain:false,refreshManualQueued:false,settingsWritePromise:null,refreshButtonSpin(){},toast(){},
    hasSettingsEdits:()=>state.automationDirty||state.clientSettingsDirty||state.personaDirty||state.writingSkillsDirty,
    discardSettingsEdits(){state.automationDirty=false;state.clientSettingsDirty=false;state.personaDirty=false;
      state.writingSkillsDirty=false;state.automationDraft=null;state.personaDraft=null;state.settingsForm={baseUrl:'',tokenFile:'',dataDir:''};},
    parseRoute:()=>({name:'settings'}),applyRoute:async()=>{calls.push('render');},...overrides};
  vm.createContext(sandbox);
  vm.runInContext(refreshCode+'\nthis.refresh=refreshCurrent;',sandbox);
  return {sandbox,state,calls};
}

test('刷新期间再次手动刷新必须排队，不能丢弃', async () => {
  let finish;
  let count=0;
  const {sandbox} = context({applyRoute:async()=>{count++;if(count===1)await new Promise(r=>finish=r);}});
  const first=sandbox.refresh(false);
  const second=sandbox.refresh(true);
  finish();
  await Promise.all([first,second]);
  assert.equal(count,2);
});

test('显式重新读取设置会丢弃旧表单缓存', async () => {
  const {sandbox,state}=context();
  state.automationDirty=true;state.automationDraft={scheduleEnabled:true};
  state.clientSettingsDirty=true;state.personaDirty=true;
  await sandbox.refresh(true,{discardSettings:true});
  assert.equal(state.automationDirty,false);
  assert.equal(state.clientSettingsDirty,false);
  assert.equal(state.personaDirty,false);
  assert.equal(state.automationDraft,null);
  assert.equal(state.settingsForm.baseUrl,'');
});

test('自动轮询不得覆盖正在编辑的人格和连接配置', async () => {
  for(const field of ['automationDirty','clientSettingsDirty','personaDirty','writingSkillsDirty']) {
    const {sandbox,state,calls}=context();state[field]=true;
    await sandbox.refresh(false);
    assert.equal(calls.length,0,field);
  }
});

test('刷新失败后释放刷新锁，后续可重试', async () => {
  let count=0;
  const {sandbox}=context({applyRoute:async()=>{if(++count===1)throw new Error('network');}});
  await assert.rejects(sandbox.refresh(true));
  await sandbox.refresh(true);
  assert.equal(count,2);
  assert.equal(sandbox.applying,false);
});

test('请求超时覆盖响应正文读取，不能永久卡住刷新', async () => {
  const begin=source.indexOf('  class ApiError extends Error');
  const end=source.indexOf('  const api =',begin);
  const sandbox={AbortController,window:{setTimeout,clearTimeout},fetch:async(_url,{signal})=>({
    status:200,ok:true,text:()=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{
      const error=new Error('aborted');error.name='AbortError';reject(error);
    }))})};
  vm.createContext(sandbox);vm.runInContext(source.slice(begin,end)+'\nthis.call=request;',sandbox);
  const result=await Promise.race([sandbox.call('/api/test',{timeout:5}).catch(e=>e.code),
    new Promise(r=>setTimeout(()=>r('BODY_TIMEOUT_MISSING'),60))]);
  assert.equal(result,'TIMEOUT');
});

test('保存必须读回匹配值，不一致时失败且释放写入锁', async () => {
  const code=source.slice(source.indexOf('  function settingsEqual('),source.indexOf('  async function refreshCurrent('));
  const sandbox={settingsWritePromise:null,renderSeq:0,refreshButtonSpin(){}};
  vm.createContext(sandbox);vm.runInContext(code+'\nthis.save=saveAndReadBack;this.equal=settingsEqual;',sandbox);
  assert.equal(sandbox.equal({a:1,b:{x:2}},{b:{x:2},a:1}),true);
  await assert.rejects(sandbox.save(async()=>{},async()=>({a:1}),v=>v.a===2),/读回值不一致/);
  assert.equal(sandbox.settingsWritePromise,null);
  await sandbox.save(async()=>{},async()=>({a:2}),v=>v.a===2);
});

test('保存过程中手动刷新等写入结束再读，轮询跳过', async () => {
  let finish;
  const pending=new Promise(resolve=>finish=resolve);
  const {sandbox,calls}=context({settingsWritePromise:pending});
  await sandbox.refresh(false);
  const manual=sandbox.refresh(true);
  assert.equal(calls.length,0);
  finish();await manual;
  assert.equal(calls.length,1);
});
