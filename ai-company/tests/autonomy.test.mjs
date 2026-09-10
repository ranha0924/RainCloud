import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store,uid,roles } from '../server/store.mjs';
import { Runner } from '../server/scheduler.mjs';
import { QueueGateway,policyOf,createTask,enqueue } from '../server/operations.mjs';
import { git } from '../server/workspaces.mjs';
import { command } from '../server/process.mjs';
import { createApp } from '../server/app.mjs';

// Explicit deterministic clients only in tests. Production never selects a simulated provider.
export async function fixture(options={}){
  const dir=await mkdtemp(path.join(os.tmpdir(),'rain-autonomy-'));const store=new Store(path.join(dir,'data'));const source=path.join(dir,'source');await mkdir(source);
  await writeFile(path.join(source,'base.txt'),'original\n');await git(source,['init']);await git(source,['config','user.name','Test']);await git(source,['config','user.email','test@localhost']);await git(source,['add','.']);await git(source,['commit','-m','Baseline']);
  const employees=roles.map(role=>{const c=store.list('candidate','company').find(c=>c.role===role.id);return store.put('employee','company',{...c,id:uid()});});
  const p=store.put('project','company',{id:uid(),name:'Independent project',repository:source,goal:'Small change',stack:'Node',testCommand:'node -e "console.log(123)"',model:'',maxRuns:100,tokenBudget:1000000,allowedPaths:['.'],assignments:employees.map(e=>({employeeId:e.id,permission:['backend','frontend'].includes(e.role)?'write':'read'})),operation:{...policyOf({}),allowedCategories:['bugfix','documentation','ui','requirements','marketing','accounting','hr'],...options.policy},...options.project});
  const calls=[];const fake={start:async()=>{},close(){},request:async(method)=>method==='thread/read'?{thread:{turns:[]}}:{},run:async o=>{
    const role=roles.find(r=>o.instructions.includes(`직무 ${r.name}입니다`))?.id;const step=store.list('run',p.id).at(-1)?.stage;calls.push({role,step,cwd:o.cwd,prompt:o.prompt});o.onThread(`thread-${uid()}`);o.onEvent({method:'turn/started',params:{turn:{id:'turn-'+uid()}}});
    if(options.run)return options.run({o,role,step,store,p,calls});
    if(['backend','frontend'].includes(role))await writeFile(path.join(o.cwd,role+'.txt'),`${role}-${calls.length}`);
    const text=JSON.stringify({summary:'실제 자료 확인 '+role,handoff:'다음 담당자 요청',passed:true,category:'bugfix',disposition:'proceed',acceptance:['변경 파일 존재'],requiredRoles:[],requests:[],assignments:[]});
    o.onEvent({method:'thread/tokenUsage/updated',params:{tokenUsage:{total:{totalTokens:10},last:{totalTokens:10}}}});
    return {text,threadId:'thread',turnId:'turn',usage:{total:{totalTokens:10},last:{totalTokens:10}}};
  }};
  const verify=options.verify||((text,cwd,opts)=>command(process.platform==='win32'?'powershell.exe':'/bin/sh',process.platform==='win32'?['-NoProfile','-NonInteractive','-Command',text]:['-c',text],cwd,{...opts,allowFailure:true}));
  const runner=new Runner(store,{clientFactory:()=>fake,verify});const gateway=new QueueGateway(store);
  return {dir,store,p,runner,gateway,calls,source,fake};
}
async function settle(runner,condition,timeout=20000){const started=Date.now();while(!condition()){if(Date.now()-started>timeout)throw new Error('Timed out: '+JSON.stringify([...runner.executions.keys()]));await runner.tick();await new Promise(r=>setTimeout(r,10));}}
async function finish(runner){await settle(runner,()=>!runner.executions.size);}
const report=(passed=true,extra={})=>JSON.stringify({summary:passed?'검증 완료':'회귀 테스트 실패',handoff:passed?'검토 요청':'node --test 로 재현 후 수정하세요',passed,disposition:'proceed',category:'bugfix',acceptance:['구현'],requiredRoles:[],requests:[],assignments:[],...extra});

test('durable queue reaches QA and CTO review with linked messages and real files',async()=>{
  const f=await fixture();const t=createTask(f.store,f.p.id,{title:'small',description:'implement'});f.gateway.startTask(f.p.id,t.id);
  await settle(f.runner,()=>['review','failed'].includes(f.store.require('task',f.p.id,t.id).status));await finish(f.runner);
  const done=f.store.require('task',f.p.id,t.id);assert.equal(done.status,'review',done.reason);assert.equal(done.verification,'passed');assert.equal(done.deployment,'not_deployed');assert.ok((await readFile(done.evidence,'utf8')).includes('checkpoints'));
  assert.deepEqual(f.calls.map(c=>c.role),['po','cto','backend','frontend','qa','cto']);assert.notEqual(f.calls[2].cwd,f.calls[3].cwd);
  const handoffs=f.store.list('message',f.p.id).filter(m=>m.kind==='handoff');assert.ok(handoffs.length>=5);assert.ok(handoffs.every(m=>m.senderId&&m.recipientId&&m.taskId===t.id&&m.projectId===f.p.id&&m.runId));
  const before=f.calls.length;await f.runner.tick();assert.equal(f.calls.length,before);assert.throws(()=>f.gateway.startTask(f.p.id,t.id));assert.equal((await git(f.source,['status','--porcelain'])).output,'');f.store.close();
});

