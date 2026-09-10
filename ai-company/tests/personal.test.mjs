import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store,uid,now,roles} from '../server/store.mjs';
import {policyOf,createTask,decision,QueueGateway,state} from '../server/operations.mjs';
import {configurePersonal,syncGoals,createExperiment,startTimer,stopTimer,addTime,personalMetrics,decisionInbox,recordSignal,improvementCandidates,applyImprovement,scopeRules,assessGoal,addBaseline,localDate} from '../server/personal.mjs';
import {resolveDecisionGroup,reviewResult} from '../server/personal-api.mjs';
import {Runner} from '../server/scheduler.mjs';
import {createApp} from '../server/app.mjs';
import {git} from '../server/workspaces.mjs';

async function fixture(){
  const dir=await mkdtemp(path.join(os.tmpdir(),'rain-personal-')),store=new Store(path.join(dir,'data'));
  const people=roles.map(r=>store.put('employee','company',{...store.list('candidate','company').find(c=>c.role===r.id),id:uid()}));
  const p=store.put('project','company',{id:uid(),name:'personal fixture',repository:'',allowedPaths:['.'],model:'fixture-only',maxRuns:100,tokenBudget:100000,assignments:people.map(e=>({employeeId:e.id,permission:['backend','frontend'].includes(e.role)?'write':'read'})),operation:{...policyOf({}),scope:'small bug fixes',allowedCategories:['bugfix'],objectives:[{id:'g',text:'usable feature',acceptance:'visible result, verified boundary',priority:1}]},personal:{}});
  const other=store.put('project','company',{...p,id:uid(),name:'other project'});syncGoals(store,p);syncGoals(store,other);
  createExperiment(store,p.id,{label:'test fixture only',startDate:localDate(now()),days:14,targetMinutes:30});
  return {store,dir,p,other,people};
}
const task=f=>createTask(f.store,f.p.id,{title:'small task',description:'bounded improvement',goalId:'g'},{teamMode:'selected'});
function verified(f,t){return f.store.patch('task',f.p.id,t.id,{status:'review',verification:'passed',evidence:'fixture-evidence.json',result:{files:['x.mjs'],repository:'fixture-only'},finishedAt:now()});}

test('time is explicit, spans midnight, survives reopen and keeps unmeasured days null',async()=>{
  const f=await fixture();createExperiment(f.store,f.p.id,{label:'fixed clock regression',startDate:'2026-09-01',days:14,targetMinutes:30});assert.equal(personalMetrics(f.store,f.p.id,'2026-09-10T00:00:00Z').knownMinutes,null);
  startTimer(f.store,f.p.id,{category:'review',target:'project'},'2026-09-09T14:50:00Z');
  assert.throws(()=>startTimer(f.store,f.other.id,{category:'review',target:'project'}),/타이머/);
  const dir=f.store.dir;f.store.close();f.store=new Store(dir);
  assert.throws(()=>stopTimer(f.store,f.other.id,{},'2026-09-09T15:10:00Z'),/범위/);
  const entries=stopTimer(f.store,f.p.id,{},'2026-09-09T15:10:00Z');assert.deepEqual(entries.map(e=>[e.date,e.minutes]),[['2026-09-09',10],['2026-09-10',10]]);
  assert.throws(()=>stopTimer(f.store,f.p.id),/타이머/);
  addTime(f.store,'company',{category:'maintenance',target:'company_tool',date:'2026-09-10',minutes:25});
  const m=personalMetrics(f.store,f.p.id,'2026-09-10T03:00:00Z');assert.equal(m.knownMinutes,45);assert.equal(m.projectMinutes,20);assert.equal(m.toolMinutes,25);assert.equal(m.days.find(d=>d.date==='2026-09-10').overTarget,5);assert.equal(m.days[0].measuredMinutes,null);assert.equal(m.days.at(-1).measuredMinutes,null);f.store.close();
});

