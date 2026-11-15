import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, ReplyRouter } from '../src/core.mjs';
const route = { agentKind: 'codex', providerId: 'local', model: 'test', effort: 'high', fastMode: false };
const config = { execution: { project: 'C:/project', route }, bots: [
  { id: 'a', name: 'A', companionId: 'a-partner', enabled: true },
  { id: 'b', name: 'B', companionId: 'b-partner', enabled: true }] };
test('Bot project overrides coexist with companion forwarding and survive config reload', async () => {
  const override = { ...route, model:'other-model', effort:'low' };
  const saved = validateConfig({ ...config, bots: [
    {...config.bots[0],mode:'project',execution:{project:'',route:override}},
    {...config.bots[1],mode:'project'},
    {id:'c',name:'C',companionId:'c-partner',enabled:true,mode:'companion'}] });
  const loaded = validateConfig(JSON.parse(JSON.stringify(saved)));
  const sent=[];
  const router=new ReplyRouter({targets:{capabilities:async()=>({delegation:{execution:true}}),resolve:async()=>{},send:async req=>{sent.push(req);return {accepted:true,taskId:'session-'+sent.length};}},tasks:{capabilities:async()=>({messageContext:true,createPermissionMode:true})},rejectInbound:async()=>{}});
  router.setConfig(loaded);
  for(const id of ['a','b','c'])await router.receive({requestId:id,botConfigId:id,text:'hello',generation:1});
  assert.equal(sent[0].target.kind,'project');assert.deepEqual(sent[0].route,override);
  assert.deepEqual(sent[1].route,route);
  assert.deepEqual(sent[2].target,{kind:'bot',id:'c-partner'});assert.equal(sent[2].route,undefined);assert.ok(sent[2].delegation);
  assert.deepEqual(loaded.execution.route,route);router.reset();
});
test('shared project route survives validation; remote routes fail instead of silently changing source', () => {
  assert.deepEqual(validateConfig(config).execution, config.execution);
  assert.throws(() => validateConfig({ ...config, execution: { ...config.execution, route: { ...route, agentDeviceId: 'other' } } }), { code: 'INVALID_CONFIG' });
  assert.equal(validateConfig({bots:config.bots}).execution, undefined);
  const router = new ReplyRouter({});
  router.setConfig(validateConfig({...config,execution:{project:'C:/project',route:null}}));assert.equal(router.execution,undefined);
  router.setConfig(validateConfig({...config,execution:{project:'',route}}));assert.equal(router.execution,undefined);
  router.setConfig(validateConfig(config));assert.deepEqual(router.execution,config.execution);
  const partial=validateConfig({execution:{project:'C:/project',route:null},bots:[{id:'a',name:'A',companionId:'project-a',enabled:true}]});
  assert.equal(partial.bots[0].enabled,false);
});
test('unreadable memory rejects immediately with a specific error instead of dispatch retry exhaustion', async () => {
  const rejected=[];
  const router=new ReplyRouter({beforeDispatch:async()=>{throw Object.assign(new Error('memory'),{code:'MEMORY_READ_FAILED'});},rejectInbound:async(id,code)=>rejected.push(code)});
  router.setConfig(config);await router.receive({requestId:'memory-fail',botConfigId:'a',text:'hello',generation:1});
  assert.deepEqual(rejected,['MEMORY_READ_FAILED']);assert.deepEqual(router.pendingRetries(),[]);
});
test('project inputs retain pure text, separate Bot memories and original task reply identity', async () => {
  const sent = [], replies = [], sessions = [];
  const router = new ReplyRouter({
    targets: { resolve: async x => x, send: async x => { sent.push(x); return { accepted:true,taskId:`task-${sent.length}` }; } },
    tasks: {capabilities:async()=>({messageContext:true,createPermissionMode:true})}, beforeDispatch: e => { e.memory = 'memory-'+e.botConfigId; },
    onProjectSession: async id => sessions.push(id), nodeReply: async x => { replies.push(x); return { delivered:true }; }, rejectInbound:async()=>{} });
  router.setConfig(validateConfig(config));
  for (const id of ['a','b']) await router.receive({requestId:id,botConfigId:id,peerId:'peer',text:'你好',generation:1});
  assert.equal(sent[0].text, '你好'); assert.deepEqual(sent[0].target,{kind:'project',id:'C:/project'});
  assert.deepEqual(sent[0].route,route); assert.equal(sent[0].delegation,undefined);
  assert.equal(JSON.parse(sent[0].context).memory,'memory-a'); assert.equal(JSON.parse(sent[1].context).memory,'memory-b');
  assert.deepEqual(sessions,['task-1','task-2']);
  await assert.rejects(router.reply('a','wrong','task-2'),{code:'WRONG_COMPANION'});
  await router.reply('a','answer','task-1'); assert.equal(replies[0].requestId,'a'); router.reset();
});
test('queued input pins original project/model across a settings change', async () => {
  const sent=[];
  const router=new ReplyRouter({targets:{resolve:async()=>{},send:async x=>{sent.push(x);return {accepted:true,taskId:'t'+sent.length};}},tasks:{capabilities:async()=>({messageContext:true,createPermissionMode:true})},nodeReply:async()=>({}),rejectInbound:async()=>{}});
  router.setConfig(config);
  await router.receive({requestId:'1',botConfigId:'a',text:'first',generation:1});
  await router.receive({requestId:'2',botConfigId:'a',text:'second',generation:1});
  router.setConfig({...config,execution:{project:'C:/new',route:{...route,effort:'low'}}});
  await router.reply('1','answer','t1'); await new Promise(r=>setImmediate(r));
  assert.deepEqual(sent[1].target,{kind:'task',id:'t1'}); assert.equal(sent[1].route,undefined); router.reset();
});

test('window validates bounds and renews after expiry', async () => {
 for(const hours of [0,25,1.5]) assert.throws(()=>validateConfig({...config,execution:{...config.execution,sessionHours:hours}}),{code:'INVALID_CONFIG'});
 for(const hours of [1,24]) assert.equal(validateConfig({...config,execution:{...config.execution,sessionHours:hours}}).execution.sessionHours,hours);
 let now=0; const sent=[];
 const router=new ReplyRouter({now:()=>now,targets:{resolve:async()=>{},send:async x=>{sent.push(x);return {accepted:true,taskId:x.target.kind==='task'?x.target.id:'t'+sent.length};}},tasks:{capabilities:async()=>({messageContext:true,createPermissionMode:true})},nodeReply:async()=>({}),rejectInbound:async()=>{}});
 router.setConfig(config);
 for(let n=0;n<3;n++){now=n===2?4*3600000:n*3600000;await router.receive({requestId:String(n),botConfigId:'a',peerId:'p',text:'hello',generation:1});await router.reply(String(n),'answer',n===2?'t3':'t1');}
 assert.equal(sent[0].permissionMode,'bypassPermissions');assert.equal(sent[1].target.kind,'task');assert.equal(sent[1].permissionMode,undefined);assert.equal(sent[2].target.kind,'project');router.reset();
});