test('failed QA creates repair handoff then passes integrated retest',async()=>{
  let verifications=0;const f=await fixture({verify:async()=>({code:++verifications===1?1:0,output:verifications===1?'expected 2 received 1':'PASS'})});
  const t=createTask(f.store,f.p.id,{title:'repair',description:'implement'});f.gateway.startTask(f.p.id,t.id);
  await settle(f.runner,()=>['review','failed'].includes(f.store.require('task',f.p.id,t.id).status));await finish(f.runner);
  const done=f.store.require('task',f.p.id,t.id);assert.equal(done.status,'review',done.reason);assert.equal(done.cycle,1);assert.deepEqual(done.verificationHistory.map(x=>x.exitCode),[1,0]);assert.equal(f.calls.filter(x=>x.role==='backend').length,2);assert.equal(f.calls.filter(x=>x.role==='po').length,1);assert.ok(f.calls.find(x=>x.step==='backend:1').prompt.includes('expected 2 received 1'));f.store.close();
});

test('QA exhaustion stores reproduction and never loops past repair limit',async()=>{
  const f=await fixture({verify:async()=>({code:1,output:'REPRODUCIBLE_FAILURE'}),policy:{maxRetries:1}});const t=createTask(f.store,f.p.id,{title:'fail',description:'implement'});f.gateway.startTask(f.p.id,t.id);
  await settle(f.runner,()=>f.store.require('task',f.p.id,t.id).status==='failed');await finish(f.runner);
  const done=f.store.require('task',f.p.id,t.id);assert.equal(done.cycle,1);assert.equal(done.verificationHistory.length,2);assert.match(done.reason,/재시도 한도/);assert.match(done.reason,/REPRODUCIBLE_FAILURE/);const n=f.calls.length;await f.runner.tick();assert.equal(f.calls.length,n);f.store.close();
});

test('information and approvals do not consume model calls or block another allowed task',async()=>{
  const f=await fixture();const info=createTask(f.store,f.p.id,{title:'accounting',description:'analyze',kind:'research',category:'accounting'});const approval=createTask(f.store,f.p.id,{title:'deploy',description:'release',category:'deploy'});const good=createTask(f.store,f.p.id,{title:'good',description:'implement'});
  [info,approval,good].forEach(t=>f.gateway.startTask(f.p.id,t.id));await settle(f.runner,()=>f.store.require('task',f.p.id,good.id).status==='review');await finish(f.runner);
  assert.equal(f.store.require('task',f.p.id,info.id).status,'waiting_info');assert.equal(f.store.require('task',f.p.id,approval.id).status,'waiting_approval');assert.equal(f.calls.length,6);assert.equal(f.store.list('decision',f.p.id).length,1);f.store.close();
});

test('pause and global stop abort actual active work; call and time budgets persist',async()=>{
  const f=await fixture({run:async({o})=>new Promise((resolve,reject)=>o.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))});
  const t=createTask(f.store,f.p.id,{title:'pause',description:'implement'});f.gateway.startTask(f.p.id,t.id);await settle(f.runner,()=>f.calls.length===1);
  f.store.patch('project','company',f.p.id,{paused:true});await f.runner.tick();await finish(f.runner);assert.equal(f.store.require('task',f.p.id,t.id).status,'paused');const n=f.calls.length;await f.runner.tick();assert.equal(f.calls.length,n);
  f.gateway.stopAll();assert.equal(f.store.require('settings','company','main').stopped,true);f.store.close();
  const limited=await fixture({policy:{maxTaskCalls:1}});const x=createTask(limited.store,limited.p.id,{title:'cap',description:'implement'});limited.gateway.startTask(limited.p.id,x.id);await settle(limited.runner,()=>limited.store.require('task',limited.p.id,x.id).status==='paused');await finish(limited.runner);assert.equal(limited.calls.length,1);assert.match(limited.store.require('task',limited.p.id,x.id).reason,/호출 한도/);limited.store.close();
  const timed=await fixture({policy:{taskMinutes:0.01},run:async({o})=>new Promise((resolve,reject)=>o.signal.addEventListener('abort',()=>reject(new Error('time')),{once:true}))});const y=createTask(timed.store,timed.p.id,{title:'timeout',description:'implement'});timed.gateway.startTask(timed.p.id,y.id);await settle(timed.runner,()=>timed.store.require('task',timed.p.id,y.id).status==='paused');await finish(timed.runner);assert.match(timed.store.require('task',timed.p.id,y.id).reason,/시간/);timed.store.close();
});