test('time links and liaisons cannot reference another project and 30 minutes never stops work',async()=>{
  const f=await fixture(),t=task(f);assert.throws(()=>addTime(f.store,f.other.id,{category:'editing',target:'project',date:'2026-09-10',minutes:1,taskId:t.id}));
  const stranger=f.store.put('employee','company',{...f.people[0],id:uid()});assert.throws(()=>configurePersonal(f.store,f.p.id,{coordinatorId:stranger.id}));assert.throws(()=>configurePersonal(f.store,f.p.id,{technicalCoordinatorId:f.people.find(e=>e.role==='qa').id}));
  addTime(f.store,f.p.id,{category:'recovery',target:'project',date:localDate(now()),minutes:45});assert.equal(new Runner(f.store).controlReason(f.p.id,t.id),'');assert.equal(personalMetrics(f.store,f.p.id).knownMinutes,45);f.store.close();
});

test('goal snapshots preserve acceptance versions and task splitting does not inflate outcomes',async()=>{
  const f=await fixture(),a=task(f),b=task(f);verified(f,a);verified(f,b);
  assert.throws(()=>assessGoal(f.store,f.p.id,'g',{version:1,notes:'still awaiting result review'}));
  reviewResult(f.store,f.p.id,a.id,{outcome:'accepted'});reviewResult(f.store,f.p.id,b.id,{outcome:'accepted'});assessGoal(f.store,f.p.id,'g',{version:1,notes:'both outcomes meet predeclared criteria'});
  let m=personalMetrics(f.store,f.p.id);assert.equal(m.acceptedGoals.length,1);assert.equal(m.taskCount,2);assert.equal(m.firstPass.denominator,2);assert.equal(m.autonomousProblems.value,null);
  const p=f.store.require('project','company',f.p.id);f.store.patch('project','company',f.p.id,{operation:{...p.operation,objectives:[{...p.operation.objectives[0],acceptance:'new requirement'}]}});const c=task(f);assert.equal(c.goalSnapshot.version,2);assert.equal(f.store.require('task',f.p.id,a.id).goalSnapshot.version,1);m=personalMetrics(f.store,f.p.id);assert.equal(m.goals.length,2);assert.equal(m.acceptedGoals.length,1);f.store.close();
});

test('rework preserves original evidence, distinguishes change reasons and invalidates stale goal acceptance',async()=>{
  const f=await fixture(),a=task(f);verified(f,a);reviewResult(f.store,f.p.id,a.id,{outcome:'accepted'});assessGoal(f.store,f.p.id,'g',{version:1,notes:'accepted original result'});
  const change=reviewResult(f.store,f.p.id,a.id,{outcome:'changes',cause:'error',notes:'boundary defect'});assert.equal(change.task.parentTaskId,a.id);assert.equal(f.store.require('task',f.p.id,a.id).evidence,'fixture-evidence.json');
  let m=personalMetrics(f.store,f.p.id);assert.equal(m.acceptedGoals.length,0);assert.equal(m.errorReopened.numerator,1);assert.equal(m.errorReopened.denominator,1);assert.equal(m.reworkMinutes.error,null);
  verified(f,change.task);reviewResult(f.store,f.p.id,change.task.id,{outcome:'accepted',technicalIntervention:'none'});m=personalMetrics(f.store,f.p.id);assert.equal(m.acceptedGoals.length,0,'old assessment must not accept later work');assert.equal(m.autonomousProblems.numerator,1);assessGoal(f.store,f.p.id,'g',{version:1,notes:'rechecked after correction'});assert.equal(personalMetrics(f.store,f.p.id).acceptedGoals.length,1);
  reviewResult(f.store,f.p.id,change.task.id,{outcome:'changes',cause:'requirements_change',notes:'new requirement'});m=personalMetrics(f.store,f.p.id);assert.equal(m.requirementsChanges,1);assert.equal(m.errorReopened.numerator,1);f.store.close();
});

test('decision grouping is project scoped and protected actions stay approval waiting',async()=>{
  const f=await fixture(),a=task(f),b=task(f),safe=task(f);configurePersonal(f.store,f.p.id,{urgentTypes:['info']});
  for(const t of [a,b]){f.store.patch('task',f.p.id,t.id,{status:'waiting_info'});decision(f.store,f.p.id,t,'info','동일 계약 확인 필요');}
  const groups=decisionInbox(f.store,f.p.id);assert.equal(groups.length,1);assert.equal(groups[0].occurrences,2);assert.equal(groups[0].urgent,true);assert.equal(groups[0].canContinue.length,1);assert.equal(groups[0].canContinue[0].id,safe.id);
  assert.throws(()=>resolveDecisionGroup(f.store,f.other.id,groups[0].id,{action:'approve',response:'wrong project'}));
  resolveDecisionGroup(f.store,f.p.id,groups[0].id,{action:'approve',response:'use current contract'});assert.equal(decisionInbox(f.store,f.p.id).length,0);assert.equal(f.store.require('task',f.p.id,a.id).scopeApproved,undefined,'information response cannot expand allowed scope');
  const deploy=createTask(f.store,f.p.id,{title:'deploy',description:'requires approval',category:'deploy'},{status:'waiting_approval'});decision(f.store,f.p.id,deploy,'external','publish production');const g=decisionInbox(f.store,f.p.id)[0];resolveDecisionGroup(f.store,f.p.id,g.id,{action:'approve',response:'approved record'});assert.equal(f.store.require('task',f.p.id,deploy.id).status,'waiting_approval');f.store.close();
});

test('repeated evidence creates editable local rules with versions and no invented effectiveness',async()=>{
  const f=await fixture();for(let n=0;n<2;n++)recordSignal(f.store,f.p.id,{kind:'question',text:'세션 만료 계약 확인'});
  let i=improvementCandidates(f.store,f.p.id)[0];assert.equal(i.status,'candidate');assert.equal(scopeRules(f.store,f.p.id,f.people[0].id),'');
  i=applyImprovement(f.store,f.p.id,i.id,{rule:'만료 시각 계약을 먼저 확인한다.',expectedEffect:'같은 질문 발생 수를 관찰한다.',employeeId:f.people[0].id,active:true});assert.equal(i.version,1);assert.match(scopeRules(f.store,f.p.id,f.people[0].id),/만료 시각/);assert.equal(scopeRules(f.store,f.other.id,f.people[0].id),'');assert.equal(scopeRules(f.store,f.p.id,f.people[1].id),'');
  applyImprovement(f.store,f.p.id,i.id,{rule:i.rule,expectedEffect:i.expectedEffect,active:false});assert.equal(scopeRules(f.store,f.p.id,f.people[0].id),'');const m=personalMetrics(f.store,f.p.id);assert.match(m.improvements[0].effect.conclusion,/확인되지/);f.store.close();
});

test('cancelled or superseded decision requests cannot resurrect a task',async()=>{
  const f=await fixture(),t=task(f);state(f.store,f.p.id,t.id,'waiting_info');decision(f.store,f.p.id,t,'info','need a choice');const id=decisionInbox(f.store,f.p.id)[0].id;
  state(f.store,f.p.id,t.id,'cancelled','representative cancelled');assert.equal(decisionInbox(f.store,f.p.id).length,0);assert.throws(()=>resolveDecisionGroup(f.store,f.p.id,id,{action:'approve',response:'stale reply'}));assert.equal(f.store.require('task',f.p.id,t.id).status,'cancelled');assert.equal(f.store.list('job',f.p.id).length,0);f.store.close();
});

test('answered stage questions are preserved in decisions but never reused for new blockers',async()=>{
  const f=await fixture(),t=task(f);
  state(f.store,f.p.id,t.id,'waiting_info','old PO reason',{decisionRequest:{question:'old PO question',why:'old why',recommendation:'old option',recommendationReason:'old evidence',alternatives:['old alternative']}});
  const original=decision(f.store,f.p.id,f.store.require('task',f.p.id,t.id),'info','old PO reason');
  resolveDecisionGroup(f.store,f.p.id,decisionInbox(f.store,f.p.id)[0].id,{action:'approve',response:'answered'});
  assert.equal(f.store.require('task',f.p.id,t.id).decisionRequest,null);assert.equal(f.store.require('decision',f.p.id,original.id).question,'old PO question');
  state(f.store,f.p.id,t.id,'waiting_info','new CTO missing employee',{step:'cto'});
  const next=decision(f.store,f.p.id,f.store.require('task',f.p.id,t.id),'info','new CTO missing employee');assert.equal(next.question,'new CTO missing employee');assert.notEqual(next.recommendation,'old option');f.store.close();
});