test('restart checks completed run response and skips model replay',async()=>{
  const f=await fixture();const t=createTask(f.store,f.p.id,{title:'recover',description:'implement'});const w=await f.runner.workflow.workspace(f.p,t,new AbortController().signal);const runId=uid();
  f.store.put('run',f.p.id,{id:runId,employeeId:f.p.assignments[1].employeeId,role:'po',stage:'po:0',taskId:t.id,status:'running',threadId:'persisted-thread',turnId:'persisted-turn',cwd:w.repo});
  f.store.patch('task',f.p.id,t.id,{status:'running',checkpoints:{'po:0':{runId,threadId:'persisted-thread'}}});f.store.put('job',f.p.id,{id:`task:${t.id}`,taskId:t.id,kind:'task',status:'running',startedAt:new Date().toISOString()});
  let reads=0;f.fake.request=async(method,params)=>{assert.equal(method,'thread/read');assert.equal(params.threadId,'persisted-thread');reads++;return {thread:{turns:[{id:'persisted-turn',status:'completed',items:[{type:'agentMessage',text:report()}]}]}};};
  await f.runner.recover();await settle(f.runner,()=>f.store.require('task',f.p.id,t.id).status==='review');await finish(f.runner);assert.equal(reads,1);assert.equal(f.calls.filter(c=>c.role==='po').length,0);assert.equal(f.store.require('run',f.p.id,runId).status,'completed');f.store.close();
});

test('project scopes isolate goal, materials, messages, workspace and employee permissions',async()=>{
  const f=await fixture();const b=f.store.put('project','company',{...f.p,id:uid(),name:'B',assignments:[]});f.store.put('material',f.p.id,{id:'secret',title:'A data',text:'ONLY_A'});f.store.put('memory',f.p.id,{id:'m',text:'ONLY_A'});f.store.message(f.p.id,'PO','ONLY_A',{taskId:'a'});
  assert.equal(f.store.list('material',b.id).length,0);assert.equal(f.store.list('message',b.id).length,0);assert.throws(()=>createTask(f.store,b.id,{title:'cross',description:'read',materials:['secret']}));assert.throws(()=>f.runner.employee(b.id,f.p.assignments[0].employeeId));assert.ok(!f.runner.instructions(b.id,f.store.list('employee','company')[0]).includes('ONLY_A'));
  const a=createTask(f.store,f.p.id,{title:'a',description:'a'}),bt=createTask(f.store,b.id,{title:'b',description:'b'});const aw=await f.runner.workflow.workspace(f.p,a),bw=await f.runner.workflow.workspace(b,bt);assert.notEqual(aw.repo,bw.repo);f.store.close();
});

test('no browser or HTTP server is needed; idle goals plan once and wait',async()=>{
  const f=await fixture({project:{operationEnabled:true},policy:{objectives:[{id:'g',text:'Check',acceptance:'No changes needed',priority:1}],scope:'Read only'},run:async()=>({text:JSON.stringify({summary:'진행할 업무 없음',evidence:['base.txt'],tasks:[]}),threadId:'plan',turnId:'t',usage:{last:{totalTokens:5}}})});
  await settle(f.runner,()=>f.store.require('project','company',f.p.id).lastPlan);await finish(f.runner);for(let i=0;i<5;i++)await f.runner.tick();assert.equal(f.calls.length,1);assert.equal(f.store.require('project','company',f.p.id).operationState,'waiting');assert.equal(f.store.list('task',f.p.id).length,0);f.store.close();
});