test('baseline missing values remain null and differing conditions are disclosed',async()=>{
  const f=await fixture();addBaseline(f.store,f.p.id,{date:localDate(now()),taskType:'documentation',size:'small',title:'direct Codex',acceptance:'different criteria',minutes:null,tokens:null,cost:null,goalId:'g'});const b=personalMetrics(f.store,f.p.id).baseline[0];assert.equal(b.minutes,null);assert.equal(b.cost,null);assert.equal(b.comparable,false);assert.ok(b.comparisonNotes.includes('완료 기준이 다름'));f.store.close();
});

test('explicit unlimited tokens retain usage accounting, call limits and global stop',async()=>{
  const f=await fixture(),runner=new Runner(f.store),t=task(f);
  f.store.patch('settings','company','main',{tokenBudget:null});f.store.patch('project','company',f.p.id,{tokenBudget:null});
  f.store.put('run',f.p.id,{id:uid(),status:'completed',accountedTokens:2000000,createdAt:now()});
  assert.doesNotThrow(()=>runner.budget(f.p.id));assert.equal(runner.controlReason(f.p.id,t.id),'');assert.equal(runner.usage(f.p.id).tokens,2000000);
  f.store.patch('project','company',f.p.id,{maxRuns:1});assert.throws(()=>runner.budget(f.p.id),/예산/);
  f.store.patch('settings','company','main',{stopped:true});assert.equal(runner.controlReason(f.p.id,t.id),'전체 중지');f.store.close();
});

test('bounded runner never dispatches another scope even when tokens are unlimited',async()=>{
  const f=await fixture(),runner=new Runner(f.store);runner.allowedScopes=new Set([f.p.id]);
  f.store.patch('settings','company','main',{tokenBudget:null});const otherTask=createTask(f.store,f.other.id,{title:'unrelated',description:'must wait'});new QueueGateway(f.store).startTask(f.other.id,otherTask.id);
  await runner.tick();assert.equal(runner.executions.size,0);assert.equal(f.store.list('run',f.other.id).length,0);assert.equal(f.store.require('task',f.other.id,otherTask.id).status,'queued');f.store.close();
});

test('representative revision starts from the verified parent result and rejects a changed parent',async()=>{
  const f=await fixture(),source=path.join(f.dir,'original');await mkdir(source);await writeFile(path.join(source,'base.txt'),'original');for(const args of [['init'],['config','user.name','Test'],['config','user.email','test@localhost'],['add','.'],['commit','-m','baseline']])await git(source,args);
  f.store.patch('project','company',f.p.id,{repository:source});const p=f.store.require('project','company',f.p.id),runner=new Runner(f.store),parent=task(f),signal=new AbortController().signal;
  const w=await runner.workflow.workspace(p,parent,signal);await writeFile(path.join(w.repo,'feature.txt'),'verified parent feature');await git(w.repo,['add','.']);await git(w.repo,['commit','-m','parent feature']);const head=(await git(w.repo,['rev-parse','HEAD'])).output.trim();
  f.store.patch('task',p.id,parent.id,{status:'review',verification:'passed',evidence:path.join(w.dir,'evidence.json'),result:{repository:w.repo,head,files:['feature.txt']}});
  const child=reviewResult(f.store,p.id,parent.id,{outcome:'changes',cause:'error',notes:'repair boundary'}).task;
  const cw=await runner.workflow.workspace(p,child,signal);assert.equal(await readFile(path.join(cw.repo,'feature.txt'),'utf8'),'verified parent feature');assert.equal(cw.baseline,head);assert.equal(cw.parentTaskId,parent.id);assert.equal((await git(source,['status','--porcelain'])).output,'');
  const other=task(f);f.store.patch('task',p.id,other.id,{parentTaskId:parent.id});await writeFile(path.join(w.repo,'feature.txt'),'unreviewed change');await assert.rejects(runner.workflow.workspace(p,f.store.require('task',p.id,other.id),signal),/이후 변경/);f.store.close();
});

test('personal HTTP persists goals and meetings while global stop prevents model dispatch',async()=>{
  const f=await fixture();f.store.patch('settings','company','main',{stopped:true});const server=createApp(f.store,new QueueGateway(f.store)).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port;const session=await fetch(url+'/api/session');const cookie=session.headers.get('set-cookie').split(';')[0];
  const api=async(s,endpoint,body,method='POST')=>{const r=await fetch(url+`/api/scopes/${s}/personal`+endpoint,{method,headers:{cookie,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
  try{
    assert.equal((await fetch(url+`/api/scopes/${f.p.id}/personal`)).status,401);
    const g=await api(f.p.id,'/goals',{text:'new goal',acceptance:'new criteria',priority:1,taskType:'bug fix',size:'small'});assert.equal(g.status,201);assert.equal(f.store.require('project','company',f.p.id).paused,true);
    const mt=await api(f.p.id,'/meetings',{agenda:'contract coordination',participantIds:[f.people[0].id]});assert.equal(mt.status,201);assert.equal((await api(f.p.id,'/meetings/'+mt.body.id+'/start',{})).status,409);assert.equal((await api(f.other.id,'/meetings/'+mt.body.id+'/start',{})).status,409);
    const data=await api(f.p.id,'',undefined,'GET');assert.equal(data.status,200);assert.equal(data.body.metrics.knownMinutes,null);assert.equal(data.body.stopped,true);assert.equal(f.store.list('run',f.p.id).length,0);
    // Meeting follow-up messages reach only the selected participants, still queued while stopped.
    f.store.patch('meeting',f.p.id,mt.body.id,{status:'open',participantIds:[f.people[0].id,f.people[1].id]});
    const follow=await fetch(url+`/api/scopes/${f.p.id}/messages`,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({message:'대표의 후속 질문',channel:'meeting-'+mt.body.id})});assert.equal(follow.status,201);
    const jobs=f.store.list('job',f.p.id).filter(j=>j.meetingId===mt.body.id);assert.equal(jobs.length,2);assert.deepEqual(jobs.map(j=>j.personId),[f.people[0].id,f.people[1].id]);assert.ok(jobs.every(j=>j.status==='queued'));
    const projectBefore=f.store.require('project','company',f.p.id),messagesBefore=f.store.list('message',f.p.id).length,jobsBefore=f.store.list('job',f.p.id).length;
    f.store.patch('project','company',f.p.id,{assignments:projectBefore.assignments.filter(a=>a.employeeId!==f.people[1].id)});
    const invalidFollow=await fetch(url+`/api/scopes/${f.p.id}/messages`,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({message:'must persist nothing',channel:'meeting-'+mt.body.id})});
    assert.equal(invalidFollow.status,409);assert.equal(f.store.list('message',f.p.id).length,messagesBefore);assert.equal(f.store.list('job',f.p.id).length,jobsBefore,'invalid second participant must not queue first participant');
    f.store.patch('project','company',f.p.id,{assignments:projectBefore.assignments});
    const evidenceTask=task(f),artifactDir=path.join(f.store.dir,'projects',f.p.id,'tasks',evidenceTask.id,'.local');await mkdir(artifactDir,{recursive:true});const artifact=path.join(artifactDir,'evidence-independent.json');await writeFile(artifact,JSON.stringify({taskId:evidenceTask.id,head:'verified-head'}));f.store.patch('task',f.p.id,evidenceTask.id,{workspace:{dir:artifactDir},evidence:artifact});
    const evidenceUrl=url+`/api/scopes/${f.p.id}/tasks/${evidenceTask.id}/evidence`;const download=await fetch(evidenceUrl,{headers:{cookie}});assert.equal(download.status,200);assert.equal((await download.json()).head,'verified-head');
    const crossDownload=await fetch(url+`/api/scopes/${f.other.id}/tasks/${evidenceTask.id}/evidence`,{headers:{cookie}});assert.equal(crossDownload.status,409);
    const outside=path.join(f.dir,'unrelated-private.json');await writeFile(outside,'private');f.store.patch('task',f.p.id,evidenceTask.id,{evidence:outside});assert.equal((await fetch(evidenceUrl,{headers:{cookie}})).status,409);f.store.patch('task',f.p.id,evidenceTask.id,{evidence:artifact});
    const info=task(f);state(f.store,f.p.id,info.id,'waiting_info');const d=decision(f.store,f.p.id,info,'info','contract question');
    const resolve=await fetch(url+`/api/scopes/${f.p.id}/decisions/${encodeURIComponent(d.id)}/resolve`,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({action:'approve',response:'current contract'})});assert.equal(resolve.status,200);assert.equal(f.store.require('task',f.p.id,info.id).scopeApproved,undefined);
    state(f.store,f.p.id,info.id,'waiting_info');const stale=decision(f.store,f.p.id,f.store.require('task',f.p.id,info.id),'info','another question');state(f.store,f.p.id,info.id,'cancelled');
    const resurrect=await fetch(url+`/api/scopes/${f.p.id}/decisions/${encodeURIComponent(stale.id)}/resolve`,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({action:'approve',response:'stale response'})});assert.equal(resurrect.status,409);assert.equal(f.store.require('task',f.p.id,info.id).status,'cancelled');
  }finally{await new Promise(r=>server.close(r));f.store.close();}
});