test('HTTP queues survive web server shutdown and approvals stay scoped',async()=>{
  const f=await fixture();const server=createApp(f.store,f.gateway).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;const s=await fetch(base+'/api/session');const cookie=s.headers.get('set-cookie').split(';')[0];const request=(url,body)=>fetch(base+'/api'+url,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const response=await request(`/scopes/${f.p.id}/tasks`,{title:'HTTP task',description:'small'});const t=await response.json();assert.equal(response.status,201);assert.equal((await request(`/scopes/${f.p.id}/tasks/${t.id}/start`,{})).status,202);
  await new Promise(r=>server.close(r));await settle(f.runner,()=>f.store.require('task',f.p.id,t.id).status==='review');await finish(f.runner);assert.equal(f.calls.length,6);f.store.close();
});

test('PO creates goal-linked tasks once and validates dependency ordering',async()=>{
  const f=await fixture({project:{operationEnabled:true},policy:{objectives:[{id:'g',text:'Small scope',acceptance:'Docs',priority:1}],scope:'Only docs'},run:async({step})=>({text:step==='planning'?JSON.stringify({summary:'두 단계',evidence:['base.txt'],tasks:[{key:'one',goalId:'g',title:'One',description:'First',kind:'research',category:'documentation',priority:1,acceptance:['doc'],dependsOn:[],materials:[]},{key:'two',goalId:'g',title:'Two',description:'Second',kind:'research',category:'documentation',priority:2,acceptance:['doc'],dependsOn:['one'],materials:[]}]}):report(),usage:{last:{totalTokens:1}}})});
  await settle(f.runner,()=>f.store.list('task',f.p.id).length===2);await finish(f.runner);f.store.patch('project','company',f.p.id,{paused:true});
  const tasks=f.store.list('task',f.p.id);assert.equal(tasks[1].dependsOn[0],tasks[0].id);assert.ok(!tasks[0].id.includes(':'));const job=f.store.list('job',f.p.id).find(j=>j.kind==='plan');await f.runner.plan(f.store.require('project','company',f.p.id),job,new AbortController().signal);assert.equal(f.store.list('task',f.p.id).length,2);assert.equal(f.calls.filter(c=>c.step==='planning').length,1);f.store.close();
});

test('concurrency cap and waiting dependency prevent unwanted worker dispatch',async()=>{
  let active=0,max=0;const f=await fixture({policy:{maxConcurrent:2},run:async({o})=>{active++;max=Math.max(max,active);return new Promise((resolve,reject)=>o.signal.addEventListener('abort',()=>{active--;reject(new Error('stop'));},{once:true}));}});
  const first=createTask(f.store,f.p.id,{title:'first',description:'1'}),second=createTask(f.store,f.p.id,{title:'second',description:'2'}),dependent=createTask(f.store,f.p.id,{title:'dependent',description:'3',dependsOn:[first.id]}),fourth=createTask(f.store,f.p.id,{title:'fourth',description:'4'});
  [first,second,dependent,fourth].forEach(t=>f.gateway.startTask(f.p.id,t.id));await settle(f.runner,()=>active===2);assert.equal(max,2);assert.equal(f.store.require('task',f.p.id,dependent.id).status,'queued');f.gateway.stopAll();await f.runner.tick();await finish(f.runner);assert.equal(f.calls.length,2);f.store.close();
});

test('peer question dispatches only its recipient and resumes blocked work on reply',async()=>{
  let asks=0;const f=await fixture({run:async({o,role,step})=>{
    if(role==='po'&&asks++===0)return {text:report(true,{disposition:'info',requests:[{toRole:'planner',text:'빈 이름 정책을 알려주세요.'}]}),usage:{last:{totalTokens:1}}};
    if(['backend','frontend'].includes(role))await writeFile(path.join(o.cwd,role+'.txt'),role);
    return {text:role==='planner'?'빈 이름은 방문자입니다.':report(),usage:{last:{totalTokens:1}}};
  }});const t=createTask(f.store,f.p.id,{title:'peer',description:'question'});f.gateway.startTask(f.p.id,t.id);
  await settle(f.runner,()=>['review','failed'].includes(f.store.require('task',f.p.id,t.id).status));await finish(f.runner);assert.equal(f.store.require('task',f.p.id,t.id).status,'review');assert.equal(f.calls.filter(c=>c.role==='planner').length,1);assert.equal(f.store.require('task',f.p.id,t.id).messageHops,1);assert.ok(f.calls.filter(c=>c.role==='po').at(-1).prompt.includes('빈 이름은 방문자'));f.store.close();
});

test('token reports abort in-flight work and company call cap admits no new run',async()=>{
  const f=await fixture({project:{tokenBudget:1000},run:async({o})=>new Promise((resolve,reject)=>{o.signal.addEventListener('abort',()=>reject(new Error('limit')),{once:true});o.onEvent({method:'thread/tokenUsage/updated',params:{tokenUsage:{total:{totalTokens:1100},last:{totalTokens:1100}}}});})});
  const t=createTask(f.store,f.p.id,{title:'token cap',description:'stop'});f.gateway.startTask(f.p.id,t.id);await settle(f.runner,()=>f.store.require('task',f.p.id,t.id).status==='paused');await finish(f.runner);assert.equal(f.runner.usage(f.p.id).tokens,1100);assert.equal(f.calls.length,1);assert.match(f.store.require('task',f.p.id,t.id).reason,/토큰/);f.store.close();
  const cap=await fixture();cap.store.patch('settings','company','main',{maxRuns:1});const q=createTask(cap.store,cap.p.id,{title:'company cap',description:'stop'});cap.gateway.startTask(cap.p.id,q.id);await settle(cap.runner,()=>cap.store.require('task',cap.p.id,q.id).status==='paused');await finish(cap.runner);assert.equal(cap.calls.length,1);cap.store.close();
});