test('CTO selects only frontend; private workspace, repair, handoff, QA and result evidence connect',async()=>{
  const f=await fixture(),source=path.join(f.dir,'source');await mkdir(source);await writeFile(path.join(source,'base.txt'),'baseline');for(const args of [['init'],['config','user.name','Test'],['config','user.email','test@localhost'],['add','.'],['commit','-m','baseline']])await git(source,args);
  f.store.patch('project','company',f.p.id,{repository:source,testCommand:'fixture verification'});const calls=[];let verifies=0;
  const fake={start:async()=>{},close(){},run:async o=>{const run=f.store.list('run',f.p.id).at(-1);calls.push(run.stage);o.onThread(uid());o.onEvent({method:'turn/started',params:{turn:{id:uid()}}});if(run.role==='frontend')await writeFile(path.join(o.cwd,'feature.txt'),'implemented '+calls.length);return {text:JSON.stringify({summary:'fixture stage',handoff:'fixture next step',passed:true,disposition:'proceed',category:'bugfix',acceptance:['visible result, verified boundary'],requiredRoles:[],assignments:run.stage==='cto:0'?[{role:'frontend',instructions:'feature.txt only'}]:[],requests:[]}),usage:{total:{totalTokens:10},last:{totalTokens:10}}};}};
  const runner=new Runner(f.store,{clientFactory:()=>fake,verify:async()=>({code:++verifies===1?1:0,output:verifies===1?'fixture failure at boundary':'fixture PASS'})}),t=task(f);new QueueGateway(f.store).startTask(f.p.id,t.id);
  try{for(let n=0;n<2000;n++){await runner.tick();await new Promise(r=>setTimeout(r,10));if(['review','failed'].includes(f.store.require('task',f.p.id,t.id).status)&&!runner.executions.size)break;}
    const done=f.store.require('task',f.p.id,t.id);assert.equal(done.status,'review',done.reason);assert.deepEqual(calls,['po:0','cto:0','frontend:0','qa:0','frontend:1','qa:1','review:1']);assert.deepEqual(done.teamPlan.developers,['frontend']);assert.equal(done.verificationHistory.length,2);assert.ok((await readFile(done.evidence,'utf8')).includes('feature.txt'));assert.equal((await git(source,['status','--porcelain'])).output,'');assert.equal(f.store.list('message',f.p.id).filter(m=>m.kind==='revision').length,1);assert.equal(f.store.list('message',f.other.id).length,0);
    reviewResult(f.store,f.p.id,t.id,{outcome:'accepted',technicalIntervention:'none'});assessGoal(f.store,f.p.id,'g',{version:1,notes:'fixture test only'});assert.equal(personalMetrics(f.store,f.p.id).acceptedGoals.length,1);assert.equal(personalMetrics(f.store,f.p.id).knownMinutes,null);
  }finally{await runner.close();f.store.close();}
});
